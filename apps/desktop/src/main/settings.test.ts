import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore, validateSettings } from './settings'

it('rejects malformed known values, drops unknown keys and fills missing defaults', () => {
  expect(validateSettings({ saveHistory: 'false', voice: 'cedar' })).toEqual(DEFAULT_SETTINGS)
  expect(validateSettings({ showNotch: false, key: 'secret' })).toEqual({ ...DEFAULT_SETTINGS, showNotch: false })
  expect(validateSettings({ retention: 6 })).toEqual(DEFAULT_SETTINGS)
  expect(validateSettings({ homeBounds: { x: 0, y: 0, width: 1, height: 3 } })).toEqual(DEFAULT_SETTINGS)
})
it('falls back on bad JSON and atomically replaces a private file with no temporary residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nimbo-settings-test-')), path = join(dir, 'settings.json')
  try {
    writeFileSync(path, '{broken')
    const store = new SettingsStore(path)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    store.set({ ...DEFAULT_SETTINGS, voice: 'cedar', retention: 7 })
    expect(new SettingsStore(path).get()).toEqual({ ...DEFAULT_SETTINGS, voice: 'cedar', retention: 7 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['settings.json'])
    expect(JSON.parse(readFileSync(path, 'utf8')).voice).toBe('cedar')
    const copy = store.get(); copy.voice = 'coral'
    expect(store.get().voice).toBe('cedar')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('does not publish new settings or leave a partial file after a failed atomic replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nimbo-settings-fail-'))
  try {
    const store = new SettingsStore(dir)
    expect(() => store.set({ ...DEFAULT_SETTINGS, voice: 'coral' })).toThrow()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(readdirSync(dir)).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.tmp`, { force: true }) }
})
