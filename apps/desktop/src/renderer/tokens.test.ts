import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { WINDOW_PALETTE } from '../shared/ui-palette'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const blocks = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(match => Object.fromEntries([...match[1]!.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(value => [value[1]!, value[2]!])))
function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722
}
function contrast(a: string, b: string): number { const values = [luminance(a), luminance(b)].sort((x,y) => y-x); return (values[0]! + .05) / (values[1]! + .05) }
for (const [index, mode] of ['light', 'dark'].entries()) it(`${mode} Pen margin tokens preserve AA text, UI boundaries and native first paint`, () => {
  const tokens = { ...blocks[0], ...blocks[index] }
  for (const background of ['canvas', 'raised', 'sidebar', 'selection']) {
    for (const role of ['text', 'secondary', 'accent', 'success', 'warning', 'error']) expect(contrast(tokens[role]!, tokens[background]!), `${role}/${background}`).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tokens.boundary!, tokens[background]!), `boundary/${background}`).toBeGreaterThanOrEqual(3)
  }
  expect(contrast(tokens['on-accent']!, tokens.accent!)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(tokens['drawing-ink']!, tokens['drawing-paper']!)).toBeGreaterThanOrEqual(4.5)
  expect(tokens.canvas).toBe(WINDOW_PALETTE[mode as keyof typeof WINDOW_PALETTE])
})
it('keeps the live pen buddy paired with the light brand mark', () => {
  const overlay = readFileSync(new URL('./overlay.css', import.meta.url), 'utf8')
  const buddy = overlay.match(/--buddy:\s*(#[\da-f]{6})/i)?.[1]
  expect(buddy?.toLowerCase()).toBe(blocks[0]!.accent!.toLowerCase())
})
