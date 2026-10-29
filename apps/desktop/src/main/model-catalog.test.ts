import { afterEach, expect, it, vi } from 'vitest'
import { catalogModels, listProviderModels } from './model-catalog'
afterEach(() => { vi.unstubAllGlobals() })
it('uses ChatGPT model slugs and visibility rather than assuming the API-key catalog shape', () => {
  expect(catalogModels('chatgpt', { models: [{ slug: 'gpt-6.1-terra', display_name: 'Terra', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] })).toEqual([{ id: 'gpt-6.1-terra', name: 'Terra', vision: true, tested: false }])
  expect(() => catalogModels('chatgpt', { data: [] })).toThrow()
})
it('uses OpenRouter capability metadata and treats unknown compatible models as text-only', () => {
  expect(catalogModels('openrouter', { data: [{ id: 'local/vision', architecture: { input_modalities: ['text', 'image'] } }, { id: 'local/text', architecture: { input_modalities: ['text'] } }] }).map(m => m.vision)).toEqual([true, false])
  expect(catalogModels('compatible', { data: [{ id: 'unknown' }] })[0]?.vision).toBe(false)
})
it('discovers Ollama tags and checks each model with /api/show rather than inferring vision from its name', async () => {
  const transport = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/api/tags') ? Response.json({ models: [{ name: 'vision-local' }, { name: 'text-local' }] }) : Response.json({ capabilities: JSON.parse(String(init?.body)).model === 'vision-local' ? ['completion', 'vision'] : ['completion'] }))
  const models = await listProviderModels('compatible', '', 'http://127.0.0.1:11434/v1', transport)
  expect(models.map(m => m.vision)).toEqual([true, false])
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/show', 'http://127.0.0.1:11434/api/show'])
})
it('validates Anthropic with model listing, correct auth/version headers and pagination; puts Gemini keys in headers not URLs', async () => {
  const transport = vi.fn<typeof fetch>(async url => String(url).includes('after_id') ? Response.json({ data: [{ id: 'second' }], has_more: false }) : Response.json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }))
  expect((await listProviderModels('anthropic', 'synthetic-anthropic', '', transport)).map(m => m.id)).toEqual(['first', 'second'])
  expect(transport.mock.calls[0]![1]?.headers).toEqual({ 'x-api-key': 'synthetic-anthropic', 'anthropic-version': '2023-06-01' })
  const google = vi.fn<typeof fetch>(async () => Response.json({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }] }))
  expect((await listProviderModels('google', 'synthetic-google', '', google))[0]?.id).toBe('gemini-3.8-flash')
  expect(String(google.mock.calls[0]![0])).not.toContain('synthetic-google'); expect(google.mock.calls[0]![1]?.headers).toEqual({ 'x-goog-api-key': 'synthetic-google' })
})

it('authenticates OpenRouter keys with /key because its /models catalog is public', async () => {
  const transport = vi.fn<typeof fetch>(async url => String(url).endsWith('/key') ? new Response('', { status: 401 }) : Response.json({ data: [{ id: 'openai/gpt-6.1-terra' }] }))
  await expect(listProviderModels('openrouter', 'synthetic-invalid', '', transport)).rejects.toThrow('401')
  expect(transport).toHaveBeenCalledOnce()
  expect(String(transport.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/key')
  expect(transport.mock.calls[0]![1]?.headers).toEqual({ Authorization: 'Bearer synthetic-invalid' })
})
