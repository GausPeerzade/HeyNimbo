import { EventEmitter } from 'node:events'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { AgentSupervisor } from '../main/agent-supervisor'
import { MockLanguageModelV4 } from 'ai/test'
import { createAgentRuntime } from './runtime'
import { MemoryAgentStore } from './store'
import { MemoryArtifactStore } from './artifacts'
import { htmlToText } from './html-text'
import { serveHost, type HostPort } from './host/serve'
import type { AgentTool } from './contracts'
import { DEFAULT_BUDGET, isTerminal, type AgentEvent, type AgentPush, type HostCommand, type MainToHost } from '../shared/agent-protocol'

class Child extends EventEmitter {
  postMessage(message: MainToHost): void {
    if (message.kind === 'init') queueMicrotask(() => this.emit('message', { v: 1, kind: 'ready' }))
    if (message.kind === 'command') queueMicrotask(() => this.emit('message', { v: 1, kind: 'reply', id: message.id, ok: true, result: { runId: 'load' } }))
  }
  kill(): boolean { this.emit('exit', 0); return true }
}
const start: HostCommand = { kind: 'start', requestId: 'load', goal: 'Synthetic background research', mode: 'web', persistence: 'temporary', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'mock', model: 'scripted' } }
function traffic() {
  const child = new Child(), pushes: AgentPush[] = []
  const supervisor = new AgentSupervisor({ spawn: () => child, credentials: async () => '', onPush: value => pushes.push(value), dataDir: process.env.TMPDIR! })
  const event = (seq: number): AgentEvent => ({ id: `event-${seq}`, runId: 'load', seq, at: Date.now(), payload: { type: 'tool.result', callId: `call-${seq}`, ok: true, summary: 'Read a bounded public source. '.repeat(12) } })
  return { child, pushes, supervisor, event }
}

// R1–R8 owner: flush bounded queues before capacity instead of crashing on a
// legal burst. Keep this executable expected failure until that fix is merged.
it.fails('keeps a valid three-batch burst alive and delivers every event instead of treating backpressure as a host crash', async () => {
  const h = traffic()
  try {
    await h.supervisor.request(start)
    for (let batch = 0; batch < 3; batch++) h.child.emit('message', { v: 1, kind: 'events', events: Array.from({ length: 256 }, (_, i) => h.event(batch * 256 + i + 1)), runs: [] })
    await delay(35)
    expect(h.supervisor.state).toBe('ready')
    expect(h.pushes.flatMap(push => push.kind === 'events' ? push.events.map(event => event.seq) : [])).toEqual(Array.from({ length: 768 }, (_, i) => i + 1))
  } finally { h.supervisor.dispose() }
})

async function measureTraffic() {
  const h = traffic(), lag = monitorEventLoopDelay({ resolution: 1 })
  let seq = 0
  try {
    await h.supervisor.request(start)
    lag.enable()
    await delay(10) // Prime the histogram before the measured traffic.
    const at = performance.now()
    for (let tick = 0; tick < 100; tick++) {
      // Mix both streams in every tick: phased traffic would hide the extra
      // Home fan-out when durable events and partials share a flush window.
      const events = Array.from({ length: 50 }, () => h.event(++seq))
      h.child.emit('message', { v: 1, kind: 'events', events, runs: [] })
      for (let i = 0; i < 20; i++) h.child.emit('message', { v: 1, kind: 'partial', runId: 'load', step: 1, text: `${tick * 20 + i}:` + 'source evidence '.repeat(80) })
      const remaining = at + (tick + 1) * 10 - performance.now()
      if (remaining > 0) await delay(remaining)
    }
    await delay(35)
    const elapsed = performance.now() - at
    // Approval/terminal messages are urgent and must not be hidden by batching.
    h.child.emit('message', { v: 1, kind: 'events', runs: [], events: [{ id: 'urgent', runId: 'load', seq: ++seq, at: Date.now(), payload: { type: 'status', status: 'succeeded' } }] })
    const events = h.pushes.flatMap(push => push.kind === 'events' ? push.events : [])
    const partials = h.pushes.filter(push => push.kind === 'partial')
    const homePushes = h.pushes.filter(push => push.kind !== 'host').length
    const p99 = lag.percentile(99) / 1e6
    console.info(`[agent-perf] S1/S2 traffic: ${elapsed.toFixed(1)}ms, events=${events.length - 1}, partialInputs=2000, Home=${homePushes}, loop p99=${p99.toFixed(3)}ms`)
    return { events, partials, homePushes, elapsed, p99, invalidMessages: h.supervisor.invalidMessages, state: h.supervisor.state }
  } finally { lag.disable(); h.supervisor.dispose() }
}

