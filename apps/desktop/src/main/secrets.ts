import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { KeyProvider } from '../shared/providers'

export type SecretName = `${KeyProvider}-key` | 'chatgpt-auth' | 'brave-search-key'
interface Entry { value: string; savedAt: number }
interface Store { version: 1; secrets: Partial<Record<SecretName, Entry>> }

/** Keys live in one owner-only (0600) file in the app's own 0700 data folder, like Pi
 *  (~/.pi/agent/auth.json), OpenCode (auth.json), Codex's default file store and Hermes
 *  (~/.hermes/.env). The macOS Keychain is not used: an unsigned or ad-hoc-signed app
 *  changes identity on every build, so Keychain access asked for the login password on
 *  every launch. Only processes running as this user can read the file. */
const FILE = 'credentials.json'
const LEGACY = /^(.+)\.bin$/
const dir = (): string => app.getPath('userData')
const path = (): string => join(dir(), FILE)
const legacyFile = (name: SecretName): string => join(dir(), `${name}.bin`)
/** Legacy Keychain migration per data folder: running/done, or denied. */
const migrations = new Map<string, Promise<void> | 'denied'>()
let queue: Promise<unknown> = Promise.resolve()

async function read(): Promise<{ store: Store; unreadable: boolean }> {
  let text: string
  try { text = await readFile(path(), 'utf8') } catch { return { store: { version: 1, secrets: {} }, unreadable: false } }
  try {
    const value = JSON.parse(text) as Store
    if (value?.version !== 1 || !value.secrets || typeof value.secrets !== 'object' || Array.isArray(value.secrets)) throw new Error('Invalid credentials file.')
    return { store: value, unreadable: false }
  } catch { return { store: { version: 1, secrets: {} }, unreadable: true } }
}
/** Writes are serialized and atomic, so concurrent saves never lose a key or leave a partial file. */
function update(change: (store: Store) => void): Promise<void> {
  const next = queue.then(async () => {
    const { store, unreadable } = await read()
    // Never overwrite a file we could not read: keep it for the owner to inspect.
    if (unreadable) await rename(path(), `${path()}.unreadable`)
    change(store)
    await mkdir(dir(), { recursive: true, mode: 0o700 })
    const temp = `${path()}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path())
    } finally { await rm(temp, { force: true }) }
  })
  queue = next.catch(() => {})
  return next
}
/** Moves keys an older build encrypted with the Keychain into the file, once. The first
 *  denied or failed Keychain read ends migration for good: that file and any not yet read are
 *  renamed to `.bin.unmigrated` (kept, never asked about again), and those keys are re-entered. */
function migrate(): Promise<void> {
  const key = dir(), state = migrations.get(key)
  if (state === 'denied') return Promise.resolve()
  if (state) return state
  const run = (async () => {
    let names: string[]
    try { names = (await readdir(key)).filter(name => LEGACY.test(name)).sort() } catch { return }
    const found: Array<{ name: SecretName; value: string; savedAt: number }> = []
    for (const [index, file] of names.entries()) {
      const name = LEGACY.exec(file)![1] as SecretName
      try {
        const bytes = await readFile(join(key, file))
        found.push({ name, value: safeStorage.decryptString(bytes), savedAt: (await stat(join(key, file))).mtimeMs })
      } catch {
        migrations.set(key, 'denied')
        for (const rest of names.slice(index)) await rename(join(key, rest), join(key, `${rest}.unmigrated`)).catch(() => {})
        break
      }
    }
    if (found.length) await update(store => { for (const { name, value, savedAt } of found) store.secrets[name] ??= { value, savedAt } })
    for (const { name } of found) await rm(join(key, `${name}.bin`), { force: true })
  })()
  migrations.set(key, run)
  return run.catch(() => {})
}

export async function loadSecret(name: SecretName): Promise<string | undefined> {
  await migrate()
  await queue
  return (await read()).store.secrets[name]?.value
}
/** When the key was saved, without opening the Keychain. */
export async function secretSavedAt(name: SecretName): Promise<number | undefined> {
  const saved = (await read()).store.secrets[name]?.savedAt
  if (saved !== undefined) return saved
  try { return (await stat(legacyFile(name))).mtimeMs } catch { return undefined }
}
export async function saveSecret(name: SecretName, value: string): Promise<void> {
  await update(store => { store.secrets[name] = { value, savedAt: Date.now() } })
  await rm(legacyFile(name), { force: true })
}
export async function removeSecret(name: SecretName): Promise<void> {
  await update(store => { delete store.secrets[name] })
  await rm(legacyFile(name), { force: true })
}
