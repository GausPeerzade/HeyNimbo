import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentSupervisor } from './agent-supervisor'
import { composeRuntime } from '../agent/host/compose'
import { serveHost } from '../agent/host/serve'
import { SqliteAgentStore } from '../agent/store'
import { FileArtifactStore } from '../agent/artifacts'
import { agentPaths } from '../agent/paths'
import { DEFAULT_BUDGET, type HostCommand, type MainToHost } from '../shared/agent-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { AppRequest } from '../shared/app'
import { AppShell, brandPath, type ShellActions } from './app-shell'
import { pageURL } from './page-security'
import { DEFAULT_SETTINGS } from './settings'
import { TalkSession, type TalkDeps } from './voice/talk'
const mocks = vi.hoisted(() => ({ menus: [] as Electron.MenuItemConstructorOptions[][], lifecycle: new Map<string, () => void>(), packaged: false, dir: '', confirm: vi.fn(), microphoneStatus: vi.fn(), allowMicrophone: vi.fn(), external: vi.fn(), handler: undefined as ((event: IpcMainInvokeEvent, request: unknown) => unknown) | undefined }))
vi.mock('./audio-window', () => ({ microphoneAccessStatus: mocks.microphoneStatus, ensureMicrophoneAccess: mocks.allowMicrophone }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    minimized = false; fullScreen = false; shown = false; focused = false; visibleOnAllWorkspaces = false
    bounds = { x: 20, y: 20, width: 900, height: 700 }
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, getURL: () => this.webContents.mainFrame.url, send: vi.fn(), setWindowOpenHandler() {}, isLoading: () => false })
    constructor(readonly options: unknown) { super() }
    isDestroyed() { return false }
    isMinimized() { return this.minimized }
    isFullScreen() { return this.fullScreen }
    getNormalBounds() { return this.bounds }
    isFocused() { return this.focused }
    restore() { this.minimized = false }
    show() { this.shown = true }
    focus() { this.focused = true }
    setVisibleOnAllWorkspaces(value: boolean) { this.visibleOnAllWorkspaces = value }
    async loadFile(file: string) { this.webContents.mainFrame.url = file.endsWith('settings.html') ? pageURL('settings') : pageURL('home') }
  }
  return {
    BrowserWindow: Window,
    shell: { openExternal: mocks.external },
    app: { getPath: () => mocks.dir, getVersion: () => '0.1.0', get isPackaged() { return mocks.packaged }, on: (event: string, listener: () => void) => mocks.lifecycle.set(event, listener), focus() {}, setLoginItemSettings() {} },
    ipcMain: { handle: (channel: string, handler: typeof mocks.handler) => { if (channel === 'heynimbo:app-request') mocks.handler = handler }, removeHandler: vi.fn() },
    dialog: { showMessageBox: mocks.confirm },
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }] },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    Menu: { buildFromTemplate: (items: Electron.MenuItemConstructorOptions[]) => { mocks.menus.push(items); return { popup() {} } }, setApplicationMenu() {} },
    Tray: class { setToolTip() {} setContextMenu() {} destroy() {} },
  }
})
let shell: AppShell | undefined, talk: TalkSession | undefined
function fixture(ask: ShellActions['ask'] = () => ({ accepted: true }), extra: Partial<ShellActions> = {}) {
  mocks.dir = mkdtempSync(join(tmpdir(), 'heynimbo-shell-test-'))
  mocks.menus.length = 0; mocks.lifecycle.clear(); mocks.packaged = false
  mocks.confirm.mockReset(); mocks.confirm.mockResolvedValue({ response: 0 })
  const actions = { ...extra, ask: vi.fn(ask), stop: vi.fn(), clear: vi.fn(), replaceKey: vi.fn(), settingsChanged: vi.fn(), permissions: () => ({ microphone: '', screen: '', input: '' }) }
  shell = new AppShell(actions, true)
  const frame = { url: pageURL('home') }, contents = { send: vi.fn(), mainFrame: frame, getURL: () => frame.url }
  shell.home = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { shell, event, contents, actions }
}
afterEach(() => { talk?.close(); talk = undefined; shell?.close(); shell = undefined; vi.restoreAllMocks(); vi.useRealTimers(); if (mocks.dir) rmSync(mocks.dir, { recursive: true, force: true }) })
function agentBridge(shell: AppShell) {
  const inbound = new EventEmitter(), child = new EventEmitter()
  let spawns = 0
  const host = serveHost({ on: (_event, listener) => inbound.on('message', listener), postMessage: message => queueMicrotask(() => child.emit('message', message)) }, composeRuntime)
  const supervisor = new AgentSupervisor({
    spawn: () => { spawns++; return Object.assign(child, { postMessage: (message: MainToHost) => inbound.emit('message', message), kill: () => true }) },
    credentials: async () => { throw new Error('No model access in deletion tests.') }, onPush: () => {}, dataDir: mocks.dir,
  })
  Object.assign(shell, { agent: supervisor })
  return { supervisor, host, spawns: () => spawns }
}
it('brings Home forward once per wait when a background task needs the owner, and again only after it stops waiting', () => {
  const { shell } = fixture()
  Object.assign(shell, { preview: false })
  const open = vi.spyOn(shell, 'openHome').mockImplementation(() => shell.home!)
  const contents = shell.home!.webContents as unknown as { send: ReturnType<typeof vi.fn>; isLoading: () => boolean }
  contents.isLoading = () => false
  const run = (status: string) => ({ id: 'run_1', goal: 'g', mode: 'web', mixed: false, status, persistence: 'retained', created: 1, updated: 2, usage: { inputTokens: 0, outputTokens: 0 } })
  const notice = (status: string) => (shell as unknown as { notice(push: unknown): void }).notice({ kind: 'events', events: [], runs: [run(status)] })
  notice('running'); expect(open).not.toHaveBeenCalled()
  notice('waiting_approval'); notice('waiting_approval'); notice('waiting_user')
  expect(open).toHaveBeenCalledOnce()
  expect(contents.send).toHaveBeenCalledWith('heynimbo:app-navigate', { runId: 'run_1' })
  notice('running'); notice('waiting_user')
  expect(open).toHaveBeenCalledTimes(2)
})
async function seedAgentHistory() {
  const paths = agentPaths(mocks.dir), store = new SqliteAgentStore(paths.db), artifacts = new FileArtifactStore(paths.artifacts)
  for (const [id, created] of [['old', Date.now() - 8 * 86_400_000], ['recent', Date.now()]] as const) {
    store.createRun({ id, requestId: id, goal: 'Retained evidence', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created })
    const meta = await artifacts.save(id, 'note', 'text/plain', new TextEncoder().encode(id))
    store.appendEvent(id, { type: 'artifact', artifactId: meta.id, name: meta.name, mediaType: meta.mediaType, bytes: meta.bytes }, created)
    store.setStatus(id, 'succeeded', created)
  }
  const ids = store.listRuns(10).map(run => ({ id: run.id, artifactId: (store.events(run.id, 0, 10)[0]!.payload as { artifactId: string }).artifactId }))
  store.close()
  return { artifacts, ids }
}
it('applies shorter retention and confirmed delete-all to real agent rows and blobs while cancellation leaves them intact', async () => {
  const { shell, event } = fixture(), { artifacts, ids } = await seedAgentHistory()
  const bridge = agentBridge(shell)
  try {
    await bridge.supervisor.request({ kind: 'list', limit: 10 })
    mocks.confirm.mockResolvedValue({ response: 1 })
    await mocks.handler?.(event, { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, retention: 7 } })
    await vi.waitFor(async () => expect(await bridge.supervisor.request({ kind: 'list', limit: 10 })).toMatchObject({ runs: [{ id: 'recent' }] }))
    expect(await artifacts.read('old', ids.find(run => run.id === 'old')!.artifactId)).toBeUndefined()
    mocks.confirm.mockResolvedValue({ response: 0 })
    await mocks.handler?.(event, { kind: 'deleteAll' })
    expect(await bridge.supervisor.request({ kind: 'list', limit: 10 })).toMatchObject({ runs: [{ id: 'recent' }] })
    mocks.confirm.mockResolvedValue({ response: 1 })
    await mocks.handler?.(event, { kind: 'deleteAll' })
    expect(await bridge.supervisor.request({ kind: 'list', limit: 10 })).toEqual({ runs: [] })
    expect(await artifacts.read('recent', ids.find(run => run.id === 'recent')!.artifactId)).toBeUndefined()
  } finally { bridge.supervisor.dispose(); await bridge.host.dispose() }
})
it.each(['settings', 'key', 'legacy-key', 'connection-refresh'] as const)('revokes in-flight agent credentials before a %s mutation can replace their key or endpoint', async mutation => {
  const { shell, event } = fixture(undefined, { connectionRequest: async () => ({ ok: true, message: 'Changed' }) })
  Object.assign(shell, { preview: false })
  const child = new EventEmitter(), sent: MainToHost[] = []
  let release!: (secret: string) => void
  const supervisor = new AgentSupervisor({ spawn: () => Object.assign(child, { postMessage: (message: MainToHost) => sent.push(message), kill: () => true }), credentials: () => new Promise(resolve => { release = resolve }), onPush() {}, dataDir: mocks.dir })
  Object.assign(shell, { agent: supervisor })
  const command: HostCommand = { kind: 'start', requestId: 'old', goal: 'Old run', mode: 'web', persistence: 'temporary', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'compatible', model: 'fixture', baseURL: 'https://old.invalid/v1' } }
  const pending = supervisor.request(command)
  child.emit('message', { v: 1, kind: 'ready' })
  child.emit('message', { v: 1, kind: 'reply', id: 1, ok: true, result: { runId: 'run' } }); await pending
  child.emit('message', { v: 1, kind: 'credential.request', id: 10, name: 'compatible', baseURL: 'https://old.invalid/v1' })
  const request: AppRequest = mutation === 'settings' ? { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, showMenuBar: false, connection: { ...DEFAULT_SETTINGS.connection!, baseURL: 'https://new.invalid/v1' } } } : mutation === 'key' ? { kind: 'connection', request: { kind: 'saveKey', provider: 'compatible', key: 'synthetic-new-key' } } : { kind: 'replaceKey' }
  if (mutation === 'connection-refresh') shell.keyPresent = shell.keyPresent
  else await mocks.handler?.(event, request)
  release('SYNTHETIC_NEW_ENDPOINT_KEY'); await Promise.resolve()
  expect(JSON.stringify(sent)).not.toContain('SYNTHETIC_NEW_ENDPOINT_KEY')
  child.emit('message', { v: 1, kind: 'credential.request', id: 11, name: 'compatible', baseURL: 'https://old.invalid/v1' }); await Promise.resolve()
  expect(sent.at(-1)).toMatchObject({ kind: 'credential', id: 11, ok: false })
})
type Surface = BrowserWindow & { minimized: boolean; fullScreen: boolean; shown: boolean; focused: boolean; visibleOnAllWorkspaces: boolean; bounds: Electron.Rectangle }
it('keeps Home and Settings native windows reusable and saves normal bounds without accepting renderer navigation', async () => {
  const { shell } = fixture()
  shell.home = undefined
  const home = shell.openHome(undefined, 'turn') as Surface
  home.emit('ready-to-show'); home.webContents.emit('did-finish-load')
  expect(home.webContents.send).toHaveBeenCalledWith('heynimbo:app-navigate', { turnId: 'turn' })
  home.emit('close'); expect(shell.settings.get().homeBounds).toEqual(home.bounds)
  home.fullScreen = true; home.bounds = { ...home.bounds, width: 1200 }; home.emit('close')
  expect(shell.settings.get().homeBounds?.width).toBe(900)
  home.minimized = true; expect(shell.openHome()).toBe(home); expect(home.minimized).toBe(false)
  Object.assign(shell, { preview: false })
  shell.openHome(undefined, 'another-turn'); expect(home.shown).toBe(true); expect(home.focused).toBe(true); expect(home.visibleOnAllWorkspaces).toBe(false)
  const settings = shell.openSettings('Connection') as Surface
  settings.emit('ready-to-show'); settings.webContents.emit('did-finish-load'); settings.emit('focus')
  expect(settings.webContents.send).toHaveBeenCalledWith('heynimbo:app-navigate', { category: 'Connection' })
  settings.minimized = true; expect(shell.openSettings('Privacy')).toBe(settings); expect(settings.minimized).toBe(false)
  expect(settings.webContents.send).toHaveBeenCalledWith('heynimbo:app-navigate', { category: 'Privacy' })
  home.emit('closed'); settings.emit('closed'); expect(shell.home).toBeUndefined(); expect(shell.preferences).toBeUndefined()
})
it('confirms conversation deletion in the focused native window and preserves its exact target until confirmation', async () => {
  const { shell, event } = fixture()
  shell.home = undefined
  const home = shell.openHome() as Surface, id = shell.conversations.newConversation()
  shell.conversations.rename(id, 'Target')
  const ownerEvent = { ...event, sender: home.webContents, senderFrame: home.webContents.mainFrame } as IpcMainInvokeEvent
  await mocks.handler?.(ownerEvent, { kind: 'contextMenu', id: 'missing' }); expect(mocks.menus).toHaveLength(0)
  await mocks.handler?.(ownerEvent, { kind: 'contextMenu', id })
  const actions = mocks.menus.at(-1)!
  const click = async (index: number) => { const action = actions[index]!.click!; await (action as () => unknown)() }
  await click(0); expect(home.webContents.send).toHaveBeenCalledWith('heynimbo:app-navigate', { renameId: id })
  await click(1); expect(shell.conversations.get(id)?.pinned).toBe(true)
  await click(2); expect(shell.conversations.get(id)).toBeDefined()
  mocks.confirm.mockResolvedValueOnce({ response: 1 }); await click(2)
  expect(shell.conversations.get(id)).toBeUndefined()
})
it('routes native menu actions through Home while keeping task deletion and settings changes owner-confirmed', async () => {
  const { shell, event, actions } = fixture()
  shell.home = undefined
  const home = shell.openHome() as Surface
  const ownerEvent = { ...event, sender: home.webContents, senderFrame: home.webContents.mainFrame } as IpcMainInvokeEvent
  const first = shell.conversations.newConversation(), second = shell.conversations.newConversation()
  await mocks.handler?.(ownerEvent, { kind: 'open', id: first, turnId: 'turn' }); expect(shell.conversations.currentId).toBe(first)
  await mocks.handler?.(ownerEvent, { kind: 'rename', id: first, title: 'Renamed' }); expect(shell.conversations.get(first)?.title).toBe('Renamed')
  expect(await mocks.handler?.(ownerEvent, { kind: 'search', query: 'Renamed' })).toEqual(expect.any(Array))
  await mocks.handler?.(ownerEvent, { kind: 'stop' }); shell.stop(); expect(actions.stop).toHaveBeenCalled()
  await mocks.handler?.(ownerEvent, { kind: 'new' }); expect(shell.conversations.currentId).not.toBe(second)
  await mocks.handler?.(ownerEvent, { kind: 'settings', category: 'History & privacy' }); expect(shell.preferences).toBeDefined()
  const previous = shell.settings.get()
  await mocks.handler?.(ownerEvent, { kind: 'updateSettings', settings: { ...previous, retention: 7 } }); expect(shell.settings.get().retention).toBe(previous.retention)
  await mocks.handler?.(ownerEvent, { kind: 'updateSettings', settings: { ...previous, saveHistory: false } }); expect(shell.conversations.currentId).toBeNull()
})
it('keeps native menu and tray actions usable before the lazy agent exists and never persists fullscreen bounds', async () => {
  const fixtureValue = fixture(); fixtureValue.shell.close()
  shell = new AppShell(fixtureValue.actions)
  const appMenu = mocks.menus[0]!, trayMenu = mocks.menus[1]!
  const click = async (action: Electron.MenuItemConstructorOptions) => { await (action.click as () => unknown)() }
  const submenu = (index: number) => appMenu[index]!.submenu as Electron.MenuItemConstructorOptions[]
  await click(submenu(0)[0]!); expect(shell.preferences).toBeDefined()
  await click(submenu(0)[2]!); expect(shell.preferences).toBeDefined()
  await click(submenu(1)[0]!); const home = shell.home as Surface; expect(shell.conversations.currentId).toBeTruthy()
  await click(submenu(1)[1]!); expect(home.webContents.send).toHaveBeenCalledWith('heynimbo:app-navigate', { focusSearch: true })
  vi.spyOn(home.webContents, 'isLoading').mockReturnValueOnce(true)
  await click(submenu(1)[1]!); home.webContents.emit('did-finish-load')
  for (const action of trayMenu.filter(item => item.click)) await click(action)
  expect(fixtureValue.actions.clear).toHaveBeenCalledOnce()
  mocks.lifecycle.get('activate')!(); mocks.lifecycle.get('second-instance')!()
  expect(shell.home).toBe(home)
  home.emit('ready-to-show'); expect(home.shown).toBe(true)
  home.emit('close'); expect(shell.settings.get().homeBounds).toEqual(home.bounds)
  const settings = shell.preferences as Surface
  settings.emit('ready-to-show'); expect(settings.shown).toBe(true)
})
it('validates connection settings before invalidating runs again and applies login changes only for a packaged app', async () => {
  const { shell, event } = fixture(undefined, { validateSettings: async value => value })
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: mocks.dir, configurable: true })
  try {
    expect(brandPath('test')).toContain('build/brand/test')
    mocks.packaged = true; expect(brandPath('test')).toBe(join(mocks.dir, 'brand', 'test'))
    Object.assign(shell, { preview: false })
    await mocks.handler?.(event, { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, openAtLogin: true } })
    expect(shell.settings.get().openAtLogin).toBe(true)
    await mocks.handler?.(event, { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, retention: 0 } })
    expect(shell.settings.get().retention).toBe(0)
  } finally { if (original) Object.defineProperty(process, 'resourcesPath', original); else Reflect.deleteProperty(process, 'resourcesPath') }
})
it('queues daily retention without spawning an idle agent and applies it before the next list', async () => {
  vi.useFakeTimers()
  const { shell } = fixture(); await seedAgentHistory()
  shell.settings.set({ ...DEFAULT_SETTINGS, retention: 7 })
  const bridge = agentBridge(shell)
  try {
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(bridge.spawns()).toBe(0)
    vi.useRealTimers()
    expect(await bridge.supervisor.request({ kind: 'list', limit: 10 })).toMatchObject({ runs: [{ id: 'recent' }] })
  } finally { bridge.supervisor.dispose(); await bridge.host.dispose() }
})
it('rejects app requests from other contents, subframes and navigated documents', () => {
  const { event, contents } = fixture()
  for (const invalid of [{ sender: {} }, { ...event, senderFrame: { url: pageURL('home') } }]) expect(() => mocks.handler?.(invalid as IpcMainInvokeEvent, { kind: 'snapshot' })).toThrow('Not allowed')
  contents.mainFrame.url = 'https://untrusted.invalid'
  expect(() => mocks.handler?.(event, { kind: 'snapshot' })).toThrow('Not allowed')
})
it('rejects invalid request and settings variants without mutation, pruning or cancellation', () => {
  const { shell, event, actions } = fixture()
  shell.settings.set({ ...DEFAULT_SETTINGS, saveHistory: false })
  const write = vi.spyOn(shell.settings, 'set'), prune = vi.spyOn(shell.conversations.history, 'prune'), rename = vi.spyOn(shell.conversations, 'rename')
  for (const value of [{ kind: 'rename', id: 'a' }, { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, voice: ['marin'] } }, { kind: 'updateSettings', settings: { ...DEFAULT_SETTINGS, saveHistory: 'true' } }]) expect(() => mocks.handler?.(event, value)).toThrow()
  for (const fn of [write, prune, rename, actions.stop, actions.settingsChanged]) expect(fn).not.toHaveBeenCalled()
  expect(shell.settings.get().saveHistory).toBe(false)
})
it('acknowledges only a persisted text turn through the real TalkSession path, before capture or the answer finishes', async () => {
  const { shell, event, actions } = fixture(question => talk!.askText(question))
  talk = new TalkSession({
    key: 'fixture', conversations: shell.conversations, capture: () => new Promise(() => {}),
    ears: { cancel() {}, close() {} }, mouth: { cancel() {}, close() {} }, audio: { send() {} },
    onStatus: (label: string | undefined) => shell.setStatus(label), drawing: { draw() {}, answerDone() {} },
  } as unknown as TalkDeps)
  expect(await mocks.handler?.(event, { kind: 'ask', question: 'Not connected' })).toBeUndefined()
  expect(actions.ask).not.toHaveBeenCalled()
  shell.keyPresent = true
  expect(await mocks.handler?.(event, { kind: 'ask', question: '  My question  ' })).toEqual({ accepted: true })
  expect(shell.conversations.turns()[0]?.question).toBe('My question')
  shell.conversations.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(shell.conversations.history, 'begin').mockImplementationOnce(() => { throw new Error('History storage failed') })
  await expect(mocks.handler?.(event, { kind: 'ask', question: 'Keep this draft' })).rejects.toThrow('History storage failed')
  expect(shell.conversations.currentId).toBeNull()
})
it('coalesces repeated snapshot work and flushes the final idle status without a trailing duplicate', () => {
  vi.useFakeTimers()
  const { shell, contents } = fixture()
  const snapshot = vi.spyOn(shell, 'snapshot')
  for (let i = 0; i < 100; i++) shell.publish()
  expect(snapshot).not.toHaveBeenCalled()
  vi.advanceTimersByTime(249); expect(snapshot).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(snapshot).toHaveBeenCalledTimes(1)
  shell.publish(); shell.setStatus(undefined)
  expect(contents.send).toHaveBeenLastCalledWith('heynimbo:app-snapshot', expect.objectContaining({ busy: false, status: '' }))
  expect(snapshot).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(250); expect(snapshot).toHaveBeenCalledTimes(2)
})

