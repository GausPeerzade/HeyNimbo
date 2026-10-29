import { join } from 'node:path'
import { BrowserWindow, ipcMain, screen, type Display, type WebPreferences } from 'electron'
import type { Mark } from '../shared/beats'
import { Channels, type NotchStatus, type OverlayCommand, type OverlayEvent } from '../shared/ipc'
import { displayFor, toOverlaySpace, type CaptureSpace } from './overlay-geometry'
import { devFlag, devSetting } from './dev'

const NOTCH_SIZE = { width: 240, height: 38 }

/** Latest notch state, replayed whenever the notch page (re)loads. */
let notchStatus: NotchStatus = { kind: 'idle' }

/** Each window gets the narrowest preload it needs. */
export type Preload = 'index' | 'setup' | 'voice'

export function secureWebPreferences(preload: Preload = 'index'): WebPreferences {
  return {
    // Sandboxed preloads must be CommonJS, so this stays `.js`.
    preload: join(__dirname, `../preload/${preload}.js`),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
}

export function loadPage(window: BrowserWindow, page: 'notch' | 'overlay' | 'setup' | 'voice'): Promise<void> {
  // Only an unpackaged build may load pages from the dev server.
  const devServer = devSetting('ELECTRON_RENDERER_URL')
  return devServer ? window.loadURL(`${devServer}/${page}.html`) : window.loadFile(join(__dirname, `../renderer/${page}.html`))
}

/** A passive surface must load successfully and paint before becoming visible.
 *  A failed page stays hidden, on an explicitly transparent native backing. */
function showPassivePage(window: BrowserWindow, page: 'notch' | 'overlay'): void {
  let failed = false
  window.webContents.on('did-fail-load', () => {
    failed = true
    if (!window.isDestroyed()) window.hide()
  })
  const painted = new Promise<void>((resolve) => window.once('ready-to-show', () => resolve()))
  void Promise.all([loadPage(window, page), painted]).then(() => {
    if (!failed && !window.isDestroyed()) window.showInactive()
  }).catch((error: unknown) => {
    if (!window.isDestroyed()) window.hide()
    console.warn(`[window] ${page} failed to load: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/** Floats above fullscreen apps and every Space and asks the OS to hide it from
 *  captures. ScreenCaptureKit can still capture protected windows, so the
 *  capture layer must also exclude our windows explicitly. */
function floatAboveEverything(window: BrowserWindow): void {
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Turning this off in development proves the capture filter excludes us on its own.
  window.setContentProtection(!devFlag('NIMBO_DEBUG_NO_CONTENT_PROTECTION'))
}

/** Centers the notch at the top of the primary display; call on display changes. */
export function positionNotch(window: BrowserWindow): void {
  const { bounds } = screen.getPrimaryDisplay()
  window.setBounds({
    ...NOTCH_SIZE,
    x: Math.round(bounds.x + (bounds.width - NOTCH_SIZE.width) / 2),
    y: bounds.y,
  })
}

/** The top-center panel: a hardware notch on recent Macs, a pill elsewhere. */
export function createNotchWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...NOTCH_SIZE,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    // Without this macOS pushes the window below the menu bar, off the notch.
    enableLargerThanScreen: true,
    show: false,
    webPreferences: secureWebPreferences(),
  })
  positionNotch(window)
  floatAboveEverything(window)
  window.webContents.on('did-finish-load', () => window.webContents.send(Channels.notchStatus, notchStatus))
  showPassivePage(window, 'notch')
  return window
}

export function sendNotchStatus(window: BrowserWindow, status: NotchStatus): void {
  notchStatus = status
  if (!window.isDestroyed()) window.webContents.send(Channels.notchStatus, status)
}

function createOverlayWindow(display: Display): BrowserWindow {
  const window = new BrowserWindow({
    ...display.bounds,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: { ...secureWebPreferences(), backgroundThrottling: false },
  })
  // Click-through, but mouse moves still reach the page so it can tell when
  // the pointer is over its one interactive part, the Clear button.
  window.setIgnoreMouseEvents(true, { forward: true })
  floatAboveEverything(window)
  showPassivePage(window, 'overlay')
  return window
}

/** Keeps exactly one click-through drawing surface per connected display. */
export class OverlayManager {
  private readonly windows = new Map<number, BrowserWindow>()
  /** The ring being shown, replayed if its display's page (re)loads. */
  private shown: { displayId: number; command: OverlayCommand } | undefined
  private fadeTimer: NodeJS.Timeout | undefined
  private buddyDisplayId: number | undefined
  /** True from a beat until its overlay reports the buddy back at the cursor;
   *  the buddy does not change displays mid-drawing. */
  private buddyBusy = false
  /** Bumped on every clear so strokes from an old scene start no sound. */
  private epoch = 0
  private followTimer: NodeJS.Timeout | undefined
  private lastCursor: Electron.Point | undefined

  onStrokeStarted?: (durationMs: number) => void

  constructor() {
    ipcMain.on(Channels.overlayEvent, (event, payload: OverlayEvent) => {
      const sender = [...this.windows].find(([, window]) => window.webContents === event.sender)
      if (!sender) return
      if (payload.kind === 'strokeStarted') {
        if (payload.epoch === this.epoch) this.onStrokeStarted?.(payload.durationMs)
      } else if (payload.kind === 'buddyIdle') {
        if (sender[0] === this.buddyDisplayId) this.buddyBusy = false
      } else if (payload.kind === 'clearHover') {
        // Clicks land only while the pointer is over the button.
        sender[1].setIgnoreMouseEvents(!payload.over, { forward: true })
      } else if (payload.kind === 'clearClicked') {
        sender[1].setIgnoreMouseEvents(true, { forward: true })
        this.clear()
      }
      else if (payload.kind === 'frameTrace' && devFlag('NIMBO_DEBUG_DRAW_TRACE')) {
        const sorted = [...payload.deltas].sort((a, b) => a - b)
        const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
        console.info(`[draw-trace] ${JSON.stringify({
          frames: sorted.length,
          activeMs: payload.deltas.reduce((sum, gap) => sum + gap, 0),
          p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0,
          longestStall: sorted.filter((gap) => gap > 100).at(-1) ?? 0,
          deltas: payload.deltas,
        })}`)
      }
    })
  }

  /** Reconciles windows with the current displays; call on any display change. */
  sync(): void {
    const displays = screen.getAllDisplays()
    const live = new Set(displays.map((display) => display.id))
    for (const [id, window] of this.windows) {
      if (!live.has(id)) {
        window.destroy()
        this.windows.delete(id)
      }
    }
    for (const display of displays) {
      const existing = this.windows.get(display.id)
      if (existing) {
        existing.setBounds(display.bounds)
        continue
      }
      const window = createOverlayWindow(display)
      window.webContents.on('did-finish-load', () => {
        if (devFlag('NIMBO_DEBUG_DRAW_TRACE')) this.send(display.id, { kind: 'debug', frameTrace: true })
        if (this.shown?.displayId === display.id) this.send(display.id, this.shown.command)
      })
      this.windows.set(display.id, window)
    }
  }

  /** Draws a ring at a global screen point on the display that contains it. */
  ring(point: Electron.Point): void {
    const display = screen.getDisplayNearestPoint(point)
    this.clear()
    const command: OverlayCommand = {
      kind: 'ring',
      ring: { x: point.x - display.bounds.x, y: point.y - display.bounds.y },
    }
    this.shown = { displayId: display.id, command }
    this.send(display.id, command)
  }

  /** Draws marks from a capture's screenshot pixels on the display it came from. */
  drawBeat(marks: Mark[], durationMs: number, space: CaptureSpace): void {
    const display = displayFor(space, screen.getAllDisplays())
    if (!display) return
    clearTimeout(this.fadeTimer)
    this.moveBuddyTo(display.id)
    this.buddyBusy = true
    const cursor = screen.getCursorScreenPoint()
    this.send(display.id, {
      kind: 'beat',
      marks: toOverlaySpace(marks, space, display.bounds),
      durationMs,
      from: { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y },
      epoch: this.epoch,
    })
  }

  /** Feeds the OS cursor to the display that owns the buddy, so it rides next
   *  to the pointer whenever it is not drawing. */
  startFollowing(intervalMs = 16): void {
    this.followTimer ??= setInterval(() => this.followCursor(), intervalMs)
  }

  stopFollowing(): void {
    clearInterval(this.followTimer)
    this.followTimer = undefined
  }

  private followCursor(): void {
    const cursor = screen.getCursorScreenPoint()
    if (this.lastCursor?.x === cursor.x && this.lastCursor.y === cursor.y) return
    this.lastCursor = cursor
    const display = screen.getDisplayNearestPoint(cursor)
    if (!this.buddyBusy) this.moveBuddyTo(display.id)
    if (display.id === this.buddyDisplayId) {
      this.send(display.id, { kind: 'cursor', at: { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y } })
    }
  }

  /** Exactly one display shows the buddy; the previous owner parks its copy. */
  private moveBuddyTo(displayId: number): void {
    if (this.buddyDisplayId === displayId) return
    if (this.buddyDisplayId !== undefined) this.send(this.buddyDisplayId, { kind: 'park' })
    this.buddyDisplayId = displayId
    this.lastCursor = undefined
  }

  /** The answer is over: offer a Clear button, and fade the drawing if it is
   *  still up after a while. */
  answerDone(lingerMs = 60_000): void {
    for (const id of this.windows.keys()) this.send(id, { kind: 'offerClear' })
    this.fadeSoon(lingerMs)
  }

  /** Lets the drawing linger, then fades it out. */
  fadeSoon(delayMs = 6_000): void {
    clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => {
      for (const id of this.windows.keys()) this.send(id, { kind: 'fade', from: this.cursorOnDisplay(id) })
    }, delayMs)
  }

  clear(): void {
    clearTimeout(this.fadeTimer)
    this.epoch++
    this.shown = undefined
    for (const id of this.windows.keys()) this.send(id, { kind: 'clear', from: this.cursorOnDisplay(id) })
  }

  private cursorOnDisplay(id: number): { x: number; y: number } | undefined {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    return display.id === id ? { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y } : undefined
  }

  private send(displayId: number, command: OverlayCommand): void {
    const window = this.windows.get(displayId)
    if (window && !window.isDestroyed()) window.webContents.send(Channels.overlay, command)
  }
}
