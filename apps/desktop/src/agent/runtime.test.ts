import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryAgentStore, SqliteAgentStore } from './store'
import { FileArtifactStore, MemoryArtifactStore } from './artifacts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnsupportedFunctionalityError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { AgentTool, RuntimeDeps, ToolContext, ToolOutcome } from './contracts'
import { DEFAULT_BUDGET, isTerminal, parseAgentEvent, type AgentEvent, type AgentEventPayload, type HostCommand } from '../shared/agent-protocol'
import { FakeArtifacts, FakeStore } from './test-fakes'
import { DO_INSTRUCTIONS } from './prompt'
import { createAgentRuntime } from './runtime'

type Chunk = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C> ? C : never
type Script = { calls?: readonly { name: string; id: string; input?: string }[]; text?: string; tokens?: number }
const usage = (tokens = 3) => ({ inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: tokens, text: tokens, reasoning: undefined } })
function chunks(script: Script): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...(script.calls ?? []).map(call => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.name, input: call.input ?? '{}' })),
    ...(script.text === undefined ? [] : [{ type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: script.text }, { type: 'text-end' as const, id: 't' }]),
    { type: 'finish', finishReason: { unified: script.calls?.length ? 'tool-calls' : 'stop', raw: 'test' }, usage: usage(script.tokens) },
  ]
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function scripted(scripts: Script[]) {
  let index = 0
  return new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ start(controller) { for (const chunk of chunks(scripts[index++] ?? { text: 'done' })) controller.enqueue(chunk); controller.close() } }) }) })
}
function agentTool(options: Partial<AgentTool> = {}): AgentTool {
  return { name: 'research', description: 'Read a public source', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, effect: 'network-read', scope: 'web', parse: value => value, needsApproval: () => false, preview: () => 'Read source', execute: async () => ({ ok: true, content: 'source evidence', summary: 'Read source' }), ...options }
}
const runtimes: ReturnType<typeof createAgentRuntime>[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); vi.useRealTimers() })
function setup(model = scripted([{ text: 'done' }]), tools: AgentTool[] = [], override: Partial<RuntimeDeps> = {}) {
  const store = new FakeStore(), memoryStore = new FakeStore(), artifacts = new FakeArtifacts(), memoryArtifacts = new FakeArtifacts()
  const received: AgentEvent[] = []
  const sink = { events: vi.fn((events: AgentEvent[]) => { received.push(...events) }), partial: vi.fn() }
  const deps = { store, memoryStore, artifacts, memoryArtifacts, models: async () => model, tools: () => tools, credentials: async () => 'credential-not-context', sink, ...override }
  const runtime = createAgentRuntime(deps)
  runtimes.push(runtime)
  const start = (changes: Partial<Extract<HostCommand, { kind: 'start' }>> = {}) => runtime.handle({ kind: 'start', requestId: 'request-1', goal: 'Research carefully', mode: 'web', persistence: 'retained', grants: [], budget: { ...DEFAULT_BUDGET }, model: { provider: 'mock', model: 'mock' }, ...changes }) as Promise<{ runId: string }>
  const events = (id: string) => (deps.memoryStore.getRun(id) ? deps.memoryStore : deps.store).events(id, 0, 1000).map(event => event.payload)
  async function terminal(id: string) { await vi.waitFor(() => expect(isTerminal((deps.memoryStore.getRun(id) ?? deps.store.getRun(id))!.status)).toBe(true)); return (deps.memoryStore.getRun(id) ?? deps.store.getRun(id))! }
  async function event<T extends AgentEventPayload['type']>(id: string, type: T) {
    await vi.waitFor(() => expect(events(id).some(event => event.type === type)).toBe(true))
    return events(id).find(event => event.type === type) as Extract<AgentEventPayload, { type: T }>
  }
  return { runtime, start, store, memoryStore, artifacts, memoryArtifacts, sink, received, events, terminal, event, deps }
}

