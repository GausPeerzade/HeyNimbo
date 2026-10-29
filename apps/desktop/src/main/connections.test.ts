import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Connections } from './connections'
import { SettingsStore } from './settings'
import { defaultConnectionSettings } from '../shared/providers'
const mocks = vi.hoisted(() => ({ secrets: new Map<string, string>(), browser: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: mocks.browser } }))
vi.mock('./secrets', () => ({ secretSavedAt: async () => 1793232000000, loadSecret: async (name: string) => mocks.secrets.get(name), saveSecret: async (name: string, value: string) => { mocks.secrets.set(name, value) }, removeSecret: async (name: string) => { mocks.secrets.delete(name) } }))
let directory = '', settings: SettingsStore
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'nimbo-connections-test-')); settings = new SettingsStore(join(directory, 'settings.json')); mocks.secrets.clear(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden') })) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks() })
it('keeps legacy OpenAI and Anthropic keys at once, separates answer billing from voice, and excludes secrets from snapshots/settings', async () => {
  mocks.secrets.set('openai-key', 'synthetic-openai'); mocks.secrets.set('anthropic-key', 'synthetic-anthropic')
  const config = defaultConnectionSettings(); config.provider = 'anthropic'; settings.set({ ...settings.get(), connection: config })
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect(connections.voiceKey).toBe('synthetic-openai'); expect(connections.answerReady).toBe(true)
  expect(connections.answer()).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  expect(connections.snapshot().voice).toBe('OpenAI key')
  expect(JSON.stringify({ snapshot: connections.snapshot(), settings: settings.get() })).not.toContain('synthetic')
  await connections.request({ kind: 'removeKey', provider: 'anthropic' })
  expect(connections.voiceKey).toBe('synthetic-openai'); expect(connections.answerReady).toBe(false)
})
it('routes the correct provider key during discovery, validates custom models, and does not store rejected credentials', async () => {
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('anthropic')) {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-anthropic')
      return Response.json({ data: [{ id: 'claude-sonnet-5-5' }] })
    }
    return new Response('', { status: 401 })
  }); vi.stubGlobal('fetch', transport)
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect((await connections.request({ kind: 'saveKey', provider: 'anthropic', key: 'synthetic-anthropic' }, { selectSavedProvider: true })).ok).toBe(true)
  expect(settings.get().connection?.provider).toBe('anthropic')
  expect((await connections.request({ kind: 'saveKey', provider: 'google', key: 'synthetic-invalid' })).ok).toBe(false)
  expect(mocks.secrets.has('google-key')).toBe(false)
  const config = connections.config; config.models.anthropic = { preset: 'custom', customModel: 'not-in-catalog' }
  await expect(connections.validateSettings(config)).rejects.toThrow('not available')
  expect(await connections.answer().credential()).toBe('synthetic-anthropic')
})
it('allows a local no-key compatible endpoint but validates its model list before sending answers', async () => {
  const config = defaultConnectionSettings(); config.provider = 'compatible'; config.baseURL = 'http://127.0.0.1:1234/v1'; config.models.compatible = { preset: 'custom', customModel: 'local-text' }
  settings.set({ ...settings.get(), connection: config })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'local-text' }] })))
  const connections = new Connections(settings, vi.fn()); await connections.load(); await connections.validateSettings(config)
  expect(connections.answerReady).toBe(true); expect(connections.snapshot().voice).toBe('unavailable'); expect(connections.answer().vision).toBe(false)
  expect(await connections.answer().credential()).toBe('')
})

it.each(['chatgpt', 'anthropic'] as const)('saving an OpenAI key never changes a disconnected %s answer billing path', async provider => {
  const config = defaultConnectionSettings(); config.provider = provider
  settings.set({ ...settings.get(), connection: config })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'gpt-6.1-terra' }] })))
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect(connections.answerReady).toBe(false)
  expect((await connections.request({ kind: 'saveKey', provider: 'openai', key: 'synthetic-openai' })).ok).toBe(true)
  expect(connections.voiceKey).toBe('synthetic-openai')
  expect(connections.config.provider).toBe(provider)
  expect(connections.answerReady).toBe(false)
})

