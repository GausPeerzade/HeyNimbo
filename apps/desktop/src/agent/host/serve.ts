import { isAbsolute } from 'node:path'
import type { AgentRuntime, CredentialSource, RuntimeSink } from '../contracts'
import { HOST_MESSAGE_MAX_BYTES, LIMITS, RUN_STATUSES, ERROR_CODES, parseAgentRequest, type AgentEventType, type AgentEvent, type RunSummary, type HostCommand, type HostToMain, type MainToHost } from '../../shared/agent-protocol'

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
const EVENT_FIELDS: Record<AgentEventType, string[]> = {
  'run.created': ['goal', 'mode', 'persistence', 'budget'], status: ['status', 'reason'], text: ['step', 'text'],
  'tool.call': ['step', 'callId', 'tool', 'input'], 'tool.result': ['callId', 'ok', 'summary', 'artifactId'], 'tool.denied': ['callId', 'reason'],
  'approval.requested': ['approvalId', 'callId', 'tool', 'preview', 'digest'], 'approval.decided': ['approvalId', 'decision'],
  question: ['questionId', 'text'], answer: ['questionId', 'text'], artifact: ['artifactId', 'name', 'mediaType', 'bytes'],
  'mode.mixed': ['allowed'], usage: ['inputTokens', 'outputTokens'], error: ['code', 'message'],
}
const BATCH_BYTES = Buffer.byteLength('{"v":1,"kind":"events","events":[],"runs":[]}')
const EVENT_SHELL_CHARS = '{"runId":"","seq":,"id":"","at":,"payload":}'.length
/** Same event vocabulary as the public validator, with one serialization for
 * both the payload limit and UTF-8 accounting. Main must not serialize again. */
function event(value: unknown): number {
  const e = object(value), p = object(e.payload)
  fields(e, ['runId', 'seq', 'id', 'at', 'payload'])
  identifier(e.runId); identifier(e.id); integer(e.seq, 1); integer(e.at)
  check(typeof p.type === 'string' && Object.hasOwn(EVENT_FIELDS, p.type))
  const type = p.type as AgentEventType
  fields(p, ['type', ...EVENT_FIELDS[type]])
  const text = (key: string, max: number = LIMITS.event, nonempty = false): void => {
    check(typeof p[key] === 'string' && p[key].length <= max && (!nonempty || p[key].trim()))
  }
  const member = (value: unknown, values: readonly string[]): void => { check(typeof value === 'string' && values.includes(value)) }
  switch (type) {
    case 'run.created': text('goal', LIMITS.goal, true); member(p.mode, ['web', 'local']); member(p.persistence, ['retained', 'temporary']); budget(p.budget); break
    case 'status': member(p.status, RUN_STATUSES); if (p.reason !== undefined) text('reason', 2000); break
    case 'text': integer(p.step, 0, 10_000); text('text'); break
    case 'tool.call': integer(p.step, 0, 10_000); identifier(p.callId); text('tool', 100, true); text('input', 8000); break
    case 'tool.result': identifier(p.callId); check(typeof p.ok === 'boolean'); text('summary', 8000); if (p.artifactId !== undefined) identifier(p.artifactId); break
    case 'tool.denied': identifier(p.callId); text('reason', 2000, true); break
    case 'approval.requested': identifier(p.approvalId); identifier(p.callId); text('tool', 100, true); text('preview', 8000, true); text('digest', 128, true); break
    case 'approval.decided': identifier(p.approvalId); member(p.decision, ['approved', 'denied']); break
    case 'question': case 'answer': identifier(p.questionId); text('text', LIMITS.answer, true); break
    case 'artifact': identifier(p.artifactId); text('name', 300, true); text('mediaType', 200, true); integer(p.bytes); break
    case 'mode.mixed': member(p.allowed, ['web', 'local']); break
    case 'usage': integer(p.inputTokens); integer(p.outputTokens); break
    case 'error': member(p.code, ERROR_CODES); text('message', 2000, true); break
  }
  const serialized = JSON.stringify(e)
  // Metadata is required ASCII and integer-only, so this subtraction is exact
  // even when MessagePort delivers properties in a different insertion order.
  const shell = EVENT_SHELL_CHARS + (e.runId as string).length + (e.id as string).length + String(e.seq).length + String(e.at).length
  check(serialized.length - shell <= LIMITS.event)
  return Buffer.byteLength(serialized)
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
      fields(g, ['id', 'root', 'label', 'identity']); identifier(g.id); string(g.label, 300); string(g.root, 4096)
      if (g.identity !== undefined) check(typeof g.identity === 'string' && /^\d{1,30}:\d{1,30}$/.test(g.identity))
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

function summary(value: unknown): number {
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
  return Buffer.byteLength(JSON.stringify(r))
}
export function parseHostToMain(value: unknown, sizes = new Map<object, number>()): HostToMain {
  const m = object(value)
  let bytes: number | undefined
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
      bytes = BATCH_BYTES
      for (const [values, validate] of [[m.events, event], [m.runs, summary]] as const) {
        for (const value of values) {
          const size = validate(value)
          sizes.set(value, size); bytes += size
        }
        bytes += Math.max(0, values.length - 1)
      }
      break
    case 'partial':
      fields(m, ['v', 'kind', 'runId', 'step', 'text'])
      identifier(m.runId); integer(m.step, 0, 10_000); string(m.text, LIMITS.event, true)
      break
    case 'credential.request':
      fields(m, ['v', 'kind', 'id', 'name', 'baseURL']); integer(m.id, 1); identifier(m.name)
      if (m.baseURL !== undefined) string(m.baseURL, 2048)
      break
    default: throw new Error('Invalid agent message.')
  }
  bytes ??= Buffer.byteLength(JSON.stringify(m))
  check(bytes <= HOST_MESSAGE_MAX_BYTES)
  sizes.set(m, bytes)
  return m as unknown as HostToMain
}

