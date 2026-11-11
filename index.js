/**
 * `image_generate` / `image_edit` — model-facing image tools for DeepSeek Harness.
 *
 * Calls an OpenAI-compatible `POST {baseURL}/images/generations` (JSON) or
 * `POST {baseURL}/images/edits` (multipart), stores every returned image in the
 * attachment store (so it renders inline in the Web GUI and on the next model
 * turn), and optionally writes PNG/JPEG/WebP files into the session workspace.
 *
 * The plugin has no npm dependencies on purpose: it must load from a profile whose
 * `node_modules` contains only the linked package itself.
 *
 * @module dsh-tool-gpt-image
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'tool-gpt-image'

/** Mount as soon as the tool registry exists; other services are read lazily. */
export const inject = ['tools']

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-image-1'
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'
const DEFAULT_TIMEOUT_MS = 300_000

const OUTPUT_FORMATS = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

const INPUT_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** The image value the `read_image` tool also produces: a durable attachment reference. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'prompt', 'images'],
  properties: {
    model: { type: 'string' },
    prompt: { type: 'string' },
    input: { type: 'string' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['image'],
        properties: {
          path: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
    },
  },
}

/** Parameters both tools share. */
const COMMON_PARAMETERS = {
  model: {
    type: 'string',
    description: 'Image model id. Defaults to the deployment default model.',
  },
  size: {
    type: 'string',
    description: 'Output size, e.g. "1024x1024", "1536x1024" (landscape), "1024x1536" (portrait), or "auto".',
  },
  n: {
    type: 'integer',
    description: 'How many variants to return (1-4). Defaults to 1.',
  },
  quality: {
    type: 'string',
    enum: ['low', 'medium', 'high', 'auto'],
    description: 'Rendering quality/cost tradeoff. Defaults to "auto" (server default).',
  },
  background: {
    type: 'string',
    enum: ['transparent', 'opaque', 'auto'],
    description: 'Background handling; "transparent" requires a format that supports alpha.',
  },
  output_format: {
    type: 'string',
    enum: ['png', 'jpeg', 'webp'],
    description: 'File format for the saved images. Defaults to "png".',
  },
  save_to: {
    type: 'string',
    description: 'Workspace path for the saved file, e.g. "images/cat.png". Relative paths resolve against the session workspace.',
  },
}

const GENERATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description: 'What to draw. Be specific about subject, composition, style, lighting, and any text that must appear.',
    },
    ...COMMON_PARAMETERS,
  },
}

const EDIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'image'],
  properties: {
    prompt: {
      type: 'string',
      description: 'The change to make. Describe the target state, not the current one, and name anything that must stay unchanged.',
    },
    image: {
      type: 'string',
      description: 'PNG/JPEG/WebP file to edit: an absolute path, or a path relative to the session workspace.',
    },
    mask: {
      type: 'string',
      description: 'Optional PNG mask of the same size as `image`. Fully transparent pixels mark the area to regenerate; opaque pixels are preserved.',
    },
    ...COMMON_PARAMETERS,
  },
}

/** Two-digit zero padding for timestamp parts. */
const pad = (value) => String(value).padStart(2, '0')

/** A filesystem-safe timestamp for default file names. */
function timestamp() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * Resolve the API key from the harness credential store, then the process environment.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} keyName
 * @returns {Promise<string | undefined>}
 */
async function resolveApiKey(ctx, keyName) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(keyName)
      if (hit?.value) return hit.value
    } catch {
      // A key name outside the credential store's grammar falls through to the environment.
    }
  }
  const fromEnv = process.env[keyName]
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined
}

/**
 * Resolve the session workspace root for a calling agent, if the service is mounted.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} exec
 * @returns {Promise<string | undefined>}
 */
async function resolveRoot(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined || exec.agent === undefined) return undefined
  try {
    return await workingDirectory.ensure(exec.agent, exec.signal)
  } catch {
    return undefined
  }
}

/**
 * Resolve a model-supplied path: absolute paths pass through, relative ones anchor at the workspace.
 * @param {string} input
 * @param {string | undefined} root
 * @returns {string}
 */
function resolveInputPath(input, root) {
  if (isAbsolute(input)) return input
  if (root === undefined) throw new Error(`cannot resolve relative path "${input}": no session workspace is mounted; pass an absolute path`)
  return resolve(root, input)
}

/**
 * POST a request and decode the JSON answer, turning HTTP and API failures into readable errors.
 * @param {object} options
 * @returns {Promise<{items: Array<{b64_json?: string, url?: string}>, revisedPrompt?: string}>}
 */
