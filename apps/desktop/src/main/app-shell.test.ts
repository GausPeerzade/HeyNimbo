import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, BrowserWindow } from 'electron'
import type { AppRequest } from '../shared/app'
import { AppShell } from './app-shell'
const mocks = vi.hoisted(() => ({ dir: '', handler: undefined as ((event: IpcMainInvokeEvent, request: AppRequest) => unknown) | undefined }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.dir, getVersion: () => '0.1.0', isPackaged: false },
  ipcMain: { handle: (channel: string, handler: typeof mocks.handler) => { if (channel === 'nimbo:app-request') mocks.handler = handler }, removeHandler: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false },
}))
let shell: AppShell | undefined
afterEach(() => { shell?.close(); shell = undefined; if (mocks.dir) rmSync(mocks.dir, { recursive: true, force: true }) })
it('authenticates app-window requests and acknowledges text submission only after dispatch accepts it', async () => {
  mocks.dir = mkdtempSync('/tmp/nimbo-shell-test-')
  const ask = vi.fn()
  shell = new AppShell({ ask, stop() {}, clear() {}, replaceKey() {}, settingsChanged() {}, permissions: () => ({ microphone: '', screen: '', input: '' }) }, true)
  const contents = { send: vi.fn() }
  shell.home = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: contents } as unknown as IpcMainInvokeEvent
  expect(() => mocks.handler?.({ sender: {} } as IpcMainInvokeEvent, { kind: 'snapshot' })).toThrow('Not allowed')
  expect(await mocks.handler?.(event, { kind: 'ask', question: 'No connection yet' })).toBeUndefined()
  expect(ask).not.toHaveBeenCalled()
  shell.keyPresent = true
  expect(await mocks.handler?.(event, { kind: 'ask', question: '  My question  ' })).toEqual({ accepted: true })
  expect(ask).toHaveBeenCalledWith('My question')
  ask.mockImplementationOnce(() => { throw new Error('History storage failed') })
  await expect(mocks.handler?.(event, { kind: 'ask', question: 'Keep this draft' })).rejects.toThrow('History storage failed')
})
