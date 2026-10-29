import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadSecret, removeSecret, saveSecret, secretSavedAt } from './secrets'
const mocks = vi.hoisted(() => ({ dir: '', available: true, encrypt: vi.fn((text: string) => Buffer.from(`encrypted:${Buffer.from(text).toString('base64')}`)), decrypt: vi.fn((bytes: Buffer) => { if (!bytes.toString().startsWith('encrypted:')) throw new Error('Not encrypted'); return Buffer.from(bytes.toString().slice(10), 'base64').toString() }) }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.dir }, safeStorage: { isEncryptionAvailable: () => mocks.available, encryptString: mocks.encrypt, decryptString: mocks.decrypt } }))
beforeEach(async () => { mocks.dir = await mkdtemp(join(tmpdir(), 'heynimbo-provider-secrets-test-')); mocks.available = true; vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden') })) })
afterEach(async () => { await rm(mocks.dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.clearAllMocks() })
it('stores separate owner-only safeStorage ciphertext per provider, and removes only the selected key', async () => {
  await saveSecret('openai-key', 'synthetic-openai'); await saveSecret('anthropic-key', 'synthetic-anthropic'); await saveSecret('compatible-key', 'synthetic-local')
  expect(mocks.encrypt).toHaveBeenCalledTimes(3)
  expect(await loadSecret('openai-key')).toBe('synthetic-openai'); expect(await loadSecret('anthropic-key')).toBe('synthetic-anthropic')
  expect((await readFile(join(mocks.dir, 'openai-key.bin'))).toString()).not.toContain('synthetic-openai')
  expect((await stat(join(mocks.dir, 'anthropic-key.bin'))).mode & 0o777).toBe(0o600)
  await removeSecret('anthropic-key'); expect(await loadSecret('anthropic-key')).toBeUndefined()
  expect(await loadSecret('openai-key')).toBe('synthetic-openai'); expect(await loadSecret('compatible-key')).toBe('synthetic-local')
})
it('loads encrypted credentials without rewriting their saved bytes', async () => {
  const ciphertext = mocks.encrypt('synthetic-key')
  await writeFile(join(mocks.dir, 'openai-key.bin'), ciphertext, { mode: 0o600 })
  expect(await loadSecret('openai-key')).toBe('synthetic-key')
  expect(await readFile(join(mocks.dir, 'openai-key.bin'))).toEqual(ciphertext)
})
it('stores OAuth tokens only in the encrypted record and refuses unavailable secure storage', async () => {
  await saveSecret('chatgpt-auth', JSON.stringify({ access: 'synthetic-access', refresh: 'synthetic-refresh' }))
  expect((await readFile(join(mocks.dir, 'chatgpt-auth.bin'))).toString()).not.toContain('synthetic-access')
  mocks.available = false
  await expect(saveSecret('google-key', 'synthetic-google')).rejects.toThrow('Secure storage')
  expect(await loadSecret('google-key')).toBeUndefined()
})

it('uses the encrypted file saved time without decrypting or changing credentials', async () => {
  await saveSecret('openai-key', 'private-value-abcd')
  await utimes(join(mocks.dir, 'openai-key.bin'), new Date('2020-01-02T00:00:00Z'), new Date('2020-01-02T00:00:00Z'))
  mocks.decrypt.mockClear()
  const date = await secretSavedAt('openai-key')
  expect(date).toBe((await stat(join(mocks.dir, 'openai-key.bin'))).mtimeMs)
  expect(mocks.decrypt).not.toHaveBeenCalled()
  await removeSecret('openai-key')
  expect(await secretSavedAt('openai-key')).toBeUndefined()
})
