import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import type { AppSettings } from '../shared/app'
import { AgentChannels, DEFAULT_BUDGET, isTerminal, parseAgentRequest, persistenceFor, type AgentPush, type AgentRequest, type FolderGrant, type RunSummary, type AgentEvent } from '../shared/agent-protocol'
import type { AgentSupervisor } from './agent-supervisor'
import type { Connections } from './connections'
import { isPageSender, pageURL } from './page-security'
import { loadSecret } from './secrets'

/** Check both the run's scope and the current connection, including after IO. */
export async function credentialForAgent(name: string, allowed: readonly string[], connections: Pick<Connections, 'answer'>, settings: () => Pick<AppSettings, 'agent'>, binding?: { baseURL?: string }): Promise<string> {
  try {
    if (!allowed.includes(name)) throw new Error('Denied.')
    if (name === 'brave-search') {
      if (settings().agent?.search?.provider !== 'brave') throw new Error('Denied.')
      const secret = await loadSecret('brave-search-key')
      if (!secret || settings().agent?.search?.provider !== 'brave') throw new Error('Denied.')
      return secret
    }
    const connection = connections.answer()
    if (name !== connection.provider || (name === 'compatible' && !binding?.baseURL) || (binding !== undefined && binding.baseURL !== connection.baseURL)) throw new Error('Denied.')
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
/** Main-owned emergency stop avoids every Control-based Explain gesture. */
export const AGENT_STOP_SHORTCUT = 'Command+Option+Shift+.'
export function registerAgentIpc(deps: AgentIpcDeps) {
  const grants = new Map<string, FolderGrant>()
  let disposed = false
  let authority = 0
  const approvals = new Map<string, Extract<AgentEvent['payload'], { type: 'approval.requested' }>>()
  const runs = new Map<string, RunSummary>()
  let confirmation: { runId: string; controller: AbortController } | undefined
  const cancelled = new Map<string, number>()
  const sequences = new Map<string, number>()
  const obsolete = (runId: string): void => { if (confirmation?.runId === runId) confirmation.controller.abort() }
  const revokeAuthority = (): void => { authority++; approvals.clear(); runs.clear(); sequences.clear(); confirmation?.controller.abort() }
  const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => `\\u{${char.codePointAt(0)!.toString(16)}}`)
  const confirm = async (event: Electron.IpcMainInvokeEvent, runId: string, kind: 'approve' | 'allowMix', message: string, detail: string, current: () => boolean): Promise<void> => {
    const home = deps.home(), generation = authority
    if (confirmation) throw new Error('Finish the open confirmation first.')
    if (!home) throw new Error('Approval expired.')
    const key = `${kind}:${runId}`
    if ((cancelled.get(key) ?? 0) > Date.now()) throw new Error('Nothing approved.')
    const controller = new AbortController()
    confirmation = { runId, controller }
    try {
      let result: Electron.MessageBoxReturnValue
      // Electron 45 supports abort for parented macOS sheets. Keep the global
      // slot until settlement even if a platform ignores/delays native dismissal.
      try { result = await dialog.showMessageBox(home, { type: 'warning', message, detail, buttons: ['Cancel', 'Approve'], defaultId: 0, cancelId: 0, signal: controller.signal }) }
      catch { throw new Error(controller.signal.aborted ? 'Approval expired.' : 'Could not confirm this action.') }
      if (disposed || controller.signal.aborted || authority !== generation || deps.home() !== home || !isPageSender(event, home, 'home') || !current()) throw new Error('Approval expired.')
      if (result.response !== 1) {
        cancelled.delete(key); cancelled.set(key, Date.now() + 2000)
        while (cancelled.size > 256) cancelled.delete(cancelled.keys().next().value!)
        throw new Error('Nothing approved.')
      }
    } finally { confirmation = undefined }
  }
  const shortcutRegistered = globalShortcut.register(AGENT_STOP_SHORTCUT, () => { revokeAuthority(); void deps.supervisor.stopAll().catch(() => {}) })
  ipcMain.handle(AgentChannels.request, async (event, value: unknown) => {
    if (disposed || !isPageSender(event, deps.home(), 'home')) throw new Error('Not allowed.')
    let request: AgentRequest
    try { request = parseAgentRequest(value) } catch { throw new Error('Invalid agent request.') }
    if (confirmation && (request.kind === 'allowMix' || (request.kind === 'approve' && request.decision === 'approved'))) throw new Error('Finish the open confirmation first.')
    if (request.kind === 'approve') {
      const pending = approvals.get(request.runId)
      if (!pending || pending.approvalId !== request.approvalId) throw new Error('Approval expired.')
      if (request.decision === 'approved') {
        const origins = new Set<string>()
        for (const match of pending.preview.matchAll(/https?:\/\/[^\s]+/g)) {
          try { origins.add(new URL(match[0]).origin) } catch { /* A malformed preview cannot invent an origin. */ }
        }
        const detail = [...origins].map(origin => `Origin: ${safe(origin)}\n`).join('') + `Tool: ${safe(pending.tool)}\nPreview: ${safe(pending.preview)}\nDigest: ${safe(pending.digest)}`
        await confirm(event, request.runId, 'approve', 'Approve this agent action?', detail, () => approvals.get(request.runId) === pending)
      }
      if (request.decision === 'denied') obsolete(request.runId)
      approvals.delete(request.runId)
      return deps.supervisor.request(request)
    }
    if (request.kind === 'allowMix') {
      const run = runs.get(request.runId)
      if (!run || isTerminal(run.status) || run.mixed) throw new Error('Approval expired.')
      await confirm(event, request.runId, 'allowMix', 'Allow web and files for this task?', `Task: ${safe(run.goal)}\nThis permits web requests and granted files in the same task. Local content may be sent to the web.`, () => {
        const current = runs.get(request.runId)
        return Boolean(current && !isTerminal(current.status) && !current.mixed)
      })
      runs.set(run.id, { ...run, mixed: true })
      return deps.supervisor.request(request)
    }
    if (request.kind === 'cancel' || request.kind === 'delete' || request.kind === 'continue') { obsolete(request.runId); approvals.delete(request.runId); runs.delete(request.runId) }
    if (request.kind === 'pickFolder') {
      if (grants.size >= 128) throw new Error('Too many folders. Restart the app to choose more.')
      try {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return { cancelled: true }
        const root = await realpath(result.filePaths[0])
        const identity = await stat(root, { bigint: true })
        if (!identity.isDirectory()) throw new Error('Not a directory.')
        if (disposed || !isPageSender(event, deps.home(), 'home') || grants.size >= 128) throw new Error('Not allowed.')
        const grant = { id: randomUUID(), root, label: basename(root) || root, identity: `${identity.dev}:${identity.ino}` }
        grants.set(grant.id, grant)
        return { grant: { id: grant.id, label: grant.label } }
      } catch { throw new Error('Could not grant folder access.') }
    }
    if (request.kind === 'start') {
      const labels = new Set<string>()
      const resolved = (request.grantIds ?? []).map(id => {
        const grant = grants.get(id)
        if (!grant) throw new Error('Folder access expired. Choose the folder again.')
        let label = grant.label
        for (let suffix = 2; labels.has(label); suffix++) label = `${grant.label} (${suffix})`
        labels.add(label)
        return { ...grant, label }
      })
      const { grantIds: _grantIds, ...start } = request
      const { provider, model, effort, baseURL } = deps.connections.answer()
      const settings = deps.settings()
      return deps.supervisor.request({ ...start, grants: resolved, persistence: persistenceFor(settings), budget: { ...DEFAULT_BUDGET }, model: { provider, model, ...(effort ? { effort } : {}), ...(baseURL ? { baseURL } : {}) }, ...(settings.agent?.search ? { search: settings.agent.search } : {}) })
    }
    if (request.kind === 'continue') {
      const { provider, model, effort, baseURL } = deps.connections.answer()
      const search = deps.settings().agent?.search
      return deps.supervisor.request({ ...request, model: { provider, model, ...(effort ? { effort } : {}), ...(baseURL ? { baseURL } : {}) }, ...(search ? { search } : {}) })
    }
    if (request.kind === 'stopAll') { revokeAuthority(); return deps.supervisor.stopAll() }
    return deps.supervisor.request(request)
  })
  return {
    shortcutRegistered,
    revokeAuthority,
    push(push: AgentPush): void {
      if (disposed) return
      // Only live, supervisor-validated events establish pending authority, never
      // historical renderer pages. Keep copies across the native dialog await.
      if (push.kind === 'host' && (push.state === 'crashed' || push.state === 'stopped' || push.state === 'starting')) revokeAuthority()
      if (push.kind === 'events') {
        for (const run of push.runs) {
          runs.set(run.id, { ...run })
          if (isTerminal(run.status)) { obsolete(run.id); approvals.delete(run.id) }
        }
        for (const event of push.events) {
          if (event.seq <= (sequences.get(event.runId) ?? 0)) continue
          sequences.set(event.runId, event.seq)
          const p = event.payload
          if (p.type === 'approval.requested') { obsolete(event.runId); approvals.set(event.runId, { ...p }) }
          if (p.type === 'approval.decided' && approvals.get(event.runId)?.approvalId === p.approvalId) { obsolete(event.runId); approvals.delete(event.runId) }
          if (p.type === 'status' && isTerminal(p.status)) { obsolete(event.runId); approvals.delete(event.runId); runs.delete(event.runId) }
        }
        for (const map of [runs, approvals, sequences]) while (map.size > 256) map.delete(map.keys().next().value!)
      }
      const home = deps.home()
      if (!disposed && home && !home.isDestroyed() && home.webContents.getURL().split('#', 1)[0] === pageURL('home')) home.webContents.send(AgentChannels.push, push)
    },
    dispose(): void {
      if (disposed) return
      disposed = true; grants.clear(); revokeAuthority()
      ipcMain.removeHandler(AgentChannels.request)
      if (shortcutRegistered) globalShortcut.unregister(AGENT_STOP_SHORTCUT)
    },
  }
}
