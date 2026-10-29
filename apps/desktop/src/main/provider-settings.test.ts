import { afterEach, expect, it, vi } from 'vitest'
import { defaultConnectionSettings, PROVIDERS, RECOMMENDED_MODELS, modelEfforts, selectedModel } from '../shared/providers'
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
it('keeps model and thinking independent and exposes levels only for supported models', () => {
  const config = defaultConnectionSettings()
  expect(selectedModel(config)).toEqual({ model: 'gpt-6.1-terra', effort: 'low', vision: true })
  for (const provider of PROVIDERS) {
    config.provider = provider
    for (const model of RECOMMENDED_MODELS[provider]) {
      config.models[provider] = { model: model.model, effort: 'high' }
      expect(selectedModel(config)).toEqual({ model: model.model, vision: model.vision, ...(modelEfforts(provider, model.model).length ? { effort: 'high' } : {}) })
    }
  }
  config.provider = 'openai'; config.models.openai = { model: 'custom/model', effort: 'high' }
  expect(selectedModel(config)).toEqual({ model: 'custom/model', vision: false })
  expect(() => parseConnectionSettings(config)).toThrow('thinking')
})
it('preserves explicit model choices and rejects incomplete or superseded settings shapes', () => {
  const current = defaultConnectionSettings(); current.models.openai = { model: 'gpt-6.1-sol', effort: 'high' }
  expect(parseSettings({ connection: current }).connection).toEqual(current)
  expect(() => parseConnectionSettings({ ...current, models: {} })).toThrow()
  expect(() => parseConnectionSettings({ ...current, models: { ...current.models, openai: { preset: 'balanced', customModel: '' } } })).toThrow()
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
  config.models.compatible = { model: '' }
  expect(parseConnectionSettings(config).models.compatible.model).toBe('')
  expect(selectedModel(config).model).toBe('')
})

it('strictly accepts Connection details and Use for answers without credential fields', () => {
  expect(parseConnectionRequest({ kind: 'details' })).toEqual({ kind: 'details' })
  expect(parseConnectionRequest({ kind: 'useForAnswers', provider: 'anthropic' })).toEqual({ kind: 'useForAnswers', provider: 'anthropic' })
  for (const request of [{ kind: 'details', key: 'secret' }, { kind: 'useForAnswers', provider: 'unknown' }, { kind: 'useForAnswers', provider: 'openai', key: 'secret' }]) expect(() => parseConnectionRequest(request)).toThrow()
})
