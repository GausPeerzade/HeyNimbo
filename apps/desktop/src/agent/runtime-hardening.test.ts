import { afterEach, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { AgentRuntime, AgentTool, RuntimeDeps } from './contracts'
import { DEFAULT_BUDGET, isTerminal, type AgentEvent, type HostCommand } from '../shared/agent-protocol'
import { MemoryArtifactStore } from './artifacts'
import { MemoryAgentStore } from './store'
import { createAgentRuntime } from './runtime'
import { artifactTools } from './tools/files'

type Chunk = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C> ? C : never
const runtimes: AgentRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.shutdown(); vi.useRealTimers() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }
function model(parts: Chunk[] = []) {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream<Chunk>({ start(controller) {
    for (const part of [{ type: 'stream-start' as const, warnings: [] }, ...parts, { type: 'finish' as const, finishReason: { unified: parts.some(p => p.type === 'tool-call') ? 'tool-calls' as const : 'stop' as const, raw: 'fixture' }, usage }]) controller.enqueue(part)
    controller.close()
  } }) }) })
}
function setup(override: Partial<RuntimeDeps> = {}) {
  const events: AgentEvent[] = []
  const deps = { store: new MemoryAgentStore(), memoryStore: new MemoryAgentStore(), artifacts: new MemoryArtifactStore(), memoryArtifacts: new MemoryArtifactStore(), models: async () => model(), tools: () => [], credentials: async () => '', sink: { events: (batch: AgentEvent[]) => { events.push(...batch) }, partial: () => {} }, ...override }
  const runtime = createAgentRuntime(deps); runtimes.push(runtime)
  let n = 0
  const start = (changes: Partial<Extract<HostCommand, { kind: 'start' }>> = {}) => runtime.handle({ kind: 'start', requestId: `request-${++n}`, goal: 'Finish safely', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, model: { provider: 'fixture', model: 'fixture' }, ...changes }) as Promise<{ runId: string }>
  const terminal = async (id: string) => { await vi.waitFor(() => expect(isTerminal((deps.memoryStore.getRun(id) ?? deps.store.getRun(id))!.status)).toBe(true)); return (deps.memoryStore.getRun(id) ?? deps.store.getRun(id))! }
  return { ...deps, runtime, events, start, terminal }
}

it('admits only three model factories in the 64-start probe without creating rejected runs', async () => {
  const gate = deferred<MockLanguageModelV4>()
  let pending = 0
  const h = setup({ models: async () => { pending++; return gate.promise } })
  const accepted: string[] = [], errors: string[] = []
  for (let i = 0; i < 64; i++) {
    try { accepted.push((await h.start()).runId) } catch (error) { errors.push((error as Error).message) }
  }
  try {
    expect(accepted).toHaveLength(3)
    expect(errors).toEqual(Array(61).fill('The agent is at capacity. Stop a task or wait for it to finish.'))
    expect(pending).toBe(3)
    expect(h.store.listRuns(200)).toHaveLength(3)
  } finally { gate.resolve(model()); await h.runtime.shutdown() }
})

it('retains a bounded reservation for cancelled abort-ignoring factories but ignores late settlement', async () => {
  const gate = deferred<MockLanguageModelV4>()
  const h = setup({ maxActiveRuns: 1, models: () => gate.promise })
  const { runId } = await h.start()
  await h.runtime.handle({ kind: 'cancel', runId })
  const before = h.store.events(runId, 0, 200)
  try {
    await expect(h.start()).rejects.toThrow('The agent is at capacity.')
    await expect(h.runtime.handle({ kind: 'approve', runId, approvalId: 'late', decision: 'approved' })).rejects.toThrow('Approval is no longer pending.')
    expect(h.store.getRun(runId)?.status).toBe('cancelled')
  } finally { gate.resolve(model()); await vi.waitFor(() => expect(h.store.events(runId, 0, 200)).toEqual(before)) }
  await vi.waitFor(async () => { const next = await h.start(); expect((await h.terminal(next.runId)).status).toBe('succeeded') })
  expect(h.store.events(runId, 0, 200)).toEqual(before)
})

const readTool = (effect: () => void): AgentTool => ({ name: 'read_file', scope: 'web', effect: 'read', description: 'Read bounded evidence', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, parse: input => input, needsApproval: () => false, preview: () => 'Read', execute: async () => { effect(); return { ok: true, content: 'read', summary: 'read' } } })

it('does not release a cancelled execution reservation while provider doStream ignores abort', async () => {
  const gate = deferred<Awaited<ReturnType<MockLanguageModelV4['doStream']>>>(), entered = deferred<void>()
  const selected = new MockLanguageModelV4({ doStream: async () => { entered.resolve(); return gate.promise } })
  const h = setup({ maxActiveRuns: 1, models: async () => selected })
  const { runId } = await h.start()
  await entered.promise
  await h.runtime.handle({ kind: 'cancel', runId })
  await new Promise(resolve => setTimeout(resolve, 20))
  try { await expect(h.start()).rejects.toThrow('The agent is at capacity.') }
  finally {
    gate.resolve(await model().doStream({ prompt: [] }))
    await h.runtime.shutdown()
  }
  expect(h.store.events(runId, 0, 200).at(-1)?.payload).toEqual({ type: 'status', status: 'cancelled' })
})

