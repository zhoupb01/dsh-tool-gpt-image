import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const path = process.env.IMAGE_PLUGIN_PATH ?? fileURLToPath(new URL('../index.js', import.meta.url))
const { apply } = await import(pathToFileURL(path).href)
const temporary = await mkdtemp(join(tmpdir(), 'dsh-image-test-'))
const input = join(temporary, 'reference.png')
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII='
await writeFile(input, Buffer.from(pixel, 'base64'))
const originalFetch = globalThis.fetch
const originalKey = process.env.OPENAI_API_KEY
delete process.env.OPENAI_API_KEY
after(async () => {
  globalThis.fetch = originalFetch
  if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey
  const target = resolve(temporary)
  assert.equal(dirname(target), resolve(tmpdir()))
  assert.ok(target.startsWith(join(resolve(tmpdir()), 'dsh-image-test-')))
  await rm(target, { recursive: true, force: true })
})

function setup(providers = { magpie: { api: 'openai-completions', baseURL: 'https://magpie.invalid/v1', apiKeyEnv: 'IMAGE_TEST_KEY', models: [{ id: 'gpt-6' }] } }, preferred = 'magpie') {
  const tools = new Map()
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({ data: [{ b64_json: pixel }] })
  }
  const services = {
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] },
    credentials: { resolve: async (ref) => ref === 'IMAGE_TEST_KEY' ? { value: 'fixture-key' } : undefined },
    attachments: { saveImage: async ({ data, mediaType }) => ({ attachmentId: 'fixture', mediaType, bytes: data.byteLength, width: 1, height: 1 }) },
    agentDefaultModel: { currentSelection: () => ({ provider: preferred }) },
  }
  const ctx = { get: (name) => services[name], tools: { register: (tool) => tools.set(tool.name, tool) }, inject: (_names, callback) => callback(ctx) }
  apply(ctx, {})
  const exec = { signal: new AbortController().signal, agent: { model: { current: () => ({ provider: preferred }) } } }
  return { calls, run: (name, args) => tools.get(name).execute(args, exec) }
}

test('explicit GPT Image works when Magpie advertises only chat models', async () => {
  const fixture = setup()
  const result = await fixture.run('image_generate', { prompt: 'A goat icon', model: 'gpt-image-2' })
  assert.equal(result.model, 'gpt-image-2')
  assert.equal(fixture.calls[0].url, 'https://magpie.invalid/v1/images/generations')
  assert.equal(JSON.parse(fixture.calls[0].options.body).model, 'gpt-image-2')
})

test('explicit GPT Image edits reach the existing compatible route', async () => {
  const fixture = setup()
  const result = await fixture.run('image_edit', { prompt: 'A goat icon', model: 'gpt-image-2', image: input })
  assert.equal(result.model, 'gpt-image-2')
  assert.equal(fixture.calls[0].url, 'https://magpie.invalid/v1/images/edits')
  assert.equal(fixture.calls[0].options.body.get('model'), 'gpt-image-2')
  assert.equal(fixture.calls[0].options.body.get('image').type, 'image/png')
})

test('legacy image model discovery still selects GPT Image 2 without an override', async () => {
  const fixture = setup({ magpie: { api: 'openai-completions', baseURL: 'https://magpie.invalid/v1', apiKeyEnv: 'IMAGE_TEST_KEY', models: [{ id: 'gpt-6' }, { id: 'gpt-image-2' }] } })
  assert.equal((await fixture.run('image_generate', { prompt: 'A goat icon' })).model, 'gpt-image-2')
})

test('explicit model does not turn chat models into implicit image candidates', async () => {
  const fixture = setup()
  await fixture.run('image_generate', { prompt: 'A goat icon', model: 'gpt-image-2' })
  await assert.rejects(fixture.run('image_generate', { prompt: 'A goat icon' }))
  assert.equal(fixture.calls.length, 1)
})

test('an Anthropic route is never sent OpenAI image requests', async () => {
  const fixture = setup({ magpie: { api: 'anthropic-messages', baseURL: 'https://anthropic.invalid', apiKeyEnv: 'IMAGE_TEST_KEY', models: [{ id: 'claude' }] } })
  await assert.rejects(fixture.run('image_generate', { prompt: 'A goat icon', model: 'gpt-image-2' }))
  assert.equal(fixture.calls.length, 0)
})

test('explicit model keeps the current compatible provider preference', async () => {
  const fixture = setup({
    other: { api: 'openai-completions', baseURL: 'https://other.invalid/v1', apiKeyEnv: 'IMAGE_TEST_KEY', models: [{ id: 'gpt-image-2' }] },
    magpie: { api: 'openai-responses', baseURL: 'https://magpie.invalid/v1', apiKeyEnv: 'IMAGE_TEST_KEY', models: [{ id: 'gpt-6' }] },
  })
  await fixture.run('image_generate', { prompt: 'A goat icon', model: 'gpt-image-2' })
  assert.equal(fixture.calls[0].url, 'https://magpie.invalid/v1/images/generations')
})
