import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Connections } from './connections'
import { SettingsStore } from './settings'
import { defaultConnectionSettings } from '../shared/providers'
const mocks = vi.hoisted(() => ({ secrets: new Map<string, string>(), browser: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: mocks.browser } }))
vi.mock('./secrets', () => ({ loadSecret: async (name: string) => mocks.secrets.get(name), saveSecret: async (name: string, value: string) => { mocks.secrets.set(name, value) }, removeSecret: async (name: string) => { mocks.secrets.delete(name) } }))
let directory = '', settings: SettingsStore
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'nimbo-connections-test-')); settings = new SettingsStore(join(directory, 'settings.json')); mocks.secrets.clear(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden') })) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.clearAllMocks() })
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

it.each(['chatgpt', 'anthropic'] as const)('adding a voice key never changes a disconnected %s answer billing path', async provider => {
  const config = defaultConnectionSettings(); config.provider = provider
  settings.set({ ...settings.get(), connection: config })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'gpt-6.1-terra' }] })))
  const connections = new Connections(settings, vi.fn()); await connections.load()
  expect(connections.answerReady).toBe(false)
  expect((await connections.request({ kind: 'saveKey', provider: 'openai', key: 'synthetic-voice' })).ok).toBe(true)
  expect(connections.voiceKey).toBe('synthetic-voice')
  expect(connections.config.provider).toBe(provider)
  expect(connections.answerReady).toBe(false)
})