it('cancels a late provider stream before releasing its non-quiescing reservation', async () => {
  const gate = deferred<Awaited<ReturnType<MockLanguageModelV4['doStream']>>>(), entered = deferred<void>(), release = deferred<void>()
  let cancelling = false
  const stream = new ReadableStream<Chunk>({ cancel() { cancelling = true; return release.promise } })
  const selected = new MockLanguageModelV4({ doStream: async () => { entered.resolve(); return gate.promise } })
  const h = setup({ maxActiveRuns: 1, models: async () => selected })
  const { runId } = await h.start()
  await entered.promise
  await h.runtime.handle({ kind: 'cancel', runId })
  gate.resolve({ stream })
  try {
    await vi.waitFor(() => expect(cancelling).toBe(true))
    await expect(h.start()).rejects.toThrow('The agent is at capacity.')
    expect(h.store.events(runId, 0, 200).at(-1)?.payload).toEqual({ type: 'status', status: 'cancelled' })
  } finally { release.resolve(); await stream.cancel(); await h.runtime.shutdown() }
})

it('rejects the complete 2 MiB tool argument before any tool effect or durable checkpoint', async () => {
  let effects = 0
  const rejected = 'REJECTED_PAYLOAD_'.padEnd(2 * 1024 * 1024, 'x')
  const h = setup({ models: async () => model([{ type: 'tool-call', toolCallId: 'large', toolName: 'read_file', input: JSON.stringify({ path: rejected }) }]), tools: () => [readTool(() => { effects++ })] })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).error?.code).toBe('budget')
  expect(effects).toBe(0)
  expect(h.store.latestCheckpoint(runId)).toBeUndefined()
  expect(JSON.stringify(h.store.events(runId, 0, 200))).not.toContain('REJECTED_PAYLOAD_')
})

it('saves a valid artifact above 16 KiB while replacing its checkpointed tool input with a placeholder', async () => {
  const content = 'LEGITIMATE_ARTIFACT_'.repeat(2000)
  let step = 0
  const selected = new MockLanguageModelV4({ doStream: () => model(step++ ? [] : [{ type: 'tool-call', toolCallId: 'save', toolName: 'save_artifact', input: JSON.stringify({ name: 'report.txt', content }) }]).doStream({ prompt: [] }) })
  const h = setup({ models: async () => selected, tools: () => artifactTools() })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).status).toBe('succeeded')
  const event = h.store.events(runId, 0, 200).find(event => event.payload.type === 'artifact')!.payload
  if (event.type !== 'artifact') throw new Error('Missing artifact')
  expect((await h.artifacts.read(runId, event.artifactId))?.content).toEqual(new TextEncoder().encode(content))
  expect(h.store.latestCheckpoint(runId)!.messages.includes('LEGITIMATE_ARTIFACT_')).toBe(false)
  expect(h.store.latestCheckpoint(runId)!.messages).toContain('Oversized tool input omitted.')
})

it.each(['tool-input-delta', 'reasoning-delta'] as const)('aborts cumulative %s bytes above 1 MiB before a completed step', async kind => {
  const parts: Chunk[] = kind === 'tool-input-delta' ? [{ type: 'tool-input-start', id: 'large', toolName: 'read_file' }] : [{ type: 'reasoning-start', id: 'reason' }]
  for (let i = 0; i < 17; i++) parts.push(kind === 'tool-input-delta' ? { type: kind, id: 'large', delta: 'x'.repeat(65536) } : { type: kind, id: 'reason', delta: 'x'.repeat(65536) })
  const h = setup({ models: async () => model(parts) })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).error?.code).toBe('budget')
  expect(h.store.latestCheckpoint(runId)).toBeUndefined()
})

it('drops reasoning parts larger than 64 KiB from the recovery checkpoint', async () => {
  const reasoning = 'PRIVATE_REASONING_'.repeat(5000)
  const h = setup({ models: async () => model([{ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: reasoning }, { type: 'reasoning-end', id: 'r' }]) })
  const { runId } = await h.start()
  expect((await h.terminal(runId)).status).toBe('succeeded')
  expect(h.store.latestCheckpoint(runId)?.messages).not.toContain('PRIVATE_REASONING_')
})

it('fails with a fixed budget error rather than writing a checkpoint above 4 MiB', async () => {
  const h = setup({ models: async () => model([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'x'.repeat(40000) }, { type: 'text-end', id: 't' }]) })
  h.store.createRun({ id: 'restore', requestId: 'restore', goal: 'Finish', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 })
  const messages = JSON.stringify([{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024 - 1000) }])
  h.store.saveCheckpoint({ runId: 'restore', step: 1, messages, at: 2 })
  h.store.interruptUnfinished(3)
  await h.runtime.handle({ kind: 'continue', runId: 'restore', model: { provider: 'fixture', model: 'fixture' } })
  expect((await h.terminal('restore')).error).toEqual({ code: 'budget', message: 'The task transcript grew too large.' })
  expect(h.store.latestCheckpoint('restore')?.messages).toBe(messages)
})

