import { app, BrowserWindow, ipcMain } from 'electron'
import { Channels, type SaveKeyResult } from '../shared/ipc'
import { saveOpenAIKey, validateOpenAIKey } from './secrets'
import { loadPage, secureWebPreferences } from './windows'

/** Asks for an OpenAI key, checks it with the API, then stores it encrypted.
 *  Only this window's renderer may call the save handler. */
export function openSetupWindow(onSaved: (key: string) => void): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    title: 'Set up NimboGuide',
    show: false,
    webPreferences: secureWebPreferences('setup'),
  })
  ipcMain.handle(Channels.saveOpenAIKey, async (event, key: unknown): Promise<SaveKeyResult> => {
    if (event.sender !== window.webContents) return { ok: false, reason: 'Not allowed.' }
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (!/^sk-[\w-]{20,}$/.test(trimmed)) return { ok: false, reason: 'That does not look like an OpenAI API key.' }
    const valid = await validateOpenAIKey(trimmed)
    if (!valid.ok) return valid
    await saveOpenAIKey(trimmed)
    onSaved(trimmed)
    setTimeout(() => window.close(), 800)
    return { ok: true }
  })
  window.on('closed', () => ipcMain.removeHandler(Channels.saveOpenAIKey))
  window.once('ready-to-show', () => {
    window.show()
    app.focus({ steal: true })
  })
  loadPage(window, 'setup')
  return window
}
