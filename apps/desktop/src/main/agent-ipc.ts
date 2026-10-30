import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import type { AppSettings } from '../shared/app'
import { AgentChannels, DEFAULT_BUDGET, isTerminal, parseAgentRequest, persistenceFor, type AgentPush, type AgentRequest, type FolderGrant, type RunMode, type RunSummary, type AgentEvent } from '../shared/agent-protocol'
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
  /** Shows Home (creating it if needed) and resolves once it is visible, or undefined if it cannot be. */
  present?(): Promise<BrowserWindow | undefined>
}
/** A task an answer proposed. Only main turns it into authority, after the owner decides. */
export interface TaskStart {
  goal: string; mode: RunMode; conversationId?: string
  /** Aborted when the proposal is withdrawn (Stop, a new question, deletion) before it starts. */
  signal?: AbortSignal
}
/** Main-owned emergency stop avoids every Control-based Explain gesture. */
export const AGENT_STOP_SHORTCUT = 'Command+Option+Shift+.'
export function registerAgentIpc(deps: AgentIpcDeps) {
  let disposed = false
  let authority = 0
  const approvals = new Map<string, Extract<AgentEvent['payload'], { type: 'approval.requested' }>>()
  const runs = new Map<string, RunSummary>()
  let confirmation: { runId: string; controller: AbortController } | undefined
  // One window-wide pause after the owner cancels: the renderer cannot reset it by
  // choosing another kind, task or Stop-all generation. Denials stay available.
  let pausedUntil = 0
  const sequences = new Map<string, number>()
  const obsolete = (runId: string): void => { if (confirmation?.runId === runId) confirmation.controller.abort() }
  const revokeAuthority = (): void => { authority++; approvals.clear(); runs.clear(); sequences.clear(); confirmation?.controller.abort() }
  const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => `\\u{${char.codePointAt(0)!.toString(16)}}`)
  const confirm = async (event: Electron.IpcMainInvokeEvent, runId: string, kind: 'approve' | 'allowMix', message: string, detail: string, current: () => boolean): Promise<void> => {
    const home = deps.home(), generation = authority
    if (confirmation) throw new Error('Finish the open confirmation first.')
    if (!home) throw new Error('Approval expired.')
    if (pausedUntil > Date.now()) throw new Error('Nothing approved.')
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
        pausedUntil = Date.now() + 2000
        throw new Error('Nothing approved.')
      }
    } finally { confirmation = undefined }
  }
  const modelSelection = () => {
    const { provider, model, effort, baseURL } = deps.connections.answer()
    return { provider, model, ...(effort ? { effort } : {}), ...(baseURL ? { baseURL } : {}) }
  }
  /** Decisions are always sheets on a visible Home: on macOS only parented dialogs can be closed when a
   *  proposal is withdrawn (unparented alerts run synchronously). Proposals usually follow a spoken
   *  question with Home hidden, so main brings it forward first, and fails closed if it cannot. */
  const owner = async (): Promise<BrowserWindow> => {
    const visible = (window: BrowserWindow | undefined): window is BrowserWindow => Boolean(window && !window.isDestroyed() && window.isVisible())
    const home = deps.home()
    if (visible(home)) return home
    const shown = await deps.present?.()
    if (!visible(shown)) throw new Error('Could not confirm this task.')
    return shown
  }
  /** The owner's decision before any host, model or network work, as a sheet that withdrawal and
   *  Stop-all close: Start/Cancel for web (its goal can carry screen or conversation details out),
   *  Choose folder/Cancel for files. One native decision at a time, shared with approvals. */
  const decide = async (task: TaskStart): Promise<FolderGrant | boolean> => {
    if (confirmation) throw new Error('Finish the open confirmation first.')
    const controller = new AbortController(), withdraw = (): void => controller.abort()
    task.signal?.addEventListener('abort', withdraw, { once: true })
    confirmation = { runId: '', controller }
    try {
      const parent = await owner()
      if (controller.signal.aborted) throw new Error('Task expired.')
      const web = task.mode === 'web'
      const options: Electron.MessageBoxOptions = web
        ? { type: 'question', message: 'Start a web task?', detail: `Task: ${safe(task.goal)}\n\nHeyNimbo will search and read websites for this task. The task text, including details from your screen or conversation, can be sent to search providers and websites.`, buttons: ['Cancel', 'Start web task'], defaultId: 0, cancelId: 0, signal: controller.signal }
        : { type: 'question', message: 'Let this task read a folder?', detail: `Task: ${safe(task.goal)}\n\nYou choose the folder next. The task can read files only inside it.`, buttons: ['Cancel', 'Choose folder…'], defaultId: 0, cancelId: 0, signal: controller.signal }
      let answer: Electron.MessageBoxReturnValue
      try { answer = await dialog.showMessageBox(parent, options) }
      catch { throw new Error(controller.signal.aborted ? 'Task expired.' : 'Could not confirm this task.') }
      if (controller.signal.aborted) throw new Error('Task expired.')
      if (answer.response !== 1 || web) return answer.response === 1
      // The picker cannot be closed programmatically, but it only opens because the owner just chose
      // it; a withdrawal or Stop-all while it is open still cancels the task afterwards.
      const result = await dialog.showOpenDialog(parent, { title: 'Choose a folder for this task', message: `HeyNimbo can read files in this folder for: ${safe(task.goal)}`, buttonLabel: 'Allow access', properties: ['openDirectory'] })
      if (result.canceled || !result.filePaths[0]) return false
      try {
        const root = await realpath(result.filePaths[0])
        const identity = await stat(root, { bigint: true })
        if (!identity.isDirectory()) throw new Error('Not a directory.')
        return { id: randomUUID(), root, label: basename(root) || root, identity: `${identity.dev}:${identity.ino}` }
      } catch { throw new Error('Could not grant folder access.') }
    } finally { confirmation = undefined; task.signal?.removeEventListener('abort', withdraw) }
  }
  const start = async (task: TaskStart): Promise<{ runId: string } | { cancelled: true }> => {
    if (disposed) throw new Error('Not allowed.')
    const generation = authority
    // Same validation as every host start: bounded goal, known mode, opaque IDs.
    parseAgentRequest({ kind: 'start', requestId: 'validation', goal: task.goal, mode: task.mode, ...(task.conversationId ? { conversationId: task.conversationId } : {}) })
    if (task.signal?.aborted) throw new Error('Task expired.')
    const decision = await decide(task)
    // Withdrawal, Stop-all, a settings change or quit during the decision cancels the task.
    if (disposed || authority !== generation || task.signal?.aborted) throw new Error('Task expired.')
    if (!decision) return { cancelled: true }
    const grant = typeof decision === 'object' ? decision : undefined
    const settings = deps.settings()
    const result = await deps.supervisor.request({ kind: 'start', requestId: randomUUID(), goal: task.goal, mode: task.mode, ...(task.conversationId ? { conversationId: task.conversationId } : {}), grants: grant ? [grant] : [], persistence: persistenceFor(settings), budget: { ...DEFAULT_BUDGET }, model: modelSelection(), ...(settings.agent?.search ? { search: settings.agent.search } : {}) })
    const runId = (result as { runId?: unknown } | undefined)?.runId
    if (typeof runId !== 'string') throw new Error('The task could not start.')
    return { runId }
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
    // Tasks start only from an answer's proposal in main, never from a renderer request.
    if (request.kind === 'start' || request.kind === 'pickFolder') throw new Error('Not allowed.')
    if (request.kind === 'continue') {
      const search = deps.settings().agent?.search
      return deps.supervisor.request({ ...request, model: modelSelection(), ...(search ? { search } : {}) })
    }
    if (request.kind === 'stopAll') { revokeAuthority(); return deps.supervisor.stopAll() }
    return deps.supervisor.request(request)
  })
  return {
    shortcutRegistered,
    revokeAuthority,
    start,
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
      disposed = true; revokeAuthority()
      ipcMain.removeHandler(AgentChannels.request)
      if (shortcutRegistered) globalShortcut.unregister(AGENT_STOP_SHORTCUT)
    },
  }
}
