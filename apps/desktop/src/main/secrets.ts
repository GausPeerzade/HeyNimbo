import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

// The key is encrypted with safeStorage, whose master key lives in the macOS
// Keychain (DPAPI on Windows). Only ciphertext touches the disk, readable by
// this user alone.
const keyFile = (): string => join(app.getPath('userData'), 'openai-key.bin')

export async function loadOpenAIKey(): Promise<string | undefined> {
  try {
    return safeStorage.decryptString(await readFile(keyFile()))
  } catch {
    return undefined
  }
}

export async function saveOpenAIKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system.')
  const temp = `${keyFile()}.tmp`
  await writeFile(temp, safeStorage.encryptString(key), { mode: 0o600 })
  await rename(temp, keyFile())
}

/** Checks a key against the API before saving it. */
export async function validateOpenAIKey(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return { ok: true }
    if (response.status === 401) return { ok: false, reason: 'OpenAI rejected this key.' }
    return { ok: false, reason: `OpenAI answered ${response.status}; try again in a moment.` }
  } catch {
    return { ok: false, reason: 'Could not reach OpenAI. Check your connection.' }
  }
}
