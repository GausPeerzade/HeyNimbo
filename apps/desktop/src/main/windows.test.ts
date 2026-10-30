import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    options: Record<string, unknown>
    emit: (event: string) => void
    webContents: { emit: (event: string) => void; send: ReturnType<typeof vi.fn> }
    showInactive: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>
    setContentProtection: ReturnType<typeof vi.fn>
  }>,
  load: Promise.resolve(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() })
    showInactive = vi.fn()
    hide = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setContentProtection = vi.fn()
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setBounds = vi.fn()
    isDestroyed = () => false
    destroy = vi.fn()
    loadFile = () => state.load
    loadURL = () => state.load
    constructor(readonly options: Record<string, unknown>) {
      super()
      state.windows.push(this)
    }
  }
  return {
    BrowserWindow,
    app: { isPackaged: false },
    ipcMain: { on: vi.fn() },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
  }
})

import { createNotchWindow, OverlayManager, positionNotch, setNotchVisibility } from './windows'

beforeEach(() => {
  state.windows.length = 0
  state.load = Promise.resolve()
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  vi.stubEnv('HEYNIMBO_DEBUG_NO_CONTENT_PROTECTION', '0')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }

function overlay(): typeof state.windows[number] {
  new OverlayManager().sync()
  return state.windows[0]!
}

describe('display changes during and after quit', () => {
  // A display can change (sleep, lid, monitor unplug) after before-quit has
  // destroyed the windows; Electron then throws "Object has been destroyed".
  it('ignores notch positioning and visibility for an already destroyed notch', () => {
    const notch = createNotchWindow() as unknown as { isDestroyed: () => boolean; setBounds: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn> }
    notch.setBounds.mockClear() // creation positions it once while alive
    notch.isDestroyed = () => true
    notch.setBounds.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    notch.hide.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    expect(() => positionNotch(notch as never)).not.toThrow()
    expect(() => setNotchVisibility(notch as never, false)).not.toThrow()
    expect(notch.setBounds).not.toHaveBeenCalled()
    setNotchVisibility(notch as never, true) // restore module-level visibility for later tests
  })
  it('ignores page-load events that arrive after quit destroyed the overlay or notch', () => {
    const manager = new OverlayManager(); manager.sync()
    const overlay = state.windows[0]! as unknown as { isDestroyed: () => boolean; setIgnoreMouseEvents: ReturnType<typeof vi.fn>; webContents: { emit(e: string): void } }
    createNotchWindow()
    const notch = state.windows[1]! as unknown as { isDestroyed: () => boolean; webContents: { emit(e: string): void; send: ReturnType<typeof vi.fn> } }
    for (const window of [overlay, notch]) window.isDestroyed = () => true
    overlay.setIgnoreMouseEvents.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    notch.webContents.send.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    expect(() => overlay.webContents.emit('did-finish-load')).not.toThrow()
    expect(() => notch.webContents.emit('did-finish-load')).not.toThrow()
  })
  it('does not recreate overlay windows when displays change after close', () => {
    const manager = new OverlayManager(); manager.sync()
    expect(state.windows).toHaveLength(1)
    manager.close(); manager.sync()
    expect(state.windows).toHaveLength(1)
  })
})

describe('3D lines ahead of their beat', () => {
  it('sends streamed model lines to the display that will draw them, converted to its space', () => {
    const manager = new OverlayManager(); manager.sync()
    const window = state.windows[0]!
    manager.prepare([{ kind: 'model', id: 'pump', x: 100, y: 50, w: 600, h: 500, title: 'Pump', turntable: true }], { frame: { x: 0, y: 0, width: 1440, height: 900 }, pixelWidth: 2880, pixelHeight: 1800 })
    expect(window.webContents.send).toHaveBeenCalledWith('heynimbo:overlay', { kind: 'prepare', marks: [{ kind: 'model', id: 'pump', x: 50, y: 25, w: 320, h: 250, title: 'Pump', turntable: true }], epoch: 0 })
  })
})

describe('passive window transparency', () => {
  it('keeps an overlay hidden until both page load and first paint have succeeded', async () => {
    let loaded!: () => void
    state.load = new Promise<void>((resolve) => { loaded = resolve })
    const window = overlay()
    expect(window.options).toMatchObject({ transparent: true, backgroundColor: '#00000000', show: false, focusable: false })
    expect(window.options.webPreferences).toMatchObject({ backgroundThrottling: false })
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    expect(window.setContentProtection).toHaveBeenCalledWith(true)
    window.emit('ready-to-show')
    await flush()
    expect(window.showInactive).not.toHaveBeenCalled()
    loaded()
    await flush()
    expect(window.showInactive).toHaveBeenCalledOnce()
  })

  it('does not show a loaded page before its first paint', async () => {
    const window = overlay()
    await flush()
    expect(window.showInactive).not.toHaveBeenCalled()
    window.emit('ready-to-show')
    await flush()
    expect(window.showInactive).toHaveBeenCalledOnce()
  })

  it('keeps failed pages hidden even if Chromium reports a painted error page', async () => {
    let failed!: (error: Error) => void
    state.load = new Promise<void>((_resolve, reject) => { failed = reject })
    const window = overlay()
    failed(new Error('overlay.html missing'))
    window.webContents.emit('did-fail-load')
    window.emit('ready-to-show')
    await flush()
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalled()
    expect(window.options.backgroundColor).toBe('#00000000')
  })

  it('cannot reveal a painted error page after a failure between load and first paint', async () => {
    const window = overlay()
    await flush()
    window.webContents.emit('did-fail-load')
    window.emit('ready-to-show')
    await flush()
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledOnce()
  })

  it('hides an already visible overlay if a later reload fails', async () => {
    const window = overlay()
    window.emit('ready-to-show')
    await flush()
    expect(window.showInactive).toHaveBeenCalledOnce()
    window.webContents.emit('did-fail-load')
    expect(window.hide).toHaveBeenCalledOnce()
  })

  it('uses the same transparent backing and load/paint gate for the notch', async () => {
    createNotchWindow()
    const window = state.windows[0]!
    expect(window.options).toMatchObject({ transparent: true, backgroundColor: '#00000000', show: false })
    await flush()
    expect(window.showInactive).not.toHaveBeenCalled()
    window.emit('ready-to-show')
    await flush()
    expect(window.showInactive).toHaveBeenCalledOnce()
  })
})