async function postImages({ baseURL, apiKey, pathName, body, signal, timeoutMs }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`image request timed out after ${timeoutMs} ms`)), timeoutMs)

  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}${pathName}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(isForm ? {} : { 'content-type': 'application/json' }),
      },
      body: isForm ? body : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      let detail = text
      try {
        const parsed = JSON.parse(text)
        detail = parsed?.error?.message ?? parsed?.message ?? text
      } catch {
        // keep the raw body
      }
      throw new Error(`${pathName} failed: HTTP ${response.status} ${String(detail).slice(0, 600)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`${pathName} returned non-JSON body: ${text.slice(0, 300)}`)
    }
    const items = Array.isArray(parsed?.data) ? parsed.data : []
    if (items.length === 0) {
      throw new Error(`${pathName} returned no images: ${text.slice(0, 300)}`)
    }
    return { items, revisedPrompt: items[0]?.revised_prompt }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Decode one API result item into bytes.
 * @param {{b64_json?: string, url?: string}} item
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array>}
 */
async function toBytes(item, signal) {
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return new Uint8Array(Buffer.from(item.b64_json, 'base64'))
  }
  if (typeof item.url === 'string' && item.url.length > 0) {
    const response = await fetch(item.url, { signal })
    if (!response.ok) {
      throw new Error(`cannot download generated image ${item.url}: HTTP ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new Error('image API returned neither b64_json nor url')
}

/**
 * Compute the on-disk target for one returned image.
 * @param {object} options
 * @returns {string | undefined}
 */
function outputTarget({ root, saveTo, outputDir, stamp, index, count, extension, prefix }) {
  if (root === undefined) return undefined
  if (typeof saveTo === 'string' && saveTo.trim().length > 0) {
    const base = isAbsolute(saveTo) ? saveTo : resolve(root, saveTo)
    if (count === 1) return base
    const dot = base.lastIndexOf('.')
    return dot > base.lastIndexOf('/') ? `${base.slice(0, dot)}-${index + 1}${base.slice(dot)}` : `${base}-${index + 1}.${extension}`
  }
  return join(root, outputDir, `${prefix}-${stamp}-${index + 1}.${extension}`)
}

/**
 * Store every returned image in the attachment store and, when possible, write it to disk.
 * @param {object} options
 * @returns {Promise<Array<{path?: string, image: object}>>}
 */
async function persistImages({ ctx, exec, items, mediaType, extension, saveTo, root, outputDir, stamp, prefix = 'image' }) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('image tools require an attachment store')

  const images = []
  for (const [index, item] of items.entries()) {
    exec.signal?.throwIfAborted()
    const data = await toBytes(item, exec.signal)
    const saved = await attachments.saveImage({
      data,
      mediaType,
      name: `${prefix}-${stamp}-${index + 1}.${extension}`,
    })

    const target = outputTarget({ root, saveTo, outputDir, stamp, index, count: items.length, extension, prefix })
    if (target !== undefined) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
    }

    images.push({
      ...(target === undefined ? {} : { path: target }),
      image: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
        ...(saved.name === undefined ? {} : { name: saved.name }),
      },
    })
  }
  return images
}

/**
 * Read an input file and resolve the media type the API will see.
 * @param {string} path
 * @returns {Promise<{data: Buffer, mediaType: string, name: string}>}
 */
async function readInputImage(path) {
  const mediaType = INPUT_MEDIA_TYPES[extname(path).toLowerCase()]
  if (mediaType === undefined) {
    throw new Error(`unsupported input image "${path}": edit accepts PNG, JPEG, or WebP files`)
  }
  const data = await readFile(path)
  if (data.byteLength === 0) throw new Error(`input image "${path}" is empty`)
  return { data, mediaType, name: basename(path) }
}

/** Build the shared content blocks for a tool result. */
function renderImages(verb, value) {
  const saved = value.images.filter((entry) => entry.path !== undefined).map((entry) => `![${verb} image](${entry.path})`)
  const head = `${verb === 'edited' ? 'Edited' : 'Generated'} ${value.images.length} image(s) with ${value.model}.`
  return [
    { type: 'text', text: saved.length > 0 ? `${head}\n\n${saved.join('\n')}` : head },
    ...value.images.map((entry) => ({ type: 'image', attachment: entry.image })),
  ]
}

/**
 * Register both tools. Runs only while an attachment store is mounted, because an
 * image result is useless without one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registration scope.
 * @param {object} config - deployment configuration.
 */
