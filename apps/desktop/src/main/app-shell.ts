import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray, utilityProcess } from 'electron'
import { AgentSupervisor } from './agent-supervisor'
import { credentialForAgent, registerAgentIpc } from './agent-ipc'
import type { AnswerConnection } from './answer-provider'
import { AppChannels, type AppRequest, type AppSettings, type AppSnapshot } from '../shared/app'
import { PROVIDER_NAMES, type ConnectionRequest, type ConnectionResult, type ConnectionSnapshot } from '../shared/providers'
import { ConversationController } from './conversations'
import { HistoryRepository } from './history'
import { clampHomeBounds } from './lifecycle'
import { SettingsStore } from './settings'
import { parseAppRequest } from './app-requests'
import { isPageSender } from './page-security'
import { loadPage, secureWebPreferences } from './windows'
import { WINDOW_PALETTE } from '../shared/ui-palette'
import { ensureMicrophoneAccess, microphoneAccessStatus } from './audio-window'

export interface ShellActions {
  ask(question: string): { accepted: true }
  stop(): void
  clear(): void
  replaceKey(): void
  settingsChanged(settings: AppSettings, previous: AppSettings): void
  connectionRequest?(request: ConnectionRequest): Promise<ConnectionResult>
  connectionSnapshot?(): ConnectionSnapshot
  agentConnection?(): AnswerConnection
  validateSettings?(settings: AppSettings): Promise<AppSettings>
  permissions(): AppSnapshot['permissions']
}

export function brandPath(file: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'brand', file) : join(__dirname, '../../build/brand', file)
}

/** Brings a window the user asked for to the front on the Space they're on,
 *  even over a full-screen app. Joining every Space just long enough to show
 *  moves it here; afterwards it stays put. This only works because HeyNimbo
 *  never takes a Dock icon: since macOS 10.14, Dock apps can't put windows over
 *  another app's full-screen Space. */
function present(window: BrowserWindow): void {
  const spaces = { visibleOnFullScreen: true, skipTransformProcessType: true }
  window.setVisibleOnAllWorkspaces(true, spaces)
  window.show()
  window.focus()
  app.focus({ steal: true })
  window.setVisibleOnAllWorkspaces(false, spaces)
}

export class AppShell {
  readonly settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  readonly conversations = new ConversationController(new HistoryRepository(join(app.getPath('userData'), 'history.sqlite')), () => this.settings.get(), () => this.publish())
  home: BrowserWindow | undefined
  preferences: BrowserWindow | undefined
  private tray: Tray | undefined
  private publishTimer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined
  private agent?: AgentSupervisor
  private agentIpc?: ReturnType<typeof registerAgentIpc>
  private status = ''
  private busy = false
  private hasKey = false
  get keyPresent(): boolean { return this.hasKey }
  // Reconnect (including legacy setup/account refresh) reports readiness here,
  // even when the boolean is unchanged. Old run authority must not survive it.
  set keyPresent(value: boolean) { this.revokeAgentAuthority(); this.hasKey = value }
  onChanged?: (snapshot: AppSnapshot) => void

  constructor(private readonly actions: ShellActions, private readonly preview = false) {
    if (actions.agentConnection && !preview) {
      const connections = { answer: actions.agentConnection }
      this.agent = new AgentSupervisor({
        spawn: () => utilityProcess.fork(join(__dirname, 'agent-host.js'), [], { serviceName: 'HeyNimbo Agent', stdio: 'ignore' }),
        credentials: (name, allowed, binding) => credentialForAgent(name, allowed, connections, () => this.settings.get(), binding),
        onPush: push => this.agentIpc?.push(push),
        dataDir: app.getPath('userData'),
      })
      this.agentIpc = registerAgentIpc({ home: () => this.home, settings: () => this.settings.get(), connections, supervisor: this.agent })
    }
    ipcMain.handle(AppChannels.request, (event, request: unknown) => {
      if (!isPageSender(event, this.home, 'home') && !isPageSender(event, this.preferences, 'settings')) throw new Error('Not allowed.')
      const parsed = parseAppRequest(request)
      if (parsed.kind === 'connection' && parsed.request.kind === 'details' && !isPageSender(event, this.preferences, 'settings')) throw new Error('Not allowed.')
      return this.handle(parsed)
    })
    this.pruneHistory()
    this.pruneTimer = setInterval(() => { this.pruneHistory(); this.publish() }, 86400000)
    if (!preview) {
      this.installMenu()
      this.updateTray()
      app.on('activate', () => this.openHome())
      app.on('second-instance', () => this.openHome())
    }
  }

