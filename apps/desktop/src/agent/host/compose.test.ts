import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { AgentRuntime } from '../contracts'
import { DEFAULT_BUDGET, type AgentEvent, type HostCommand, type HostToMain, type RunSummary } from '../../shared/agent-protocol'
import { SqliteAgentStore } from '../store'
import { agentPaths } from '../paths'
import { composeRuntime } from './compose'
import { parseHostToMain, serveHost } from './serve'

export type Chunk = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C> ? C : never
export type Script = { text?: string; call?: { name: string; id: string; input: unknown } }
export function stream(script: Script) {
  const chunks: Chunk[] = [
    { type: 'stream-start', warnings: [] },
    ...(script.call ? [{ type: 'tool-call' as const, toolCallId: script.call.id, toolName: script.call.name, input: JSON.stringify(script.call.input) }] : []),
    ...(script.text === undefined ? [] : [{ type: 'text-start' as const, id: 'text' }, { type: 'text-delta' as const, id: 'text', delta: script.text }, { type: 'text-end' as const, id: 'text' }]),
    { type: 'finish', finishReason: { unified: script.call ? 'tool-calls' : 'stop', raw: 'fixture' }, usage: { inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } } },
  ]
  return { stream: new ReadableStream<Chunk>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } }) }
}
export function model(scripts: Script[]) { let index = 0; return new MockLanguageModelV4({ doStream: async () => stream(scripts[index++] ?? { text: 'Done' }) }) }
class Port extends EventEmitter {
  sent: HostToMain[] = []
  postMessage(message: unknown) { this.sent.push(parseHostToMain(message)) }
}
const dirs: string[] = [], runtimes: AgentRuntime[] = []
const hosts: ReturnType<typeof serveHost>[] = [], servers: Server[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const runtime of runtimes.splice(0)) await runtime.shutdown()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
// Canonical like main's picker grants (macOS temp paths go through /var → /private/var).
function temp() { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'heynimbo-compose-'))); dirs.push(dir); return dir }
async function http(listener: RequestListener) {
  const server = createServer(listener); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
async function hostRuntime(dir: string, selected: MockLanguageModelV4) {
  const port = new Port(), host = serveHost(port, init => composeRuntime(init, { models: async () => selected, resolver: async () => [{ address: '127.0.0.1', family: 4 }], allowLoopbackForTests: true }))
  hosts.push(host)
  port.emit('message', { v: 1, kind: 'init', dataDir: dir })
  await vi.waitFor(() => expect(port.sent).toContainEqual({ v: 1, kind: 'ready' }))
  let next = 0
  const handle = async (command: HostCommand) => {
    const id = ++next
    port.emit('message', { v: 1, kind: 'command', id, command })
    let reply: Extract<HostToMain, { kind: 'reply' }> | undefined
    await vi.waitFor(() => { reply = port.sent.find(m => m.kind === 'reply' && m.id === id) as typeof reply; expect(reply).toBeDefined() })
    if (!reply!.ok) throw new Error(reply!.message)
    return reply!.result
  }
  const events = () => port.sent.flatMap(m => m.kind === 'events' ? m.events : [])
  return { port, host, handle, events }
}
const start: Extract<HostCommand, { kind: 'start' }> = { kind: 'start', requestId: 'req', goal: 'Finish the task', mode: 'web', grants: [], persistence: 'retained', budget: DEFAULT_BUDGET, model: { provider: 'openai', model: 'fixture' } }
async function finished(runtime: AgentRuntime, id: string) {
  let run: RunSummary | undefined
  await vi.waitFor(async () => {
    const list = await runtime.handle({ kind: 'list', limit: 20 }) as { runs: RunSummary[] }
    run = list.runs.find(run => run.id === id)
    expect(run?.status).toMatch(/succeeded|failed/)
  })
  return run!
}
it('runs search → fetch → artifact over the host port and resumes after shutdown without repeating completed HTTP effects', async () => {
  let searchHits = 0, articleHits = 0
  const article = await http((_req, res) => { articleHits++; res.setHeader('content-type', 'text/html'); res.end('<title>Fixture</title><article>Verified local article evidence.</article>') })
  const search = await http((req, res) => { searchHits++; expect(req.url).toContain('/search?q=evidence&format=json'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ title: 'Fixture', url: article, content: 'Article evidence' }] })) })
  const dir = temp()
  const selected = model([
    { call: { name: 'web_search', id: 'search', input: { query: 'evidence' } } },
    { call: { name: 'fetch_url', id: 'fetch', input: { url: article } } },
    { call: { name: 'save_artifact', id: 'save', input: { name: 'evidence.md', content: `Verified local article evidence. Source: ${article}` } } },
    { text: 'Saved verified evidence.' },
  ])
  const first = await hostRuntime(dir, selected)
  const { runId } = await first.handle({ ...start, search: { provider: 'searxng', baseURL: search } }) as { runId: string }
  await vi.waitFor(() => expect(first.events().at(-1)?.payload).toEqual({ type: 'status', status: 'succeeded' }))
  expect(first.events().map(e => e.seq)).toEqual(Array.from({ length: first.events().length }, (_, i) => i + 1))
  expect(first.events().map(e => e.payload.type)).toEqual(['run.created', 'status', 'tool.call', 'tool.result', 'text', 'usage', 'tool.call', 'tool.result', 'text', 'usage', 'tool.call', 'artifact', 'tool.result', 'text', 'usage', 'text', 'usage', 'status'])
  expect(selected.doStreamCalls[1]!.prompt).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', content: expect.arrayContaining([expect.objectContaining({ output: expect.objectContaining({ value: expect.stringContaining(article) }) })]) })]))
  expect(JSON.stringify(selected.doStreamCalls[2]!.prompt)).toContain('Verified local article evidence.')
  const artifact = first.events().find(e => e.payload.type === 'artifact')!.payload as Extract<AgentEvent['payload'], { type: 'artifact' }>
  expect(await first.handle({ kind: 'artifact', runId, artifactId: artifact.artifactId })).toMatchObject({ name: 'evidence.md', text: `Verified local article evidence. Source: ${article}` })
  expect([searchHits, articleHits]).toEqual([1, 1])
  await first.host.dispose()
  let release!: (value: ReturnType<typeof stream>) => void
  let entered = false, index = 0
  const waiting = new MockLanguageModelV4({ doStream: async () => {
    if (index++ === 0) return stream({ call: { name: 'fetch_url', id: 'completed-fetch', input: { url: article } } })
    entered = true
    return new Promise(resolve => { release = resolve })
  } })
  const second = await hostRuntime(dir, waiting)
  expect(await second.handle({ kind: 'list', limit: 10 })).toMatchObject({ runs: [{ id: runId, status: 'succeeded' }] })
  const next = await second.handle({ ...start, requestId: 'second' }) as { runId: string }
  await vi.waitFor(() => expect(entered).toBe(true))
  await second.host.dispose()
  release(stream({ text: 'late response must be ignored' }))
  const resumed = model([{ call: { name: 'fetch_url', id: 'completed-fetch', input: { url: article } } }, { text: 'Resumed using saved evidence.' }])
  const third = await hostRuntime(dir, resumed)
  expect(await third.handle({ kind: 'list', limit: 10 })).toMatchObject({ runs: expect.arrayContaining([expect.objectContaining({ id: next.runId, status: 'interrupted' })]) })
  await third.handle({ kind: 'continue', runId: next.runId, model: start.model, search: { provider: 'searxng', baseURL: search } })
  await vi.waitFor(() => expect(third.events().at(-1)?.payload).toEqual({ type: 'status', status: 'succeeded' }))
  expect(JSON.stringify(resumed.doStreamCalls[0]!.prompt)).toContain('Verified local article evidence.')
  expect(third.events().map(e => e.payload)).toContainEqual(expect.objectContaining({ type: 'tool.denied', reason: expect.stringContaining('already completed') }))
  expect([searchHits, articleHits]).toEqual([1, 2])
  expect(third.host.invalidMessages).toBe(0)
})
it('reads a real granted file in local temporary mode and keeps its transcript and artifacts out of durable storage', async () => {
  const dir = temp(), folder = temp()
  writeFileSync(join(folder, 'note.txt'), 'PRIVATE_LOCAL_FIXTURE')
  const selected = model([{ call: { name: 'read_file', id: 'read', input: { path: 'Project/note.txt' } } }, { call: { name: 'save_artifact', id: 'save', input: { name: 'private.txt', content: 'PRIVATE_LOCAL_FIXTURE' } } }, { text: 'Read and saved' }])
  const host = await hostRuntime(dir, selected)
  const { runId } = await host.handle({ ...start, mode: 'local', persistence: 'temporary', grants: [{ id: 'grant', root: folder, label: 'Project' }] }) as { runId: string }
  await vi.waitFor(() => expect(host.events().at(-1)?.payload).toEqual({ type: 'status', status: 'succeeded' }))
  expect(host.events().map(e => e.payload)).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: true }))
  expect(JSON.stringify(selected.doStreamCalls[1]!.prompt)).toContain('PRIVATE_LOCAL_FIXTURE')
  const artifact = host.events().find(e => e.payload.type === 'artifact')!.payload as Extract<AgentEvent['payload'], { type: 'artifact' }>
  expect(await host.handle({ kind: 'artifact', runId, artifactId: artifact.artifactId })).toMatchObject({ text: 'PRIVATE_LOCAL_FIXTURE' })
  const durable = new SqliteAgentStore(agentPaths(dir).db)
  expect(durable.listRuns(10)).toEqual([]); durable.close()
  expect(existsSync(agentPaths(dir).artifacts)).toBe(false)
  await host.host.dispose()
  const reopened = await hostRuntime(dir, model([]))
  expect(await reopened.handle({ kind: 'list', limit: 10 })).toEqual({ runs: [] })
  await expect(reopened.handle({ kind: 'artifact', runId, artifactId: artifact.artifactId })).rejects.toThrow()
})
it('denies web file reads until owner mixing and still cannot mint folder authority after mixing', async () => {
  const selected = model([
    { call: { name: 'read_file', id: 'before', input: { path: 'Project/note.txt' } } },
    { call: { name: 'ask_user', id: 'wait', input: { question: 'Allow mixing using the owner control?' } } },
    { call: { name: 'read_file', id: 'after', input: { path: 'Project/note.txt' } } },
    { text: 'No folder access is available.' },
  ])
  const host = await hostRuntime(temp(), selected)
  const { runId } = await host.handle(start) as { runId: string }
  await vi.waitFor(() => expect(host.events().some(e => e.payload.type === 'question')).toBe(true))
  const question = host.events().find(e => e.payload.type === 'question')!.payload as Extract<AgentEvent['payload'], { type: 'question' }>
  expect(host.events().map(e => e.payload)).toContainEqual(expect.objectContaining({ type: 'tool.denied', reason: expect.stringContaining('explicitly allow mixing') }))
  expect(host.events().filter(e => e.payload.type === 'tool.call' && e.payload.tool === 'read_file')).toEqual([])
  await host.handle({ kind: 'allowMix', runId })
  await host.handle({ kind: 'answer', runId, questionId: question.questionId, text: 'Proceed without any folder grants.' })
  await vi.waitFor(() => expect(host.events().at(-1)?.payload).toEqual({ type: 'status', status: 'succeeded' }))
  expect(host.events().map(e => e.payload)).toContainEqual({ type: 'mode.mixed', allowed: 'local' })
  expect(host.events().filter(e => e.payload.type === 'tool.call' && e.payload.tool === 'read_file')).toHaveLength(1)
  expect(host.events().map(e => e.payload)).toContainEqual(expect.objectContaining({ type: 'tool.result', ok: false }))
  expect(JSON.stringify(selected.doStreamCalls[3]!.prompt)).toContain('Access denied by file policy.')
  expect(JSON.stringify(selected.doStreamCalls[2]!.prompt)).toContain('Folder grants: []')
})
it('uses the real sdkModel compatible adapter against an owned local model endpoint', async () => {
  let body = '', authorization = ''
  const endpoint = await http(async (req, res) => {
    authorization = req.headers.authorization ?? ''
    for await (const chunk of req) body += String(chunk)
    res.setHeader('content-type', 'text/event-stream')
    for (const payload of [
      { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'local', choices: [{ index: 0, delta: { role: 'assistant', content: 'Real compatible response' }, finish_reason: null }] },
      { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]) res.write(`data: ${JSON.stringify(payload)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  const runtime = await composeRuntime({ dataDir: temp(), credentials: async name => { expect(name).toBe('compatible'); return 'fixture-only-key' }, sink: { events: () => {}, partial: () => {} } }); runtimes.push(runtime)
  const { runId } = await runtime.handle({ ...start, model: { provider: 'compatible', model: 'local', baseURL: endpoint } }) as { runId: string }
  expect((await finished(runtime, runId)).status).toBe('succeeded')
  expect(authorization).toBe('Bearer fixture-only-key')
  expect(JSON.parse(body)).toMatchObject({ model: 'local', stream: true, max_tokens: DEFAULT_BUDGET.maxOutputTokens })
  expect(await runtime.handle({ kind: 'events', runId, afterSeq: 0, limit: 50 })).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ payload: { type: 'text', step: 1, text: 'Real compatible response' } })]) })
})
it('continues a real durable provider-failed run without recreating its completed tool effects', async () => {
  const dir = temp()
  let index = 0
  const failing = new MockLanguageModelV4({ doStream: async () => {
    if (index++ === 0) return stream({ call: { name: 'save_artifact', id: 'saved', input: { name: 'before.txt', content: 'Completed before outage' } } })
    throw new Error('sensitive-provider-failure')
  } })
  const host = await hostRuntime(dir, failing)
  const { runId } = await host.handle(start) as { runId: string }
  await vi.waitFor(() => expect(host.events().at(-1)?.payload).toEqual({ type: 'status', status: 'failed' }))
  await host.host.dispose()
  const resumed = await hostRuntime(dir, model([{ text: 'Recovered with saved result' }]))
  await expect(resumed.handle({ kind: 'continue', runId, model: start.model })).resolves.toEqual({ ok: true })
  await vi.waitFor(() => expect(resumed.events().at(-1)?.payload).toEqual({ type: 'status', status: 'succeeded' }))
  const events = await resumed.handle({ kind: 'events', runId, afterSeq: 0, limit: 100 }) as { events: AgentEvent[] }
  expect(events.events.filter(e => e.payload.type === 'artifact')).toHaveLength(1)
  expect(JSON.stringify(events)).not.toContain('sensitive-provider-failure')
})
it('fails closed on a symlinked artifact root before recovery can mutate retained runs', async () => {
  const dir = temp(), outside = temp(), paths = agentPaths(dir)
  const store = new SqliteAgentStore(paths.db)
  store.createRun({ id: 'waiting', requestId: 'waiting', goal: 'Waiting', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 }); store.close()
  writeFileSync(join(outside, 'old.tmp'), 'Do not delete'); utimesSync(join(outside, 'old.tmp'), 1, 1)
  symlinkSync(outside, paths.artifacts)
  await expect(composeRuntime({ dataDir: dir, credentials: async () => '', sink: { events: () => {}, partial: () => {} } })).rejects.toThrow('Artifact unavailable.')
  const reopened = new SqliteAgentStore(paths.db)
  expect(reopened.getRun('waiting')?.status).toBe('queued'); reopened.close()
  expect(existsSync(join(outside, 'old.tmp'))).toBe(true)
})
it.each(['unknown-provider', 'gateway-name'])('sanitizes unsupported model selections without implicit gateway access: %s', async provider => {
  const runtime = await composeRuntime({ dataDir: temp(), credentials: async () => { throw new Error('credential-secret') }, sink: { events: () => {}, partial: () => {} } }, provider === 'gateway-name' ? { models: async () => 'implicit/gateway' } : {}); runtimes.push(runtime)
  const { runId } = await runtime.handle({ ...start, model: { provider, model: 'fixture' } }) as { runId: string }
  const run = await finished(runtime, runId)
  expect(run).toMatchObject({ status: 'failed', error: { code: 'provider', message: expect.stringContaining('Check the connection') } })
  expect(JSON.stringify(run)).not.toContain('credential-secret')
})
it('sweeps only old artifact temp files at startup without following directory symlinks', async () => {
  const dir = temp(), outside = temp(), artifacts = agentPaths(dir).artifacts
  mkdirSync(join(artifacts, 'meta'), { recursive: true }); mkdirSync(join(artifacts, 'ab'))
  const old = [join(artifacts, 'meta', 'orphan.tmp'), join(artifacts, 'ab', 'orphan.tmp')]
  const keep = [join(artifacts, 'meta', 'recent.tmp'), join(artifacts, 'meta', 'saved.json'), join(outside, 'secret.tmp')]
  for (const path of [...old, ...keep]) writeFileSync(path, 'fixture')
  for (const path of [...old, keep[1]!, keep[2]!]) utimesSync(path, 1, 1)
  symlinkSync(outside, join(artifacts, 'cd'))
  const runtime = await composeRuntime({ dataDir: dir, credentials: async () => '', sink: { events: () => {}, partial: () => {} } }); runtimes.push(runtime)
  expect(old.map(existsSync)).toEqual([false, false])
  expect(keep.map(existsSync)).toEqual([true, true, true])
})
it('refuses ChatGPT plan access before credentials or model dispatch with a fixed actionable error', async () => {
  const selected = model([{ text: 'Must not run' }])
  let credentials = 0
  const runtime = await composeRuntime({ dataDir: temp(), credentials: async () => { credentials++; return 'secret' }, sink: { events: () => {}, partial: () => {} } }, { models: async () => selected }); runtimes.push(runtime)
  const { runId } = await runtime.handle({ ...start, model: { provider: 'chatgpt', model: 'fixture' } }) as { runId: string }
  expect(await finished(runtime, runId)).toMatchObject({ status: 'failed', error: { code: 'model_unsupported', message: 'Do mode needs an API key or a local model; ChatGPT plan access is used for Explain only.' } })
  expect(selected.doStreamCalls).toEqual([])
  expect(credentials).toBe(0)
})
it.each([
  ['openai', 'medium', { openai: { store: false, include: ['reasoning.encrypted_content'], reasoningEffort: 'medium' }, anthropic: { effort: 'medium' } }],
  ['anthropic', 'high', { openai: { store: false, include: ['reasoning.encrypted_content'], reasoningEffort: 'high' }, anthropic: { effort: 'high' } }],
  ['openai', undefined, { openai: { store: false, include: ['reasoning.encrypted_content'] }, anthropic: {} }],
] as const)('preserves stateless reasoning options and cumulative runtime token limits for %s effort %s', async (provider, effort, expected) => {
  const selected = model([{ call: { name: 'save_artifact', id: 'save', input: { name: 'note.txt', mediaType: 'text/plain', content: 'Evidence' } } }, { text: 'Saved' }])
  const runtime = await composeRuntime({ dataDir: temp(), credentials: async () => '', sink: { events: () => {}, partial: () => {} } }, { models: async () => selected }); runtimes.push(runtime)
  const { runId } = await runtime.handle({ ...start, model: { provider, model: 'fixture', ...(effort ? { effort } : {}) } }) as { runId: string }
  expect((await finished(runtime, runId)).status).toBe('succeeded')
  expect(selected.doStreamCalls).toHaveLength(2)
  expect(selected.doStreamCalls.map(call => call.providerOptions)).toEqual([expected, expected])
  expect(selected.doStreamCalls.map(call => call.maxOutputTokens)).toEqual([DEFAULT_BUDGET.maxOutputTokens, DEFAULT_BUDGET.maxOutputTokens - 3])
})
it('composes durable recovery without startup pushes and preserves completed runs across restart', async () => {
  const dir = temp(), store = new SqliteAgentStore(join(dir, 'agent.sqlite'))
  store.createRun({ id: 'old', requestId: 'old', goal: 'Old task', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 1 }); store.close()
  const pushes: unknown[] = []
  const init = { dataDir: dir, credentials: async () => '', sink: { events: (...args: unknown[]) => { pushes.push(args) }, partial: () => {} } }
  const runtime = await composeRuntime(init, { models: async () => model([{ text: 'Finished' }]), clock: { now: () => 1000 } }); runtimes.push(runtime)
  expect(pushes).toEqual([])
  expect(await runtime.handle({ kind: 'list', limit: 10 })).toMatchObject({ runs: [{ id: 'old', status: 'interrupted' }] })
  const { runId } = await runtime.handle(start) as { runId: string }
  expect((await finished(runtime, runId)).status).toBe('succeeded')
  await runtime.shutdown()
  const reopened = await composeRuntime(init); runtimes.push(reopened)
  expect(await reopened.handle({ kind: 'list', limit: 10 })).toMatchObject({ runs: expect.arrayContaining([expect.objectContaining({ id: runId, status: 'succeeded' }), expect.objectContaining({ id: 'old', status: 'interrupted' })]) })
})
