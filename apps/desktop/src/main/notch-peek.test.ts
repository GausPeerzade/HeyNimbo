import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { AppShell } from './app-shell'
import type { AppSnapshot } from '../shared/app'
import { AppChannels } from '../shared/app'
const mocks = vi.hoisted(() => ({ register: vi.fn(() => true), unregister: vi.fn(), receive: undefined as ((event: IpcMainEvent, payload: unknown) => void) | undefined }))
vi.mock('electron', () => ({ app: { isPackaged: true }, globalShortcut: { register: mocks.register, unregister: mocks.unregister }, ipcMain: { on: (_channel: string, handler: typeof mocks.receive) => { mocks.receive = handler }, removeListener: vi.fn() } }))
import { NotchPeek } from './notch-peek'
import { pageURL } from './page-security'
afterEach(() => vi.clearAllMocks())
function fixture() {
  const frame = { url: pageURL('notch') }
  const contents = Object.assign(new EventEmitter(), { send: vi.fn(), mainFrame: frame, getURL: () => frame.url })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, setIgnoreMouseEvents: vi.fn() })
  const shell = { settings: { get: () => ({ showNotch: true }) }, openHome: vi.fn(), snapshot: () => ({ busy: false }) }
  const peek = new NotchPeek(window as unknown as BrowserWindow, shell as unknown as AppShell)
  const sender = { sender: contents, senderFrame: frame } as unknown as IpcMainEvent
  return { window, contents, shell, peek, sender }
}
it('keeps hover nonactivating, authenticates the main frame and file URL, and rejects malformed hover flags', () => {
  const { window, contents, shell, peek, sender } = fixture()
  for (const invalid of [{ sender: {} }, { ...sender, senderFrame: { url: pageURL('notch') } }]) mocks.receive?.(invalid as IpcMainEvent, { kind: 'home' })
  contents.mainFrame.url = 'https://untrusted.invalid'; mocks.receive?.(sender, { kind: 'home' }); contents.mainFrame.url = pageURL('notch')
  expect(shell.openHome).not.toHaveBeenCalled()
  for (const value of [{ kind: 'hover', over: 'true' }, { kind: 'expanded', expanded: 'false' }]) mocks.receive?.(sender, value)
  expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled()
  mocks.receive?.(sender, { kind: 'hover', over: true })
  expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true })
  mocks.receive?.(sender, { kind: 'expanded', expanded: true })
  expect(mocks.register).toHaveBeenCalledWith('Escape', expect.any(Function))
  mocks.receive?.(sender, { kind: 'home', id: 'conversation' })
  expect(shell.openHome).toHaveBeenCalledWith('conversation')
  expect(mocks.unregister).toHaveBeenCalledWith('Escape')
  expect(contents.send).toHaveBeenCalledWith('nimbo:peek-dismiss')
  peek.close()
})
it.each(['render-process-gone', 'unresponsive', 'did-start-loading'])('restores click-through and releases Escape on %s without messaging a failing renderer', event => {
  const { window, contents, peek, sender } = fixture()
  mocks.receive?.(sender, { kind: 'hover', over: true }); mocks.receive?.(sender, { kind: 'expanded', expanded: true })
  window.setIgnoreMouseEvents.mockClear(); contents.send.mockClear()
  ;(event === 'unresponsive' ? window : contents).emit(event)
  expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  expect(mocks.unregister).toHaveBeenCalledWith('Escape')
  expect(contents.send).not.toHaveBeenCalled()
  peek.close()
})
it('performs native cleanup before a renderer send can fail during dismissal', () => {
  const { window, contents, peek, sender } = fixture()
  mocks.receive?.(sender, { kind: 'expanded', expanded: true })
  contents.send.mockImplementationOnce(() => { throw new Error('Renderer unavailable') })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(() => peek.dismiss()).not.toThrow()
  expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  expect(mocks.unregister).toHaveBeenCalledWith('Escape')
  expect(window.setIgnoreMouseEvents.mock.invocationCallOrder.at(-1)!).toBeLessThan(contents.send.mock.invocationCallOrder.at(-1)!)
  peek.close(); warning.mockRestore()
})
it('shows the three most recent conversations rather than letting old pins displace them', () => {
  const { contents, peek } = fixture()
  peek.publish({ settings: { showNotch: true }, turns: [{ id: 'not-for-peek' }], conversations: [{ id: 'pinned', updated: 1 }, { id: 'new', updated: 5 }, { id: 'second', updated: 4 }, { id: 'third', updated: 3 }] } as AppSnapshot)
  expect(contents.send).toHaveBeenCalledWith(AppChannels.snapshot, expect.objectContaining({ turns: [], conversations: [{ id: 'new', updated: 5 }, { id: 'second', updated: 4 }, { id: 'third', updated: 3 }] }))
  peek.close()
})