it('serves key hints only to the Settings page through the dedicated details request, never app broadcasts', async () => {
  const connectionRequest = vi.fn(async () => ({ ok: true, message: '', keyHints: { openai: { suffix: 'abcd', savedAt: 1793232000000 } } }))
  const { shell, event, contents } = fixture(undefined, { connectionRequest })
  expect(() => mocks.handler?.(event, { kind: 'connection', request: { kind: 'details' } })).toThrow('Not allowed')
  expect(connectionRequest).not.toHaveBeenCalled()
  const frame = { url: pageURL('settings') }, settingsContents = { send: vi.fn(), mainFrame: frame, getURL: () => frame.url }
  shell.preferences = { webContents: settingsContents, isDestroyed: () => false } as unknown as BrowserWindow
  const settingsEvent = { sender: settingsContents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  expect(await mocks.handler?.(settingsEvent, { kind: 'connection', request: { kind: 'details' } })).toMatchObject({ keyHints: { openai: { suffix: 'abcd' } } })
  shell.publish(true)
  for (const target of [contents, settingsContents]) expect(JSON.stringify(target.send.mock.calls)).not.toMatch(/keyHints|abcd/)
  expect(JSON.stringify(await mocks.handler?.(settingsEvent, { kind: 'snapshot' }))).not.toMatch(/keyHints|abcd/)
})
it('requests first-time microphone access from an explicit app action, opens Settings after denial, and never prompts in preview', async () => {
  const { shell, event } = fixture()
  mocks.microphoneStatus.mockReset(); mocks.allowMicrophone.mockReset(); mocks.external.mockReset()
  const request = { kind: 'permission', permission: 'microphone' }
  await mocks.handler?.(event, request)
  expect(mocks.microphoneStatus).not.toHaveBeenCalled(); expect(mocks.allowMicrophone).not.toHaveBeenCalled(); expect(mocks.external).not.toHaveBeenCalled()
  Object.assign(shell, { preview: false })
  mocks.microphoneStatus.mockReturnValue('not-determined'); mocks.allowMicrophone.mockResolvedValue(true)
  const publish = vi.spyOn(shell, 'publish')
  await mocks.handler?.(event, request)
  expect(mocks.allowMicrophone).toHaveBeenCalledOnce(); expect(mocks.external).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledWith(true)
  mocks.microphoneStatus.mockReturnValue('denied'); await mocks.handler?.(event, request)
  expect(mocks.allowMicrophone).toHaveBeenCalledOnce()
  expect(mocks.external).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
  mocks.microphoneStatus.mockReturnValue('unavailable')
  await expect(mocks.handler?.(event, request)).rejects.toThrow('missing voice permission descriptions')
  expect(mocks.allowMicrophone).toHaveBeenCalledOnce()
})
it.each([{ kind: 'removeKey', provider: 'anthropic' }, { kind: 'signOut' }])('requires native confirmation before $kind removes a saved connection', async request => {
  const connectionRequest = vi.fn(async () => ({ ok: true, message: 'Removed.' }))
  const { shell, event, actions } = fixture(undefined, { connectionRequest })
  Object.assign(shell, { preview: false })
  expect(await mocks.handler?.(event, { kind: 'connection', request })).toMatchObject({ ok: false, message: 'Nothing removed.' })
  expect(connectionRequest).not.toHaveBeenCalled(); expect(actions.stop).not.toHaveBeenCalled()
  mocks.confirm.mockResolvedValue({ response: 1 })
  expect(await mocks.handler?.(event, { kind: 'connection', request })).toMatchObject({ ok: true })
  expect(connectionRequest).toHaveBeenCalledWith(request)
  expect(actions.stop).toHaveBeenCalledOnce()
})
