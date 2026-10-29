import { expect, it } from 'vitest'
import { clampHomeBounds, shouldShowDock } from './lifecycle'
it('keeps Dock identity while either conventional window is open, including minimized Home', () => {
  expect(shouldShowDock(true, false)).toBe(true)
  expect(shouldShowDock(false, true)).toBe(true)
  expect(shouldShowDock(true, true)).toBe(true)
  expect(shouldShowDock(false, false)).toBe(false)
})
it('restores disconnected-display bounds into a valid work area and constrains oversized windows', () => {
  const area = { x: -1000, y: 24, width: 1000, height: 720 }
  expect(clampHomeBounds({ x: 5000, y: 100, width: 1200, height: 800 }, [area])).toEqual({ x: -1000, y: 24, width: 1000, height: 720 })
})
