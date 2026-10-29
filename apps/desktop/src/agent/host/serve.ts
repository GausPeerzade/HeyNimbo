import { isAbsolute } from 'node:path'
import type { AgentRuntime, CredentialSource, RuntimeSink } from '../contracts'
import { LIMITS, RUN_STATUSES, ERROR_CODES, parseAgentEvent, parseAgentRequest, type HostCommand, type HostToMain, type MainToHost } from '../../shared/agent-protocol'

export interface HostPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
}
export interface HostInit { dataDir: string; credentials: CredentialSource; sink: RuntimeSink }

function check(value: unknown): asserts value { if (!value) throw new Error('Invalid agent message.') }
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, keys: string[]): void { check(Object.keys(value).every(key => keys.includes(key))) }
function string(value: unknown, max = 200, empty = false): void { check(typeof value === 'string' && value.length <= max && !value.includes('\0') && (empty || value.trim())) }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void { check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) }
function identifier(value: unknown): void { check(typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)) }
function budget(value: unknown): void {
  const b = object(value), keys = ['maxSteps', 'maxOutputTokens', 'maxWallMs', 'maxToolOutputBytes']
  fields(b, keys)
  for (const key of keys) integer(b[key], 1)
}
function event(value: unknown): void {
  const parsed = parseAgentEvent(value)
  if (parsed.payload.type === 'run.created') budget(parsed.payload.budget)
}
function model(value: unknown): void {
  const m = object(value)
  fields(m, ['provider', 'model', 'effort', 'baseURL'])
  identifier(m.provider); string(m.model, 500)
  if (m.effort !== undefined) check(['low', 'medium', 'high'].includes(m.effort as string))
  if (m.baseURL !== undefined) string(m.baseURL, 2048)
}
function search(value: unknown): void {
  if (value === undefined) return
  const s = object(value)
  check(s.provider === 'brave' || s.provider === 'searxng')
  fields(s, s.provider === 'brave' ? ['provider'] : ['provider', 'baseURL'])
  if (s.provider === 'searxng') string(s.baseURL, 2048)
}
function parseCommand(value: unknown): HostCommand {
  const c = object(value)
  if (c.kind === 'start') {
    fields(c, ['kind', 'requestId', 'goal', 'mode', 'persistence', 'conversationId', 'grants', 'budget', 'model', 'search'])
    parseAgentRequest({ kind: 'start', requestId: c.requestId, goal: c.goal, mode: c.mode, ...(c.conversationId !== undefined ? { conversationId: c.conversationId } : {}) })
    check(c.persistence === 'retained' || c.persistence === 'temporary')
    check(Array.isArray(c.grants) && c.grants.length <= LIMITS.grants)
    check(c.mode !== 'web' || c.grants.length === 0)
    for (const grant of c.grants) {
      const g = object(grant)
      fields(g, ['id', 'root', 'label']); identifier(g.id); string(g.label, 300); string(g.root, 4096)
      check(isAbsolute(g.root as string))
    }
    budget(c.budget)
    model(c.model)
    search(c.search)
  } else if (c.kind === 'continue') {
    fields(c, ['kind', 'runId', 'model', 'search']); identifier(c.runId); model(c.model); search(c.search)
  } else if (c.kind === 'cancelAll') {
    fields(c, ['kind'])
  } else if (c.kind === 'purge') {
    fields(c, ['kind', 'before'])
    if (c.before !== undefined) integer(c.before)
  } else if (c.kind === 'deleteConversation') {
    fields(c, ['kind', 'conversationId']); identifier(c.conversationId)
  } else {
    const parsed = parseAgentRequest(c)
    check(parsed.kind !== 'pickFolder' && parsed.kind !== 'stopAll')
  }
  return c as unknown as HostCommand
}

/** Private transport validators shared by the two trusted process adapters. */
export function parseMainToHost(value: unknown): MainToHost {
  const m = object(value)
  check(m.v === 1)
  switch (m.kind) {
    case 'init': fields(m, ['v', 'kind', 'dataDir']); string(m.dataDir, 4096); check(isAbsolute(m.dataDir as string)); break
    case 'command': fields(m, ['v', 'kind', 'id', 'command']); integer(m.id, 1); parseCommand(m.command); break
    case 'credential':
      integer(m.id, 1)
      check(typeof m.ok === 'boolean')
      fields(m, m.ok ? ['v', 'kind', 'id', 'ok', 'secret'] : ['v', 'kind', 'id', 'ok', 'message'])
      string(m.ok ? m.secret : m.message, m.ok ? 64_000 : 2000, Boolean(m.ok))
      break
    default: throw new Error('Invalid agent message.')
  }
  return m as unknown as MainToHost
}

