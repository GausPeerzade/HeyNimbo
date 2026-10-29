import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { KeyProvider } from '../shared/providers'

export type SecretName = `${KeyProvider}-key` | 'chatgpt-auth'
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
