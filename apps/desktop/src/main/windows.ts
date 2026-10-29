import { join } from 'node:path'
import { BrowserWindow, screen, type Display, type WebPreferences } from 'electron'
import { Channels, type NotchStatus, type OverlayCommand } from '../shared/ipc'

const NOTCH_SIZE = { width: 240, height: 38 }

/** Latest notch state, replayed whenever the notch page (re)loads. */
let notchStatus: NotchStatus = { kind: 'idle' }

function secureWebPreferences(): WebPreferences {
  return {
    // Sandboxed preloads must be CommonJS, so this stays `.js`.
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
}

function loadPage(window: BrowserWindow, page: 'notch' | 'overlay'): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void window.loadURL(`${devServer}/${page}.html`)
  else void window.loadFile(join(__dirname, `../renderer/${page}.html`))
}

/** Floats above fullscreen apps and every Space and asks the OS to hide it from
 *  captures. ScreenCaptureKit can still capture protected windows, so the
 *  capture layer must also exclude our windows explicitly. */
function floatAboveEverything(window: BrowserWindow): void {
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.setContentProtection(true)
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
  loadPage(window, 'notch')
  window.once('ready-to-show', () => window.showInactive())
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
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    show: false,
    webPreferences: secureWebPreferences(),
  })
  window.setIgnoreMouseEvents(true)
  floatAboveEverything(window)
  loadPage(window, 'overlay')
  window.once('ready-to-show', () => window.showInactive())
  return window
}

/** Keeps exactly one click-through drawing surface per connected display. */
export class OverlayManager {
  private readonly windows = new Map<number, BrowserWindow>()
  /** The ring being shown, replayed if its display's page (re)loads. */
  private shown: { displayId: number; command: OverlayCommand } | undefined

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

  clear(): void {
    this.shown = undefined
    for (const id of this.windows.keys()) this.send(id, { kind: 'clear' })
  }

  private send(displayId: number, command: OverlayCommand): void {
    const window = this.windows.get(displayId)
    if (window && !window.isDestroyed()) window.webContents.send(Channels.overlay, command)
  }
}
