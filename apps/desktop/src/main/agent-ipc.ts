import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import type { AppSettings } from '../shared/app'
import { AgentChannels, DEFAULT_BUDGET, parseAgentRequest, persistenceFor, type AgentPush, type AgentRequest, type FolderGrant } from '../shared/agent-protocol'
import type { AgentSupervisor } from './agent-supervisor'
import type { Connections } from './connections'
import { isPageSender, pageURL } from './page-security'
import { loadSecret } from './secrets'

/** Check both the run's scope and the current connection, including after IO. */
export async function credentialForAgent(name: string, allowed: readonly string[], connections: Pick<Connections, 'answer'>, settings: () => Pick<AppSettings, 'agent'>): Promise<string> {
  try {
    if (!allowed.includes(name)) throw new Error('Denied.')
    if (name === 'brave-search') {
      if (settings().agent?.search?.provider !== 'brave') throw new Error('Denied.')
      const secret = await loadSecret('brave-search-key')
      if (!secret || settings().agent?.search?.provider !== 'brave') throw new Error('Denied.')
      return secret
    }
    const connection = connections.answer()
    if (name !== connection.provider) throw new Error('Denied.')
    const secret = await connection.credential()
    const current = connections.answer()
    if (current.provider !== connection.provider || current.model !== connection.model || current.baseURL !== connection.baseURL || current.effort !== connection.effort) throw new Error('Denied.')
    return secret
  } catch { throw new Error('Agent credential unavailable.') }
}

interface AgentIpcDeps {
  home(): BrowserWindow | undefined
  settings(): AppSettings
  connections: Pick<Connections, 'answer'>
  supervisor: Pick<AgentSupervisor, 'request' | 'stopAll'>
}
/** Main-owned emergency stop: Control + Option + Command + . works in other apps. */
export const AGENT_STOP_SHORTCUT = 'Control+Option+Command+.'
export function registerAgentIpc(deps: AgentIpcDeps) {
  const grants = new Map<string, FolderGrant>()
  let disposed = false
  const shortcutRegistered = globalShortcut.register(AGENT_STOP_SHORTCUT, () => { void deps.supervisor.stopAll().catch(() => {}) })
  ipcMain.handle(AgentChannels.request, async (event, value: unknown) => {
    if (disposed || !isPageSender(event, deps.home(), 'home')) throw new Error('Not allowed.')
    let request: AgentRequest
    try { request = parseAgentRequest(value) } catch { throw new Error('Invalid agent request.') }
    if (request.kind === 'pickFolder') {
      if (grants.size >= 128) throw new Error('Too many folders. Restart the app to choose more.')
      try {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return { cancelled: true }
        const root = await realpath(result.filePaths[0])
        if (!(await stat(root)).isDirectory()) throw new Error('Not a directory.')
        if (disposed || !isPageSender(event, deps.home(), 'home') || grants.size >= 128) throw new Error('Not allowed.')
        const grant = { id: randomUUID(), root, label: basename(root) || root }
        grants.set(grant.id, grant)
        return { grant: { id: grant.id, label: grant.label } }
      } catch { throw new Error('Could not grant folder access.') }
    }
    if (request.kind === 'start') {
      const resolved = (request.grantIds ?? []).map(id => {
        const grant = grants.get(id)
        if (!grant) throw new Error('Folder access expired. Choose the folder again.')
        return grant
      })
      const { grantIds: _grantIds, ...start } = request
      const { provider, model, effort, baseURL } = deps.connections.answer()
      const settings = deps.settings()
      return deps.supervisor.request({ ...start, grants: resolved, persistence: persistenceFor(settings), budget: { ...DEFAULT_BUDGET }, model: { provider, model, ...(effort ? { effort } : {}), ...(baseURL ? { baseURL } : {}) }, ...(settings.agent?.search ? { search: settings.agent.search } : {}) })
    }
    if (request.kind === 'continue') {
      const { provider, model, effort, baseURL } = deps.connections.answer()
      return deps.supervisor.request({ ...request, model: { provider, model, ...(effort ? { effort } : {}), ...(baseURL ? { baseURL } : {}) } })
    }
    if (request.kind === 'stopAll') return deps.supervisor.stopAll()
    return deps.supervisor.request(request)
  })
  return {
    shortcutRegistered,
    push(push: AgentPush): void {
      const home = deps.home()
      if (!disposed && home && !home.isDestroyed() && home.webContents.getURL().split('#', 1)[0] === pageURL('home')) home.webContents.send(AgentChannels.push, push)
    },
    dispose(): void {
      if (disposed) return
      disposed = true; grants.clear()
      ipcMain.removeHandler(AgentChannels.request)
      if (shortcutRegistered) globalShortcut.unregister(AGENT_STOP_SHORTCUT)
    },
  }
}