it.each(['https://b.example.invalid/v1', 'https://a.example.invalid/other/v1'])('binds the encrypted compatible key to its normalized endpoint, never sending A credentials to %s', async endpoint => {
  const config = defaultConnectionSettings(); config.provider = 'compatible'; config.baseURL = 'https://a.example.invalid/v1/'
  config.models.compatible = { preset: 'custom', customModel: 'model-a' }
  settings.set({ ...settings.get(), connection: config })
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const isA = String(url) === 'https://a.example.invalid/v1/models'
    expect(new Headers(init?.headers).get('authorization')).toBe(isA ? 'Bearer synthetic-a' : null)
    return Response.json({ data: [{ id: isA ? 'model-a' : 'model-b' }] })
  }); vi.stubGlobal('fetch', transport)
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect((await connections.request({ kind: 'saveKey', provider: 'compatible', key: 'synthetic-a' })).ok).toBe(true)
  expect(JSON.parse(mocks.secrets.get('compatible-key')!)).toEqual({ baseURL: 'https://a.example.invalid/v1', key: 'synthetic-a' })
  const reloaded = new Connections(settings, vi.fn()); await reloaded.load()
  expect(await reloaded.answer().credential()).toBe('synthetic-a')
  const candidate = reloaded.config; candidate.baseURL = endpoint
  const next = await reloaded.validateSettings(candidate)
  settings.set({ ...settings.get(), connection: next })
  expect(reloaded.snapshot().compatibleKeyPresent).toBe(false)
  expect((await reloaded.request({ kind: 'details' })).keyHints?.compatible).toBeUndefined()
  expect((await reloaded.request({ kind: 'models', provider: 'compatible' })).ok).toBe(true)
  const selected = reloaded.config; selected.models.compatible = { preset: 'custom', customModel: 'model-b' }
  const validated = await reloaded.validateSettings(selected)
  settings.set({ ...settings.get(), connection: validated })
  expect(await reloaded.answer().credential()).toBe('')
  expect(transport.mock.calls.filter(([url]) => String(url).startsWith(`${endpoint}/`)).length).toBeGreaterThan(0)
  expect(JSON.stringify({ snapshot: reloaded.snapshot(), settings: settings.get() })).not.toContain('synthetic-a')
})

it('requires an explicitly entered key for a new compatible endpoint, including pre-save discovery', async () => {
  const config = defaultConnectionSettings(); config.provider = 'compatible'; config.baseURL = 'https://a.example.invalid/v1'
  settings.set({ ...settings.get(), connection: config })
  mocks.secrets.set('compatible-key', JSON.stringify({ baseURL: config.baseURL, key: 'synthetic-a' }))
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://b.example.invalid/v1/models')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-b')
    return Response.json({ data: [{ id: 'model-b' }] })
  }); vi.stubGlobal('fetch', transport)
  const connections = new Connections(settings, vi.fn()); await connections.load()
  const candidate = connections.config; candidate.baseURL = 'https://b.example.invalid/v1'
  settings.set({ ...settings.get(), connection: await connections.validateSettings(candidate) })
  expect((await connections.request({ kind: 'saveKey', provider: 'compatible', key: 'synthetic-b' })).ok).toBe(true)
  expect(JSON.parse(mocks.secrets.get('compatible-key')!)).toEqual({ baseURL: candidate.baseURL, key: 'synthetic-b' })
  expect(connections.snapshot().compatibleKeyPresent).toBe(true)
})

it('ignores legacy compatible keys without an endpoint binding', async () => {
  mocks.secrets.set('compatible-key', 'synthetic-unbound')
  const config = defaultConnectionSettings(); config.provider = 'compatible'; config.baseURL = 'https://b.example.invalid/v1'
  config.models.compatible = { preset: 'custom', customModel: 'model-b' }; settings.set({ ...settings.get(), connection: config })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    return Response.json({ data: [{ id: 'model-b' }] })
  }))
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect(await connections.answer().credential()).toBe('')
})

it.each([false, true])('repairs an endpoint with a disjoint catalog when the old endpoint is unreachable: %s', async unreachable => {
  const config = defaultConnectionSettings(); config.provider = 'compatible'; config.baseURL = 'https://a.example.invalid/v1'
  config.models.compatible = { preset: 'custom', customModel: 'model-a' }; settings.set({ ...settings.get(), connection: config })
  const transport = vi.fn<typeof fetch>(async url => {
    if (String(url).startsWith('https://a.example.invalid/')) {
      if (unreachable) throw new Error('Old endpoint unreachable')
      return Response.json({ data: [{ id: 'model-a' }] })
    }
    return Response.json({ data: [{ id: 'model-b' }] })
  }); vi.stubGlobal('fetch', transport)
  const connections = new Connections(settings, vi.fn()); await connections.load()
  const candidate = connections.config; candidate.baseURL = 'https://b.example.invalid/v1'
  const next = await connections.validateSettings(candidate)
  expect(next?.models.compatible).toEqual({ preset: 'custom', customModel: '' })
  expect(candidate.models.compatible.customModel).toBe('model-a')
  expect(transport).not.toHaveBeenCalled()
  settings.set({ ...settings.get(), connection: next })
  expect(connections.answerReady).toBe(false)
  expect((await connections.request({ kind: 'models', provider: 'compatible' })).ok).toBe(true)
  expect(connections.snapshot().models.map(model => model.id)).toEqual(['model-b'])
  const selected = connections.config; selected.models.compatible = { preset: 'custom', customModel: 'model-b' }
  settings.set({ ...settings.get(), connection: await connections.validateSettings(selected) })
  expect(connections.answerReady).toBe(true)
  expect(await connections.answer().credential()).toBe('')
  expect(transport.mock.calls.every(([url]) => String(url).startsWith('https://b.example.invalid/'))).toBe(true)
})

