import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAgentStore } from '../agent/store'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSupervisor } from './agent-supervisor'
import { DEFAULT_BUDGET, type AgentEvent, type AgentPush, type HostCommand, type MainToHost, type RunSummary } from '../shared/agent-protocol'

class Child extends EventEmitter {
  pid?: number
  sent: MainToHost[] = []
  killed = false
  postMessage(message: MainToHost): void { this.sent.push(message) }
  kill(): boolean { this.killed = true; return true }
  ready(): void { this.emit('message', { v: 1, kind: 'ready' }) }
  reply(result: unknown = { ok: true }): void {
    const last = this.sent.findLast(message => message.kind === 'command')
    if (last?.kind !== 'command') throw new Error('No command.')
    this.emit('message', { v: 1, kind: 'reply', id: last.id, ok: true, result })
  }
}
const start: HostCommand = { kind: 'start', requestId: 'request', goal: 'Research', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'openai', model: 'test-model' } }
function setup() {
  const children: Child[] = [], pushes: AgentPush[] = []
  const credentials = vi.fn(async () => 'test-secret')
  const supervisor = new AgentSupervisor({ spawn: () => { const child = new Child(); children.push(child); return child }, credentials, onPush: push => pushes.push(push), dataDir: '/data' })
  return { supervisor, children, pushes, credentials }
}
afterEach(() => vi.useRealTimers())
it('queues only the latest idle retention purge and dispatches it before new work after ready', async () => {
  const { supervisor, children } = setup()
  await supervisor.purge(100)
  await supervisor.purge(200)
  expect(children).toHaveLength(0)
  const started = supervisor.request(start), child = children[0]!
  child.ready()
  const commands = child.sent.filter(m => m.kind === 'command')
  expect(commands.map(m => m.command.kind)).toEqual(['purge', 'start'])
  expect(commands[0]!.command).toEqual({ kind: 'purge', before: 200 })
  child.emit('message', { v: 1, kind: 'reply', id: commands[0]!.id, ok: true, result: { ok: true } })
  child.reply(); await started
  const pruning = supervisor.purge(300)
  expect(child.sent.at(-1)).toMatchObject({ command: { kind: 'purge', before: 300 } })
  child.reply(); await pruning
  supervisor.dispose()
})
it('retries a rejected queued purge before new work after a host crash and restart', async () => {
  const { supervisor, children } = setup()
  await supervisor.purge(100)
  const started = supervisor.request(start), first = children[0]!
  first.ready()
  const purge = first.sent.find(m => m.kind === 'command' && m.command.kind === 'purge')!
  if (purge.kind !== 'command') throw new Error('Purge not sent.')
  first.emit('message', { v: 1, kind: 'reply', id: purge.id, ok: false, message: 'unsafe-host-error' })
  first.reply(); await started; await Promise.resolve()
  first.emit('exit', 1)
  const list = supervisor.request({ kind: 'list', limit: 10 }), next = children[1]!
  next.ready()
  const commands = next.sent.filter(m => m.kind === 'command')
  expect(commands.map(m => m.command.kind)).toEqual(['purge', 'list'])
  expect(commands[0]!.command).toEqual({ kind: 'purge', before: 100 })
  next.emit('message', { v: 1, kind: 'reply', id: commands[0]!.id, ok: true, result: { ok: true } })
  next.reply({ runs: [] })
  await expect(list).resolves.toEqual({ runs: [] })
  supervisor.dispose()
})
it('explicit delete-all starts an idle host only when durable agent data exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-delete-all-'))
  const child = new Child()
  const supervisor = new AgentSupervisor({ spawn: () => child, credentials: async () => '', onPush: () => {}, dataDir: dir })
  try {
    await supervisor.purge(undefined, true)
    expect(child.sent).toEqual([])
    new SqliteAgentStore(join(dir, 'agent.sqlite')).close()
    const deleted = supervisor.purge(undefined, true)
    child.ready()
    expect(child.sent.at(-1)).toMatchObject({ command: { kind: 'purge' } })
    child.reply(); await deleted
    expect(supervisor.state).toBe('ready')
  } finally { supervisor.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
it('loads retained interrupted tasks on idle list only when an agent database exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-supervisor-'))
  const child = new Child()
  const supervisor = new AgentSupervisor({ spawn: () => child, credentials: async () => '', onPush: () => {}, dataDir: dir })
  try {
    await expect(supervisor.request({ kind: 'list', limit: 10 })).resolves.toEqual({ runs: [] })
    expect(child.sent).toEqual([])
    const store = new SqliteAgentStore(join(dir, 'agent.sqlite'))
    store.createRun({ id: 'old', requestId: 'old-request', goal: 'Resume me', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 0 })
    store.interruptUnfinished(1)
    const runs = store.listRuns(10); store.close()
    const list = supervisor.request({ kind: 'list', limit: 10 })
    expect(child.sent).toEqual([{ v: 1, kind: 'init', dataDir: dir }])
    child.ready(); child.reply({ runs })
    await expect(list).resolves.toMatchObject({ runs: [{ id: 'old', status: 'interrupted' }] })
  } finally { supervisor.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
it('reaps a real SIGSTOP-frozen child with the production SIGKILL fallback', async () => {
  const processChild = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = once(processChild, 'exit')
  await once(processChild.stdout!, 'data')
  const child = new Child(); child.pid = processChild.pid!
  child.kill = () => { child.killed = true; return processChild.kill('SIGTERM') }
  const supervisor = new AgentSupervisor({ spawn: () => child, credentials: async () => '', onPush: () => {}, dataDir: '/data' })
  try {
    const started = supervisor.request(start)
    child.ready(); child.reply({ runId: 'run' }); await started
    process.kill(processChild.pid!, 'SIGSTOP')
    await supervisor.stopAll()
    const [code, signal] = await exited
    expect(code).toBeNull()
    expect(signal).toBe('SIGKILL')
  } finally { supervisor.dispose(); processChild.kill('SIGKILL') }
})
it('clears request deadlines on errors and rejects stale replies and duplicate ready messages', async () => {
  vi.useFakeTimers()
  const { supervisor, children } = setup()
  const failed = expect(supervisor.request(start)).rejects.toThrow('Agent request failed.')
  const child = children[0]!
  child.ready(); child.ready()
  child.emit('message', { v: 1, kind: 'reply', id: 1, ok: false, message: 'provider-secret' })
  await failed
  child.emit('message', { v: 1, kind: 'reply', id: 1, ok: true, result: {} })
  expect(supervisor.invalidMessages).toBe(2)
  const timeout = expect(supervisor.request({ kind: 'list', limit: 10 })).rejects.toThrow('Agent request timed out.')
  await vi.advanceTimersByTimeAsync(30_000); await timeout
  expect(vi.getTimerCount()).toBe(0)
  supervisor.dispose(); supervisor.dispose()
})
it('keeps credentials authorized for two concurrent run generations instead of only the most recent provider', async () => {
  const { supervisor, children, credentials } = setup()
  let release!: (secret: string) => void
  credentials.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const first = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'first' }); await first
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'openai' })
  const second = supervisor.request({ ...start, requestId: 'second', model: { provider: 'anthropic', model: 'model' } })
  child.reply({ runId: 'second' }); await second
  release('FIRST_RUN_KEY'); await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 1, ok: true, secret: 'FIRST_RUN_KEY' })
  child.emit('message', { v: 1, kind: 'credential.request', id: 2, name: 'anthropic' }); await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 2, ok: true, secret: 'test-secret' })
  supervisor.dispose()
})
it('scopes Continue credentials to its explicit search backend instead of stale run search', async () => {
  const { supervisor, children } = setup()
  const started = supervisor.request({ ...start, search: { provider: 'brave' } }), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  const resumed = supervisor.request({ kind: 'continue', runId: 'run', model: start.model })
  child.reply(); await resumed
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'brave-search' }); await Promise.resolve()
  expect(child.sent.at(-1)).toMatchObject({ kind: 'credential', ok: false })
  const brave = supervisor.request({ kind: 'continue', runId: 'run', model: start.model, search: { provider: 'brave' } })
  child.reply(); await brave
  child.emit('message', { v: 1, kind: 'credential.request', id: 2, name: 'brave-search' }); await Promise.resolve()
  expect(child.sent.at(-1)).toMatchObject({ kind: 'credential', ok: true, secret: 'test-secret' })
  supervisor.dispose()
})
it('keeps Continue credentials scoped to its model and the configured Brave backend', async () => {
  const child = new Child()
  const supervisor = new AgentSupervisor({ spawn: () => child, credentials: async () => 'brave-secret', onPush: () => {}, dataDir: '/data' })
  const continued = supervisor.request({ kind: 'continue', runId: 'run', model: { provider: 'openai', model: 'model' }, search: { provider: 'brave' } })
  child.ready(); child.reply(); await continued
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'brave-search' }); await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 1, ok: true, secret: 'brave-secret' })
  supervisor.dispose()
})
it('maps spawn and disconnected-port failures to safe errors instead of leaking raw transport details', async () => {
  const failed = new AgentSupervisor({ spawn: () => { throw new Error('secret-path') }, credentials: async () => '', onPush: () => {}, dataDir: '/data' })
  await expect(Promise.resolve().then(() => failed.request(start))).rejects.toThrow('Agent host unavailable. Try again.')
  expect(failed.state).toBe('crashed')
  failed.dispose()
  const { supervisor, children } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  child.postMessage = () => { throw new Error('secret-transport') }
  await expect(supervisor.request({ kind: 'cancel', runId: 'run' })).rejects.toThrow('Agent host unavailable. Try again.')
  expect(child.killed).toBe(true)
  supervisor.dispose()
})
it('bounds outstanding requests and never respawns after disposal', async () => {
  const { supervisor, children } = setup()
  const pending = Array.from({ length: 256 }, () => expect(supervisor.request({ kind: 'events', runId: 'run', afterSeq: 0, limit: 1 })).rejects.toThrow('Agent host stopped.'))
  await expect(supervisor.request(start)).rejects.toThrow('Too many agent requests. Try again.')
  supervisor.dispose()
  await Promise.all(pending)
  await expect(supervisor.request(start)).rejects.toThrow('Agent host stopped.')
  expect(children).toHaveLength(1)
})
it('never dispatches a queued start after Stop-all revokes work during host initialization', async () => {
  const { supervisor, children } = setup()
  const pending = expect(supervisor.request(start)).rejects.toThrow('Agent host stopped.')
  const stopped = supervisor.stopAll(), child = children[0]!
  child.ready()
  expect(child.sent.filter(m => m.kind === 'command').map(m => m.kind === 'command' ? m.command.kind : '')).toEqual(['cancelAll'])
  child.reply()
  await stopped; await pending
  expect(child.killed).toBe(false)
  supervisor.dispose()
})
it('drops the 255 by 48KB review batch before deep validation without killing the host', async () => {
  const { supervisor, children, pushes } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  pushes.length = 0
  const events: AgentEvent[] = Array.from({ length: 255 }, (_, i) => ({ runId: 'run', seq: i + 1, id: `e${i}`, at: 0, payload: { type: 'text', step: i, text: 'x'.repeat(48_000) } }))
  events.push({ runId: 'run', seq: 256, id: 'end', at: 0, payload: { type: 'status', status: 'succeeded' } })
  child.emit('message', { v: 1, kind: 'events', events, runs: [] })
  expect(supervisor.invalidMessages).toBe(1)
  expect(supervisor.state).toBe('ready'); expect(child.killed).toBe(false)
  expect(pushes).toEqual([])
  supervisor.dispose()
})
it('flushes before retained event payload exceeds four MiB even across valid sub-threshold messages', async () => {
  vi.useFakeTimers()
  const { supervisor, children, pushes } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started; pushes.length = 0
  const events: AgentEvent[] = Array.from({ length: 200 }, (_, i) => ({ runId: 'run', seq: i + 1, id: `e${i}`, at: 0, payload: { type: 'text', step: i, text: 'x'.repeat(48_000) } }))
  for (let offset = 0; offset < 200; offset += 50) child.emit('message', { v: 1, kind: 'events', events: events.slice(offset, offset + 50), runs: [] })
  expect(pushes.length).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(16)
  expect(pushes.flatMap(push => push.kind === 'events' ? push.events : [])).toEqual(events)
  for (const push of pushes) expect(Buffer.byteLength(JSON.stringify(push))).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(child.killed).toBe(false); expect(supervisor.invalidMessages).toBe(0)
  supervisor.dispose(); expect(vi.getTimerCount()).toBe(0)
})
it('denies old endpoint and missing endpoint credential requests then permits only a newly bound start after revocation', async () => {
  const { supervisor, children, credentials } = setup()
  let release!: (secret: string) => void
  credentials.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const command = { ...start, model: { provider: 'compatible', model: 'fixture', baseURL: 'https://old.invalid/v1' } }
  const started = supervisor.request(command), child = children[0]!
  child.ready(); child.reply({ runId: 'old' }); await started
  for (const [id, baseURL] of [[1, undefined], [2, 'https://new.invalid/v1']] as const) child.emit('message', { v: 1, kind: 'credential.request', id, name: 'compatible', ...(baseURL ? { baseURL } : {}) })
  await Promise.resolve(); expect(credentials).not.toHaveBeenCalled()
  child.emit('message', { v: 1, kind: 'credential.request', id: 3, name: 'compatible', baseURL: 'https://old.invalid/v1' })
  supervisor.revokeAuthority()
  release('REVOKED_KEY'); await Promise.resolve()
  expect(JSON.stringify(child.sent)).not.toContain('REVOKED_KEY')
  expect(child.sent).toContainEqual(expect.objectContaining({ kind: 'credential', id: 3, ok: false }))
  const next = supervisor.request({ ...command, requestId: 'new', model: { ...command.model, baseURL: 'https://new.invalid/v1' } })
  child.reply({ runId: 'new' }); await next
  child.emit('message', { v: 1, kind: 'credential.request', id: 4, name: 'compatible', baseURL: 'https://old.invalid/v1' })
  child.emit('message', { v: 1, kind: 'credential.request', id: 5, name: 'compatible', baseURL: 'https://new.invalid/v1' }); await Promise.resolve()
  expect(child.sent).toContainEqual(expect.objectContaining({ kind: 'credential', id: 4, ok: false }))
  expect(child.sent).toContainEqual(expect.objectContaining({ kind: 'credential', id: 5, ok: true }))
  expect(credentials.mock.calls.at(-1)).toEqual(['compatible', ['compatible'], { baseURL: 'https://new.invalid/v1' }])
  supervisor.dispose()
})
it('does not grant credentials to starts queued before a connection generation was revoked', async () => {
  const { supervisor, children, credentials } = setup()
  const started = expect(supervisor.request(start)).rejects.toThrow('Agent connection changed. Start or continue the task again.')
  supervisor.revokeAuthority()
  const child = children[0]!
  child.ready()
  expect(child.sent.filter(message => message.kind === 'command')).toEqual([])
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'openai' }); await Promise.resolve()
  expect(credentials).not.toHaveBeenCalled()
  await started; supervisor.dispose()
})
it('retires a run binding even when its terminal event arrives before the start acknowledgement', async () => {
  const { supervisor, children, credentials } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready()
  child.emit('message', { v: 1, kind: 'events', runs: [], events: [{ runId: 'run', seq: 1, id: 'end', at: 0, payload: { type: 'status', status: 'succeeded' } }] })
  child.reply({ runId: 'run' }); await started
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'openai' }); await Promise.resolve()
  expect(credentials).not.toHaveBeenCalled()
  expect(child.sent.at(-1)).toMatchObject({ kind: 'credential', ok: false })
  supervisor.dispose()
})
it('does not invalidate a simultaneous same-provider credential when another matching run finishes', async () => {
  const { supervisor, children, credentials } = setup()
  const first = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'first' }); await first
  const second = supervisor.request({ ...start, requestId: 'second' })
  child.reply({ runId: 'second' }); await second
  let release!: (secret: string) => void
  credentials.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'openai' })
  child.emit('message', { v: 1, kind: 'events', runs: [], events: [{ runId: 'first', seq: 1, id: 'end', at: 0, payload: { type: 'status', status: 'succeeded' } }] })
  release('SECOND_KEY'); await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 1, ok: true, secret: 'SECOND_KEY' })
  supervisor.dispose()
})
it('drops huge sparse reply arrays before accepting a matching request ID', async () => {
  const { supervisor, children } = setup()
  const started = expect(supervisor.request(start)).rejects.toThrow('Agent host stopped.')
  const child = children[0]!; child.ready()
  child.emit('message', { v: 1, kind: 'reply', id: 1, ok: true, result: { values: new Array(1_000_000) } })
  expect(supervisor.invalidMessages).toBe(1)
  supervisor.dispose(); await started
})
it('rejects cyclic, over-deep and non-JSON host values before forwarding or accepting a reply', async () => {
  const { supervisor, children, pushes } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.emit('message', { v: 1, kind: 'partial', runId: 'run', step: 0, text: 'premature' })
  child.ready(); child.reply({ runId: 'run' }); await started; pushes.length = 0
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  let deep: unknown = null
  for (let n = 0; n < 20; n++) deep = { nested: deep }
  for (const result of [cycle, deep, 1n, Array.from({ length: 1000 }, () => Array(30).fill(null))]) child.emit('message', { v: 1, kind: 'reply', id: 99, ok: true, result })
  expect(supervisor.invalidMessages).toBe(5)
  expect(pushes).toEqual([]); expect(child.killed).toBe(false)
  supervisor.dispose()
})
it('flushes healthy bursts at the threshold without dropping events or killing the host', async () => {
  const { supervisor, children, pushes } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  const events = Array.from({ length: 256 }, (_, n) => ({ runId: 'run', seq: n + 1, id: `e${n}`, at: 0, payload: { type: 'text', step: 0, text: 'x' } }))
  for (let n = 0; n < 3; n++) child.emit('message', { v: 1, kind: 'events', events, runs: [] })
  expect(child.killed).toBe(false)
  expect(supervisor.state).toBe('ready')
  expect(pushes.flatMap(p => p.kind === 'events' ? p.events : [])).toHaveLength(768)
  supervisor.dispose()
})
it('kills abusive volumes above 10000 events in one frame even across threshold flushes', async () => {
  vi.useFakeTimers()
  const { supervisor, children } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply(); await started
  const events = Array.from({ length: 256 }, (_, i) => ({ runId: 'run', seq: i + 1, id: `e${i}`, at: 0, payload: { type: 'text', step: 0, text: 'x' } }))
  for (let n = 0; n < 39; n++) child.emit('message', { v: 1, kind: 'events', events, runs: [] })
  expect(child.killed).toBe(false)
  await vi.advanceTimersByTimeAsync(16)
  child.emit('message', { v: 1, kind: 'events', events, runs: [] })
  expect(child.killed).toBe(false)
  for (let n = 0; n < 39; n++) child.emit('message', { v: 1, kind: 'events', events, runs: [] })
  expect(child.killed).toBe(true)
  expect(supervisor.state).toBe('crashed')
  supervisor.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
it('escalates a frozen host to SIGKILL even when graceful kill reports successful delivery', async () => {
  vi.useFakeTimers()
  const child = new Child(); child.pid = 12345
  const forceKill = vi.fn()
  const supervisor = new AgentSupervisor({ spawn: () => child, forceKill, credentials: async () => '', onPush: () => {}, dataDir: '/data' })
  const started = supervisor.request(start)
  child.ready(); child.reply({ runId: 'run' }); await started
  const stopped = supervisor.stopAll()
  await vi.advanceTimersByTimeAsync(1500); await stopped
  expect(child.killed).toBe(true)
  expect(forceKill).toHaveBeenCalledWith(12345)
  supervisor.dispose()
})
it('revokes an in-flight credential before Stop-all waits on an unresponsive host', async () => {
  vi.useFakeTimers()
  const { supervisor, children, credentials } = setup()
  let finish!: (secret: string) => void
  credentials.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  child.emit('message', { v: 1, kind: 'credential.request', id: 1, name: 'openai' })
  const stopped = supervisor.stopAll()
  finish('revoked-secret'); await Promise.resolve()
  expect(JSON.stringify(child.sent)).not.toContain('revoked-secret')
  await vi.advanceTimersByTimeAsync(1500); await stopped
  supervisor.dispose()
})
it('coalesces frame deltas and latest summaries and partials while flushing approval and terminal events immediately', async () => {
  vi.useFakeTimers()
  const { supervisor, children, pushes } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  pushes.length = 0
  const run: RunSummary = { id: 'run', goal: 'Research', mode: 'web', mixed: false, status: 'running', persistence: 'retained', created: 0, updated: 0, usage: { inputTokens: 0, outputTokens: 0 } }
  const event = (seq: number, payload: AgentEvent['payload']): AgentEvent => ({ runId: 'run', seq, id: `e${seq}`, at: 0, payload })
  const e1 = event(1, { type: 'text', step: 0, text: 'a' }), e2 = event(2, { type: 'text', step: 1, text: 'b' })
  child.emit('message', { v: 1, kind: 'events', events: [e1], runs: [run] })
  child.emit('message', { v: 1, kind: 'events', events: [e2], runs: [{ ...run, updated: 1 }] })
  child.emit('message', { v: 1, kind: 'partial', runId: 'run', step: 2, text: 'old' })
  child.emit('message', { v: 1, kind: 'partial', runId: 'run', step: 2, text: 'latest' })
  await vi.advanceTimersByTimeAsync(15)
  expect(pushes).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(pushes).toEqual([{ kind: 'events', events: [e1, e2], runs: [{ ...run, updated: 1 }], partials: [{ runId: 'run', step: 2, text: 'latest' }] }])
  for (const payload of [
    { type: 'approval.requested', approvalId: 'a', callId: 'c', tool: 'read', preview: 'Read file', digest: 'digest' },
    { type: 'question', questionId: 'q', text: 'Which?' },
    { type: 'status', status: 'succeeded' },
  ] as AgentEvent['payload'][]) {
    pushes.length = 0
    const e = event(3, payload)
    child.emit('message', { v: 1, kind: 'events', events: [e], runs: [] })
    expect(pushes).toEqual([{ kind: 'events', events: [e], runs: [] }])
  }
  supervisor.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
it('rejects in-flight work on crash and respawns without accepting replies from the old generation', async () => {
  const { supervisor, children, pushes } = setup()
  const failed = expect(supervisor.request(start)).rejects.toThrow('Agent host stopped unexpectedly. Try again.')
  const old = children[0]!
  old.ready()
  old.emit('exit', 1)
  await failed
  expect(pushes).toContainEqual({ kind: 'host', state: 'crashed', message: 'Agent host stopped unexpectedly. Try again.' })
  const retry = supervisor.request({ kind: 'events', runId: 'run', afterSeq: 0, limit: 10 })
  expect(children).toHaveLength(2)
  old.emit('message', { v: 1, kind: 'ready' })
  expect(supervisor.state).toBe('starting')
  children[1]!.ready(); children[1]!.reply({ events: [] })
  await expect(retry).resolves.toEqual({ events: [] })
  supervisor.dispose()
})
it('kills a non-cooperating host within 1500ms and rejects pending work even without an exit event', async () => {
  vi.useFakeTimers()
  const { supervisor, children, pushes } = setup()
  const pending = expect(supervisor.request(start)).rejects.toThrow('Agent host stopped.')
  const child = children[0]!
  child.ready()
  const stopped = supervisor.stopAll()
  expect(child.sent).toContainEqual(expect.objectContaining({ kind: 'command', command: { kind: 'cancelAll' } }))
  await vi.advanceTimersByTimeAsync(1499)
  expect(child.killed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await stopped; await pending
  expect(child.killed).toBe(true)
  expect(pushes).toContainEqual({ kind: 'host', state: 'stopped', message: 'Agent host stopped.' })
  expect(vi.getTimerCount()).toBe(0)
  supervisor.dispose()
})
it('refuses other providers and permits Brave only when the run selected Brave search', async () => {
  const { supervisor, children, credentials } = setup()
  const started = supervisor.request(start), child = children[0]!
  child.ready(); child.reply({ runId: 'run' }); await started
  child.emit('message', { v: 1, kind: 'credential.request', id: 11, name: 'anthropic' })
  await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 11, ok: false, message: 'Agent credential unavailable.' })
  expect(credentials).not.toHaveBeenCalled()
  child.emit('message', { v: 1, kind: 'credential.request', id: 12, name: 'openai' })
  await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 12, ok: true, secret: 'test-secret' })
  child.emit('message', { v: 1, kind: 'credential.request', id: 13, name: 'brave-search' })
  await Promise.resolve()
  expect(child.sent).toContainEqual(expect.objectContaining({ id: 13, ok: false }))
  const brave = supervisor.request({ ...start, search: { provider: 'brave' } } as HostCommand)
  child.reply({ runId: 'run2' }); await brave
  child.emit('message', { v: 1, kind: 'credential.request', id: 14, name: 'brave-search' })
  await Promise.resolve()
  expect(child.sent).toContainEqual({ v: 1, kind: 'credential', id: 14, ok: true, secret: 'test-secret' })
  supervisor.dispose()
})
it('ignores malformed host messages and unknown fields rather than trusting a matching reply ID', async () => {
  const { supervisor, children } = setup()
  const started = supervisor.request(start), child = children[0]!
  const invalid = [null, [], { v: 2, kind: 'ready' }, { v: 1, kind: 'ready', extra: true }, { v: 1, kind: 'reply', id: 1, ok: true, result: {}, secret: 'no' }, { v: 1, kind: 'partial', runId: 'run', step: -1, text: 'bad' }, { v: 1, kind: 'events', events: [{ runId: 'run' }], runs: [] }]
  for (const message of invalid) child.emit('message', message)
  expect(supervisor.invalidMessages).toBe(invalid.length)
  expect(supervisor.state).toBe('starting')
  child.ready(); child.reply({ runId: 'run' }); await started
  supervisor.dispose()
})
it('keeps idle list and stop allocation-free and starts exactly one host for the first Do request', async () => {
  const { supervisor, children, pushes } = setup()
  expect(supervisor.state).toBe('idle')
  await expect(supervisor.request({ kind: 'list', limit: 10 })).resolves.toEqual({ runs: [] })
  await supervisor.stopAll()
  expect(children).toHaveLength(0)
  const result = supervisor.request(start)
  expect(children).toHaveLength(1)
  const child = children[0]!
  expect(child.sent).toEqual([{ v: 1, kind: 'init', dataDir: '/data' }])
  child.ready()
  child.reply({ runId: 'run' })
  await expect(result).resolves.toEqual({ runId: 'run' })
  expect(pushes).toContainEqual({ kind: 'host', state: 'starting' })
  expect(pushes).toContainEqual({ kind: 'host', state: 'ready' })
  supervisor.dispose()
})
