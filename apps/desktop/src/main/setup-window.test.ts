import { afterEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
const mocks = vi.hoisted(() => ({ handler: undefined as ((event: IpcMainInvokeEvent, key: unknown) => Promise<unknown>) | undefined, windows: [] as Array<{ webContents: { mainFrame: { url: string } }; emit(event: string): void }>, validate: vi.fn(async () => ({ ok: true })), save: vi.fn(async () => {}) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const { pathToFileURL } = await import('node:url')
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, getURL: () => this.webContents.mainFrame.url, setWindowOpenHandler: vi.fn() })
    isDestroyed = () => false
    async loadFile(path: string) { this.webContents.mainFrame.url = pathToFileURL(path).href }
    constructor() { super(); mocks.windows.push(this) }
  }
  return { app: { isPackaged: true }, nativeTheme: { shouldUseDarkColors: false }, BrowserWindow, ipcMain: { handle: (_channel: string, handler: typeof mocks.handler) => { mocks.handler = handler }, removeHandler: vi.fn() } }
})
vi.mock('./secrets', () => ({ validateOpenAIKey: mocks.validate, saveOpenAIKey: mocks.save }))
import { openSetupWindow } from './setup-window'
afterEach(() => { for (const window of mocks.windows.splice(0)) window.emit('closed'); vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks() })
it('never validates or stores a key from a subframe or a navigated setup document', async () => {
  vi.useFakeTimers()
  const saved = vi.fn(), key = `sk-${'x'.repeat(30)}`
  openSetupWindow(saved)
  const contents = mocks.windows[0]!.webContents, frame = contents.mainFrame, url = frame.url
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  expect(await mocks.handler?.({ ...event, senderFrame: { url } } as IpcMainInvokeEvent, key)).toMatchObject({ ok: false })
  frame.url = 'https://untrusted.invalid'
  expect(await mocks.handler?.(event, key)).toMatchObject({ ok: false })
  expect(mocks.validate).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled()
  frame.url = url
  expect(await mocks.handler?.(event, key)).toEqual({ ok: true })
  expect(mocks.save).toHaveBeenCalledWith(key); expect(saved).toHaveBeenCalledWith(key)
})

it('authenticates and strictly parses the setup connection handler before any secret-bearing operation', async () => {
  vi.useFakeTimers()
  const connect = vi.fn(async () => ({ ok: true, message: 'Synthetic connection' }))
  openSetupWindow(vi.fn(), connect)
  const contents = mocks.windows[0]!.webContents, frame = contents.mainFrame, url = frame.url
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const request = { kind: 'saveKey', provider: 'anthropic', key: 'synthetic-key' }
  expect(await mocks.handler?.({ ...event, senderFrame: { url } } as IpcMainInvokeEvent, request)).toMatchObject({ ok: false })
  expect(await mocks.handler?.(event, { ...request, access_token: 'synthetic' })).toMatchObject({ ok: false })
  expect(connect).not.toHaveBeenCalled()
  expect(await mocks.handler?.(event, request)).toMatchObject({ ok: true })
  expect(connect).toHaveBeenCalledWith(request)
})
