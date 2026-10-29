import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentChannels, DEFAULT_BUDGET, type AgentApi, type AgentPush, type HostCommand } from '../shared/agent-protocol'
import type { AppSettings } from '../shared/app'
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn(), showOpenDialog: vi.fn(), register: vi.fn(() => true), unregister: vi.fn(), expose: vi.fn(), invoke: vi.fn(async () => ({ ok: true })), rendererOn: vi.fn(), rendererRemove: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler }, dialog: { showOpenDialog: electron.showOpenDialog }, globalShortcut: { register: electron.register, unregister: electron.unregister }, contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: { invoke: electron.invoke, on: electron.rendererOn, removeListener: electron.rendererRemove } }))
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
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
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
it('rejects picker completion after disposal and does not leak filesystem failures', async () => {
  const { ipc, handler, event } = setup()
  let finish!: (value: { canceled: boolean; filePaths: string[] }) => void
  electron.showOpenDialog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = handler(event, { kind: 'pickFolder' })
  ipc.dispose()
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  finish({ canceled: false, filePaths: [dir] })
  await expect(pending).rejects.toThrow('Could not grant folder access.')
})
it('bounds remembered folder grants even when Home keeps picking new folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  const { handler, event } = setup()
  electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] })
  for (let n = 0; n < 128; n++) await handler(event, { kind: 'pickFolder' })
  await expect(handler(event, { kind: 'pickFolder' })).rejects.toThrow('Too many folders. Restart the app to choose more.')
})
it.each([{ saveHistory: false }, { retention: 0 as const }, { saveHistory: true, retention: 30 as const }])('derives persistence and host authority from settings rather than renderer fields: %j', async settings => {
  const { handler, event, commands } = setup({ ...settings, agent: { search: { provider: 'brave' } } })
  await expect(handler(event, { kind: 'start', requestId: 'req', goal: 'Research', mode: 'web' })).resolves.toEqual({ runId: 'run' })
  expect(commands).toEqual([{ kind: 'start', requestId: 'req', goal: 'Research', mode: 'web', grants: [], persistence: settings.saveHistory === false || settings.retention === 0 ? 'temporary' : 'retained', budget: DEFAULT_BUDGET, model: { provider: 'openai', model: 'test-model', effort: 'low', baseURL: 'https://model.invalid' }, search: { provider: 'brave' } }])
  expect(JSON.stringify(commands)).not.toContain('not-for-renderer')
  await expect(handler(event, { kind: 'start', requestId: 'req2', goal: 'Read', mode: 'local', grantIds: ['unknown'] })).rejects.toThrow('Folder access expired. Choose the folder again.')
  await expect(handler(event, { kind: 'start', requestId: 'req3', goal: 'Read', mode: 'web', grantIds: ['unknown'] })).rejects.toThrow('Invalid agent request.')
  await expect(handler(event, { kind: 'start', requestId: 'req4', goal: 'Read', mode: 'local', persistence: 'retained' })).rejects.toThrow('Invalid agent request.')
  expect(commands).toHaveLength(1)
})
it('returns only an opaque folder grant and resolves its canonical root only for a local host start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  const root = join(dir, 'chosen'); await mkdir(root)
  const link = join(dir, 'alias'); await symlink(root, link)
  electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [link] })
  const { handler, event, commands } = setup()
  const picked = await handler(event, { kind: 'pickFolder' }) as { grant: { id: string; label: string } }
  expect(Object.keys(picked.grant).sort()).toEqual(['id', 'label'])
  expect(picked.grant.label).toBe(basename(root))
  expect(JSON.stringify(picked)).not.toContain(dir)
  expect(electron.showOpenDialog.mock.calls[0]![0]).toEqual({ properties: ['openDirectory'] })
  await handler(event, { kind: 'start', requestId: 'req', goal: 'Read', mode: 'local', grantIds: [picked.grant.id] })
  expect(commands[0]).toMatchObject({ grants: [{ id: picked.grant.id, root: await realpath(root), label: basename(root) }] })
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
  expect(accelerator).toBe('Control+Option+Command+.')
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
it('handles cancelled and invalid native selections without granting files or exposing their paths', async () => {
  const { handler, event, frame } = setup()
  for (const selection of [{ canceled: true, filePaths: [] }, { canceled: false, filePaths: [] }]) {
    electron.showOpenDialog.mockResolvedValueOnce(selection)
    await expect(handler(event, { kind: 'pickFolder' })).resolves.toEqual({ cancelled: true })
  }
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-ipc-')); dirs.push(dir)
  const file = join(dir, 'file'); writeFileSync(file, 'fixture')
  for (const path of [file, join(dir, 'missing')]) {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
    await expect(handler(event, { kind: 'pickFolder' })).rejects.toThrow('Could not grant folder access.')
  }
  electron.showOpenDialog.mockImplementationOnce(async () => { frame.url = 'https://navigated.invalid'; return { canceled: false, filePaths: [dir] } })
  await expect(handler(event, { kind: 'pickFolder' })).rejects.toThrow('Could not grant folder access.')
})
it('omits absent model and search options and refuses pushes to a navigated or disposed Home', async () => {
  electron.register.mockReturnValueOnce(false)
  const { ipc, handler, event, commands, contents, frame } = setup({}, true)
  await handler(event, { kind: 'start', requestId: 'req', goal: 'Research', mode: 'web' })
  await handler(event, { kind: 'continue', runId: 'run' })
  expect(commands[0]).toMatchObject({ model: { provider: 'openai', model: 'test-model' } })
  expect(commands[0]).not.toHaveProperty('search')
  expect(commands[1]).toEqual({ kind: 'continue', runId: 'run', model: { provider: 'openai', model: 'test-model' } })
  frame.url = 'https://navigated.invalid'
  ipc.push({ kind: 'host', state: 'ready' })
  expect(contents.send).not.toHaveBeenCalled()
  ipc.dispose()
  expect(electron.unregister).not.toHaveBeenCalled()
  frame.url = pageURL('home')
  ipc.push({ kind: 'host', state: 'ready' })
  expect(contents.send).not.toHaveBeenCalled()
  await expect(handler(event, { kind: 'list', limit: 10 })).rejects.toThrow('Not allowed.')
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
