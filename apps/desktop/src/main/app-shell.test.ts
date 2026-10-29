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
import { DEFAULT_BUDGET, type MainToHost } from '../shared/agent-protocol'
import { afterEach, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { AppShell, type ShellActions } from './app-shell'
import { pageURL } from './page-security'
import { DEFAULT_SETTINGS } from './settings'
import { TalkSession, type TalkDeps } from './voice/talk'
const mocks = vi.hoisted(() => ({ dir: '', confirm: vi.fn(), microphoneStatus: vi.fn(), allowMicrophone: vi.fn(), external: vi.fn(), handler: undefined as ((event: IpcMainInvokeEvent, request: unknown) => unknown) | undefined }))
vi.mock('./audio-window', () => ({ microphoneAccessStatus: mocks.microphoneStatus, ensureMicrophoneAccess: mocks.allowMicrophone }))
vi.mock('electron', () => ({
  shell: { openExternal: mocks.external },
  app: { getPath: () => mocks.dir, getVersion: () => '0.1.0', isPackaged: true },
  ipcMain: { handle: (channel: string, handler: typeof mocks.handler) => { if (channel === 'heynimbo:app-request') mocks.handler = handler }, removeHandler: vi.fn() },
  dialog: { showMessageBox: mocks.confirm },
  nativeTheme: { shouldUseDarkColors: false },
}))
let shell: AppShell | undefined, talk: TalkSession | undefined
function fixture(ask: ShellActions['ask'] = () => ({ accepted: true }), extra: Partial<ShellActions> = {}) {
  mocks.dir = mkdtempSync(join(tmpdir(), 'heynimbo-shell-test-'))
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
