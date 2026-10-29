import { app, screen } from 'electron'
import type { Mark } from '../shared/beats'
import { devFlag } from './dev'
import type { OverlayManager } from './windows'

/** A last-resort process deadline, installed before waiting for app readiness. */
export function limitDrawDemoRuntime(): void {
  if (!devFlag('NIMBO_DEBUG_DRAW_DEMO')) return
  setTimeout(() => app.exit(0), Math.max(0, 20_000 - process.uptime() * 1000))
}

/** Eight seconds of silent beats; main must return before creating audio or
 *  starting gestures, credentials, microphone capture or OpenAI connections. */
export function scheduleDrawDemo(overlays: OverlayManager): boolean {
  if (!devFlag('NIMBO_DEBUG_DRAW_DEMO')) return false
  setTimeout(() => {
    const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const space = { frame: bounds, pixelWidth: bounds.width, pixelHeight: bounds.height }
    const x = bounds.width * 0.25
    const y = bounds.height * 0.35
    const beats: Array<{ durationMs: number; marks: Mark[] }> = [
      { durationMs: 1200, marks: [{ kind: 'circle', x, y, r: 65 }] },
      { durationMs: 1300, marks: [{ kind: 'arrow', x1: x + 90, y1: y, x2: x + 300, y2: y + 55 }] },
      { durationMs: 1200, marks: [{ kind: 'box', x: x + 320, y: y - 55, w: 145, h: 110 }] },
      { durationMs: 800, marks: [{ kind: 'highlight', x: x - 60, y: y + 130, w: 210, h: 26 }] },
      { durationMs: 800, marks: [{ kind: 'line', x1: x - 60, y1: y + 190, x2: x + 150, y2: y + 190 }] },
      { durationMs: 900, marks: [{ kind: 'text', x: x + 200, y: y + 180, text: 'Follow the pen' }] },
      { durationMs: 900, marks: [{ kind: 'point', x: x + 400, y: y + 170, label: 'Start here' }] },
      { durationMs: 900, marks: [{ kind: 'point', x: bounds.width - 24, y: y + 230, label: 'Then here' }] },
    ]
    overlays.clear()
    console.info('[draw-demo] start')
    let delay = 0
    for (const beat of beats) {
      setTimeout(() => overlays.drawBeat(beat.marks, beat.durationMs, space), delay)
      delay += beat.durationMs
    }
    setTimeout(() => {
      console.info('[draw-demo] complete')
      overlays.fadeSoon(0)
      setTimeout(() => app.quit(), 3000)
    }, delay)
  }, 3000)
  return true
}
