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
  it('preserves all 2D beats, builds the pump in stages, offers Clear and quits within forty seconds', async () => {
    const overlays = { clear: vi.fn(), drawBeat: vi.fn(), answerDone: vi.fn() }
    expect(scheduleDrawDemo(overlays as unknown as OverlayManager)).toBe(true)
    await vi.advanceTimersByTimeAsync(3001)
    expect(overlays.clear).toHaveBeenCalledOnce()
    expect(overlays.drawBeat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9838)
    expect(overlays.drawBeat).toHaveBeenCalledTimes(11)
    expect(overlays.drawBeat.mock.calls.flatMap(([marks]) => marks.map((mark: { kind: string }) => mark.kind))).toEqual([
      'card', 'heading', 'arc', 'curve', 'card', 'heading', 'step', 'label', 'step', 'label', 'step', 'step', 'note', 'point',
    ])
    await vi.advanceTimersByTimeAsync(18501)
    expect(overlays.clear).toHaveBeenCalledTimes(2)
    expect(overlays.drawBeat).toHaveBeenCalledTimes(19)
    const pumpMarks = overlays.drawBeat.mock.calls.slice(11).flatMap(([marks]) => marks)
    expect(pumpMarks.filter((mark) => mark.kind === 'part')).toHaveLength(18)
    expect(pumpMarks.find((mark) => mark.kind === 'cut')).toMatchObject({ axis: 'z' })
    expect(pumpMarks.find((mark) => mark.kind === 'move')).toMatchObject({ part: 'rod', motion: 'slide' })
    expect(overlays.answerDone).toHaveBeenCalledWith(4500)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6499)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('caps total process uptime at forty seconds even if app readiness or quit stalls', async () => {
    limitDrawDemoRuntime()
    await vi.advanceTimersByTimeAsync(37999)
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
