import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultConnectionSettings } from '../shared/providers'
import { parseConnectionSettings } from './provider-settings'
import type { AppSettings } from '../shared/app'

export const DEFAULT_SETTINGS: AppSettings = {
  openAtLogin: false, showMenuBar: true, showNotch: true, voice: 'marin', muted: false, saveHistory: true, retention: 30, connection: defaultConnectionSettings(),
}

/** File loads may omit fields; live updates must contain a complete valid value. */
export function parseSettings(value: unknown, complete = false): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings.')
  const input = value as Record<string, unknown>
  const result = { ...DEFAULT_SETTINGS, connection: defaultConnectionSettings() }
  if (complete && Object.keys(input).some(key => !['openAtLogin', 'showMenuBar', 'showNotch', 'muted', 'saveHistory', 'voice', 'retention', 'homeBounds', 'connection'].includes(key))) throw new Error('Unknown setting.')
  for (const key of ['openAtLogin', 'showMenuBar', 'showNotch', 'muted', 'saveHistory'] as const) {
    if (complete || input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error(`Invalid setting: ${key}.`)
      result[key] = input[key]
    }
  }
  if (complete || input.voice !== undefined) {
    if (typeof input.voice !== 'string' || !['marin', 'cedar', 'alloy', 'coral'].includes(input.voice)) throw new Error('Invalid speaking voice.')
    result.voice = input.voice as AppSettings['voice']
  }
  if (complete || input.retention !== undefined) {
    if (![0, 7, 30, 90, 'forever'].includes(input.retention as number)) throw new Error('Invalid history retention.')
    result.retention = input.retention as AppSettings['retention']
  }
  if (input.connection !== undefined) result.connection = parseConnectionSettings(input.connection)
  if (input.homeBounds !== undefined) {
    const b = input.homeBounds as Record<string, unknown> | null
    if (!b || typeof b !== 'object' || Array.isArray(b) || (complete && Object.keys(b).some(key => !['x', 'y', 'width', 'height'].includes(key))) || !['x', 'y', 'width', 'height'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key])) || Number(b.width) < 720 || Number(b.height) < 520) throw new Error('Invalid Home bounds.')
    result.homeBounds = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) }
  }
  return result
}

export class SettingsStore {
  private value: AppSettings
  constructor(private readonly path: string) {
    try { this.value = parseSettings(JSON.parse(readFileSync(path, 'utf8'))) }
    catch { this.value = { ...DEFAULT_SETTINGS, connection: defaultConnectionSettings() } }
  }
  get(): AppSettings { return structuredClone(this.value) }
  set(value: unknown): AppSettings {
    const next = parseSettings(value, true)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.tmp`
    try {
      const fd = openSync(temp, 'w', 0o600)
      try { chmodSync(temp, 0o600); writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd) }
      finally { closeSync(fd) }
      renameSync(temp, this.path)
      this.value = next
    } finally { rmSync(temp, { force: true }) }
    return this.get()
  }
}
