import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentChannels, DEFAULT_BUDGET, type AgentApi, type AgentPush, type HostCommand } from '../shared/agent-protocol'
import type { AppSettings } from '../shared/app'
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), showOpenDialog: vi.fn(), showMessageBox: vi.fn(async (_home: unknown, _options: { detail: string; signal?: AbortSignal }) => ({ response: 0 })), register: vi.fn(() => true), unregister: vi.fn(), expose: vi.fn(), invoke: vi.fn(async () => ({ ok: true })), rendererOn: vi.fn(), rendererRemove: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler }, dialog: { showOpenDialog: electron.showOpenDialog, showMessageBox: electron.showMessageBox }, globalShortcut: { register: electron.register, unregister: electron.unregister }, contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: { invoke: electron.invoke, on: electron.rendererOn, removeListener: electron.rendererRemove } }))
const secretStore = vi.hoisted(() => ({ load: vi.fn(async () => 'brave-secret') }))
vi.mock('./secrets', () => ({ loadSecret: secretStore.load }))
import { credentialForAgent, registerAgentIpc } from './agent-ipc'
import { pageURL } from './page-security'

const dirs: string[] = []
const cleanups: (() => void)[] = []
beforeEach(() => vi.clearAllMocks())
it('exposes only the agent IPC channel and removes the exact push listener from the preload bridge', async () => {
  await import('../preload/app')
  const api = electron.expose.mock.calls.find(call => call[0] === 'heynimboApp')![1] as { agent: AgentApi }
  await expect(api.agent.request({ kind: 'stopAll' })).resolves.toEqual({ ok: true })
  expect(electron.invoke).toHaveBeenCalledWith(AgentChannels.request, { kind: 'stopAll' })
  const listener = vi.fn(), remove = api.agent.onPush(listener)
  const [channel, handler] = electron.rendererOn.mock.calls[0]! as [string, (_event: unknown, push: AgentPush) => void]
  expect(channel).toBe(AgentChannels.push)
  handler({}, { kind: 'host', state: 'ready' })
  expect(listener).toHaveBeenCalledWith({ kind: 'host', state: 'ready' })
  remove()
  expect(electron.rendererRemove).toHaveBeenCalledWith(AgentChannels.push, handler)
})
it('rechecks selected credentials in main and refuses unconfigured Brave and revoked providers', async () => {
  let provider: 'openai' | 'anthropic' = 'openai'
  let brave = false
  let finish!: (secret: string) => void
  const credential = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const connections = { answer: () => ({ provider, model: 'model', vision: false, credential }) }
  const settings = () => ({ agent: brave ? { search: { provider: 'brave' as const } } : undefined })
  await expect(credentialForAgent('anthropic', ['openai'], connections, settings)).rejects.toThrow('Agent credential unavailable.')
  await expect(credentialForAgent('brave-search', ['brave-search'], connections, settings)).rejects.toThrow('Agent credential unavailable.')
  expect(credential).not.toHaveBeenCalled()
  brave = true
  await expect(credentialForAgent('brave-search', ['brave-search'], connections, settings)).resolves.toBe('brave-secret')
  expect(secretStore.load).toHaveBeenCalledWith('brave-search-key')
  const pending = expect(credentialForAgent('openai', ['openai'], connections, settings)).rejects.toThrow('Agent credential unavailable.')
  provider = 'anthropic'; finish('revoked-secret')
  await pending
})
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
function setup(overrides: Partial<AppSettings> = {}, minimalModel = false) {
  const frame = { url: pageURL('home') }
  const contents = { mainFrame: frame, getURL: () => frame.url, send: vi.fn() }
  const home = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const settings: AppSettings = { openAtLogin: false, showMenuBar: true, showNotch: true, voice: 'marin', muted: false, saveHistory: true, retention: 30, ...overrides }
  const commands: HostCommand[] = []
  const supervisor = { request: async (command: HostCommand) => { commands.push(command); return { runId: 'run' } }, stopAll: vi.fn(async () => ({ ok: true as const })) }
  const answer = () => ({ provider: 'openai' as const, model: 'test-model', ...(minimalModel ? {} : { effort: 'low' as const, baseURL: 'https://model.invalid' }), vision: true, credential: async () => 'not-for-renderer' })
  const ipc = registerAgentIpc({ home: () => home, settings: () => settings, connections: { answer }, supervisor })
  cleanups.push(() => ipc.dispose())
  const handler = electron.handle.mock.calls.find(call => call[0] === AgentChannels.request)![1] as (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
  return { ipc, event, frame, commands, handler, supervisor, contents, settings }
}
it('admits only one native confirmation across three live runs and both confirmation kinds', async () => {
  const { ipc, handler, event, commands } = setup()
  const runs = ['one', 'two', 'three'].map(id => ({ id, goal: 'Read then research', mode: 'local' as const, mixed: false, status: 'running' as const, persistence: 'temporary' as const, created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 } }))
  ipc.push({ kind: 'events', runs, events: [{ runId: 'two', seq: 1, id: 'e1', at: 0, payload: { type: 'approval.requested', approvalId: 'a', callId: 'c', tool: 'save_artifact', preview: 'Save', digest: 'digest' } }] })
  let release!: (value: { response: number }) => void
  electron.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = handler(event, { kind: 'allowMix', runId: 'one' })
  await expect(handler(event, { kind: 'approve', runId: 'two', approvalId: 'a', decision: 'approved' })).rejects.toThrow('Finish the open confirmation first.')
  await expect(handler(event, { kind: 'allowMix', runId: 'three' })).rejects.toThrow('Finish the open confirmation first.')
  await expect(handler(event, { kind: 'approve', runId: 'unknown', approvalId: 'unknown', decision: 'approved' })).rejects.toThrow('Finish the open confirmation first.')
  await expect(handler(event, { kind: 'allowMix', runId: 'unknown' })).rejects.toThrow('Finish the open confirmation first.')
  expect(electron.showMessageBox).toHaveBeenCalledOnce()
  release({ response: 1 }); await pending
  expect(commands).toEqual([{ kind: 'allowMix', runId: 'one' }])
})
it.each(['approve', 'allowMix'] as const)('blocks twenty %s retries for two seconds after native Cancel without opening another dialog', async kind => {
  vi.useFakeTimers()
  const { ipc, handler, event, commands } = setup()
  ipc.push({ kind: 'events', runs: [{ id: 'run', goal: 'Read', mode: 'local', mixed: false, status: 'running', persistence: 'temporary', created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 } }], events: [{ runId: 'run', seq: 1, id: 'e1', at: 0, payload: { type: 'approval.requested', approvalId: 'a', callId: 'c', tool: 'save_artifact', preview: 'Save', digest: 'digest' } }] })
  const request = kind === 'approve' ? { kind, runId: 'run', approvalId: 'a', decision: 'approved' } : { kind, runId: 'run' }
  await expect(handler(event, request)).rejects.toThrow('Nothing approved.')
  await vi.advanceTimersByTimeAsync(1999)
  for (let i = 0; i < 20; i++) await expect(handler(event, request)).rejects.toThrow('Nothing approved.')
  expect(electron.showMessageBox).toHaveBeenCalledOnce()
  expect(commands).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
  await handler(event, request)
  expect(electron.showMessageBox).toHaveBeenCalledTimes(2)
  expect(commands).toEqual([request])
})
it('applies the post-Cancel pause to every confirmation so switching kind, task or Stop-all generation cannot reopen a dialog', async () => {
  vi.useFakeTimers()
  const { ipc, handler, event, commands } = setup()
  const live = (id: string) => ({ id, goal: 'Read', mode: 'local' as const, mixed: false, status: 'running' as const, persistence: 'temporary' as const, created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 } })
  const ask = (runId: string, n: number) => ipc.push({ kind: 'events', runs: [live(runId)], events: [{ runId, seq: n, id: `e${runId}${n}`, at: 0, payload: { type: 'approval.requested', approvalId: `a${runId}`, callId: 'c', tool: 'save_artifact', preview: 'Save', digest: 'd' } }] })
  ask('one', 1)
  await expect(handler(event, { kind: 'approve', runId: 'one', approvalId: 'aone', decision: 'approved' })).rejects.toThrow('Nothing approved.')
  await expect(handler(event, { kind: 'allowMix', runId: 'one' })).rejects.toThrow('Nothing approved.')
  for (const id of ['two', 'three', 'four']) {
    await handler(event, { kind: 'stopAll' }); ask(id, 1)
    await expect(handler(event, { kind: 'allowMix', runId: id })).rejects.toThrow('Nothing approved.')
    await expect(handler(event, { kind: 'approve', runId: id, approvalId: `a${id}`, decision: 'approved' })).rejects.toThrow('Nothing approved.')
  }
  expect(electron.showMessageBox).toHaveBeenCalledOnce()
  // Denial needs no confirmation and stays available during the pause.
  await handler(event, { kind: 'approve', runId: 'four', approvalId: 'afour', decision: 'denied' })
  expect(commands).toEqual([{ kind: 'approve', runId: 'four', approvalId: 'afour', decision: 'denied' }])
  await vi.advanceTimersByTimeAsync(2000)
  electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
  await handler(event, { kind: 'allowMix', runId: 'four' })
  expect(electron.showMessageBox).toHaveBeenCalledTimes(2)
})
it('requires main-owned approval of the retained host preview before forwarding an approved decision', async () => {
  vi.useFakeTimers()
  const { ipc, handler, event, commands } = setup()
  const request = { kind: 'approve', runId: 'run', approvalId: 'approval', decision: 'approved' }
  await expect(handler(event, request)).rejects.toThrow('Approval expired.')
  expect(electron.showMessageBox).not.toHaveBeenCalled()
  const pending = { type: 'approval.requested' as const, approvalId: 'approval', callId: 'call', tool: 'fetch_url', preview: 'https://safe.invalid/a\u202E\u2066\u200E\u2028\n\u0001\u0085', digest: 'host_digest' }
  ipc.push({ kind: 'events', runs: [], events: [{ runId: 'run', id: 'e1', seq: 1, at: 0, payload: pending }] })
  await expect(handler(event, request)).rejects.toThrow('Nothing approved.')
  expect(commands).toEqual([])
  expect(electron.showMessageBox.mock.calls[0]?.[1]).toMatchObject({ type: 'warning', buttons: ['Cancel', 'Approve'], defaultId: 0, cancelId: 0 })
  const detail = String(electron.showMessageBox.mock.calls[0]?.[1].detail)
  expect(detail).toContain('Origin: https://safe.invalid\n')
  expect(detail).toContain('host_digest')
  expect(detail).toContain('\\u{202e}\\u{2066}\\u{200e}\\u{2028}\\u{a}\\u{1}\\u{85}')
  await vi.advanceTimersByTimeAsync(2000)
  electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
  await handler(event, request)
  expect(commands).toEqual([request])
  await expect(handler(event, request)).rejects.toThrow('Approval expired.')
  expect(commands).toHaveLength(1)
})
it('refuses a compatible endpoint key unless its requested endpoint still matches before and after loading', async () => {
  let baseURL = 'https://new.invalid/v1'
  let release!: (secret: string) => void
  const credential = () => new Promise<string>(resolve => { release = resolve })
  const connections = { answer: () => ({ provider: 'compatible' as const, model: 'm', baseURL, vision: false, credential }) }
  for (const binding of [undefined, { baseURL: 'https://old.invalid/v1' }]) {
    // A stale run must be denied before even asking the new endpoint for a key.
    const attempt = credentialForAgent('compatible', ['compatible'], connections, () => ({}), binding)
    release?.('SYNTHETIC_NEW_KEY')
    await expect(attempt).rejects.toThrow('Agent credential unavailable.')
  }
  const pending = credentialForAgent('compatible', ['compatible'], connections, () => ({}), { baseURL })
  baseURL = 'https://third.invalid/v1'; release('STALE_KEY')
  await expect(pending).rejects.toThrow('Agent credential unavailable.')
  const valid = credentialForAgent('compatible', ['compatible'], connections, () => ({}), { baseURL })
  release('CURRENT_KEY'); await expect(valid).resolves.toBe('CURRENT_KEY')
})
it.each(['changed', 'decided', 'terminal', 'cancel', 'stop', 'crash', 'settings', 'navigate', 'dispose'] as const)('rejects a native confirmation that became stale during %s without forwarding authority', async invalidation => {
  const { ipc, handler, event, commands, frame } = setup()
  const payload = { type: 'approval.requested' as const, approvalId: 'approval', callId: 'call', tool: 'save_artifact', preview: 'Save the file', digest: 'digest' }
  ipc.push({ kind: 'events', runs: [], events: [{ runId: 'run', seq: 1, id: 'e1', at: 0, payload }] })
  let release!: (value: { response: number }) => void
  electron.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const request = { kind: 'approve', runId: 'run', approvalId: 'approval', decision: 'approved' }
  const pending = handler(event, request)
  expect(commands).toEqual([]) // A programmatic Home request is only a trigger.
  await expect(handler(event, request)).rejects.toThrow('Finish the open confirmation first.')
  expect(electron.showMessageBox).toHaveBeenCalledOnce()
  if (invalidation === 'changed') ipc.push({ kind: 'events', runs: [], events: [{ runId: 'run', seq: 2, id: 'e2', at: 0, payload: { ...payload, preview: 'Different operation', digest: 'new_digest' } }] })
  if (invalidation === 'decided') await handler(event, { ...request, decision: 'denied' })
  if (invalidation === 'terminal') ipc.push({ kind: 'events', runs: [], events: [{ runId: 'run', seq: 2, id: 'e2', at: 0, payload: { type: 'status', status: 'cancelled' } }] })
  if (invalidation === 'cancel') await handler(event, { kind: 'cancel', runId: 'run' })
  if (invalidation === 'stop') await handler(event, { kind: 'stopAll' })
  if (invalidation === 'crash') ipc.push({ kind: 'host', state: 'crashed' })
  if (invalidation === 'settings') ipc.revokeAuthority()
  if (invalidation === 'navigate') frame.url = 'https://navigated.invalid'
  if (invalidation === 'dispose') ipc.dispose()
  if (invalidation !== 'navigate') expect(electron.showMessageBox.mock.calls[0]![1].signal?.aborted).toBe(true)
  release({ response: 1 })
  await expect(pending).rejects.toThrow('Approval expired.')
  expect(commands.filter(command => command.kind === 'approve' && command.decision === 'approved')).toEqual([])
})
it('requires a native mixing confirmation for a known live run and makes the confirmed decision single-use', async () => {
  vi.useFakeTimers()
  const { ipc, handler, event, commands } = setup()
  const request = { kind: 'allowMix', runId: 'run' }
  await expect(handler(event, request)).rejects.toThrow('Approval expired.')
  ipc.push({ kind: 'events', events: [], runs: [{ id: 'run', goal: 'Read \u202E then research', mode: 'local', mixed: false, status: 'running', persistence: 'temporary', created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 } }] })
  await expect(handler(event, request)).rejects.toThrow('Nothing approved.')
  expect(commands).toEqual([])
  expect(electron.showMessageBox.mock.calls[0]?.[1].detail).toContain('Local content may be sent to the web.')
  await vi.advanceTimersByTimeAsync(2000)
  electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
  await handler(event, request)
  expect(commands).toEqual([request])
  await expect(handler(event, request)).rejects.toThrow('Approval expired.')
})
it.each(['stopAll', 'revoke', 'crash', 'shortcut'] as const)('aborts the obsolete dialog on %s but retains its global slot until native settlement and never forwards late approval', async action => {
  const { ipc, handler, event, commands } = setup()
  const run = { id: 'run', goal: 'Read', mode: 'local' as const, mixed: false, status: 'running' as const, persistence: 'temporary' as const, created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 } }
  ipc.push({ kind: 'events', runs: [run], events: [] })
  let release!: (value: { response: number }) => void
  // Electron is the external boundary; deliberately ignore abort to exercise
  // platforms where dismissing the native surface is not immediate/reliable.
  electron.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = expect(handler(event, { kind: 'allowMix', runId: 'run' })).rejects.toThrow('Approval expired.')
  const signal = electron.showMessageBox.mock.calls[0]![1].signal
  expect(signal?.aborted).toBe(false)
  if (action === 'stopAll') await handler(event, { kind: 'stopAll' })
  if (action === 'revoke') ipc.revokeAuthority()
  if (action === 'crash') ipc.push({ kind: 'host', state: 'crashed' })
  if (action === 'shortcut') (electron.register.mock.calls[0] as unknown as [string, () => void])[1]()
  expect(signal?.aborted).toBe(true)
  for (let epoch = 0; epoch < 4; epoch++) {
    ipc.push({ kind: 'events', runs: [{ ...run, id: `new-${epoch}` }], events: [] })
    await expect(handler(event, { kind: 'allowMix', runId: `new-${epoch}` })).rejects.toThrow('Finish the open confirmation first.')
    await handler(event, { kind: 'stopAll' })
  }
  expect(electron.showMessageBox).toHaveBeenCalledOnce()
  release({ response: 1 }); await pending
  expect(commands).toEqual([])
})
it('releases the global slot when an abort-supporting native dialog rejects and allows a fresh generation to confirm', async () => {
  const { ipc, handler, event, commands } = setup()
  const run = { id: 'run', goal: 'Read', mode: 'local' as const, mixed: false, status: 'running' as const, persistence: 'temporary' as const, created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 } }
  ipc.push({ kind: 'events', runs: [run], events: [] })
  electron.showMessageBox.mockImplementationOnce((_home, options) => new Promise((_resolve, reject) => { options.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_NATIVE_ABORT'))) }))
  const pending = handler(event, { kind: 'allowMix', runId: 'run' })
  await handler(event, { kind: 'stopAll' })
  await expect(pending).rejects.toThrow('Approval expired.')
  ipc.push({ kind: 'events', runs: [{ ...run, id: 'fresh' }], events: [] })
  electron.showMessageBox.mockResolvedValueOnce({ response: 1 })
  await handler(event, { kind: 'allowMix', runId: 'fresh' })
  expect(commands).toEqual([{ kind: 'allowMix', runId: 'fresh' }])
  expect(electron.showMessageBox).toHaveBeenCalledTimes(2)
})
it('hides native confirmation failures instead of exposing platform diagnostics to Home', async () => {
  const { ipc, handler, event, commands } = setup()
  ipc.push({ kind: 'events', runs: [], events: [{ runId: 'run', seq: 1, id: 'e1', at: 0, payload: { type: 'approval.requested', approvalId: 'approval', callId: 'call', tool: 'save_artifact', preview: 'Save file', digest: 'digest' } }] })
  electron.showMessageBox.mockRejectedValueOnce(new Error('PRIVATE_PLATFORM_PATH'))
  await expect(handler(event, { kind: 'approve', runId: 'run', approvalId: 'approval', decision: 'approved' })).rejects.toThrow('Could not confirm this action.')
  expect(commands).toEqual([])
})
it('refuses renderer-initiated starts and folder pickers: only an answer proposal in main can start a task', async () => {
  const { handler, event, commands } = setup()
  await expect(handler(event, { kind: 'start', requestId: 'req', goal: 'Research', mode: 'web' })).rejects.toThrow('Not allowed.')
  await expect(handler(event, { kind: 'pickFolder' })).rejects.toThrow('Not allowed.')
  expect(electron.showOpenDialog).not.toHaveBeenCalled(); expect(commands).toEqual([])
})
it.each([{ saveHistory: false }, { retention: 0 as const }, { saveHistory: true, retention: 30 as const }])('derives persistence, model and search for a proposed web task from main state, never the proposal: %j', async settings => {
  const { ipc, commands } = setup({ ...settings, agent: { search: { provider: 'brave' } } })
  await expect(ipc.start({ goal: 'Research', mode: 'web', conversationId: 'conversation-1' })).resolves.toEqual({ runId: 'run' })
  expect(commands).toEqual([{ kind: 'start', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), goal: 'Research', mode: 'web', conversationId: 'conversation-1', grants: [], persistence: settings.saveHistory === false || settings.retention === 0 ? 'temporary' : 'retained', budget: DEFAULT_BUDGET, model: { provider: 'openai', model: 'test-model', effort: 'low', baseURL: 'https://model.invalid' }, search: { provider: 'brave' } }])
  expect(JSON.stringify(commands)).not.toContain('not-for-renderer')
  expect(electron.showOpenDialog).not.toHaveBeenCalled()
})
it.each(['', '   ', 'x'.repeat(16001)])('rejects an invalid proposed goal before any picker or host command: %#', async goal => {
  const { ipc, commands } = setup()
  await expect(ipc.start({ goal, mode: 'local' })).rejects.toThrow()
  expect(electron.showOpenDialog).not.toHaveBeenCalled(); expect(commands).toEqual([])
})
it('grants exactly the canonical folder the owner picks in a native sheet that names the task, and never returns its path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  const root = join(dir, 'chosen'); await mkdir(root)
  const link = join(dir, 'alias'); await symlink(root, link)
  electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [link] })
  const { ipc, commands } = setup()
  const result = await ipc.start({ goal: 'List TODOs \u202E in my project', mode: 'local' })
  expect(result).toEqual({ runId: 'run' })
  const [parent, options] = electron.showOpenDialog.mock.calls[0]! as unknown as [unknown, Electron.OpenDialogOptions]
  expect(parent).toBeDefined()
  expect(options).toMatchObject({ properties: ['openDirectory'], buttonLabel: 'Allow access' })
  expect(options.message).toContain('List TODOs \\u{202e} in my project')
  const canonical = await realpath(root), identity = await stat(canonical, { bigint: true })
  expect(commands).toEqual([expect.objectContaining({ kind: 'start', mode: 'local', grants: [{ id: expect.any(String), root: canonical, label: basename(canonical), identity: `${identity.dev}:${identity.ino}` }] })])
  expect(JSON.stringify(result)).not.toContain(dir)
})
it('treats a cancelled picker as no task and a file or missing selection as a hidden failure', async () => {
  const { ipc, commands } = setup()
  for (const selection of [{ canceled: true, filePaths: [] }, { canceled: false, filePaths: [] }]) {
    electron.showOpenDialog.mockResolvedValueOnce(selection)
    await expect(ipc.start({ goal: 'Read', mode: 'local' })).resolves.toEqual({ cancelled: true })
  }
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  const file = join(dir, 'file'); writeFileSync(file, 'fixture')
  for (const path of [file, join(dir, 'missing')]) {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
    await expect(ipc.start({ goal: 'Read', mode: 'local' })).rejects.toThrow('Could not grant folder access.')
  }
  expect(commands).toEqual([])
})
it.each(['stopAll', 'revoke', 'shortcut', 'dispose'] as const)('withdraws a task whose folder picker was open during %s', async action => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  const { ipc, handler, event, commands } = setup()
  let finish!: (value: { canceled: boolean; filePaths: string[] }) => void
  electron.showOpenDialog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = ipc.start({ goal: 'Read', mode: 'local' })
  await expect(ipc.start({ goal: 'Another', mode: 'local' })).rejects.toThrow('Finish choosing the folder for the other task first.')
  if (action === 'stopAll') await handler(event, { kind: 'stopAll' })
  if (action === 'revoke') ipc.revokeAuthority()
  if (action === 'shortcut') (electron.register.mock.calls[0] as unknown as [string, () => void])[1]()
  if (action === 'dispose') ipc.dispose()
  finish({ canceled: false, filePaths: [dir] })
  await expect(pending).rejects.toThrow('Task expired.')
  expect(commands.filter(command => command.kind === 'start')).toEqual([])
  if (action !== 'dispose') { electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] }); await expect(ipc.start({ goal: 'Read', mode: 'local' })).resolves.toEqual({ cancelled: true }) }
})
it('rejects a host reply without a run ID and omits absent model and search options', async () => {
  const { ipc, commands, supervisor } = setup({}, true)
  await ipc.start({ goal: 'Research', mode: 'web' })
  expect(commands[0]).toMatchObject({ model: { provider: 'openai', model: 'test-model' } })
  expect(commands[0]).not.toHaveProperty('search'); expect(commands[0]).not.toHaveProperty('conversationId')
  supervisor.request = async () => ({ ok: true }) as never
  await expect(ipc.start({ goal: 'Research', mode: 'web' })).rejects.toThrow('The task could not start.')
})
it('refuses pushes to a navigated or disposed Home and refuses starts after disposal', async () => {
  electron.register.mockReturnValueOnce(false)
  const { ipc, handler, event, contents, frame } = setup()
  frame.url = 'https://navigated.invalid'
  ipc.push({ kind: 'host', state: 'ready' })
  expect(contents.send).not.toHaveBeenCalled()
  ipc.dispose()
  expect(electron.unregister).not.toHaveBeenCalled()
  frame.url = pageURL('home')
  ipc.push({ kind: 'host', state: 'ready' })
  expect(contents.send).not.toHaveBeenCalled()
  await expect(handler(event, { kind: 'list', limit: 10 })).rejects.toThrow('Not allowed.')
  await expect(ipc.start({ goal: 'Research', mode: 'web' })).rejects.toThrow('Not allowed.')
})
it('forwards the current search configuration on Continue without credentials', async () => {
  const { handler, event, commands, settings } = setup({ agent: { search: { provider: 'brave' } } })
  await handler(event, { kind: 'continue', runId: 'run' })
  expect(commands[0]).toMatchObject({ kind: 'continue', search: { provider: 'brave' } })
  settings.agent = { search: { provider: 'searxng', baseURL: 'https://search.invalid' } }
  await handler(event, { kind: 'continue', runId: 'run' })
  expect(commands[1]).toMatchObject({ search: settings.agent.search })
  expect(JSON.stringify(commands)).not.toContain('not-for-renderer')
})
it('forwards narrow task requests and delivers Stop-all from the global shortcut without window focus', async () => {
  const { ipc, handler, event, commands, supervisor, contents, frame } = setup()
  await handler(event, { kind: 'continue', runId: 'run' })
  expect(commands).toEqual([{ kind: 'continue', runId: 'run', model: { provider: 'openai', model: 'test-model', effort: 'low', baseURL: 'https://model.invalid' } }])
  await handler(event, { kind: 'list', limit: 10 })
  expect(commands[1]).toEqual({ kind: 'list', limit: 10 })
  await handler(event, { kind: 'stopAll' })
  expect(supervisor.stopAll).toHaveBeenCalledTimes(1)
  const [accelerator, callback] = electron.register.mock.calls[0]! as unknown as [string, () => void]
  expect(accelerator).toBe('Command+Option+Shift+.')
  expect(accelerator).not.toContain('Control')
  frame.url = 'https://not-focused.invalid'
  callback()
  await Promise.resolve()
  expect(supervisor.stopAll).toHaveBeenCalledTimes(2)
  frame.url = pageURL('home')
  ipc.push({ kind: 'host', state: 'ready' })
  expect(contents.send).toHaveBeenCalledWith(AgentChannels.push, { kind: 'host', state: 'ready' })
  ipc.dispose()
  expect(electron.unregister).toHaveBeenCalledWith(accelerator)
  expect(electron.removeHandler).toHaveBeenCalledWith(AgentChannels.request)
})
it('returns only the selected model credential and hides missing Brave-key errors', async () => {
  const connections = { answer: () => ({ provider: 'openai' as const, model: 'm', vision: false, credential: async () => 'model-secret' }) }
  await expect(credentialForAgent('openai', ['openai'], connections, () => ({}))).resolves.toBe('model-secret')
  await expect(credentialForAgent('anthropic', ['anthropic'], connections, () => ({}))).rejects.toThrow('Agent credential unavailable.')
  secretStore.load.mockResolvedValueOnce('')
  await expect(credentialForAgent('brave-search', ['brave-search'], connections, () => ({ agent: { search: { provider: 'brave' } } }))).rejects.toThrow('Agent credential unavailable.')
})
it('rejects non-Home frames and navigated Home documents before they can start work', async () => {
  const { event, handler, frame, commands } = setup()
  await expect(handler({ ...event, sender: {} } as IpcMainInvokeEvent, { kind: 'list', limit: 10 })).rejects.toThrow('Not allowed.')
  await expect(handler({ ...event, senderFrame: { url: pageURL('home') } } as IpcMainInvokeEvent, { kind: 'list', limit: 10 })).rejects.toThrow('Not allowed.')
  frame.url = pageURL('settings')
  await expect(handler(event, { kind: 'list', limit: 10 })).rejects.toThrow('Not allowed.')
  expect(commands).toEqual([])
})
