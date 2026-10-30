import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { screen } from 'electron'
import type { NotchStatus } from '../shared/ipc'
import { devFlag, devSetting } from './dev'
import {
  captureScreens,
  hasScreenCaptureAccess,
  requestScreenCaptureAccess,
  type ScreenCaptures,
} from '@heynimbo/native'

/** Asks for Screen Recording only when the owner uses it, never at launch: right after a new build
 *  starts, macOS briefly reports no access while it re-checks the app, and asking then shows a
 *  prompt for a grant the owner already gave. */
export function ensureScreenCaptureAccess(): boolean {
  return hasScreenCaptureAccess() || requestScreenCaptureAccess()
}

/** What the notch shows at rest: idle, or a reminder while Screen Recording is
 *  missing. Re-checked each time (no prompt), so a revoked grant shows up. */
export function restingStatus(): NotchStatus {
  return hasScreenCaptureAccess() ? { kind: 'idle' } : { kind: 'needsPermission', permission: 'screenRecording' }
}

/** Captures the display under the cursor. Nothing is written to disk unless
 *  `HEYNIMBO_DEBUG_CAPTURE_DIR` is set in an unpackaged development build. */
export async function captureCursorDisplay(): Promise<ScreenCaptures | undefined> {
  if (!ensureScreenCaptureAccess()) return undefined
  try {
    const captures = await captureScreens({ maxLongEdge: 1280 })
    const [display] = captures.displays
    if (display) {
      const cursor = display.cursor ? `${Math.round(display.cursor.x)},${Math.round(display.cursor.y)}` : 'none'
      console.info(
        `[capture] display=${display.displayId} ${display.pixelWidth}x${display.pixelHeight} ` +
          `jpeg=${Math.round(display.jpeg.length / 1024)}KB capture=${captures.captureMs.toFixed(0)}ms ` +
          `encode=${captures.encodeMs.toFixed(0)}ms cursor=${cursor}`,
      )
      const debugDir = devSetting('HEYNIMBO_DEBUG_CAPTURE_DIR')
      if (debugDir) await writeFile(join(debugDir, 'latest-capture.jpg'), display.jpeg)
    }
    return captures
  } catch (error) {
    console.warn(`[capture] failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Development check that our own windows are excluded: shows a ring at the
 *  center of the cursor's display, then captures once it is surely on screen. */
export function scheduleExclusionSelfTest(showRing: (point: Electron.Point) => void): void {
  if (!devSetting('HEYNIMBO_DEBUG_CAPTURE_DIR') || !devFlag('HEYNIMBO_DEBUG_EXCLUSION_TEST')) return
  setTimeout(() => {
    const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    showRing({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    console.info('[capture] exclusion self-test ring shown')
    setTimeout(() => void captureCursorDisplay(), 1000)
  }, 3000)
}