it('retries failed run artifact deletion on purge after the run record is already gone', async () => {
  class FailingArtifacts extends MemoryArtifactStore {
    fail = true
    override async delete(ids: readonly string[]) {
      if (this.fail) { this.fail = false; throw new Error('Injected EIO') }
      return super.delete(ids)
    }
  }
  const artifacts = new FailingArtifacts(), h = setup({ artifacts })
  const { runId } = await h.start()
  await h.terminal(runId)
  const meta = await artifacts.save(runId, 'Private', 'text/plain', new Uint8Array([1]))
  h.store.appendEvent(runId, { type: 'artifact', artifactId: meta.id, name: meta.name, mediaType: meta.mediaType, bytes: meta.bytes }, Date.now())
  await expect(h.runtime.handle({ kind: 'delete', runId })).rejects.toThrow('Artifact cleanup is pending.')
  expect(h.store.getRun(runId)).toBeUndefined()
  expect(h.store.cleanupJobs()).toEqual([meta.id])
  await h.runtime.handle({ kind: 'purge' })
  expect(h.store.cleanupJobs()).toEqual([])
  expect(await artifacts.read(runId, meta.id)).toBeUndefined()
  await expect(h.runtime.handle({ kind: 'delete', runId })).resolves.toEqual({ ok: true })
})

it('evicts the oldest terminal temporary run and its memory artifacts beyond fifty retained runs', async () => {
  let time = 100
  const h = setup({ clock: { now: () => time } })
  const ids: string[] = []
  let saved!: { id: string }
  for (let i = 0; i < 51; i++) {
    time++
    const { runId } = await h.start({ persistence: 'temporary' })
    ids.push(runId)
    await h.terminal(runId)
    if (i === 0) {
      saved = await h.memoryArtifacts.save(runId, 'Private', 'text/plain', new Uint8Array([1]))
      h.memoryStore.appendEvent(runId, { type: 'artifact', artifactId: saved.id, name: 'Private', mediaType: 'text/plain', bytes: 1 }, time)
    }
  }
  expect(h.memoryStore.listRuns(200)).toHaveLength(50)
  expect(h.memoryStore.getRun(ids[0]!)).toBeUndefined()
  expect(await h.memoryArtifacts.read(ids[0]!, saved.id)).toBeUndefined()
  expect(h.memoryStore.getRun(ids[1]!)).toBeDefined()
})

it('retains a cleanup job if deleting a cancelled late artifact save fails', async () => {
  const entered = deferred<void>(), release = deferred<void>()
  let artifactId = ''
  class SlowArtifacts extends MemoryArtifactStore {
    fail = true
    override async save(runId: string, name: string, mediaType: string, content: Uint8Array) {
      entered.resolve(); await release.promise
      const meta = await super.save(runId, name, mediaType, content)
      artifactId = meta.id
      return meta
    }
    override async delete(ids: readonly string[]) {
      if (this.fail) { this.fail = false; throw new Error('Injected EIO') }
      return super.delete(ids)
    }
  }
  const artifacts = new SlowArtifacts()
  const save: AgentTool = { ...readTool(() => {}), name: 'save', effect: 'artifact-write', execute: async (_input, ctx) => {
    await ctx.artifacts.save(ctx.runId, 'Late', 'text/plain', new Uint8Array([1]))
    return { ok: true, content: 'saved', summary: 'saved' }
  } }
  const h = setup({ artifacts, models: async () => model([{ type: 'tool-call', toolCallId: 'late', toolName: 'save', input: '{"path":"x"}' }]), tools: () => [save] })
  const { runId } = await h.start()
  await entered.promise
  await h.runtime.handle({ kind: 'cancel', runId })
  release.resolve()
  await vi.waitFor(() => expect(artifactId).not.toBe(''))
  await vi.waitFor(() => expect(h.store.cleanupJobs()).toEqual([artifactId]))
  expect(h.store.events(runId, 0, 200).at(-1)?.payload).toEqual({ type: 'status', status: 'cancelled' })
  await h.runtime.handle({ kind: 'purge' })
  expect(await artifacts.read(runId, artifactId)).toBeUndefined()
})

it('replaces legacy oversized tool inputs with placeholders before resaving recovery messages', async () => {
  const h = setup()
  h.store.createRun({ id: 'legacy', requestId: 'legacy', goal: 'Finish', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 })
  h.store.saveCheckpoint({ runId: 'legacy', step: 1, messages: JSON.stringify([
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'read_file', input: { path: 'LEGACY_PRIVATE'.repeat(2000) } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'read_file', output: { type: 'text', value: 'Denied input' } }] },
  ]), at: 2 })
  h.store.interruptUnfinished(3)
  await h.runtime.handle({ kind: 'continue', runId: 'legacy', model: { provider: 'fixture', model: 'fixture' } })
  expect((await h.terminal('legacy')).status).toBe('succeeded')
  expect(h.store.latestCheckpoint('legacy')!.messages.includes('LEGACY_PRIVATE')).toBe(false)
  expect(h.store.latestCheckpoint('legacy')!.messages).toContain('Oversized tool input omitted.')
})