describe('agent coordinator', () => {
  it('instructs file tools to address grants by label rather than opaque picker IDs', () => {
    expect(DO_INSTRUCTIONS).toContain('folder-grant labels')
    expect(DO_INSTRUCTIONS).not.toContain('Use opaque folder-grant IDs')
  })
  it('gives Continue a fresh activation wall budget after downtime exceeds the original budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heynimbo-wall-'))
    const store = new SqliteAgentStore(join(dir, 'agent.sqlite'))
    let time = 10_000_000
    store.createRun({ id: 'old', requestId: 'old-request', goal: 'Finish', mode: 'web', persistence: 'retained', grants: [], budget: { ...DEFAULT_BUDGET, maxWallMs: 100 }, created: 0 })
    store.interruptUnfinished(time)
    const model = scripted([{ text: 'finished after restart' }])
    const h = setup(model, [], { store, memoryStore: new MemoryAgentStore(), artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore(), clock: { now: () => time } })
    try {
      await h.runtime.handle({ kind: 'continue', runId: 'old', model: { provider: 'mock', model: 'mock' } })
      expect((await h.terminal('old')).status).toBe('succeeded')
      expect(model.doStreamCalls).toHaveLength(1)
      time++
    } finally { await h.runtime.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it.each(['start', 'continue'] as const)('rolls back %s registration after a real SQLite status failure so Stop-all cannot cancel an unstarted activation', async kind => {
    const dir = mkdtempSync(join(tmpdir(), 'heynimbo-activation-')), path = join(dir, 'agent.sqlite')
    const store = new SqliteAgentStore(path), db = new DatabaseSync(path)
    if (kind === 'continue') {
      store.createRun({ id: 'old', requestId: 'old', goal: 'Continue', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: Date.now() })
      store.interruptUnfinished(Date.now())
    }
    db.exec("CREATE TRIGGER reject_activation BEFORE UPDATE OF status ON runs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT, 'Injected activation failure'); END")
    const h = setup(scripted([{ text: 'Recovered' }]), [], { store, memoryStore: new MemoryAgentStore(), artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore() })
    try {
      await expect(kind === 'continue' ? h.runtime.handle({ kind: 'continue', runId: 'old', model: { provider: 'mock', model: 'mock' } }) : h.start()).rejects.toThrow()
      const runId = store.listRuns(1)[0]!.id
      await h.runtime.handle({ kind: 'cancelAll' })
      expect(store.getRun(runId)?.status).toBe(kind === 'continue' ? 'interrupted' : 'queued')
      db.exec('DROP TRIGGER reject_activation')
      if (kind === 'start') store.interruptUnfinished(Date.now())
      await h.runtime.handle({ kind: 'continue', runId, model: { provider: 'mock', model: 'mock' } })
      expect((await h.terminal(runId)).status).toBe('succeeded')
    } finally { await h.runtime.shutdown(); db.close(); store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('purges safely after a deleted run still has an abort-ignoring provider initialization in flight', async () => {
    const store = new MemoryAgentStore(), memoryStore = new MemoryAgentStore()
    const gate = deferred<MockLanguageModelV4>()
    const h = setup(undefined, [], { store, memoryStore, artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore(), models: () => gate.promise })
    const { runId } = await h.start()
    await h.runtime.handle({ kind: 'delete', runId })
    try {
      await expect(h.runtime.handle({ kind: 'purge', before: Date.now() + 1 })).resolves.toEqual({ ok: true })
      expect(store.listRuns(10)).toEqual([])
    } finally { gate.resolve(scripted([{ text: 'Late response' }])); await h.runtime.shutdown() }
  })
  it('purges old active runs and their real blobs from both partitions without deleting newer runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heynimbo-purge-'))
    const store = new SqliteAgentStore(join(dir, 'agent.sqlite')), memoryStore = new MemoryAgentStore()
    const artifacts = new FileArtifactStore(join(dir, 'artifacts')), memoryArtifacts = new MemoryArtifactStore()
    let time = 100
    const h = setup(scripted([{ calls: [{ name: 'ask_user', id: 'q1', input: '{"question":"Wait?"}' }] }, { calls: [{ name: 'ask_user', id: 'q2', input: '{"question":"Wait?"}' }] }]), [], { store, memoryStore, artifacts, memoryArtifacts, clock: { now: () => time } })
    try {
      const retained = await h.start(); await h.event(retained.runId, 'question')
      const temporary = await h.start({ requestId: 'temp', persistence: 'temporary' }); await h.event(temporary.runId, 'question')
      const saved = []
      for (const [id, partition, blobs] of [[retained.runId, store, artifacts], [temporary.runId, memoryStore, memoryArtifacts]] as const) {
        const meta = await blobs.save(id, 'old', 'text/plain', new TextEncoder().encode('private'))
        partition.appendEvent(id, { type: 'artifact', artifactId: meta.id, name: meta.name, bytes: meta.bytes, mediaType: meta.mediaType }, time)
        saved.push({ id, blobs, artifactId: meta.id })
      }
      time = 1000
      store.createRun({ id: 'new', requestId: 'new', goal: 'Keep', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: time })
      await expect(h.runtime.handle({ kind: 'purge', before: 200 })).resolves.toEqual({ ok: true })
      expect(store.listRuns(10).map(run => run.id)).toEqual(['new'])
      expect(memoryStore.listRuns(10)).toEqual([])
      for (const savedBlob of saved) expect(await savedBlob.blobs.read(savedBlob.id, savedBlob.artifactId)).toBeUndefined()
      await expect(h.runtime.handle({ kind: 'answer', runId: retained.runId, questionId: 'q1', text: 'late' })).rejects.toThrow()
      await h.runtime.handle({ kind: 'purge' })
      expect(store.listRuns(10)).toEqual([])
    } finally { await h.runtime.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('cancel-all stops both persistence partitions and list pagination returns only public summaries', async () => {
    let time = 1000
    const h = setup(scripted([
      { calls: [{ name: 'ask_user', id: 'q1', input: '{"question":"First?"}' }] },
      { calls: [{ name: 'ask_user', id: 'q2', input: '{"question":"Second?"}' }] },
    ]), [], { clock: { now: () => time } })
    const first = await h.start()
    await h.event(first.runId, 'question')
    time++
    const second = await h.start({ requestId: 'request-2', persistence: 'temporary' })
    await h.event(second.runId, 'question')
    await h.runtime.handle({ kind: 'cancelAll' })
    expect(h.store.getRun(first.runId)?.status).toBe('cancelled')
    expect(h.memoryStore.getRun(second.runId)?.status).toBe('cancelled')
    const list = await h.runtime.handle({ kind: 'list', limit: 10 }) as { runs: { id: string }[] }
    expect(list.runs.map(run => run.id)).toEqual([second.runId, first.runId])
    expect(JSON.stringify(list)).not.toMatch(/requestId|grants|nextSeq/)
    expect(await h.runtime.handle({ kind: 'list', limit: 10, before: time })).toEqual({ runs: [] })
    await expect(h.runtime.handle({ kind: 'allowMix', runId: first.runId })).rejects.toThrow()
    await expect(h.runtime.handle({ kind: 'events', runId: 'missing', afterSeq: 0, limit: 10 })).rejects.toThrow(/not found/)
    // A task link resolves one public summary from either partition, never private run state.
    expect(await h.runtime.handle({ kind: 'run', runId: second.runId })).toEqual({ run: list.runs[0] })
    expect(await h.runtime.handle({ kind: 'run', runId: first.runId })).toEqual({ run: list.runs[1] })
    expect(JSON.stringify(await h.runtime.handle({ kind: 'run', runId: first.runId }))).not.toMatch(/requestId|grants|nextSeq/)
    await expect(h.runtime.handle({ kind: 'run', runId: 'missing' })).rejects.toThrow(/not found/)
  })

  it('tools can read their saved artifact but cannot delete it through their capability facade', async () => {
    let read = ''
    const h = setup(scripted([{ calls: [{ name: 'save', id: 's1' }] }, { text: 'done' }]), [agentTool({ name: 'save', scope: 'any', effect: 'artifact-write', execute: async (_input, ctx) => {
      const saved = await ctx.artifacts.save(ctx.runId, 'note', 'text/plain', new TextEncoder().encode('bounded content'))
      read = new TextDecoder().decode((await ctx.artifacts.read(ctx.runId, saved.id))!.content)
      await ctx.artifacts.delete([saved.id])
      return { ok: true, content: 'unreachable', summary: 'unreachable' }
    } })])
    const { runId } = await h.start()
    await h.terminal(runId)
    expect(read).toBe('bounded content')
    expect(h.artifacts.values.size).toBe(1)
    expect(h.events(runId)).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: false }))
  })

  it('deleting a run during artifact save removes an unreferenced late artifact', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    class SlowArtifacts extends FakeArtifacts {
      override async save(runId: string, name: string, mediaType: string, content: Uint8Array) {
        entered.resolve()
        await release.promise
        return super.save(runId, name, mediaType, content)
      }
    }
    const artifacts = new SlowArtifacts()
    const h = setup(scripted([{ calls: [{ name: 'save', id: 's1' }] }]), [agentTool({ name: 'save', scope: 'any', effect: 'artifact-write', execute: async (_input, ctx) => {
      await ctx.artifacts.save(ctx.runId, 'late.txt', 'text/plain', new Uint8Array([1]))
      return { ok: true, content: 'saved', summary: 'saved' }
    } })], { artifacts })
    const { runId } = await h.start()
    await entered.promise
    await h.runtime.handle({ kind: 'delete', runId })
    release.resolve()
    await h.runtime.shutdown()
    expect(artifacts.values.size).toBe(0)
    expect(h.store.getRun(runId)).toBeUndefined()
    expect(h.received.filter(event => event.payload.type === 'artifact')).toHaveLength(0)
  })

  it('invalid host budgets are rejected before creating a run or resolving credentials', async () => {
    const h = setup()
    await expect(h.start({ budget: { ...DEFAULT_BUDGET, maxSteps: Infinity } })).rejects.toThrow(/budget/i)
    await expect(h.start({ budget: { ...DEFAULT_BUDGET, maxWallMs: 0 } })).rejects.toThrow(/budget/i)
    expect(h.store.listRuns(10)).toHaveLength(0)
  })

  it('invalid provider usage cannot persist fractional or negative token counts', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ start(controller) {
      const parts = chunks({ text: 'done' })
      for (const part of parts) controller.enqueue(part.type === 'finish' ? { ...part, usage: usage(-1) } : part)
      controller.close()
    } }) }) })
    const h = setup(model)
    const { runId } = await h.start()
    expect((await h.terminal(runId)).error?.code).toBe('provider')
    expect(h.store.getRun(runId)?.usage.outputTokens).toBe(0)
    expect(h.events(runId).filter(event => event.type === 'usage')).toHaveLength(0)
  })

  it('a tool-call flood is bounded even when every tool returns empty output', async () => {
    let effects = 0
    const model = scripted([{ calls: Array.from({ length: 129 }, (_item, index) => ({ name: 'research', id: `c${index}` })) }])
    const h = setup(model, [agentTool({ execute: async () => { effects++; return { ok: true, content: '', summary: 'read' } } })])
    const { runId } = await h.start()
    expect((await h.terminal(runId)).error?.code).toBe('budget')
    expect(effects).toBeLessThanOrEqual(128)
  })

  it('artifact previews preserve UTF-8 at the one-megabyte cap and reject binary or cross-run access', async () => {
    const h = setup()
    const { runId } = await h.start()
    await h.terminal(runId)
    const large = await h.artifacts.save(runId, 'large.txt', 'text/plain', new TextEncoder().encode('a'.repeat(999999) + '🙂'))
    const result = await h.runtime.handle({ kind: 'artifact', runId, artifactId: large.id }) as { text: string; bytes: number }
    expect(result.text.includes('�')).toBe(false)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1000000)
    const binary = await h.artifacts.save(runId, 'x.png', 'image/png', new Uint8Array([1]))
    await expect(h.runtime.handle({ kind: 'artifact', runId, artifactId: binary.id })).rejects.toThrow(/text/)
    const other = await h.artifacts.save('someone-else', 'private.txt', 'text/plain', new Uint8Array([1]))
    await expect(h.runtime.handle({ kind: 'artifact', runId, artifactId: other.id })).rejects.toThrow(/not found/)
  })

  it('provider call IDs and oversized tool summaries cannot break the event protocol', async () => {
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'provider:call/a' }] }, { text: 'done' }]), [agentTool({ execute: async () => ({ ok: true, content: 'ok', summary: '"'.repeat(100000) }) })])
    const { runId } = await h.start()
    expect((await h.terminal(runId)).status).toBe('succeeded')
    for (const event of h.store.events(runId, 0, 200)) expect(() => parseAgentEvent(event)).not.toThrow()
    const called = await h.event(runId, 'tool.call')
    const result = await h.event(runId, 'tool.result')
    expect(called.callId).toBe(result.callId)
  })

  it('a repeated completed tool-call ID after restart cannot execute its effect again', async () => {
    let effects = 0
    const tools = [agentTool({ execute: async () => { effects++; return { ok: true, content: 'once evidence', summary: 'once' } } })]
    let index = 0
    const blocked = deferred<ReturnType<MockLanguageModelV4['doStream']> extends PromiseLike<infer T> ? T : never>()
    const first = setup(new MockLanguageModelV4({ doStream: async () => index++ === 0 ? { stream: new ReadableStream<Chunk>({ start(controller) { for (const part of chunks({ calls: [{ name: 'research', id: 'stable' }] })) controller.enqueue(part); controller.close() } }) } : blocked.promise }), tools)
    const { runId } = await first.start()
    await vi.waitFor(() => expect(first.store.latestCheckpoint(runId)?.step).toBe(1))
    await first.runtime.shutdown()
    blocked.resolve({ stream: new ReadableStream<Chunk>({ start(controller) { controller.close() } }) })
    const next = setup(scripted([{ calls: [{ name: 'research', id: 'stable' }] }, { text: 'continued' }]), tools, { store: first.store })
    await next.runtime.handle({ kind: 'continue', runId, model: { provider: 'mock', model: 'mock' } })
    expect((await next.terminal(runId)).status).toBe('succeeded')
    expect(effects).toBe(1)
  })

  it('escaped model text cannot create an oversized wire event', async () => {
    const h = setup(scripted([{ text: '"'.repeat(40000) }]))
    const { runId } = await h.start()
    const run = await h.terminal(runId)
    expect(run.error?.code).toBe('budget')
    for (const event of h.store.events(runId, 0, 200)) expect(() => parseAgentEvent(event)).not.toThrow()
  })

  it('deadline checks fence effects even when the timer has not had an event-loop turn', async () => {
    let time = 1000, effects = 0
    const model = new MockLanguageModelV4({ doStream: async () => {
      time = 1020
      return { stream: new ReadableStream<Chunk>({ start(controller) { for (const part of chunks({ calls: [{ name: 'research', id: 'late' }] })) controller.enqueue(part); controller.close() } }) }
    } })
    const h = setup(model, [agentTool({ execute: async () => { effects++; return { ok: true, content: 'late', summary: 'late' } } })], { clock: { now: () => time } })
    const { runId } = await h.start({ budget: { ...DEFAULT_BUDGET, maxWallMs: 10 } })
    expect((await h.terminal(runId)).error?.code).toBe('budget')
    expect(effects).toBe(0)
  })

  it('Continue cannot reset a consumed token budget before calling the model', async () => {
    const h = setup()
    const created = h.store.createRun({ id: 'restored', requestId: 'old', goal: 'old goal', mode: 'local', persistence: 'retained', grants: [], created: Date.now(), budget: { ...DEFAULT_BUDGET, maxOutputTokens: 3 } })
    h.store.addUsage(created.run.id, { inputTokens: 2, outputTokens: 3 }, Date.now())
    h.store.setStatus(created.run.id, 'interrupted', Date.now())
    const calls = vi.fn(async () => scripted([{ text: 'unexpected' }]))
    const next = setup(undefined, [], { store: h.store, models: calls })
    await next.runtime.handle({ kind: 'continue', runId: created.run.id, model: { provider: 'mock', model: 'mock' } })
    expect((await next.terminal(created.run.id)).error?.code).toBe('budget')
    expect(calls).not.toHaveBeenCalled()
  })

  it('shutdown waits for abort-ignoring tool work but stops waiting at its bounded deadline', async () => {
    vi.useFakeTimers()
    const entered = deferred<void>()
    const gate = deferred<ToolOutcome>()
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'c1' }] }]), [agentTool({ execute: async () => { entered.resolve(); return gate.promise } })])
    await h.start()
    await entered.promise
    let stopped = false
    const stopping = h.runtime.shutdown().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(749)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(stopped).toBe(true)
    gate.resolve({ ok: true, content: 'late', summary: 'late' })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalid tool results consume the same output byte budget as successful tools', async () => {
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'bad' }] }]), [agentTool({ parse: () => { throw new Error('invalid') } })])
    const { runId } = await h.start({ budget: { ...DEFAULT_BUDGET, maxToolOutputBytes: 5 } })
    expect((await h.terminal(runId)).error?.code).toBe('budget')
    const messages = JSON.parse(h.store.latestCheckpoint(runId)!.messages) as { role: string; content: { output?: { value: string } }[] }[]
    const result = messages.find(message => message.role === 'tool')!.content[0]!.output!.value
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(5)
  })

  it('Do instructions allow Markdown without the Explain voice prompt or raw grant paths', async () => {
    const model = scripted([{ text: '# Task result' }])
    const h = setup(model)
    const { runId } = await h.start({ mode: 'local', grants: [{ id: 'grant-opaque', root: '/private/owner/path', label: 'Project' }] })
    await h.terminal(runId)
    const context = JSON.stringify(model.doStreamCalls[0]?.prompt)
    expect(context).toMatch(/Markdown/)
    expect(context).toContain('grant-opaque')
    expect(context).not.toContain('/private/owner/path')
    expect(context).toMatch(/untrusted/)
  })

  it('streaming coalesces partials and event batches while preserving monotonic persisted sequence', async () => {
    vi.useFakeTimers()
    const opened = deferred<ReadableStreamDefaultController<Chunk>>()
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ start(controller) { opened.resolve(controller); controller.enqueue({ type: 'stream-start', warnings: [] }); controller.enqueue({ type: 'text-start', id: 't' }) } }) }) })
    const h = setup(model)
    const { runId } = await h.start()
    const controller = await opened.promise
    controller.enqueue({ type: 'text-delta', id: 't', delta: 'One' })
    controller.enqueue({ type: 'text-delta', id: 't', delta: ' two' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.sink.events).not.toHaveBeenCalled()
    expect(h.sink.partial).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(16)
    expect(h.sink.events).toHaveBeenCalledTimes(1)
    expect(h.sink.partial).toHaveBeenLastCalledWith(runId, 1, 'One two')
    controller.enqueue({ type: 'text-delta', id: 't', delta: ' three' })
    await vi.advanceTimersByTimeAsync(15)
    expect(h.sink.partial).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sink.partial).toHaveBeenCalledTimes(2)
    controller.enqueue({ type: 'text-end', id: 't' })
    controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage() })
    controller.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.store.getRun(runId)?.status).toBe('succeeded')
    expect(h.sink.events).toHaveBeenCalledTimes(2)
    expect(h.received.map(event => event.seq)).toEqual(h.received.map((_event, index) => index + 1))
    expect(h.events(runId).filter(event => event.type === 'text')).toEqual([{ type: 'text', step: 1, text: 'One two three' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancellation during streaming suppresses later deltas, checkpoints and success', async () => {
    const opened = deferred<ReadableStreamDefaultController<Chunk>>()
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ start(controller) { opened.resolve(controller); for (const part of chunks({ text: 'partial' }).slice(0, -2)) controller.enqueue(part) } }) }) })
    const h = setup(model)
    const { runId } = await h.start()
    const controller = await opened.promise
    await h.runtime.handle({ kind: 'cancel', runId })
    controller.enqueue({ type: 'text-delta', id: 't', delta: 'late-secret' })
    controller.close()
    await h.runtime.shutdown()
    expect(h.store.getRun(runId)?.status).toBe('cancelled')
    expect(h.store.latestCheckpoint(runId)).toBeUndefined()
    expect(JSON.stringify(h.received) + JSON.stringify(h.sink.partial.mock.calls)).not.toContain('late-secret')
  })

  it.each([
    ['memory', 'interrupted'], ['memory', 'failed'], ['SQLite', 'interrupted'], ['SQLite', 'failed'],
  ] as const)('%s Continue from %s reuses checkpointed tool results without repeating effects', async (adapter, restored) => {
    const dir = mkdtempSync(join(tmpdir(), 'heynimbo-resume-'))
    const store = adapter === 'memory' ? new MemoryAgentStore() : new SqliteAgentStore(join(dir, 'agent.sqlite'))
    try {
      let effects = 0
      let calls = 0
      const model = new MockLanguageModelV4({ doStream: async () => {
        if (calls++) throw new Error('interrupted connection')
        return { stream: new ReadableStream<Chunk>({ start(controller) { for (const chunk of chunks({ calls: [{ name: 'research', id: 'once' }] })) controller.enqueue(chunk); controller.close() } }) }
      } })
      const tools = [agentTool({ execute: async () => { effects++; return { ok: true, content: 'completed evidence', summary: 'Read source' } } })]
      const first = setup(model, tools, { store })
      const { runId } = await first.start()
      expect((await first.terminal(runId)).status).toBe('failed')
      expect(effects).toBe(1)
      if (restored === 'interrupted') {
        store.resume(runId, Date.now())
        expect(store.interruptUnfinished(Date.now())).toEqual([runId])
      }
      const resumedModel = scripted([{ text: 'Resumed with evidence' }])
      const next = setup(resumedModel, tools, { store, memoryStore: first.memoryStore, artifacts: first.artifacts, memoryArtifacts: first.memoryArtifacts })
      await next.runtime.handle({ kind: 'continue', runId, model: { provider: 'mock', model: 'mock' } })
      expect((await next.terminal(runId)).status).toBe('succeeded')
      expect(effects).toBe(1)
      expect(JSON.stringify(resumedModel.doStreamCalls[0]?.prompt)).toContain('completed evidence')
      expect(store.latestCheckpoint(runId)?.step).toBe(2)
      await expect(next.runtime.handle({ kind: 'continue', runId, model: { provider: 'mock', model: 'mock' } })).rejects.toThrow()
      const blocked = deferred<MockLanguageModelV4>()
      const other = setup(undefined, [], { store, models: () => blocked.promise })
      const live = await other.start({ requestId: 'other' })
      await expect(other.runtime.handle({ kind: 'continue', runId, model: { provider: 'mock', model: 'mock' } })).rejects.toThrow()
      await other.runtime.handle({ kind: 'cancelAll' })
      expect(store.getRun(live.runId)?.status).toBe('cancelled')
      blocked.resolve(scripted([{ text: 'late' }]))
      await Promise.all([first.runtime.shutdown(), next.runtime.shutdown(), other.runtime.shutdown()])
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('temporary runs and artifacts never access retained storage', async () => {
    const blocked = new Proxy({} as FakeStore, { get: () => { throw new Error('retained store touched') } })
    const blockedArtifacts = new Proxy({} as FakeArtifacts, { get: () => { throw new Error('retained artifacts touched') } })
    const h = setup(scripted([{ calls: [{ name: 'save', id: 'save1' }] }, { text: 'Saved' }]), [agentTool({ name: 'save', scope: 'any', effect: 'artifact-write', execute: async (_input, ctx) => {
      const meta = await ctx.artifacts.save(ctx.runId, 'note.md', 'text/markdown', new TextEncoder().encode('temporary note'))
      return { ok: true, content: 'Saved note', summary: 'Saved note', artifactId: meta.id }
    } })], { store: blocked, artifacts: blockedArtifacts })
    const { runId } = await h.start({ persistence: 'temporary' })
    expect((await h.terminal(runId)).status).toBe('succeeded')
    const artifact = await h.event(runId, 'artifact')
    expect(await h.runtime.handle({ kind: 'artifact', runId, artifactId: artifact.artifactId })).toEqual({ name: 'note.md', mediaType: 'text/markdown', bytes: 14, text: 'temporary note' })
    await h.runtime.handle({ kind: 'delete', runId })
    expect(h.memoryStore.getRun(runId)).toBeUndefined()
    expect(h.memoryStore.events(runId, 0, 200)).toEqual([])
    expect(h.memoryStore.latestCheckpoint(runId)).toBeUndefined()
    expect(h.memoryArtifacts.values.size).toBe(0)
  })

  it('deleting a conversation cancels waiting runs and purges both artifact partitions', async () => {
    const h = setup(scripted([{ calls: [{ name: 'ask_user', id: 'q1', input: '{"question":"Wait?"}' }] }]))
    const { runId } = await h.start({ conversationId: 'conv' })
    await h.event(runId, 'question')
    const saved = await h.artifacts.save(runId, 'x', 'text/plain', new Uint8Array())
    h.store.appendEvent(runId, { type: 'artifact', artifactId: saved.id, name: 'x', mediaType: 'text/plain', bytes: 0 }, Date.now())
    await h.runtime.handle({ kind: 'deleteConversation', conversationId: 'conv' })
    expect(h.store.getRun(runId)).toBeUndefined()
    expect(h.artifacts.values.size).toBe(0)
  })

  it.each([
    { key: 'maxSteps', value: 1, script: { calls: [{ name: 'research', id: 'c1' }] } },
    { key: 'maxOutputTokens', value: 2, script: { text: 'too many tokens', tokens: 3 } },
  ] as const)('$key exhaustion is a terminal budget failure with a clear reason', async ({ key, value, script }) => {
    const h = setup(scripted([script]), [agentTool()])
    const { runId } = await h.start({ budget: { ...DEFAULT_BUDGET, [key]: value } })
    const run = await h.terminal(runId)
    expect(run.status).toBe('failed')
    expect(run.error?.code).toBe('budget')
    expect(run.error?.message).toMatch(key === 'maxSteps' ? /step/i : /token/i)
    expect(h.store.latestCheckpoint(runId)).toBeDefined()
  })

  it('tool output is UTF-8 bounded by the remaining budget even when a tool ignores it', async () => {
    const remaining: number[] = []
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'c1' }] }]), [agentTool({ execute: async (_input, ctx) => { remaining.push(ctx.outputBudget); return { ok: true, content: '🙂🙂', summary: 'Two emojis' } } })])
    const { runId } = await h.start({ budget: { ...DEFAULT_BUDGET, maxToolOutputBytes: 5 } })
    expect((await h.terminal(runId)).error?.code).toBe('budget')
    expect(remaining).toEqual([5])
    const checkpoint = h.store.latestCheckpoint(runId)!
    expect(checkpoint.messages).toContain('🙂')
    expect(checkpoint.messages).not.toContain('🙂🙂')
    expect(checkpoint.messages).not.toContain('�')
  })

  it('wall deadline aborts a pending model factory and clears its timer', async () => {
    const gate = deferred<MockLanguageModelV4>()
    const h = setup(undefined, [], { models: () => gate.promise })
    const { runId } = await h.start({ budget: { ...DEFAULT_BUDGET, maxWallMs: 10 } })
    expect((await h.terminal(runId)).error?.code).toBe('budget')
    gate.resolve(scripted([{ text: 'late answer' }]))
    await h.runtime.shutdown()
    expect(h.events(runId).filter(event => event.type === 'text')).toHaveLength(0)
  })

  it.each(['provider', 'model_unsupported'] as const)('%s failures never expose raw provider errors or credentials', async code => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw code === 'provider' ? new Error('sk-secret request body') : new UnsupportedFunctionalityError({ functionality: 'tools' }) } })
    const h = setup(model)
    const { runId } = await h.start()
    expect((await h.terminal(runId)).error?.code).toBe(code)
    expect(JSON.stringify(h.events(runId))).not.toContain('sk-secret')
    expect(h.events(runId)).toContainEqual(expect.objectContaining({ type: 'error', code }))
  })

  it('ask-user accepts only the current question and records the owner answer', async () => {
    const h = setup(scripted([{ calls: [{ name: 'ask_user', id: 'q1', input: '{"question":"Which source?"}' }] }, { text: 'Answered' }]))
    const { runId } = await h.start()
    const question = await h.event(runId, 'question')
    expect(h.store.getRun(runId)?.status).toBe('waiting_user')
    await expect(h.runtime.handle({ kind: 'answer', runId, questionId: 'old', text: 'bad' })).rejects.toThrow()
    await h.runtime.handle({ kind: 'answer', runId, questionId: question.questionId, text: 'The official docs' })
    await expect(h.runtime.handle({ kind: 'answer', runId, questionId: question.questionId, text: 'duplicate' })).rejects.toThrow()
    expect((await h.terminal(runId)).status).toBe('succeeded')
    expect(h.events(runId)).toContainEqual({ type: 'answer', questionId: question.questionId, text: 'The official docs' })
    expect(h.store.latestCheckpoint(runId)?.messages).toContain('The official docs')
  })

  it.each(['web', 'local'] as const)('%s mode denies cross-scope egress until explicit mixing at the next step', async mode => {
    const seen: { name: string; grants: readonly unknown[] }[] = []
    const tools = [agentTool({ name: 'network', scope: 'web' }), agentTool({ name: 'files', scope: 'local' })].map(entry => ({ ...entry, execute: async (_input: unknown, ctx: ToolContext) => { seen.push({ name: entry.name, grants: ctx.grants }); return { ok: true, content: 'ok', summary: 'ok' } } }))
    const forbidden = mode === 'web' ? 'files' : 'network'
    const model = scripted([{ calls: [{ name: forbidden, id: 'denied' }, { name: 'ask_user', id: 'q1', input: '{"question":"Ready?"}' }] }, { calls: [{ name: forbidden, id: 'allowed' }] }, { text: 'done' }])
    const h = setup(model, tools)
    const grants = [{ id: 'g1', root: '/owner/folder', label: 'Folder' }]
    const { runId } = await h.start({ mode, grants })
    const question = await h.event(runId, 'question')
    expect(seen).toHaveLength(0)
    expect((await h.event(runId, 'tool.denied')).reason).toMatch(/owner.*mix/i)
    expect(model.doStreamCalls[0]?.tools?.map(tool => tool.name)).not.toContain(forbidden)
    await h.runtime.handle({ kind: 'allowMix', runId })
    await h.runtime.handle({ kind: 'answer', runId, questionId: question.questionId, text: 'Yes' })
    expect((await h.terminal(runId)).status).toBe('succeeded')
    expect(seen).toEqual([{ name: forbidden, grants: mode === 'local' ? grants : [] }])
    expect(h.events(runId)).toContainEqual({ type: 'mode.mixed', allowed: mode === 'web' ? 'local' : 'web' })
  })

  it('invalid input and thrown tool errors become fixed safe results rather than raw exception text', async () => {
    let effects = 0
    const h = setup(scripted([{ calls: [{ name: 'invalid', id: 'i1' }, { name: 'broken', id: 'i2' }] }, { text: 'done' }]), [
      agentTool({ name: 'invalid', parse: () => { throw new Error('sk-secret input details') }, execute: async () => { effects++; return { ok: true, content: 'bad', summary: 'bad' } } }),
      agentTool({ name: 'broken', execute: async () => { throw new Error('sk-secret transport details') } }),
    ])
    const { runId } = await h.start()
    expect((await h.terminal(runId)).status).toBe('succeeded')
    expect(effects).toBe(0)
    expect(h.events(runId).filter(event => event.type === 'tool.result' && !event.ok)).toHaveLength(2)
    expect(JSON.stringify(h.events(runId)) + h.store.latestCheckpoint(runId)?.messages).not.toContain('sk-secret')
  })

  it('cancellation discards a late tool result and fences a second queued tool effect', async () => {
    const gate = deferred<ToolOutcome>()
    let effects = 0
    let signal: AbortSignal | undefined
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'c1' }, { name: 'research', id: 'c2' }] }]), [agentTool({ execute: async (_input, ctx) => { signal = ctx.signal; effects++; return gate.promise } })])
    const { runId } = await h.start()
    await h.event(runId, 'tool.call')
    await h.runtime.handle({ kind: 'cancel', runId })
    expect(signal?.aborted).toBe(true)
    gate.resolve({ ok: true, content: 'late secret', summary: 'Late result' })
    await h.runtime.shutdown()
    expect(effects).toBe(1)
    expect(h.store.getRun(runId)?.status).toBe('cancelled')
    expect(h.events(runId).filter(event => event.type === 'tool.result')).toHaveLength(0)
    expect(h.store.latestCheckpoint(runId)).toBeUndefined()
  })

  it.each(['approved', 'denied'] as const)('%s approval is bound to normalized arguments and consumed only once', async decision => {
    let effects = 0
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'c1', input: '{"z":1,"a":2}' }] }, { text: 'done' }]), [agentTool({
      needsApproval: () => true, preview: () => 'Trusted host preview', execute: async () => { effects++; return { ok: true, content: 'ok', summary: 'Executed' } },
    })])
    const { runId } = await h.start()
    const request = await h.event(runId, 'approval.requested')
    expect(h.store.getRun(runId)?.status).toBe('waiting_approval')
    expect(effects).toBe(0)
    expect(request.preview).toBe('Trusted host preview')
    expect(request.digest).toBe(createHash('sha256').update('research\n{"a":2,"z":1}').digest('hex'))
    await expect(h.runtime.handle({ kind: 'approve', runId, approvalId: 'wrong', decision })).rejects.toThrow()
    await h.runtime.handle({ kind: 'approve', runId, approvalId: request.approvalId, decision })
    await expect(h.runtime.handle({ kind: 'approve', runId, approvalId: request.approvalId, decision })).rejects.toThrow()
    expect((await h.terminal(runId)).status).toBe('succeeded')
    expect(effects).toBe(decision === 'approved' ? 1 : 0)
    expect(h.events(runId)).toContainEqual({ type: 'approval.decided', approvalId: request.approvalId, decision })
    if (decision === 'denied') expect(h.events(runId).some(event => event.type === 'tool.denied')).toBe(true)
  })

  it('cancel invalidates an approval wait before any effect can start', async () => {
    let effects = 0
    const h = setup(scripted([{ calls: [{ name: 'research', id: 'c1' }] }]), [agentTool({ needsApproval: () => true, execute: async () => { effects++; return { ok: true, content: 'ok', summary: 'ok' } } })])
    const { runId } = await h.start()
    const request = await h.event(runId, 'approval.requested')
    await h.runtime.handle({ kind: 'cancel', runId })
    await expect(h.runtime.handle({ kind: 'approve', runId, approvalId: request.approvalId, decision: 'approved' })).rejects.toThrow()
    expect((await h.terminal(runId)).status).toBe('cancelled')
    expect(effects).toBe(0)
  })

  it('checkpoints two sequential research tool calls before the final answer and deduplicates start', async () => {
    let effects = 0
    const model = scripted([{ calls: [{ name: 'research', id: 'c1' }, { name: 'research', id: 'c2' }] }, { text: 'A cited answer' }])
    const h = setup(model, [agentTool({ execute: async () => { effects++; return { ok: true, content: 'private full evidence', summary: 'Read source' } } })])
    const { runId } = await h.start()
    expect(await h.start()).toEqual({ runId })
    expect((await h.terminal(runId)).status).toBe('succeeded')
    expect(effects).toBe(2)
    expect(h.events(runId).filter(event => event.type === 'tool.result')).toHaveLength(2)
    expect(JSON.stringify(h.events(runId))).not.toContain('private full evidence')
    expect(h.store.latestCheckpoint(runId)?.messages).toContain('private full evidence')
    expect(h.store.latestCheckpoint(runId)?.step).toBe(2)
    expect(h.events(runId).filter(event => event.type === 'usage')).toHaveLength(2)
    expect(h.store.getRun(runId)?.usage).toEqual({ inputTokens: 4, outputTokens: 6 })
    expect((await h.runtime.handle({ kind: 'events', runId, afterSeq: 0, limit: 100 }) as { events: AgentEvent[] }).events[0]?.payload.type).toBe('run.created')
    expect((await h.runtime.handle({ kind: 'list', limit: 10 }) as { runs: unknown[] }).runs).toHaveLength(1)
    expect(h.events(runId)).toContainEqual({ type: 'text', step: 2, text: 'A cited answer' })
  })
})
