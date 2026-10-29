import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayManager } from './windows'

const app = vi.hoisted(() => ({ isPackaged: false, quit: vi.fn(), exit: vi.fn() }))
vi.mock('electron', () => ({
  app,
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ bounds: { x: -1440, y: 0, width: 1440, height: 900 } }),
  },
}))

import { limitDrawDemoRuntime, scheduleDrawDemo } from './draw-demo'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubEnv('NIMBO_DEBUG_DRAW_DEMO', '1')
  vi.spyOn(process, 'uptime').mockReturnValue(2)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  app.isPackaged = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('drawing demo safety', () => {
  it('plays eight bounded beats, fades immediately, then quits three seconds later', async () => {
    const overlays = { clear: vi.fn(), drawBeat: vi.fn(), fadeSoon: vi.fn() }
    expect(scheduleDrawDemo(overlays as unknown as OverlayManager)).toBe(true)
    await vi.advanceTimersByTimeAsync(3001)
    expect(overlays.clear).toHaveBeenCalledOnce()
    expect(overlays.drawBeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(7999)
    expect(overlays.drawBeat).toHaveBeenCalledTimes(8)
    expect(overlays.drawBeat.mock.calls.flatMap(([marks]) => marks.map((mark: { kind: string }) => mark.kind))).toEqual([
      'circle', 'arrow', 'box', 'highlight', 'line', 'text', 'point', 'point',
    ])
    expect(overlays.fadeSoon).toHaveBeenCalledWith(0)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2999)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('caps total process uptime at twenty seconds even if app readiness or quit stalls', async () => {
    limitDrawDemoRuntime()
    await vi.advanceTimersByTimeAsync(17999)
    expect(app.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('cannot start or install a shutdown timer in a packaged app', () => {
    app.isPackaged = true
    expect(scheduleDrawDemo({} as OverlayManager)).toBe(false)
    limitDrawDemoRuntime()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing unless the dev switch is explicitly enabled', () => {
    vi.stubEnv('NIMBO_DEBUG_DRAW_DEMO', '0')
    expect(scheduleDrawDemo({} as OverlayManager)).toBe(false)
    limitDrawDemoRuntime()
    expect(vi.getTimerCount()).toBe(0)
  })
})
