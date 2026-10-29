import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import type { AppShell } from './app-shell'
import type { AppSnapshot, NotchEvent } from '../shared/app'
import { AppChannels } from '../shared/app'
const mocks = vi.hoisted(() => ({ register: vi.fn(() => true), unregister: vi.fn(), receive: undefined as ((event: IpcMainEvent, payload: NotchEvent) => void) | undefined }))
vi.mock('electron', () => ({ globalShortcut: { register: mocks.register, unregister: mocks.unregister }, ipcMain: { on: (_channel: string, handler: typeof mocks.receive) => { mocks.receive = handler }, removeListener: vi.fn() } }))
import { NotchPeek } from './notch-peek'
afterEach(() => vi.clearAllMocks())
it('keeps hover nonactivating, authenticates the sender, and releases Escape after dismissal', () => {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() })
  const window = { webContents: contents, isDestroyed: () => false, setIgnoreMouseEvents: vi.fn() }
  const shell = { settings: { get: () => ({ showNotch: true }) }, openHome: vi.fn(), snapshot: () => ({ busy: false }) }
  const peek = new NotchPeek(window as unknown as BrowserWindow, shell as unknown as AppShell)
  const sender = { sender: contents } as unknown as IpcMainEvent
  mocks.receive?.({ sender: {} } as IpcMainEvent, { kind: 'home' })
  expect(shell.openHome).not.toHaveBeenCalled()
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
it('shows the three most recent conversations rather than letting old pins displace them', () => {
  const contents = Object.assign(new EventEmitter(), { send: vi.fn() })
  const window = { webContents: contents, isDestroyed: () => false }
  const peek = new NotchPeek(window as unknown as BrowserWindow, {} as AppShell, true)
  peek.publish({ settings: { showNotch: true }, turns: [{ id: 'not-for-peek' }], conversations: [{ id: 'pinned', updated: 1 }, { id: 'new', updated: 5 }, { id: 'second', updated: 4 }, { id: 'third', updated: 3 }] } as AppSnapshot)
  expect(contents.send).toHaveBeenCalledWith(AppChannels.snapshot, expect.objectContaining({ turns: [], conversations: [{ id: 'new', updated: 5 }, { id: 'second', updated: 4 }, { id: 'third', updated: 3 }] }))
  peek.close()
})
