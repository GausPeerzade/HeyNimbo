import { parseHostToMain } from '../agent/host/serve'
import { existsSync } from 'node:fs'
import { agentPaths } from '../agent/paths'
import { HOST_MESSAGE_MAX_BYTES, isTerminal, type CancelAllResult, type AgentEvent, type AgentPush, type HostCommand, type HostState, type HostToMain, type MainToHost, type RunSummary } from '../shared/agent-protocol'

export interface ChildLike {
  postMessage(message: MainToHost): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean | void
  pid?: number
}
interface SupervisorDeps {
  spawn(): ChildLike
  forceKill?(pid: number): void
  credentials(name: string, allowed: readonly string[], binding?: { baseURL?: string }): Promise<string>
  onPush(push: AgentPush): void
  dataDir: string
}
interface Pending {
  command: HostCommand
  sent: boolean
  generation: number
  resolve(result: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}
const CRASHED = 'Agent host stopped unexpectedly. Try again.'
const UNAVAILABLE = 'Agent host unavailable. Try again.'
const STOPPED = 'Agent host stopped.'
const FLUSH_BYTES = 4 * 1024 * 1024
/** Structural/string-length lower bound only: reject huge envelopes before
 * scanning UTF-8 or escaping payloads. Exact bytes come from validation once. */
function preflight(value: unknown): number {
  let bytes = 0, nodes = 0
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 16 || bytes > HOST_MESSAGE_MAX_BYTES) throw new Error('Too large.')
    if (typeof value === 'string') bytes += value.length + 2
    else if (value && typeof value === 'object') {
      if (seen.has(value)) throw new Error('Invalid message.')
      seen.add(value); bytes += 2
      if (Array.isArray(value)) {
        if (value.length > 1024) throw new Error('Too large.')
        bytes += Math.max(0, value.length - 1)
        for (const item of value) visit(item === undefined ? null : item, depth + 1)
      } else {
        let count = 0
        for (const [key, item] of Object.entries(value)) if (item !== undefined) {
          if (count++) bytes++
          visit(key, depth + 1); bytes++; visit(item, depth + 1)
        }
      }
      seen.delete(value)
    } else if (value === null) bytes += 4
    else if (typeof value === 'boolean' || typeof value === 'number') bytes += String(value).length
    else if (value !== undefined) throw new Error('Invalid message.')
    if (bytes > HOST_MESSAGE_MAX_BYTES) throw new Error('Too large.')
  }
  visit(value, 0)
  return bytes
}

export class AgentSupervisor {
  state: HostState = 'idle'
  invalidMessages = 0
  private child?: ChildLike
  private disposed = false
  private nextId = 0
  private pending = new Map<number, Pending>()
  private bindings = new Map<number, { allowed: string[]; baseURL?: string; runId?: string }>()
  private authority = 0
  private terminalRuns = new Set<string>()
  private credentialRequests = new Set<number>()
  private stopping = false
  private stopped?: Promise<{ ok: true }>
  private events: AgentEvent[] = []
  private outputBytes = 0
  private runs = new Map<string, RunSummary>()
  private partials = new Map<string, Extract<AgentPush, { kind: 'partial' }>>()
  private flushTimer?: NodeJS.Timeout
  private volumeTimer?: NodeJS.Timeout
  private volume = 0
  private queuedPurge?: Extract<HostCommand, { kind: 'purge' }>
  private inbox: Array<{ child: ChildLike; value: unknown; bytes: number }> = []
  private inboxBytes = 0
  private inboxTurn?: NodeJS.Immediate

