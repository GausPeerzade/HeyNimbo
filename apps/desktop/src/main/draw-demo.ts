import { app, screen } from 'electron'
import type { Mark } from '../shared/beats'
import { devFlag } from './dev'
import type { OverlayManager } from './windows'
import { pumpDemo } from './pump-demo'
import { isolateDevProfile, launchInBackground } from './dev-profile'

let cleanupProfile: (() => void) | undefined

export function configureDrawDemo(): void {
  if (!devFlag('NIMBO_DEBUG_DRAW_DEMO')) return
  launchInBackground()
  cleanupProfile = isolateDevProfile('draw-demo')
}

/** A last-resort process deadline, installed before waiting for app readiness. */
export function limitDrawDemoRuntime(): void {
  if (!devFlag('NIMBO_DEBUG_DRAW_DEMO')) return
  setTimeout(() => { cleanupProfile?.(); app.exit(0) }, Math.max(0, 40_000 - process.uptime() * 1000))
}

/** Silent teaching beats; main returns before starting audio, gestures,
 *  credentials, microphone capture or OpenAI connections. */
export function scheduleDrawDemo(overlays: OverlayManager): boolean {
  if (!devFlag('NIMBO_DEBUG_DRAW_DEMO')) return false
  setTimeout(() => {
    const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const space = { frame: bounds, pixelWidth: bounds.width, pixelHeight: bounds.height }
    const x = Math.round(bounds.width * 0.06)
    const y = Math.round(bounds.height * 0.12)
    const w = Math.round(bounds.width * 0.41)
    const right = Math.round(bounds.width * 0.55)
    const cloudX = x + w * 0.59
    const cloudY = y + 195
    const sunX = x + 78
    const sunY = y + 153
    const beats: Array<{ durationMs: number; marks: Mark[] }> = [
      { durationMs: 1800, marks: [
        { kind: 'card', id: 'sky', x, y, w, h: 370, title: 'A drop’s round trip', board: 'plain' },
        { kind: 'heading', id: 'sky', text: 'From sea to sky' },
      ] },
      { durationMs: 2700, marks: [
        { kind: 'arc', x: sunX, y: sunY, r: 28, start: -90, sweep: 360 },
        { kind: 'curve', points: [[cloudX - 82, cloudY + 20], [cloudX - 100, cloudY - 1], [cloudX - 83, cloudY - 22], [cloudX - 57, cloudY - 21], [cloudX - 43, cloudY - 50], [cloudX - 13, cloudY - 48], [cloudX + 10, cloudY - 28], [cloudX + 42, cloudY - 30], [cloudX + 67, cloudY - 10], [cloudX + 66, cloudY + 16], [cloudX + 42, cloudY + 23], [cloudX - 82, cloudY + 20]] },
      ] },
      { durationMs: 2000, marks: [
        { kind: 'card', id: 'cycle', x: right, y: y + 30, w: Math.round(bounds.width * 0.37), h: 180, title: 'The water cycle', board: 'grid' },
        { kind: 'heading', id: 'cycle', text: 'One continuous journey' },
      ] },
      { durationMs: 2600, marks: [{ kind: 'step', id: 'cycle', text: 'Evaporation', direction: 'up', color: 'orange' }] },
      { durationMs: 2200, marks: [{ kind: 'label', x: sunX + 20, y: sunY + 15, lx: x + 22, ly: y + 285, text: 'Warmth lifts water' }] },
      { durationMs: 2600, marks: [{ kind: 'step', id: 'cycle', text: 'Condensation', direction: 'right', color: 'purple' }] },
      { durationMs: 2200, marks: [{ kind: 'label', x: cloudX + 20, y: cloudY, lx: cloudX - 32, ly: y + 320, text: 'Tiny drops gather' }] },
      { durationMs: 2600, marks: [{ kind: 'step', id: 'cycle', text: 'Precipitation', direction: 'down', color: 'blue' }] },
      { durationMs: 2600, marks: [{ kind: 'step', id: 'cycle', text: 'Collection', direction: 'left', color: 'green' }] },
      { durationMs: 1700, marks: [{ kind: 'note', id: 'cycle', text: 'Then the journey begins again.' }] },
      { durationMs: 1600, marks: [{ kind: 'point', x: x + w / 2, y: y + 410, label: 'Powered by the sun' }] },
    ]
    overlays.clear()
    console.info('[draw-demo] start: water cycle')
    let delay = 0
    // Keep the complete 2D fixture, at a brisk pace, before the mechanism.
    for (const beat of beats) {
      const durationMs = beat.durationMs * 0.4
      setTimeout(() => overlays.drawBeat(beat.marks, durationMs, space), delay)
      delay += durationMs
    }
    setTimeout(() => { overlays.clear(); console.info('[draw-demo] start: bicycle pump') }, delay)
    for (const beat of pumpDemo(bounds.width, bounds.height)) {
      setTimeout(() => overlays.drawBeat(beat.marks, beat.durationMs, space), delay)
      delay += beat.durationMs
    }
    setTimeout(() => {
      console.info('[draw-demo] complete')
      overlays.answerDone(4500)
      setTimeout(() => app.quit(), 6500)
    }, delay)
  }, 3000)
  return true
}
