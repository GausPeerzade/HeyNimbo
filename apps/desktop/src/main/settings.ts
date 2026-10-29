import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppSettings } from '../shared/app'

export const DEFAULT_SETTINGS: AppSettings = {
  openAtLogin: false, showMenuBar: true, showNotch: true, voice: 'marin', muted: false, saveHistory: true, retention: 30,
}

/** Invalid known values reject the file; unknown keys never enter app state. */
export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SETTINGS }
  const input = value as Record<string, unknown>
  const result = { ...DEFAULT_SETTINGS }
  for (const key of ['openAtLogin', 'showMenuBar', 'showNotch', 'muted', 'saveHistory'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') return { ...DEFAULT_SETTINGS }
      result[key] = input[key]
    }
  }
  if (input.voice !== undefined) {
    if (!['marin', 'cedar', 'alloy', 'coral'].includes(String(input.voice))) return { ...DEFAULT_SETTINGS }
    result.voice = input.voice as AppSettings['voice']
  }
  if (input.retention !== undefined) {
    if (![0, 7, 30, 90, 'forever'].includes(input.retention as number)) return { ...DEFAULT_SETTINGS }
    result.retention = input.retention as AppSettings['retention']
  }
  if (input.homeBounds !== undefined) {
    const b = input.homeBounds as Record<string, unknown> | null
    if (!b || !['x', 'y', 'width', 'height'].every(key => typeof b[key] === 'number' && Number.isFinite(b[key])) || Number(b.width) < 720 || Number(b.height) < 520) return { ...DEFAULT_SETTINGS }
    result.homeBounds = { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) }
  }
  return result
}

export class SettingsStore {
  private value: AppSettings
  constructor(private readonly path: string) {
    try { this.value = validateSettings(JSON.parse(readFileSync(path, 'utf8'))) }
    catch { this.value = { ...DEFAULT_SETTINGS } }
  }
  get(): AppSettings { return structuredClone(this.value) }
  set(value: unknown): AppSettings {
    const next = validateSettings(value)
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