  constructor(private readonly deps: SupervisorDeps) {}
  private setState(state: HostState, message?: string): void {
    this.state = state
    this.deps.onPush({ kind: 'host', state, ...(message ? { message } : {}) })
  }
  request(command: HostCommand): Promise<unknown> { return this.submit(command, 30_000) }
  purge(before?: number, explicit = false): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error(STOPPED))
    const command = { kind: 'purge' as const, ...(before !== undefined ? { before } : {}) }
    if (!this.child) {
      if (!explicit) { this.queuedPurge = command; return Promise.resolve({ ok: true }) }
      if (!existsSync(agentPaths(this.deps.dataDir).db)) return Promise.resolve({ ok: true })
    }
    return this.request(command).catch(error => { this.queuedPurge = command; throw error })
  }
  private submit(command: HostCommand, timeoutMs: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error(STOPPED))
    if (this.stopping && command.kind !== 'cancelAll') return Promise.reject(new Error('Agent host is stopping.'))
    if (command.kind === 'list' && this.state === 'idle' && !existsSync(agentPaths(this.deps.dataDir).db)) return Promise.resolve({ runs: [] })
    if (command.kind === 'run' && this.state === 'idle' && !existsSync(agentPaths(this.deps.dataDir).db)) return Promise.reject(new Error('Run not found.'))
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many agent requests. Try again.'))
    if ((command.kind === 'start' || command.kind === 'continue') && this.bindings.size >= 256) return Promise.reject(new Error('Too many agent requests. Try again.'))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); this.bindings.delete(id); reject(new Error('Agent request timed out.')) }, timeoutMs)
      const request: Pending = { command, sent: false, generation: this.authority, resolve, reject, timer }
      this.pending.set(id, request)
      try {
        this.ensureChild()
        if (this.state === 'ready') this.dispatch(id, request)
      } catch { this.fail(UNAVAILABLE, true) }
    })
  }
  private ensureChild(): void {
    if (this.child) return
    this.setState('starting')
    const child = this.child = this.deps.spawn()
    this.credentialRequests = new Set()
    child.on('exit', () => { if (this.child === child) this.fail(CRASHED, false) })
    child.on('message', message => { if (this.child === child) this.receive(child, message) })
    this.send(child, { v: 1, kind: 'init', dataDir: this.deps.dataDir })
  }
  private dispatch(id: number, request: Pending): void {
    if (request.sent || !this.child || !this.pending.has(id)) return
    const command = request.command
    if ((command.kind === 'start' || command.kind === 'continue') && request.generation !== this.authority) {
      clearTimeout(request.timer); this.pending.delete(id)
      request.reject(new Error('Agent connection changed. Start or continue the task again.'))
      return
    }
    request.sent = true
    if (command.kind === 'start' || command.kind === 'continue') {
      if (command.kind === 'continue') for (const [key, binding] of this.bindings) if (binding.runId === command.runId) this.bindings.delete(key)
      if (command.kind === 'continue') this.terminalRuns.delete(command.runId)
      this.bindings.set(id, { allowed: [command.model.provider, ...(command.search?.provider === 'brave' ? ['brave-search'] : [])], baseURL: command.model.baseURL, ...(command.kind === 'continue' ? { runId: command.runId } : {}) })
    }
    this.send(this.child, { v: 1, kind: 'command', id, command: request.command })
  }
  private send(child: ChildLike, message: MainToHost): void {
    try { child.postMessage(message) } catch { if (this.child === child) this.fail(UNAVAILABLE, true) }
  }
  private receive(child: ChildLike, value: unknown): void {
    let bytes: number
    try { bytes = preflight(value) } catch { this.invalidMessages++; return }
    // Large legal batches can arrive together in one MessagePort poll phase.
    // Bound each validation slice, not merely each envelope. Keep subsequent
    // events FIFO (even tiny terminal events); replies/credentials stay immediate.
    if ((value as { kind?: unknown })?.kind === 'events' && (bytes > 64 * 1024 || this.inboxTurn)) {
      if (this.inboxTurn) {
        if (this.inboxBytes + bytes > 16 * 1024 * 1024 || this.inbox.length >= 1024) {
          // Do not silently drop a legal terminal/control event under overload.
          // Surface interruption instead; retained work can resume in a new host.
          this.clearOutput(); this.fail(CRASHED, true)
          return
        }
        this.inbox.push({ child, value, bytes }); this.inboxBytes += bytes
        return
      }
      this.scheduleInbox()
    }
    this.consume(child, value)
  }
  private scheduleInbox(): void {
    this.inboxTurn = setImmediate(() => {
      this.inboxTurn = undefined
      const next = this.inbox.shift()
      if (!next) return
      this.inboxBytes -= next.bytes
      this.scheduleInbox()
      if (this.child === next.child) this.consume(next.child, next.value)
    })
  }
  private clearInbox(): void {
    clearImmediate(this.inboxTurn); this.inboxTurn = undefined
    this.inbox = []; this.inboxBytes = 0
  }
  private consume(child: ChildLike, value: unknown): void {
    let m: HostToMain
    const sizes = new Map<object, number>()
    try { m = parseHostToMain(value, sizes) } catch { this.invalidMessages++; return }
    if (m.kind === 'ready') {
      if (this.state !== 'starting') { this.invalidMessages++; return }
      this.setState('ready')
      if (this.queuedPurge) {
        const purge = this.queuedPurge
        this.queuedPurge = undefined
        void this.request(purge).catch(() => { this.queuedPurge ??= purge })
      }
      for (const [id, request] of this.pending) this.dispatch(id, request)
    } else if (m.kind === 'credential.request') {
      void this.credential(child, m.id, m.name, m.baseURL)
    } else if (this.state !== 'ready') {
      this.invalidMessages++
    } else if (m.kind === 'reply') {
      const pending = this.pending.get(m.id)
      if (!pending?.sent) { this.invalidMessages++; return }
      clearTimeout(pending.timer); this.pending.delete(m.id)
      const binding = this.bindings.get(m.id)
      if (binding && pending.command.kind === 'start' && m.ok && m.result && typeof m.result === 'object' && 'runId' in m.result && typeof m.result.runId === 'string') binding.runId = m.result.runId
      if (!m.ok || (binding?.runId && this.terminalRuns.has(binding.runId))) this.bindings.delete(m.id)
      if (m.ok) pending.resolve(m.result)
      else pending.reject(new Error('Agent request failed.'))
    } else if (m.kind === 'events') {
      this.volumeTimer ??= setTimeout(() => { this.volume = 0; this.volumeTimer = undefined }, 16)
      this.volume += m.events.length + m.runs.length
      if (this.volume > 10_000) { this.clearOutput(); this.fail(CRASHED, true); return }
      for (const event of m.events) if (event.payload.type === 'status' && isTerminal(event.payload.status)) {
        this.terminalRuns.add(event.runId)
        if (this.terminalRuns.size > 256) this.terminalRuns.delete(this.terminalRuns.values().next().value!)
        for (const [key, binding] of this.bindings) if (binding.runId === event.runId) this.bindings.delete(key)
      }
      for (const run of m.runs) { this.reserveOutput(sizes.get(run)!); this.runs.set(run.id, run) }
      for (const event of m.events) { this.reserveOutput(sizes.get(event)!); this.events.push(event) }
      for (const event of m.events) if (event.payload.type === 'text' || (event.payload.type === 'status' && isTerminal(event.payload.status))) this.partials.delete(event.runId)
      const urgent = m.events.some(event => event.payload.type === 'approval.requested' || event.payload.type === 'approval.decided' || event.payload.type === 'question' || (event.payload.type === 'status' && isTerminal(event.payload.status)))
      if (urgent || this.events.length >= 256 || this.runs.size >= 256) this.flush()
      else this.scheduleFlush()
    } else {
      this.reserveOutput(sizes.get(m)!)
      this.partials.set(m.runId, { kind: 'partial', runId: m.runId, step: m.step, text: m.text })
      if (this.partials.size > 256) { this.clearOutput(); this.fail(CRASHED, true); return }
      this.scheduleFlush()
    }
  }
  private async credential(child: ChildLike, id: number, name: string, baseURL?: string): Promise<void> {
    const authority = this.authority, requests = this.credentialRequests
    if (requests.has(id)) { this.invalidMessages++; return }
    try {
      const entries = [...this.bindings.entries()].filter(([, b]) => b.allowed.includes(name) && (name === 'brave-search' ? baseURL === undefined : b.baseURL === baseURL) && (name !== 'compatible' || Boolean(baseURL)))
      if (!entries.length || this.stopping || requests.size >= 128) throw new Error('Denied.')
      const [, binding] = entries[0]!
      requests.add(id)
      const secret = await this.deps.credentials(name, [...binding.allowed], name === 'brave-search' ? undefined : { baseURL })
      if (this.child !== child) return
      if (this.authority !== authority || !entries.some(([key, binding]) => this.bindings.get(key) === binding)) throw new Error('Denied.')
      this.send(child, { v: 1, kind: 'credential', id, ok: true, secret })
    } catch {
      if (this.child === child) this.send(child, { v: 1, kind: 'credential', id, ok: false, message: 'Agent credential unavailable.' })
    } finally { requests.delete(id) }
  }
  private rejectPending(message: string): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.pending.clear()
  }
  private fail(message: string, kill: boolean): void {
    this.clearInbox()
    clearTimeout(this.volumeTimer); this.volumeTimer = undefined; this.volume = 0
    const child = this.child
    this.child = undefined; this.revokeAuthority()
    if (kill) this.terminate(child)
    this.rejectPending(message)
    this.flush()
    this.setState('crashed', message)
  }
  private terminate(child: ChildLike | undefined): void {
    if (!child) return
    let exited = false
    child.on('exit', () => { exited = true })
    try { child.kill() } catch { /* SIGTERM delivery is not proof of termination. */ }
    if (!exited && child.pid !== undefined) {
      try {
        if (this.deps.forceKill) this.deps.forceKill(child.pid)
        else process.kill(child.pid, 'SIGKILL')
      } catch { /* It may have exited between the two signals. */ }
    }
  }
  private reserveOutput(bytes: number): void { if (this.outputBytes + bytes > FLUSH_BYTES) this.flush(); this.outputBytes += bytes }
  private scheduleFlush(): void { this.flushTimer ??= setTimeout(() => this.flush(), 16) }
  private clearOutput(): void {
    clearTimeout(this.flushTimer); this.flushTimer = undefined
    this.events = []; this.runs.clear(); this.partials.clear(); this.outputBytes = 0
  }
  private flush(): void {
    const events = this.events, runs = [...this.runs.values()], partials = [...this.partials.values()]
    this.clearOutput()
    if (events.length || runs.length || partials.length) this.deps.onPush({ kind: 'events', events, runs, ...(partials.length ? { partials: partials.map(({ runId, step, text }) => ({ runId, step, text })) } : {}) })
  }
  /** Revoke before mutating settings/keys, including while credential IO is pending. */
  revokeAuthority(): void { this.authority++; this.bindings.clear(); this.terminalRuns.clear() }
  stopAll(): Promise<{ ok: true }> {
    if (this.stopped) return this.stopped
    if (!this.child) return Promise.resolve({ ok: true })
    this.stopping = true
    this.revokeAuthority()
    this.rejectPending(STOPPED)
    const reap = (): { ok: true } => {
      this.clearInbox()
      const child = this.child
      this.child = undefined
      this.terminate(child)
      this.rejectPending(STOPPED); this.flush()
      this.setState('stopped', STOPPED)
      return { ok: true }
    }
    this.stopped = this.submit({ kind: 'cancelAll' }, 1500).then(result => {
      // Older hosts acknowledge cancellation without proving quiescence. Keep
      // compatibility, but never let a new host's unsettled work strand Do.
      const drain = result as Partial<CancelAllResult> | undefined
      return drain?.ok === true && typeof drain.unsettled === 'number' && drain.unsettled > 0 ? reap() : { ok: true as const }
    }, reap).finally(() => { this.stopping = false; this.stopped = undefined })
    return this.stopped
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearInbox()
    clearTimeout(this.volumeTimer); this.volumeTimer = undefined
    const child = this.child
    this.child = undefined; this.revokeAuthority()
    this.terminate(child); this.rejectPending(STOPPED); this.clearOutput()
    this.setState('stopped')
  }
}