function summary(value: unknown): void {
  const r = object(value)
  fields(r, ['id', 'conversationId', 'goal', 'mode', 'mixed', 'status', 'persistence', 'created', 'updated', 'usage', 'error'])
  identifier(r.id)
  if (r.conversationId !== undefined) identifier(r.conversationId)
  string(r.goal, LIMITS.goal)
  check(r.mode === 'web' || r.mode === 'local'); check(typeof r.mixed === 'boolean')
  check(RUN_STATUSES.includes(r.status as typeof RUN_STATUSES[number]))
  check(r.persistence === 'retained' || r.persistence === 'temporary')
  integer(r.created); integer(r.updated)
  const u = object(r.usage)
  fields(u, ['inputTokens', 'outputTokens']); integer(u.inputTokens); integer(u.outputTokens)
  if (r.error !== undefined) {
    const e = object(r.error)
    fields(e, ['code', 'message']); check(ERROR_CODES.includes(e.code as typeof ERROR_CODES[number])); string(e.message, 2000)
  }
}
export function parseHostToMain(value: unknown): HostToMain {
  const m = object(value)
  check(m.v === 1)
  switch (m.kind) {
    case 'ready': fields(m, ['v', 'kind']); break
    case 'reply':
      integer(m.id, 1); check(typeof m.ok === 'boolean')
      fields(m, m.ok ? ['v', 'kind', 'id', 'ok', 'result'] : ['v', 'kind', 'id', 'ok', 'message'])
      if (m.ok) check(Object.hasOwn(m, 'result'))
      else string(m.message, 2000)
      break
    case 'events':
      fields(m, ['v', 'kind', 'events', 'runs'])
      check(Array.isArray(m.events) && m.events.length <= 256)
      check(Array.isArray(m.runs) && m.runs.length <= 256)
      m.events.forEach(event); m.runs.forEach(summary)
      break
    case 'partial':
      fields(m, ['v', 'kind', 'runId', 'step', 'text'])
      identifier(m.runId); integer(m.step, 0, 10_000); string(m.text, LIMITS.event, true)
      break
    case 'credential.request': fields(m, ['v', 'kind', 'id', 'name']); integer(m.id, 1); identifier(m.name); break
    default: throw new Error('Invalid agent message.')
  }
  return m as unknown as HostToMain
}

export function serveHost(port: HostPort, compose: (init: HostInit) => Promise<AgentRuntime>) {
  let runtime: AgentRuntime | undefined
  let disposed = false
  let initialized = false
  let invalidMessages = 0
  let credentialId = 0
  const pending = new Map<number, { resolve(secret: string): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  const credentials: CredentialSource = name => new Promise((resolve, reject) => {
    if (disposed) { reject(new Error('Agent host stopped.')); return }
    if (pending.size >= 128 || !/^[A-Za-z0-9_-]{1,200}$/.test(name)) { reject(new Error('Agent credential unavailable.')); return }
    const id = ++credentialId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent credential timed out.')) }, 10_000)
    pending.set(id, { resolve, reject, timer })
    try { port.postMessage({ v: 1, kind: 'credential.request', id, name }) }
    catch { pending.delete(id); clearTimeout(timer); reject(new Error('Agent credential unavailable.')) }
  })
  const send = (message: HostToMain): void => {
    if (disposed) return
    try { port.postMessage(message) } catch { /* The parent may already be gone. */ }
  }
  const sink: RuntimeSink = {
    events(events, runs) {
      const valid = events.filter(value => { try { event(value); return true } catch { invalidMessages++; return false } })
      for (let offset = 0; offset < Math.max(valid.length, runs.length, 1); offset += 256) {
        try { send(parseHostToMain({ v: 1, kind: 'events', events: valid.slice(offset, offset + 256), runs: runs.slice(offset, offset + 256) })) } catch { invalidMessages++ }
      }
    },
    partial(runId, step, text) {
      try { send(parseHostToMain({ v: 1, kind: 'partial', runId, step, text })) } catch { invalidMessages++ }
    },
  }
  port.on('message', message => {
    if (disposed) return
    let m: MainToHost
    try { m = parseMainToHost(message) } catch { invalidMessages++; return }
    if (m.kind === 'credential') {
      const request = pending.get(m.id)
      if (!request) return
      pending.delete(m.id); clearTimeout(request.timer)
      if (m.ok) request.resolve(m.secret)
      else request.reject(new Error('Agent credential unavailable.'))
    } else if (m.kind === 'init' && !initialized) {
      initialized = true
      void (async () => {
        try {
          const value = await compose({ dataDir: m.dataDir, credentials, sink })
          if (disposed) { await value.shutdown(); return }
          runtime = value
          send({ v: 1, kind: 'ready' })
        } catch { /* No ready acknowledgement: main's startup deadline fails closed. */ }
      })()
    } else if (m.kind === 'command') {
      if (!runtime) { send({ v: 1, kind: 'reply', id: m.id, ok: false, message: 'Agent runtime unavailable.' }); return }
      const target = runtime
      void (async () => {
        try { send({ v: 1, kind: 'reply', id: m.id, ok: true, result: await target.handle(m.command) }) }
        catch { send({ v: 1, kind: 'reply', id: m.id, ok: false, message: 'Agent request failed.' }) }
      })()
    }
  })
  return {
    get invalidMessages() { return invalidMessages },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Agent host stopped.')) }
      pending.clear()
      await runtime?.shutdown()
    },
  }
}
