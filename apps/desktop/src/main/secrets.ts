import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { KeyProvider } from '../shared/providers'
import { noRedirectFetch } from './provider-settings'

export type SecretName = `${KeyProvider}-key` | 'chatgpt-auth'
/** Legacy openai-key.bin stays in place; no plaintext migration or renewed key entry. */
const secretFile = (name: SecretName): string => join(app.getPath('userData'), `${name}.bin`)
export async function loadSecret(name: SecretName): Promise<string | undefined> {
  try { return safeStorage.decryptString(await readFile(secretFile(name))) } catch { return undefined }
}
export async function secretSavedAt(name: SecretName): Promise<number | undefined> {
  try { return (await stat(secretFile(name))).mtimeMs } catch { return undefined }
}
export async function saveSecret(name: SecretName, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure storage is not available on this system.')
  const temp = `${secretFile(name)}.tmp`
  try {
    await writeFile(temp, safeStorage.encryptString(value), { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, secretFile(name))
  } finally { await rm(temp, { force: true }) }
}
export async function removeSecret(name: SecretName): Promise<void> { await rm(secretFile(name), { force: true }) }
export const loadOpenAIKey = (): Promise<string | undefined> => loadSecret('openai-key')
export const saveOpenAIKey = (key: string): Promise<void> => saveSecret('openai-key', key)
export async function validateOpenAIKey(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await noRedirectFetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
    if (response.ok) return { ok: true }
    return { ok: false, reason: response.status === 401 ? 'OpenAI rejected this key.' : `OpenAI answered ${response.status}; try again in a moment.` }
  } catch { return { ok: false, reason: 'Could not reach OpenAI. Check your connection.' } }
}
