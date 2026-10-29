import { globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import { AppChannels, type AppSnapshot } from '../shared/app'
import { parseNotchEvent } from './app-requests'
import { isPageSender } from './page-security'
import type { AppShell } from './app-shell'

/** The peek remains passive; Escape is registered only during its disclosure. */
export class NotchPeek {
  private escapeRegistered = false
  constructor(private readonly window: BrowserWindow, private readonly shell: AppShell, private readonly preview = false) {
    ipcMain.on(AppChannels.notch, this.receive)
    window.webContents.on('did-finish-load', () => this.publish(shell.snapshot()))
    window.webContents.on('render-process-gone', this.resetNative)
    window.webContents.on('did-start-loading', this.resetNative)
    window.on('unresponsive', this.resetNative)
  }
  private readonly receive = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (!isPageSender(event, this.window, 'notch')) return
    let payload
    try { payload = parseNotchEvent(value) } catch { return }
    if (!this.shell.settings.get().showNotch) return
    switch (payload.kind) {
      case 'hover': this.window.setIgnoreMouseEvents(!payload.over, { forward: true }); return
      case 'expanded':
        if (payload.expanded && !this.escapeRegistered && !this.preview) {
          this.escapeRegistered = globalShortcut.register('Escape', () => {
            if (this.shell.snapshot().busy) void this.shellStop()
            this.dismiss()
          })
          if (!this.escapeRegistered) console.warn('[peek] Escape is unavailable; move the pointer away to dismiss.')
        } else if (!payload.expanded) this.releaseEscape()
        return
      case 'home': this.dismiss(); this.shell.openHome(payload.id); return
      case 'new': this.dismiss(); this.shell.newConversation(); return
      case 'stop': this.shellStop(); return
    }
  }
  private shellStop(): void {
    // The normal menu/composer path and peek use the same request action.
    this.shell.stop()
  }
  publish(snapshot: AppSnapshot): void {
    if (!snapshot.settings.showNotch) this.dismiss()
    if (!this.window.isDestroyed()) this.window.webContents.send(AppChannels.snapshot, {
      ...snapshot, turns: [], conversations: [...snapshot.conversations].sort((a, b) => b.updated - a.updated).slice(0, 3),
    })
  }
  private readonly resetNative = (): void => {
    this.releaseEscape()
    if (!this.window.isDestroyed()) this.window.setIgnoreMouseEvents(true, { forward: true })
  }
  dismiss(): void {
    this.resetNative()
    if (!this.window.isDestroyed()) {
      try { this.window.webContents.send('heynimbo:peek-dismiss') }
      catch { console.warn('[peek] Renderer unavailable while dismissing.') }
    }
  }
  private releaseEscape(): void { if (this.escapeRegistered) globalShortcut.unregister('Escape'); this.escapeRegistered = false }
  close(): void {
    this.resetNative(); ipcMain.removeListener(AppChannels.notch, this.receive)
    this.window.webContents.removeListener('render-process-gone', this.resetNative)
    this.window.webContents.removeListener('did-start-loading', this.resetNative)
    this.window.removeListener('unresponsive', this.resetNative)
  }
}
