import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { Channels } from '../shared/ipc'
import { isPageSender } from './page-security'
import { loadPage, secureWebPreferences } from './windows'
import { parseConnectionRequest } from './provider-settings'
import type { ConnectionRequest, ConnectionResult } from '../shared/providers'
import { WINDOW_PALETTE } from '../shared/ui-palette'

let setup: BrowserWindow | undefined

/** Only this window's renderer may submit setup credentials. */
export function openSetupWindow(connect: (request: ConnectionRequest) => Promise<ConnectionResult>): BrowserWindow {
  if (setup && !setup.isDestroyed()) { setup.show(); setup.focus(); return setup }
  const window = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    title: 'Set up HeyNimbo',
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_PALETTE.dark : WINDOW_PALETTE.light,
    webPreferences: secureWebPreferences('setup'),
  })
  setup = window
  ipcMain.handle(Channels.connection, async (event, value: unknown): Promise<ConnectionResult> => {
    if (!isPageSender(event, window, 'setup')) return { ok: false, message: 'Not allowed.' }
    let request: ConnectionRequest
    try { request = parseConnectionRequest(value) } catch { return { ok: false, message: 'Invalid connection request.' } }
    if (request.kind === 'details') return { ok: false, message: 'Not allowed.' }
    const result = await connect(request)
    if (result.ok && (request.kind === 'saveKey' || (request.kind === 'signIn' && result.connection?.providers.chatgpt))) setTimeout(() => { if (!window.isDestroyed()) window.close() }, 800)
    return result
  })
  window.on('closed', () => { setup = undefined; ipcMain.removeHandler(Channels.connection) })
  window.once('ready-to-show', () => {
    window.show()
    app.focus({ steal: true })
  })
  loadPage(window, 'setup')
  return window
}
