import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import type { KeyProvider } from '../shared/providers'

export type SecretName = `${KeyProvider}-key` | 'chatgpt-auth'
interface Entry { value: string; savedAt: number }
interface Store { version: 1; secrets: Partial<Record<SecretName, Entry>> }

/** Keys live in one owner-only (0600) file in the app's own 0700 data folder, the same way
 *  Hermes (~/.hermes/auth.json) and OpenCode store them. The macOS Keychain is not used, so
 *  saving or using a key never asks for the login password. */
const FILE = 'credentials.json'
const dir = (): string => app.getPath('userData')
const path = (): string => join(dir(), FILE)
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
export async function loadSecret(name: SecretName): Promise<string | undefined> {
  await queue
  return (await read()).store.secrets[name]?.value
}
export async function secretSavedAt(name: SecretName): Promise<number | undefined> {
  return (await read()).store.secrets[name]?.savedAt
}
export async function saveSecret(name: SecretName, value: string): Promise<void> {
  await update(store => { store.secrets[name] = { value, savedAt: Date.now() } })
}
export async function removeSecret(name: SecretName): Promise<void> {
  await update(store => { delete store.secrets[name] })
}
