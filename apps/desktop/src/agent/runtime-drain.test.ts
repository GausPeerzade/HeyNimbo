import { afterEach, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { DEFAULT_BUDGET } from '../shared/agent-protocol'
import type { AgentTool, RuntimeDeps, ToolOutcome } from './contracts'
import { MemoryArtifactStore } from './artifacts'
import { MemoryAgentStore } from './store'
import { createAgentRuntime } from './runtime'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
type Response = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
const response = (call = false): Response => ({ stream: new ReadableStream({ start(controller) {
  if (call) controller.enqueue({ type: 'tool-call', toolCallId: 'call', toolName: 'read', input: '{}' })
  controller.enqueue({ type: 'finish', finishReason: { unified: call ? 'tool-calls' : 'stop', raw: 'fixture' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } })
  controller.close()
} }) })
const model = () => new MockLanguageModelV4({ doStream: async () => response() })
function setup(override: Partial<RuntimeDeps> = {}) {
  const store = new MemoryAgentStore()
  const runtime = createAgentRuntime({ store, memoryStore: new MemoryAgentStore(), artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore(), models: async () => model(), tools: () => [], credentials: async () => '', sink: { events: () => {}, partial: () => {} }, ...override })
  let next = 0
  const start = () => runtime.handle({ kind: 'start', requestId: `drain-${++next}`, goal: 'Finish', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'fixture', model: 'fixture' } }) as Promise<{ runId: string }>
  return { runtime, store, start }
}
afterEach(() => vi.useRealTimers())

it('retains a reservation until an active provider stream cancellation promise settles', async () => {
  vi.useFakeTimers()
  const entered = deferred<void>(), cancelled = deferred<void>(), release = deferred<void>()
  const selected = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({
    start(controller) { controller.enqueue({ type: 'stream-start', warnings: [] }); entered.resolve() },
    cancel() { cancelled.resolve(); return release.promise },
  }) }) })
  const h = setup({ maxActiveRuns: 1, models: async () => selected })
  await h.start(); await entered.promise
  await vi.advanceTimersByTimeAsync(0)
  const stopped = h.runtime.handle({ kind: 'cancelAll' })
  try {
    await vi.advanceTimersByTimeAsync(750)
    await cancelled.promise
    expect(await stopped).toEqual({ ok: true, unsettled: 1 })
    await expect(h.start()).rejects.toThrow('The agent is at capacity.')
  } finally { release.resolve(); await vi.advanceTimersByTimeAsync(0); await h.runtime.shutdown() }
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['cancelAll', 'shutdown'] as const)('%s reports all held factories at exactly 750 ms without releasing their reservations', async kind => {
  vi.useFakeTimers()
  const gate = deferred<MockLanguageModelV4>()
  const h = setup({ models: () => gate.promise })
  const ids = await Promise.all([h.start(), h.start(), h.start()])
  let settled = false
  const stopped = (kind === 'cancelAll' ? h.runtime.handle({ kind }) : h.runtime.shutdown()).then(result => { settled = true; return result })
  try {
    expect(ids.map(({ runId }) => h.store.getRun(runId)?.status)).toEqual(Array(3).fill(kind === 'shutdown' ? 'interrupted' : 'cancelled'))
    await vi.advanceTimersByTimeAsync(749)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await stopped).toEqual({ ok: true, unsettled: 3 })
    if (kind === 'cancelAll') await expect(h.start()).rejects.toThrow('The agent is at capacity.')
  } finally { gate.resolve(model()); await vi.runAllTimersAsync(); await h.runtime.shutdown() }
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['factory', 'provider', 'tool'] as const)('cancelAll drains cooperative %s work and releases admission before its deadline', async boundary => {
  vi.useFakeTimers()
  const entered = deferred<void>(), factory = deferred<MockLanguageModelV4>(), provider = deferred<Response>(), effect = deferred<ToolOutcome>()
  const selected = new MockLanguageModelV4({ doStream: async options => {
    if (boundary === 'provider') {
      entered.resolve()
      options.abortSignal?.addEventListener('abort', () => provider.resolve(response()), { once: true })
      return provider.promise
    }
    return response(true)
  } })
  const read: AgentTool = { name: 'read', scope: 'web', effect: 'read', description: 'Fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, parse: x => x, needsApproval: () => false, preview: () => 'Read', execute: async (_input, ctx) => {
    ctx.signal.addEventListener('abort', () => effect.resolve({ ok: true, content: 'late', summary: 'late' }), { once: true })
    entered.resolve()
    return effect.promise
  } }
  const h = setup({ maxActiveRuns: 1, models: () => boundary === 'factory' ? factory.promise : Promise.resolve(selected), tools: () => [read] })
  const { runId } = await h.start()
  if (boundary !== 'factory') await entered.promise
  const stopped = h.runtime.handle({ kind: 'cancelAll' })
  if (boundary === 'factory') factory.resolve(model())
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(await stopped).toEqual({ ok: true, unsettled: 0 })
    expect(h.store.events(runId, 0, 200).at(-1)?.payload).toEqual({ type: 'status', status: 'cancelled' })
    expect(h.store.latestCheckpoint(runId)).toBeUndefined()
    factory.resolve(model())
    await expect(h.start()).resolves.toHaveProperty('runId')
  } finally { await h.runtime.shutdown() }
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['provider', 'tool'] as const)('cancelAll reports abort-ignoring %s promises even after the SDK stream has stopped', async boundary => {
  vi.useFakeTimers()
  const entered = deferred<void>(), provider = deferred<Response>(), effect = deferred<ToolOutcome>()
  const selected = new MockLanguageModelV4({ doStream: async () => {
    if (boundary === 'provider') { entered.resolve(); return provider.promise }
    return response(true)
  } })
  const read: AgentTool = { name: 'read', scope: 'web', effect: 'read', description: 'Fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, parse: x => x, needsApproval: () => false, preview: () => 'Read', execute: () => { entered.resolve(); return effect.promise } }
  const h = setup({ maxActiveRuns: 1, models: async () => selected, tools: () => [read] })
  const { runId } = await h.start()
  await entered.promise
  const stopped = h.runtime.handle({ kind: 'cancelAll' })
  try {
    await vi.advanceTimersByTimeAsync(750)
    expect(await stopped).toEqual({ ok: true, unsettled: 1 })
    await expect(h.start()).rejects.toThrow('The agent is at capacity.')
    expect(h.store.events(runId, 0, 200).at(-1)?.payload).toEqual({ type: 'status', status: 'cancelled' })
  } finally {
    provider.resolve(response()); effect.resolve({ ok: true, content: 'late', summary: 'late' })
    await vi.advanceTimersByTimeAsync(0)
    await h.runtime.shutdown()
  }
  expect(vi.getTimerCount()).toBe(0)
})