it('processes 5000 mixed valid events and 2000 partials without event loss or a main-loop p99 stall', async () => {
  const result = await measureTraffic()
  expect(result.events.map(event => event.seq)).toEqual(Array.from({ length: 5001 }, (_, i) => i + 1))
  expect(result.partials.at(-1)?.text).toMatch(/^1999:/)
  expect(result.invalidMessages).toBe(0)
  expect(result.state).toBe('ready')
  // Provisional machine-local proxy, not a renderer/audio release SLO.
  expect(result.p99).toBeLessThan(20)
  expect(result.partials.length).toBeLessThanOrEqual(Math.ceil(result.elapsed / 16) + 2)
})

// R1–R8 output-coalescing owner: current flush emits separate Home calls for
// durable events and partials in the same frame (observed 101 vs a 69 bound).
it.fails('limits combined Home event and partial pushes to approximately one per frame under mixed traffic', async () => {
  const result = await measureTraffic()
  expect(result.homePushes).toBeLessThanOrEqual(Math.ceil(result.elapsed / 16) + 4)
})

type Chunk = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C> ? C : never
const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2000, text: 2000, reasoning: undefined } }
it('completes 2000 text deltas and 50 serialized tool calls while coalescing partial output by the flush window', async () => {
  const flushMs = 16, memory = new MemoryAgentStore(), retained = new MemoryAgentStore()
  let calls = 0, active = 0, maxActive = 0, partials = 0, streams = 0
  const events: AgentEvent[] = []
  let terminal!: () => void
  const done = new Promise<void>(resolve => { terminal = resolve })
  const model = new MockLanguageModelV4({ doStream: async () => {
    const first = ++streams === 1
    return { stream: new ReadableStream<Chunk>({ async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'text-start', id: 'text' })
      if (first) {
        for (let i = 0; i < 2000; i++) {
          controller.enqueue({ type: 'text-delta', id: 'text', delta: 'x' })
          if (i % 40 === 39) await delay(2)
        }
        for (let i = 0; i < 50; i++) controller.enqueue({ type: 'tool-call', toolCallId: `read-${i}`, toolName: 'read_source', input: '{}' })
      } else controller.enqueue({ type: 'text-delta', id: 'text', delta: 'Completed research.' })
      controller.enqueue({ type: 'text-end', id: 'text' })
      controller.enqueue({ type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: 'scripted' }, usage })
      controller.close()
    } }) }
  } })
  const tool: AgentTool = {
    name: 'read_source', description: 'Read synthetic bounded evidence', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, scope: 'web', effect: 'network-read',
    parse: input => input, needsApproval: () => false, preview: () => 'Read a source',
    async execute(_input, context) {
      context.checkpoint(); calls++; active++; maxActive = Math.max(maxActive, active)
      await delay(1)
      active--; context.checkpoint()
      return { ok: true, content: 'bounded fixture evidence', summary: 'Source read.' }
    },
  }
  const runtime = createAgentRuntime({ store: retained, memoryStore: memory, artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore(), models: async () => model, tools: () => [tool], credentials: async () => '', flushMs, sink: { partial: () => { partials++ }, events(batch) { events.push(...batch); if (batch.some(event => event.payload.type === 'status' && isTerminal(event.payload.status))) terminal() } } })
  const at = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await runtime.handle(start) as { runId: string }
    await Promise.race([done, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Scripted runtime did not complete.')), 3000) })])
    const elapsed = performance.now() - at
    console.info(`[agent-perf] runtime: ${elapsed.toFixed(1)}ms, deltas=2000, tools=${calls}, partials=${partials}, flush=${flushMs}ms`)
    expect(memory.getRun(result.runId)?.status).toBe('succeeded')
    expect(retained.listRuns(10)).toEqual([])
    expect(calls).toBe(50)
    expect(maxActive).toBe(1)
    expect(streams).toBe(2)
    expect(partials).toBeGreaterThan(0)
    expect(partials).toBeLessThanOrEqual(Math.ceil(elapsed / flushMs) + 2)
    expect(events.filter(event => event.payload.type === 'text').map(event => event.payload)).toEqual([{ type: 'text', step: 1, text: 'x'.repeat(2000) }, { type: 'text', step: 2, text: 'Completed research.' }])
    expect(events.filter(event => event.payload.type === 'tool.result')).toHaveLength(50)
    expect(memory.latestCheckpoint(result.runId)?.step).toBe(2)
  } finally { clearTimeout(timer); await runtime.shutdown(); memory.close(); retained.close() }
})

