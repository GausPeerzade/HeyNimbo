import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  windows: [] as Array<{ options: Record<string, unknown>; show: () => void; showInactive: () => void; focus: () => void; destroy: () => void }>,
  request: undefined as undefined | ((details: { url: string }, done: (result: { cancel: boolean }) => void) => void),
  files: [] as string[], quit: vi.fn(), exit: vi.fn(), focus: vi.fn(), packaged: false,
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class BrowserWindow {
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(), isDestroyed: () => false, executeJavaScript: vi.fn(async () => 0),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('png') })),
      debugger: { isAttached: () => true, attach: vi.fn(), sendCommand: vi.fn(async () => ({})) },
    })
    show = vi.fn(); showInactive = vi.fn(); focus = vi.fn(); destroy = vi.fn()
    constructor(readonly options: Record<string, unknown>) { state.windows.push(this) }
  }
  return {
    BrowserWindow,
    app: { get isPackaged() { return state.packaged }, isActive: () => false, on: vi.fn(), quit: state.quit, exit: state.exit, focus: state.focus, setPath: vi.fn(), setActivationPolicy: vi.fn() },
    Menu: { setApplicationMenu: vi.fn() },
    ipcMain: { on: vi.fn() },
    session: { defaultSession: { webRequest: { onBeforeRequest: (handler: typeof state.request) => { state.request = handler } } } },
  }
})
vi.mock('node:fs', () => ({ mkdirSync: vi.fn(), writeFileSync: (file: string) => { state.files.push(file) }, mkdtempSync: () => '/tmp/heynimbo-model-gallery-test', rmSync: vi.fn() }))
vi.mock('./windows', () => ({ loadPage: vi.fn(async () => {}), secureWebPreferences: () => ({}), frameTraceSummary: () => ({}) }))

beforeEach(() => {
  vi.useFakeTimers()
  state.windows.length = 0; state.files.length = 0; state.packaged = false
  vi.stubEnv('HEYNIMBO_DEBUG_3D_GALLERY', '1')
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks() })

it('renders fixtures only in windows that are never shown or focused, offline, then quits by itself', async () => {
  vi.stubEnv('HEYNIMBO_DEBUG_3D_GALLERY_ONLY', 'water')
  vi.stubEnv('HEYNIMBO_DEBUG_3D_GALLERY_LABEL', 'test')
  const { runModelGallery } = await import('./model-gallery')
  const done = runModelGallery()
  await vi.advanceTimersByTimeAsync(40_000)
  await done
  expect(state.windows.length).toBeGreaterThan(0)
  for (const window of state.windows) {
    expect(window.options).toMatchObject({ show: false, paintWhenInitiallyHidden: true, focusable: false })
    for (const reveal of [window.show, window.showInactive, window.focus]) expect(reveal).not.toHaveBeenCalled()
    expect(window.destroy).toHaveBeenCalled()
  }
  expect(state.focus).not.toHaveBeenCalled()
  const decide = (url: string) => { let cancel: boolean | undefined; state.request!({ url }, (result) => { cancel = result.cancel }); return cancel }
  expect(decide('https://example.com/')).toBe(true); expect(decide('file:///app/overlay.html')).toBe(false)
  expect(state.files.length).toBeGreaterThan(2)
  expect(state.files.every((file) => file.startsWith('/tmp/heynimbo-3d-gallery/test/'))).toBe(true)
  expect(state.quit).toHaveBeenCalledOnce()
})

it('cannot outlive a minute, counted from process start, and does nothing in a packaged app', async () => {
  vi.spyOn(process, 'uptime').mockReturnValue(1)
  const { configureModelGallery } = await import('./model-gallery')
  configureModelGallery()
  await vi.advanceTimersByTimeAsync(56_999)
  expect(state.exit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(state.exit).toHaveBeenCalledOnce()
  vi.clearAllMocks(); state.packaged = true
  configureModelGallery()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(state.exit).not.toHaveBeenCalled()
})
