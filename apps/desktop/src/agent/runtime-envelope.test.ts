import { afterEach, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { sdkModel } from '../main/answer-provider'
import { DEFAULT_BUDGET, isTerminal } from '../shared/agent-protocol'
import type { AgentRuntime, AgentTool, RuntimeDeps } from './contracts'
import { MemoryArtifactStore } from './artifacts'
import { MemoryAgentStore } from './store'
import { createAgentRuntime } from './runtime'

type Chunk = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C> ? C : never
const runtimes: AgentRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.shutdown() })
function setup(override: Partial<RuntimeDeps>) {
  const store = new MemoryAgentStore()
  const runtime = createAgentRuntime({ store, memoryStore: new MemoryAgentStore(), artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore(), models: async () => { throw new Error('Missing fixture') }, tools: () => [], credentials: async () => '', sink: { events: () => {}, partial: () => {} }, ...override })
  runtimes.push(runtime)
  const start = () => runtime.handle({ kind: 'start', requestId: 'envelope', goal: 'Finish', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'compatible', model: 'fixture', baseURL: 'https://synthetic.invalid/v1' } }) as Promise<{ runId: string }>
  const terminal = async (id: string) => { await vi.waitFor(() => expect(isTerminal(store.getRun(id)!.status)).toBe(true)); return store.getRun(id)! }
  return { store, runtime, start, terminal }
}
const read = (effect: (input: unknown) => void): AgentTool => ({ name: 'read', scope: 'web', effect: 'read', description: 'Synthetic read', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false }, parse: x => x, needsApproval: () => false, preview: () => 'Read', execute: async input => { effect(input); return { ok: true, content: 'Evidence', summary: 'Read' } } })
function compatible(records: (request: number) => unknown[]) {
  let pulled = 0, requests = 0
  const selected = sdkModel({ provider: 'compatible', model: 'fixture', baseURL: 'https://synthetic.invalid/v1', vision: false, credential: async () => '' }, '', async () => {
    const chunks = records(requests++)
    let index = 0
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (index === chunks.length) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); return }
      pulled++
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunks[index++])}\n\n`))
    } }), { headers: { 'content-type': 'text/event-stream' } })
  })
  return { selected, pulled: () => pulled }
}
const record = (delta: unknown, finish_reason: string | null = null) => ({ id: 'response', model: 'fixture', created: 0, choices: [{ index: 0, delta, finish_reason }] })

it('rejects 256 KiB call IDs through the production compatible SSE adapter before pulling all forty records or executing tools', async () => {
  const transport = compatible(() => [...Array.from({ length: 40 }, (_, index) => record({ tool_calls: [{ index, id: String(index).padEnd(256 * 1024, 'x'), type: 'function', function: { name: 'read', arguments: '{}' } }] })), record({}, 'tool_calls')])
  let effects = 0
  const h = setup({ models: async () => transport.selected, tools: () => [read(() => { effects++ })] })
  const { runId } = await h.start()
  const result = await h.terminal(runId)
  console.info(`rawIds chunks pulled: ${transport.pulled()}/41`)
  expect(transport.pulled()).toBeLessThan(40)
  expect(result.error).toEqual({ code: 'budget', message: 'The model response was too large.' })
  expect(h.store.latestCheckpoint(runId)).toBeUndefined()
  expect(effects).toBe(0)
})

it('preserves fragmented arguments and long text below the per-step envelope budget through the production adapter', async () => {
  const text = 'normal '.repeat(5500), argument = JSON.stringify({ text: 'valid'.repeat(160000) })
  const transport = compatible(request => request ? [record({ content: text }), record({}, 'stop')] : [
    record({ tool_calls: [{ index: 0, id: 'i'.repeat(256), type: 'function', function: { name: 'read', arguments: '' } }] }),
    ...Array.from({ length: Math.ceil(argument.length / 16000) }, (_, index) => record({ tool_calls: [{ index: 0, function: { arguments: argument.slice(index * 16000, (index + 1) * 16000) } }] })),
    record({}, 'tool_calls'),
  ])
  const inputs: unknown[] = []
  const h = setup({ models: async () => transport.selected, tools: () => [read(input => { inputs.push(input) })] })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).status).toBe('succeeded')
  expect(inputs).toEqual([JSON.parse(argument)])
  expect(h.store.events(runId, 0, 200).map(e => e.payload)).toContainEqual({ type: 'text', step: 2, text })
})

// 1 is the worst legal fragmentation; 1,000 and 48,000 are typical and single-record providers.
it.each([1, 1000, 48000])('accepts the same near-limit 48,000-character answer whether the provider sends it %i characters per SSE record', async size => {
  // Same shape as the review's reproduction: a code answer just under the 48,000-character text limit.
  const answer = 'const x = 1;\n'.repeat(4000).slice(0, 48000)
  const transport = compatible(() => [...Array.from({ length: Math.ceil(answer.length / size) }, (_, i) => record({ content: answer.slice(i * size, (i + 1) * size) })), record({}, 'stop')])
  const h = setup({ models: async () => transport.selected })
  const { runId } = await h.start()
  const run = await h.terminal(runId)
  expect(run.status).toBe('succeeded')
  expect(h.store.events(runId, 0, 200).map(e => e.payload)).toContainEqual({ type: 'text', step: 1, text: answer })
}, 30_000)

it('still fails early on a flood of empty stream parts that carry no content', async () => {
  let pulled = 0
  const selected = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ pull(controller) {
    if (pulled++ === 0) { controller.enqueue({ type: 'text-start', id: 't' }); return }
    if (pulled > 400_000) { controller.close(); return }
    controller.enqueue({ type: 'text-delta', id: 't', delta: '' })
  } }) }) })
  const h = setup({ models: async () => selected })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).error).toEqual({ code: 'budget', message: 'The model response was too large.' })
  expect(pulled).toBeLessThan(400_000)
}, 30_000)

it('charges provider metadata attached to text deltas instead of exempting it with the delta text', async () => {
  let pulled = 0
  const selected = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ pull(controller) {
    if (pulled++ === 0) { controller.enqueue({ type: 'text-start', id: 't' }); return }
    if (pulled > 40) { controller.close(); return }
    controller.enqueue({ type: 'text-delta', id: 't', delta: 'a', providerMetadata: { fixture: { padding: 'p'.repeat(100_000) } } } as Chunk)
  } }) }) })
  const h = setup({ models: async () => selected })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).error).toEqual({ code: 'budget', message: 'The model response was too large.' })
  expect(pulled).toBeLessThan(40)
})

it.each(['toolCallId', 'toolName', 'id'] as const)('rejects an oversized %s field before SDK accumulation', async field => {
  const chunk: Chunk = field === 'id' ? { type: 'tool-input-start', id: 'i'.repeat(257), toolName: 'read' } : { type: 'tool-call', toolCallId: 'call', toolName: 'read', input: '{}', [field]: 'x'.repeat(field === 'toolName' ? 129 : 257) }
  const selected = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ start(controller) { controller.enqueue(chunk); controller.close() } }) }) })
  let effects = 0
  const h = setup({ models: async () => selected, tools: () => [read(() => { effects++ })] })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).error).toEqual({ code: 'budget', message: 'The model response was too large.' })
  expect(h.store.latestCheckpoint(runId)).toBeUndefined()
  expect(effects).toBe(0)
})

it('counts nested provider metadata in the cumulative 2 MiB raw envelope before a checkpoint', async () => {
  let pulled = 0
  const selected = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ pull(controller) {
    if (pulled++ === 12) { controller.close(); return }
    controller.enqueue({ type: 'response-metadata', id: 'response', modelId: 'fixture', providerMetadata: { fixture: { nested: { evidence: 'é'.repeat(100000) } } } } as Chunk)
  } }) }) })
  const h = setup({ models: async () => selected })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).error).toEqual({ code: 'budget', message: 'The model response was too large.' })
  expect(pulled).toBeLessThan(13)
  expect(h.store.latestCheckpoint(runId)).toBeUndefined()
})