it('reports measured Explain TTFT, completion and loop delay for idle, one-run and three-run plus 5 MiB extraction scenarios', async () => {
  type Scenario = { name: string; samples: { firstTokenMs: number; totalMs: number }[]; providerRequests: number; loop: { p50Ms: number; p99Ms: number }; load?: { completed: number; extractionBytes: number; overlapsExplain: boolean } }
  // The standalone JS entry has no declaration file; narrow its public result
  // here instead of allowing an untyped measurement into the assertions.
  // @ts-expect-error Standalone ESM benchmark intentionally does not emit .d.ts.
  const bench = await import('../../scripts/agent-bench.mjs') as { main(args: string[], write: (line: string) => void): Promise<{ scenarios: Scenario[] }>; runBenchmark(options: { samples: number }): Promise<unknown> }
  const lines: string[] = []
  await expect(bench.runBenchmark({ samples: 0 })).rejects.toThrow('samples must be an integer from 3 to 50')
  const report = await bench.main(['--samples=3'], line => lines.push(line))
  expect(lines.some(line => line.startsWith('BENCH_JSON '))).toBe(true)
  expect(report.scenarios.map(scenario => scenario.name)).toEqual(['S0', 'S1', 'S2'])
  for (const scenario of report.scenarios) {
    expect(scenario.samples).toHaveLength(3)
    expect(scenario.providerRequests).toBe(3)
    expect(scenario.loop.p50Ms).toBeGreaterThan(0)
    expect(scenario.loop.p99Ms).toBeGreaterThanOrEqual(scenario.loop.p50Ms)
    for (const sample of scenario.samples) {
      expect(sample.firstTokenMs).toBeGreaterThanOrEqual(0)
      expect(sample.totalMs).toBeGreaterThan(sample.firstTokenMs)
    }
  }
  expect(report.scenarios[0]?.load).toBeUndefined()
  expect(report.scenarios[1]?.load?.completed).toBe(1)
  expect(report.scenarios[2]?.load).toMatchObject({ completed: 3, extractionBytes: 5 * 1024 * 1024, overlapsExplain: true })
}, 30_000)

it.each(['exit', 'error', 'timeout'] as const)('rejects benchmark host %s before readiness and releases its listeners instead of publishing incomplete metrics', async failure => {
  // @ts-expect-error The standalone JS benchmark intentionally has no .d.ts.
  const bench = await import('../../scripts/agent-bench.mjs') as { waitForHostMessage(child: EventEmitter, kind: string, timeoutMs: number): Promise<unknown> }
  const child = new EventEmitter()
  const pending = expect(bench.waitForHostMessage(child, 'bench.ready', 5)).rejects.toThrow(`Benchmark host ${failure === 'exit' ? 'exited' : failure === 'error' ? 'failed' : 'timed out'} before bench.ready`)
  child.emit('message', { kind: 'unrelated' })
  if (failure !== 'timeout') child.emit(failure, failure === 'error' ? new Error('Synthetic boundary failure') : 1)
  await pending
  for (const event of ['message', 'exit', 'error']) expect(child.listenerCount(event)).toBe(0)
})

it('exercises the benchmark load through serveHost and the real supervisor, preserving all three completions and bounded extraction', async () => {
  type LoadMetrics = { completed: number; deltas: number; partials: number; extractionBytes: number; extractionMs: number }
  type Notice = { kind: string; metrics?: LoadMetrics }
  // @ts-expect-error The standalone JS benchmark intentionally has no .d.ts.
  const bench = await import('../../scripts/agent-bench.mjs') as { serveBenchmarkHost(app: object, port: HostPort, options: { count: number; extraction: boolean; notify(value: Notice): void }): Promise<{ close(): Promise<void> }> }
  const child = new Child(), inbound = new EventEmitter(), pushes: AgentPush[] = []
  child.postMessage = message => { queueMicrotask(() => inbound.emit('message', message)) }
  let finish!: (metrics: LoadMetrics) => void
  const done = new Promise<LoadMetrics>(resolve => { finish = resolve })
  const notices: string[] = []
  const app = { MemoryAgentStore, MemoryArtifactStore, createAgentRuntime, htmlToText, serveHost, isTerminal }
  const host = await bench.serveBenchmarkHost(app, { on: (_event, listener) => inbound.on('message', listener), postMessage: value => { queueMicrotask(() => child.emit('message', value)) } }, { count: 3, extraction: true, notify: notice => { notices.push(notice.kind); if (notice.metrics) finish(notice.metrics) } })
  const supervisor = new AgentSupervisor({ spawn: () => child, credentials: async () => '', onPush: push => pushes.push(push), dataDir: process.env.TMPDIR! })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.all(Array.from({ length: 3 }, (_, i) => supervisor.request({ ...start, requestId: `bench-load-${i}` })))
    const metrics = await Promise.race([done, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Benchmark load did not complete.')), 3000) })])
    expect(metrics).toMatchObject({ completed: 3, deltas: 6000, extractionBytes: 5 * 1024 * 1024 })
    expect(metrics.partials).toBeGreaterThan(0)
    expect(metrics.extractionMs).toBeGreaterThan(0)
    expect(notices).toEqual(['bench.ready', 'bench.streaming', 'bench.completed'])
    const result = await supervisor.request({ kind: 'list', limit: 10 }) as { runs: { status: string }[] }
    expect(result.runs.map(run => run.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(pushes.filter(push => push.kind === 'events').flatMap(push => push.events).filter(event => event.payload.type === 'text')).toHaveLength(3)
    expect(supervisor.invalidMessages).toBe(0)
  } finally { clearTimeout(timer); await host.close(); supervisor.dispose() }
})