it('exposes only four-character key hints and saved dates in Connection details, never OAuth token hints or general snapshots', async () => {
  const providers = ['openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'compatible'] as const
  const config = defaultConnectionSettings()
  for (const provider of providers) mocks.secrets.set(`${provider}-key`, provider === 'compatible' ? JSON.stringify({ baseURL: config.baseURL, key: `private-${provider}-wXyZ` }) : `private-${provider}-wXyZ`)
  mocks.secrets.set('chatgpt-auth', JSON.stringify({ hostId: 'urn:uuid:synthetic-host', active: 'account', profiles: [{ id: 'account', clientId: 'synthetic-client', identity: { subject: 'subject', name: 'Alex', email: 'alex@example.invalid' }, tokens: { access: 'private-access-s3Qt', refresh: 'private-refresh-r8Lp', id: 'private-id-i6Vn', expires: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] } }] }))
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')]
  const changed = vi.fn(), connections = new Connections(settings, changed); await connections.load()
  const details = await connections.request({ kind: 'details' })
  expect(Object.keys(details.keyHints ?? {}).sort()).toEqual([...providers].sort())
  for (const provider of providers) expect(details.keyHints?.[provider]).toEqual({ suffix: 'wXyZ', savedAt: 1793232000000 })
  const serialized = JSON.stringify(details)
  for (const forbidden of ['private-', '-wXyZ', 's3Qt', 'r8Lp', 'i6Vn', 'chatgpt']) expect(serialized).not.toContain(forbidden)
  const general = JSON.stringify({ snapshot: connections.snapshot(), response: await connections.request({ kind: 'snapshot' }), settings: settings.get() })
  expect(general).not.toContain('wXyZ'); expect(general).not.toContain('keyHints')
  expect(changed).not.toHaveBeenCalled()
  for (const log of logs) expect(log).not.toHaveBeenCalled()
})
it.each(['x', '1234', 'private-value-abcd'])('never reveals a complete credential even when a key is short: %s', async value => {
  mocks.secrets.set('openai-key', value)
  const connections = new Connections(settings, vi.fn()); await connections.load()
  const hint = (await connections.request({ kind: 'details' })).keyHints?.openai
  expect(hint?.suffix).toBe(value.length > 4 ? value.slice(-4) : '')
  expect(hint?.suffix.length).toBeLessThanOrEqual(4)
  expect(hint?.suffix).not.toBe(value)
})
it.each(['chatgpt', 'openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'compatible'] as const)('Use for answers selects %s without changing any saved model choice or the shared OpenAI key', async provider => {
  const config = defaultConnectionSettings(); config.models.anthropic = { preset: 'best', customModel: 'remembered-claude' }; config.models.compatible = { preset: 'custom', customModel: 'local-model' }
  settings.set({ ...settings.get(), connection: config }); mocks.secrets.set('openai-key', 'private-openai-abcd')
  const changed = vi.fn(), connections = new Connections(settings, changed); await connections.load()
  expect((await connections.request({ kind: 'useForAnswers', provider })).ok).toBe(true)
  expect(connections.config.provider).toBe(provider)
  expect(connections.config.models).toEqual(config.models)
  expect(connections.voiceKey).toBe('private-openai-abcd')
  expect(changed).toHaveBeenCalledOnce()
  expect(fetch).not.toHaveBeenCalled()
})
it.each(['openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'compatible'] as const)('removing %s clears its key hint, saved date and key status', async provider => {
  const value = 'private-value-abcd', config = defaultConnectionSettings()
  mocks.secrets.set(`${provider}-key`, provider === 'compatible' ? JSON.stringify({ baseURL: config.baseURL, key: value }) : value)
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect((await connections.request({ kind: 'details' })).keyHints?.[provider]?.suffix).toBe('abcd')
  expect((await connections.request({ kind: 'removeKey', provider })).ok).toBe(true)
  expect((await connections.request({ kind: 'details' })).keyHints?.[provider]).toBeUndefined()
  expect(provider === 'compatible' ? connections.snapshot().compatibleKeyPresent : connections.snapshot().providers[provider]).toBe(false)
  expect(mocks.secrets.has(`${provider}-key`)).toBe(false)
})
