import { afterEach, expect, it, vi } from 'vitest'
import { defaultConnectionSettings, PRESETS, selectedModel } from '../shared/providers'
import { noRedirectFetch, parseConnectionRequest, parseConnectionSettings, validateBaseURL } from './provider-settings'
import { parseSettings, DEFAULT_SETTINGS } from './settings'
afterEach(() => vi.unstubAllGlobals())
it('allows HTTPS and exact HTTP loopback names only, without embedded credentials or query data', () => {
  for (const url of ['https://api.example.invalid/v1', 'http://127.0.0.1:11434/v1', 'http://localhost:1234/v1/']) expect(validateBaseURL(url)).toBe(url.replace(/\/$/, ''))
  for (const url of ['http://example.invalid/v1', 'http://127.0.0.1.evil.invalid/v1', 'http://192.168.0.1/v1', 'file:///tmp/model', 'https://user:secret@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid/#secret', 'http://[::1]:11434/v1', 'not a URL']) expect(() => validateBaseURL(url)).toThrow()
})
it('forbids redirect following even if an SDK requests it', async () => {
  const transport = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', transport)
  await noRedirectFetch('https://example.invalid/models', { redirect: 'follow', headers: { Authorization: 'synthetic-only' } })
  expect(transport).toHaveBeenCalledWith('https://example.invalid/models', expect.objectContaining({ redirect: 'error' }))
})
it('maps verified speed presets and effort independently for each answer provider', () => {
  const config = defaultConnectionSettings()
  expect(selectedModel(config)).toEqual({ model: 'gpt-6.1-terra', effort: 'medium', vision: true })
  expect(PRESETS.openai.fast).toMatchObject({ model: 'gpt-6.1-terra', effort: 'low' }); expect(PRESETS.chatgpt.best).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' })
  expect(PRESETS.anthropic.fast).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' }); expect(PRESETS.anthropic.balanced).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' }); expect(PRESETS.anthropic.best.model).toBe('claude-opus-5-5')
  expect(PRESETS.google.balanced.model).toBe('gemini-3.8-flash'); expect(PRESETS.deepseek.balanced).toMatchObject({ model: 'deepseek-flash', vision: true }); expect(PRESETS.deepseek.best.vision).toBe(false)
  config.models.openai = { preset: 'custom', customModel: 'custom/model' }
  expect(selectedModel(config)).toEqual({ model: 'custom/model', vision: false })
})
it('validates provider/model/endpoint settings and refuses secret fields in settings or IPC requests', () => {
  const config = defaultConnectionSettings()
  expect(parseSettings({}).connection).toEqual(config)
  expect(parseConnectionSettings(config)).toEqual(config)
  for (const value of [{ ...config, provider: 'unknown' }, { ...config, models: { ...config.models, openai: { preset: ['fast'], customModel: '' } } }, { ...config, baseURL: 'http://remote.invalid' }, { ...config, access_token: 'synthetic' }, { ...config, models: { ...config.models, openai: { preset: 'custom', customModel: '' } } }, { ...config, models: { ...config.models, openai: { preset: 'balanced', customModel: '', apiKey: 'synthetic' } } }]) expect(() => parseConnectionSettings(value)).toThrow()
  expect(() => parseSettings({ ...DEFAULT_SETTINGS, apiKey: 'synthetic' }, true)).toThrow()
  for (const value of [{ kind: 'saveKey', provider: 'chatgpt', key: 'synthetic' }, { kind: 'saveKey', provider: 'anthropic', key: 'x\r\ninjected' }, { kind: 'removeKey', provider: 'openai', key: 'synthetic' }, { kind: 'signIn', token: 'synthetic' }]) expect(() => parseConnectionRequest(value)).toThrow()
  expect(parseConnectionRequest({ kind: 'saveKey', provider: 'anthropic', key: ' synthetic ' })).toEqual({ kind: 'saveKey', provider: 'anthropic', key: 'synthetic' })
})

it('allows a compatible endpoint to remain unselected while models are discovered', () => {
  const config = defaultConnectionSettings(); config.provider = 'compatible'
  config.models.compatible = { preset: 'custom', customModel: '' }
  expect(parseConnectionSettings(config).models.compatible.customModel).toBe('')
  expect(selectedModel(config).model).toBe('')
})

it('strictly accepts Connection details and Use for answers without credential fields', () => {
  expect(parseConnectionRequest({ kind: 'details' })).toEqual({ kind: 'details' })
  expect(parseConnectionRequest({ kind: 'useForAnswers', provider: 'anthropic' })).toEqual({ kind: 'useForAnswers', provider: 'anthropic' })
  for (const request of [{ kind: 'details', key: 'secret' }, { kind: 'useForAnswers', provider: 'unknown' }, { kind: 'useForAnswers', provider: 'openai', key: 'secret' }]) expect(() => parseConnectionRequest(request)).toThrow()
})
