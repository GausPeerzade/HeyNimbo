import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, IpcMainEvent, WebContents } from 'electron'
import { devSetting } from './dev'

export type AppPage = 'notch' | 'overlay' | 'setup' | 'voice' | 'home' | 'settings'
const protectedContents = new WeakSet<WebContents>()

export function pageURL(page: AppPage): string {
  const server = devSetting('ELECTRON_RENDERER_URL')
  return server ? `${server}/${page}.html` : pathToFileURL(join(__dirname, `../renderer/${page}.html`)).href
}

/** Only main-process loads may change an app window's document. */
export function protectPage(window: BrowserWindow): void {
  const contents = window.webContents
  if (protectedContents.has(contents)) return
  protectedContents.add(contents)
  contents.on('will-navigate', event => event.preventDefault())
  contents.on('will-redirect', event => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

export function isPageSender(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>, window: BrowserWindow | undefined, page: AppPage): boolean {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false
  const contents = window.webContents, frame = event.senderFrame
  const expected = pageURL(page)
  return frame === contents.mainFrame && frame?.url === expected && contents.getURL() === expected
}