function registerTools(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  const apiKeyName = config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const defaultModel = config?.defaultModel ?? DEFAULT_MODEL
  const editModel = config?.defaultEditModel ?? defaultModel
  const models = Array.isArray(config?.models) && config.models.length > 0 ? config.models : [defaultModel]
  const outputDir = config?.outputDir ?? 'images'
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const modelHint = `Default model: ${defaultModel}. Configured models: ${models.join(', ')}.`

  /** Shared argument normalization. */
  const normalize = (args) => {
    const format = (args.output_format ?? 'png').toLowerCase()
    const mediaType = OUTPUT_FORMATS[format]
    if (mediaType === undefined) throw new Error(`unsupported output_format "${format}"; use png, jpeg, or webp`)
    return {
      model: typeof args.model === 'string' && args.model.length > 0 ? args.model : undefined,
      count: Number.isInteger(args.n) ? Math.min(Math.max(args.n, 1), 4) : 1,
      format,
      mediaType,
      extension: format === 'jpeg' ? 'jpg' : format,
    }
  }

  ctx.tools.register({
    name: 'image_generate',
    description:
      'Generate images from a text prompt with an image model and save them into the workspace. '
      + 'Returns the images themselves so you can see and compare them. Use this for diagrams, illustrations, '
      + `mockups, avatars, or any request that needs pixels rather than code. ${modelHint}`,
    parameters: GENERATE_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderImages('generated', value),
      presentationMeta: (_args, value) => ({ count: value.images.length, path: value.images[0]?.path }),
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const { model = defaultModel, count, format, mediaType, extension } = normalize(args)

      const apiKey = await resolveApiKey(ctx, apiKeyName)
      if (apiKey === undefined) {
        throw new Error(`no image API key: set the "${apiKeyName}" credential (the Models page writes it) or export it in the environment`)
      }

      const body = { model, prompt, n: count }
      for (const field of ['size', 'quality', 'background']) {
        if (typeof args[field] === 'string' && args[field].length > 0) body[field] = args[field]
      }
      if (format !== 'png') body.output_format = format

      const { items } = await postImages({ baseURL, apiKey, pathName: '/images/generations', body, signal: exec.signal, timeoutMs })
      const root = await resolveRoot(ctx, exec)
      const stamp = timestamp()
      const images = await persistImages({
        ctx,
        exec,
        items,
        mediaType,
        extension,
        saveTo: args.save_to,
        root,
        outputDir,
        stamp,
      })
      return { model, prompt, images }
    },
  })

  ctx.tools.register({
    name: 'image_edit',
    description:
      'Edit an existing PNG/JPEG/WebP image with a text prompt (inpainting when a mask is given). '
      + 'Returns the edited images and saves them into the workspace. Use it to restyle, extend, remove, '
      + `or repaint part of an image the user already has. ${modelHint}`,
    parameters: EDIT_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderImages('edited', value),
      presentationMeta: (_args, value) => ({ count: value.images.length, path: value.images[0]?.path }),
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      if (typeof args.image !== 'string' || args.image.trim().length === 0) throw new Error('image must be a non-empty path')
      if (typeof FormData === 'undefined') throw new Error('image_edit needs a runtime with FormData (Node 18+)')

      const { model = editModel, count, format, mediaType, extension } = normalize(args)
      const apiKey = await resolveApiKey(ctx, apiKeyName)
      if (apiKey === undefined) {
        throw new Error(`no image API key: set the "${apiKeyName}" credential (the Models page writes it) or export it in the environment`)
      }

      const root = await resolveRoot(ctx, exec)
      const source = resolveInputPath(args.image.trim(), root)
      const input = await readInputImage(source)

      const form = new FormData()
      form.append('model', model)
      form.append('prompt', prompt)
      form.append('n', String(count))
      form.append('image', new Blob([input.data], { type: input.mediaType }), input.name)
      if (typeof args.mask === 'string' && args.mask.trim().length > 0) {
        const maskPath = resolveInputPath(args.mask.trim(), root)
        const mask = await readInputImage(maskPath)
        form.append('mask', new Blob([mask.data], { type: mask.mediaType }), mask.name)
      }
      for (const field of ['size', 'quality', 'background']) {
        if (typeof args[field] === 'string' && args[field].length > 0) form.append(field, args[field])
      }
      if (format !== 'png') form.append('output_format', format)

      const { items } = await postImages({ baseURL, apiKey, pathName: '/images/edits', body: form, signal: exec.signal, timeoutMs })
      const stamp = timestamp()
      const images = await persistImages({
        ctx,
        exec,
        items,
        mediaType,
        extension,
        saveTo: typeof args.save_to === 'string' && args.save_to.length > 0 ? args.save_to : undefined,
        root,
        outputDir,
        stamp,
        prefix: 'edited',
      })
      return { model, prompt, input: source, images }
    },
  })
}

/**
 * Mount the tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} config - the `config` block of the `tool-gpt-image` row.
 */
export function apply(ctx, config) {
  ctx.inject(['attachments'], (scope) => registerTools(scope, config))
}