export function serveHost(port: HostPort, compose: (init: HostInit) => Promise<AgentRuntime>) {
  let runtime: AgentRuntime | undefined
  let disposed = false
  let initialized = false
  let invalidMessages = 0
  let credentialId = 0
  const pending = new Map<number, { resolve(secret: string): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  const credentials: CredentialSource = (name, binding) => new Promise((resolve, reject) => {
    if (disposed) { reject(new Error('Agent host stopped.')); return }
    if (pending.size >= 128 || !/^[A-Za-z0-9_-]{1,200}$/.test(name)) { reject(new Error('Agent credential unavailable.')); return }
    const id = ++credentialId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent credential timed out.')) }, 10_000)
    pending.set(id, { resolve, reject, timer })
    try { port.postMessage({ v: 1, kind: 'credential.request', id, name, ...(binding?.baseURL !== undefined ? { baseURL: binding.baseURL } : {}) }) }
    catch { pending.delete(id); clearTimeout(timer); reject(new Error('Agent credential unavailable.')) }
  })
  const send = (message: HostToMain): void => {
    if (disposed) return
    // Results are not chunkable in v1. Reject oversized pages/previews in the
    // host rather than leaving main to drop the reply and wait for its deadline.
    if (message.kind === 'reply' && message.ok && Buffer.byteLength(JSON.stringify(message)) > HOST_MESSAGE_MAX_BYTES) message = { v: 1, kind: 'reply', id: message.id, ok: false, message: 'Agent response too large.' }
    try { port.postMessage(message) } catch { /* The parent may already be gone. */ }
  }
  const sink: RuntimeSink = {
    events(events, runs) {
      let batch: Extract<HostToMain, { kind: 'events' }> = { v: 1, kind: 'events', events: [], runs: [] }, bytes = BATCH_BYTES
      const flush = (): void => { if (batch.events.length || batch.runs.length) send(batch); batch = { v: 1, kind: 'events', events: [], runs: [] }; bytes = BATCH_BYTES }
      for (const [kind, values] of [['events', events], ['runs', runs]] as const) for (const value of values) {
        try {
          const size = kind === 'events' ? event(value) : summary(value)
          if (batch[kind].length >= 256 || bytes + size + (batch[kind].length ? 1 : 0) > HOST_MESSAGE_MAX_BYTES) flush()
          bytes += size + (batch[kind].length ? 1 : 0)
          if (kind === 'events') batch.events.push(value as AgentEvent)
          else batch.runs.push(value as RunSummary)
        } catch { invalidMessages++ }
      }
      flush()
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
