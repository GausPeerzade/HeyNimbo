import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { loadSecret, removeSecret, saveSecret, secretSavedAt } from './secrets'
// safeStorage is the old Keychain-backed store. It may be used only to migrate files an
// older build left behind; any other use would bring back the Keychain password prompt.
const mocks = vi.hoisted(() => ({ dir: '', decrypt: vi.fn((bytes: Buffer) => { if (!bytes.toString().startsWith('encrypted:')) throw new Error('Keychain access denied'); return Buffer.from(bytes.toString().slice(10), 'base64').toString() }), keychain: vi.fn(() => { throw new Error('Keychain must not be used') }) }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.dir }, safeStorage: { decryptString: mocks.decrypt, encryptString: mocks.keychain, isEncryptionAvailable: mocks.keychain, getSelectedStorageBackend: mocks.keychain } }))
const legacy = (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`)
const file = () => join(mocks.dir, 'credentials.json')
beforeEach(async () => { mocks.dir = await mkdtemp(join(tmpdir(), 'heynimbo-provider-secrets-test-')); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden') })) })
afterEach(async () => { await rm(mocks.dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

it('keeps every key in one owner-only file without touching the Keychain, and removes only the selected key', async () => {
  await saveSecret('openai-key', 'synthetic-openai'); await saveSecret('anthropic-key', 'synthetic-anthropic'); await saveSecret('compatible-key', 'synthetic-local')
  expect(await loadSecret('openai-key')).toBe('synthetic-openai'); expect(await loadSecret('anthropic-key')).toBe('synthetic-anthropic')
  expect((await stat(file())).mode & 0o777).toBe(0o600)
  await removeSecret('anthropic-key'); expect(await loadSecret('anthropic-key')).toBeUndefined()
  expect(await loadSecret('openai-key')).toBe('synthetic-openai'); expect(await loadSecret('compatible-key')).toBe('synthetic-local')
  expect(await loadSecret('google-key')).toBeUndefined()
  expect(mocks.keychain).not.toHaveBeenCalled(); expect(mocks.decrypt).not.toHaveBeenCalled()
})
it('does not lose a key when several are saved at once', async () => {
  const names = ['openai-key', 'anthropic-key', 'google-key', 'deepseek-key', 'openrouter-key', 'brave-search-key'] as const
  await Promise.all(names.map(name => saveSecret(name, `synthetic-${name}`)))
  for (const name of names) expect(await loadSecret(name)).toBe(`synthetic-${name}`)
})
it('tightens a loosened file back to owner-only on the next save and leaves no temporary copy', async () => {
  await saveSecret('openai-key', 'synthetic-openai')
  await chmod(file(), 0o644)
  await saveSecret('anthropic-key', 'synthetic-anthropic')
  expect((await stat(file())).mode & 0o777).toBe(0o600)
  expect((await import('node:fs')).readdirSync(mocks.dir).filter(name => name.includes('.tmp'))).toEqual([])
})
it('moves an unreadable credentials file aside instead of overwriting it, and keeps working', async () => {
  await writeFile(file(), '{ not json', { mode: 0o600 })
  expect(await loadSecret('openai-key')).toBeUndefined()
  await saveSecret('openai-key', 'synthetic-openai')
  expect(await loadSecret('openai-key')).toBe('synthetic-openai')
  expect(await readFile(`${file()}.unreadable`, 'utf8')).toBe('{ not json')
})
it('migrates every key an older build saved in one Keychain read, keeps saved times, and deletes the old files', async () => {
  for (const [name, value] of [['openai-key', 'synthetic-legacy-openai'], ['anthropic-key', 'synthetic-legacy-anthropic']] as const) {
    await writeFile(join(mocks.dir, `${name}.bin`), legacy(value), { mode: 0o600 })
    await utimes(join(mocks.dir, `${name}.bin`), new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))
  }
  // Reading only the saved time must not open the Keychain.
  expect(await secretSavedAt('openai-key')).toBe(Date.parse('2026-01-02T00:00:00Z'))
  expect(mocks.decrypt).not.toHaveBeenCalled()
  expect(await loadSecret('openai-key')).toBe('synthetic-legacy-openai')
  expect(mocks.decrypt).toHaveBeenCalledTimes(2)
  expect(existsSync(join(mocks.dir, 'openai-key.bin'))).toBe(false); expect(existsSync(join(mocks.dir, 'anthropic-key.bin'))).toBe(false)
  expect(await loadSecret('anthropic-key')).toBe('synthetic-legacy-anthropic')
  expect(await secretSavedAt('anthropic-key')).toBe(Date.parse('2026-01-02T00:00:00Z'))
  expect(mocks.decrypt).toHaveBeenCalledTimes(2)
})
it('asks the Keychain once: a denial is remembered across launches, old files are kept aside, and a new key still saves', async () => {
  await writeFile(join(mocks.dir, 'anthropic-key.bin'), legacy('synthetic-legacy-anthropic'), { mode: 0o600 })
  await writeFile(join(mocks.dir, 'chatgpt-auth.bin'), 'unreadable-ciphertext', { mode: 0o600 })
  await writeFile(join(mocks.dir, 'openai-key.bin'), 'also-unreadable', { mode: 0o600 })
  expect(await loadSecret('chatgpt-auth')).toBeUndefined()
  expect(await loadSecret('openai-key')).toBeUndefined()
  // Keys read before the denial are migrated; the denied and remaining ones are set aside, not deleted.
  expect(await loadSecret('anthropic-key')).toBe('synthetic-legacy-anthropic')
  expect(mocks.decrypt).toHaveBeenCalledTimes(2)
  expect((await import('node:fs')).readdirSync(mocks.dir).filter(name => name.includes('.bin')).sort()).toEqual(['chatgpt-auth.bin.unmigrated', 'openai-key.bin.unmigrated'])
  expect(await secretSavedAt('openai-key')).toBeUndefined()
  // The next launch does not ask again.
  vi.resetModules()
  const relaunched = await import('./secrets')
  expect(await relaunched.loadSecret('openai-key')).toBeUndefined()
  expect(mocks.decrypt).toHaveBeenCalledTimes(2)
  await relaunched.saveSecret('chatgpt-auth', JSON.stringify({ access: 'synthetic-access' }))
  expect(JSON.parse((await relaunched.loadSecret('chatgpt-auth'))!)).toEqual({ access: 'synthetic-access' })
  expect(mocks.decrypt).toHaveBeenCalledTimes(2)
})
it("removing a key also removes an older build's copy so it cannot come back", async () => {
  await writeFile(join(mocks.dir, 'google-key.bin'), legacy('synthetic-google'), { mode: 0o600 })
  await removeSecret('google-key')
  expect(existsSync(join(mocks.dir, 'google-key.bin'))).toBe(false)
  expect(await loadSecret('google-key')).toBeUndefined()
})
it('records when each key was saved', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  await saveSecret('openai-key', 'synthetic-openai')
  expect(await secretSavedAt('openai-key')).toBe(1_800_000_000_000)
  expect(await secretSavedAt('anthropic-key')).toBeUndefined()
})
