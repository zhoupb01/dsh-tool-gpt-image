/**
 * `image_generate` — a model-facing image generation tool for DeepSeek Harness.
 *
 * Calls an OpenAI-compatible `POST {baseURL}/images/generations` endpoint, stores
 * every returned image in the attachment store (so it renders inline in the Web
 * GUI and on the next model turn), and optionally writes PNG/JPEG/WebP files into
 * the session workspace.
 *
 * The plugin has no npm dependencies on purpose: it must load from a profile whose
 * `node_modules` contains only the linked package itself.
 *
 * @module dsh-tool-gpt-image
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

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

/** The image value the `image_read` tool also produces: a durable attachment reference. */
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

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description: 'What to draw. Be specific about subject, composition, style, lighting, and any text that must appear.',
    },
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
      description: 'How many images to generate (1-4). Defaults to 1.',
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
      description: 'Workspace path for the saved file, e.g. "images/cat.png". Relative paths resolve against the session workspace. Defaults to "images/image-<timestamp>-<n>.<ext>".',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'prompt', 'images'],
  properties: {
    model: { type: 'string' },
    prompt: { type: 'string' },
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

/** Two-digit zero padding for timestamp parts. */
const pad = (value) => String(value).padStart(2, '0')

/** A filesystem-safe timestamp for default file names. */
function timestamp() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
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
 * POST the generation request and return the data items.
 * @param {object} options
 * @returns {Promise<{items: Array<{b64_json?: string, url?: string}>, revisedPrompt?: string}>}
 */
async function generate({ baseURL, apiKey, body, signal, timeoutMs }) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`image generation timed out after ${timeoutMs} ms`)), timeoutMs)

  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
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
      throw new Error(`image generation failed: HTTP ${response.status} ${String(detail).slice(0, 600)}`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`image generation returned non-JSON body: ${text.slice(0, 300)}`)
    }
    const items = Array.isArray(parsed?.data) ? parsed.data : []
    if (items.length === 0) {
      throw new Error(`image generation returned no images: ${text.slice(0, 300)}`)
    }
    return { items, revisedPrompt: items[0]?.revised_prompt }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Register the tool. Runs only while an attachment store is mounted, because an
 * image result is useless without one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registration scope.
 * @param {object} config - deployment configuration.
 */
function registerTool(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  const apiKeyName = config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const defaultModel = config?.defaultModel ?? DEFAULT_MODEL
  const models = Array.isArray(config?.models) && config.models.length > 0 ? config.models : [defaultModel]
  const outputDir = config?.outputDir ?? 'images'
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  ctx.tools.register({
    name: 'image_generate',
    description:
      'Generate images from a text prompt with an image model and save them into the workspace. '
      + 'Returns the images themselves so you can see and compare them. Use this for diagrams, illustrations, '
      + 'mockups, avatars, or any request that needs pixels rather than code. '
      + `Default model: ${defaultModel}. Configured models: ${models.join(', ')}.`,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const saved = value.images.filter((entry) => entry.path !== undefined).map((entry) => `![generated image](${entry.path})`)
        const head = `Generated ${value.images.length} image(s) with ${value.model}.`
        return [
          { type: 'text', text: saved.length > 0 ? `${head}\n\n${saved.join('\n')}` : head },
          ...value.images.map((entry) => ({ type: 'image', attachment: entry.image })),
        ]
      },
      presentationMeta(_args, value) {
        return { count: value.images.length, path: value.images[0]?.path }
      },
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')

      const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : defaultModel
      const count = Number.isInteger(args.n) ? Math.min(Math.max(args.n, 1), 4) : 1
      const format = (args.output_format ?? 'png').toLowerCase()
      const mediaType = OUTPUT_FORMATS[format]
      if (mediaType === undefined) throw new Error(`unsupported output_format "${format}"; use png, jpeg, or webp`)

      const apiKey = await resolveApiKey(ctx, apiKeyName)
      if (apiKey === undefined) {
        throw new Error(`no image API key: set the "${apiKeyName}" credential (Settings → Models/API keys) or export it in the environment`)
      }

      const body = { model, prompt, n: count }
      for (const field of ['size', 'quality', 'background']) {
        if (typeof args[field] === 'string' && args[field].length > 0) body[field] = args[field]
      }
      if (format !== 'png') body.output_format = format

      const { items } = await generate({ baseURL, apiKey, body, signal: exec.signal, timeoutMs })

      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('image_generate requires an attachment store')

      // Resolve the workspace root so files land where the user expects them.
      let root
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory !== undefined && exec.agent !== undefined) {
        try {
          root = await workingDirectory.ensure(exec.agent, exec.signal)
        } catch {
          root = undefined
        }
      }

      const stamp = timestamp()
      const extension = format === 'jpeg' ? 'jpg' : format
      const images = []
      for (const [index, item] of items.entries()) {
        exec.signal?.throwIfAborted()
        const data = await toBytes(item, exec.signal)
        const saved = await attachments.saveImage({ data, mediaType, name: `generated-${stamp}-${index + 1}.${extension}` })

        let path
        if (root !== undefined) {
          const base = typeof args.save_to === 'string' && args.save_to.trim().length > 0
            ? (isAbsolute(args.save_to) ? args.save_to : resolve(root, args.save_to))
            : join(root, outputDir, `image-${stamp}-${index + 1}.${extension}`)
          const target = items.length > 1 && typeof args.save_to === 'string'
            ? base.replace(/(\.[^./\\]+)?$/, (ext) => `-${index + 1}${ext || `.${extension}`}`)
            : base
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, data)
          path = target
        }

        images.push({
          ...(path === undefined ? {} : { path }),
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

      return { model, prompt, images }
    },
  })
}

/**
 * Mount the tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} config - the `config` block of the `tool-gpt-image` row.
 */
export function apply(ctx, config) {
  ctx.inject(['attachments'], (scope) => registerTool(scope, config))
}