  private revokeAgentAuthority(): void { this.agent?.revokeAuthority(); this.agentIpc?.revokeAuthority() }
  private pruneHistory(): void {
    const retention = this.settings.get().retention
    this.conversations.history.prune(retention)
    // Retention never starts a host or adds an await to the Explain path.
    if (typeof retention === 'number' && retention > 0) void this.agent?.purge(Math.max(0, Date.now() - retention * 86_400_000)).catch(() => {})
  }
  snapshot(): AppSnapshot {
    return {
      conversations: this.conversations.list(), currentId: this.conversations.currentId, turns: this.conversations.turns(),
      activeTurnId: this.conversations.activeTurnId, busy: this.busy, status: this.status, settings: this.settings.get(), keyPresent: this.keyPresent,
      connection: this.actions.connectionSnapshot?.(),
      saved: this.conversations.saved, version: app.getVersion(), permissions: this.preview ? { microphone: 'Preview only', screen: 'Preview only', input: 'Preview only' } : this.actions.permissions(),
    }
  }
  publish(flush = false): void {
    if (!flush) {
      this.publishTimer ??= setTimeout(() => this.publish(true), 250)
      return
    }
    clearTimeout(this.publishTimer); this.publishTimer = undefined
    const snapshot = this.snapshot()
    for (const window of [this.home, this.preferences]) if (window && !window.isDestroyed()) window.webContents.send(AppChannels.snapshot, snapshot)
    this.onChanged?.(snapshot)
  }
  setStatus(label: string | undefined): void { this.status = label ?? ''; this.busy = Boolean(label && !label.includes('wrong') && !label.includes('unavailable')); this.publish(!this.busy) }
  openHome(id?: string, turnId?: string): BrowserWindow {
    if (id && id !== this.conversations.currentId && this.conversations.get(id)) { this.actions.stop(); this.conversations.open(id) }
    if (!this.home) {
      const window = new BrowserWindow({
        ...clampHomeBounds(this.settings.get().homeBounds, screen.getAllDisplays().map(d => d.workArea)), minWidth: 720, minHeight: 520,
        title: 'HeyNimbo', titleBarStyle: 'hiddenInset', backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_PALETTE.dark : WINDOW_PALETTE.light, show: false,
        paintWhenInitiallyHidden: true, webPreferences: secureWebPreferences('app'),
      })
      this.home = window
      window.on('close', () => { if (!window.isFullScreen()) this.settings.set({ ...this.settings.get(), homeBounds: window.getNormalBounds() }) })
      window.on('closed', () => { this.home = undefined })
      window.once('ready-to-show', () => { if (!this.preview) present(window) })
      window.webContents.once('did-finish-load', () => { this.publish(); if (turnId) window.webContents.send(AppChannels.navigate, { turnId }) })
      void loadPage(window, 'home')
    } else {
      if (this.home.isMinimized()) this.home.restore()
      if (!this.preview) present(this.home); this.publish()
      if (turnId) this.home.webContents.send(AppChannels.navigate, { turnId })
    }
    return this.home
  }
  openSettings(category?: string): BrowserWindow {
    if (!this.preferences) {
      const window = new BrowserWindow({ width: 760, height: 610, minWidth: 680, minHeight: 520, title: 'HeyNimbo Settings', titleBarStyle: 'hiddenInset', show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_PALETTE.dark : WINDOW_PALETTE.light, paintWhenInitiallyHidden: true, webPreferences: secureWebPreferences('app') })
      this.preferences = window
      window.on('closed', () => { this.preferences = undefined })
      window.once('ready-to-show', () => { if (!this.preview) present(window) })
      window.webContents.once('did-finish-load', () => { this.publish(); if (category) window.webContents.send(AppChannels.navigate, { category }) })
      window.on('focus', () => this.publish())
      void loadPage(window, 'settings')
    } else {
      if (this.preferences.isMinimized()) this.preferences.restore()
      if (!this.preview) present(this.preferences); this.publish()
      if (category) this.preferences.webContents.send(AppChannels.navigate, { category })
    }
    return this.preferences
  }
  stop(): void { this.actions.stop() }
  newConversation(): void { this.actions.stop(); this.conversations.newConversation(); this.openHome() }
  private installMenu(): void {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'HeyNimbo', submenu: [
        { label: 'About HeyNimbo', click: () => this.openSettings('About') }, { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => this.openSettings() }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
      ] },
      { label: 'File', submenu: [{ label: 'New conversation', accelerator: 'CmdOrCtrl+N', click: () => this.newConversation() }, { label: 'Find conversations', accelerator: 'CmdOrCtrl+F', click: () => {
        const window = this.openHome()
        const find = (): void => window.webContents.send(AppChannels.navigate, { focusSearch: true })
        if (window.webContents.isLoading()) window.webContents.once('did-finish-load', find); else find()
      } }, { role: 'close' }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]))
  }
  private updateTray(): void {
    this.tray?.destroy(); this.tray = undefined
    if (!this.settings.get().showMenuBar || this.preview) return
    const image = nativeImage.createFromPath(brandPath('HeyNimboTemplate.png'))
    image.setTemplateImage(true)
    this.tray = new Tray(image)
    this.tray.setToolTip('HeyNimbo')
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Home', click: () => this.openHome() }, { label: 'New conversation', click: () => this.newConversation() },
      { label: 'Clear drawings', click: () => this.actions.clear() }, { type: 'separator' },
      { label: 'Settings…', click: () => this.openSettings() }, { role: 'quit' },
    ]))
  }
  private async handle(request: AppRequest): Promise<unknown> {
    switch (request.kind) {
      case 'snapshot': return this.snapshot()
      case 'new': this.newConversation(); return
      case 'open': this.openHome(request.id, request.turnId); return
      case 'ask':
        if (!this.keyPresent) { this.status = 'Choose an answer connection in Settings → Connection to ask a question.'; this.publish(); return }
        return this.actions.ask(request.question.trim())
      case 'stop': this.actions.stop(); return
      case 'settings': this.openSettings(request.category); return
      case 'search': return this.conversations.search(request.query)
      case 'rename': this.conversations.rename(request.id, request.title); return
      case 'contextMenu': {
        const c = this.conversations.get(request.id)
        if (!c || !this.home) return
        Menu.buildFromTemplate([
          { label: 'Rename', click: () => { this.openHome(c.id).webContents.send(AppChannels.navigate, { renameId: c.id }) } },
          { label: c.pinned ? 'Unpin' : 'Pin', click: () => this.conversations.pin(c.id, !c.pinned) },
          { label: 'Delete…', click: async () => { if (await this.confirm('Delete this conversation?', 'Its transcript and generated drawings will be removed from local history.')) { this.actions.stop(); this.conversations.delete(c.id) } } },
        ]).popup({ window: this.home }); return
      }
      case 'updateSettings': {
        const previous = this.settings.get()
        let next = request.settings
        if (typeof next.retention === 'number' && next.retention > 0 && (previous.retention === 'forever' || previous.retention === 0 || next.retention < previous.retention)) {
          if (!await this.confirm('Apply shorter history retention?', 'Older conversations, including pinned ones, will be deleted.', 'Apply retention')) { this.publish(); return }
        }
        this.revokeAgentAuthority()
        try { next = await this.actions.validateSettings?.(next) ?? next; this.settings.set(next) }
        finally { this.revokeAgentAuthority() }
        if (next.saveHistory !== previous.saveHistory || next.retention === 0 || previous.retention === 0) { this.actions.stop(); this.conversations.reset() }
        // Only a packaged app can own a login item, and only an actual change
        // should touch it, so a choice made in System Settings is left alone.
        if (!this.preview && app.isPackaged && next.openAtLogin !== previous.openAtLogin) app.setLoginItemSettings({ openAtLogin: next.openAtLogin })
        this.updateTray(); this.actions.settingsChanged(next, previous)
        this.pruneHistory(); this.publish(); return
      }
      case 'deleteAll': if (await this.confirm('Delete all history?', 'All saved conversations and generated drawings will be removed from this Mac. This cannot be undone.')) { this.actions.stop(); this.conversations.deleteAll(); await this.agent?.purge(undefined, true) }; return
      case 'connection': {
        const command = request.request
        if ((this.preview && command.kind !== 'details') || !this.actions.connectionRequest) return { ok: false, message: 'Connections are disabled in preview.' }
        if (command.kind === 'removeKey' || command.kind === 'signOut') {
          const name = command.kind === 'removeKey' ? command.provider === 'openai' ? 'OpenAI' : PROVIDER_NAMES[command.provider] : 'ChatGPT'
          if (!await this.confirm(command.kind === 'signOut' ? 'Sign out of ChatGPT?' : `Remove ${name} key?`, 'This disconnects it on this Mac and stops the current answer. You can connect again later.', command.kind === 'signOut' ? 'Sign out' : 'Remove')) return { ok: false, message: 'Nothing removed.' }
        }
        if (['snapshot', 'details', 'usage', 'models', 'test'].includes(command.kind)) return this.actions.connectionRequest(command)
        this.revokeAgentAuthority(); this.actions.stop()
        try { return await this.actions.connectionRequest(command) }
        finally { this.revokeAgentAuthority() }
      }
      case 'replaceKey': if (!this.preview) { this.revokeAgentAuthority(); this.actions.replaceKey() }; return
      case 'permission': {
        if (!this.preview && request.permission === 'microphone') {
          const status = microphoneAccessStatus()
          if (status === 'unavailable') throw new Error('This app is missing voice permission descriptions. For development, run pnpm dev:speech-permissions and restart HeyNimbo.')
          if (status === 'not-determined') { await ensureMicrophoneAccess(); this.publish(true); return }
        }
        const panes = { microphone: 'Privacy_Microphone', screen: 'Privacy_ScreenCapture', input: 'Privacy_ListenEvent' }
        if (request.permission in panes && !this.preview) await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[request.permission]}`)
        return
      }
    }
  }
  private async confirm(message: string, detail: string, action = 'Delete'): Promise<boolean> {
    const parent = this.preferences?.isFocused() ? this.preferences : this.home
    const options = { type: 'warning' as const, message, detail, buttons: ['Cancel', action], defaultId: 0, cancelId: 0 }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return result.response === 1
  }
  close(): void { this.agentIpc?.dispose(); this.agent?.dispose(); clearTimeout(this.publishTimer); clearInterval(this.pruneTimer); this.tray?.destroy(); this.conversations.close(); ipcMain.removeHandler(AppChannels.request) }
}
