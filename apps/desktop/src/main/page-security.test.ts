import { EventEmitter } from 'node:events'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: true } }))
import { isPageSender, pageURL } from './page-security'
import { loadPage } from './windows'

afterEach(() => vi.unstubAllEnvs())
it.each(['home', 'settings', 'notch', 'setup'] as const)('guards %s against navigation, redirects and new windows while allowing its main-process load', async page => {
  let open!: () => { action: string }
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: (handler: typeof open) => { open = handler } })
  const window = { webContents: contents, loadFile: vi.fn(async () => {}), loadURL: vi.fn(async () => {}) }
  await loadPage(window as unknown as BrowserWindow, page)
  expect(window.loadFile).toHaveBeenCalledWith(expect.stringContaining(`${page}.html`))
  for (const name of ['will-navigate', 'will-redirect']) {
    const event = { preventDefault: vi.fn() }; contents.emit(name, event, 'https://untrusted.invalid')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  }
  expect(open()).toEqual({ action: 'deny' })
})
it.each(['home', 'settings', 'notch', 'setup'] as const)('authenticates the exact %s main frame and file URL, not just WebContents', page => {
  const frame = { url: pageURL(page) }, contents = { mainFrame: frame, getURL: () => frame.url }
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainEvent
  expect(isPageSender(event, window, page)).toBe(true)
  expect(isPageSender({ ...event, sender: {} } as IpcMainEvent, window, page)).toBe(false)
  expect(isPageSender({ ...event, senderFrame: { url: frame.url } } as IpcMainEvent, window, page)).toBe(false)
  // A skip link only adds an anchor; the same document must stay trusted.
  frame.url = `${pageURL(page)}#content`
  expect(isPageSender(event, window, page)).toBe(true)
  for (const url of ['https://untrusted.invalid', 'file:///tmp/home.html', `${pageURL(page)}?spoof=1`, `${pageURL(page)}?spoof=1#content`]) {
    frame.url = url
    expect(isPageSender(event, window, page)).toBe(false)
  }
})
