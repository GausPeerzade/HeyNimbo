import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRuntime, RuntimeSink, CredentialSource } from '../contracts'
import { parseMainToHost, parseHostToMain, serveHost } from './serve'
import { DEFAULT_BUDGET, type HostCommand } from '../../shared/agent-protocol'

class Port extends EventEmitter {
  sent: unknown[] = []
  postMessage(message: unknown): void { this.sent.push(message) }
}
afterEach(() => vi.useRealTimers())

it('delivers a 600-event flush completely and in order through bounded transport messages', async () => {
  const port = new Port()
  let sink!: RuntimeSink
  const host = serveHost(port, async init => { sink = init.sink; return { handle: async () => ({}), shutdown: async () => {} } })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' }); await Promise.resolve()
  const events = Array.from({ length: 600 }, (_, i) => ({ runId: 'run', seq: i + 1, id: `event${i}`, at: 0, payload: { type: 'text' as const, step: 0, text: `${i}` } }))
  sink.events(events, [])
  const batches = port.sent.map(parseHostToMain).filter(m => m.kind === 'events')
  expect(batches.flatMap(m => m.events)).toEqual(events)
  expect(batches.map(m => m.events.length)).toEqual([256, 256, 88])
  expect(host.invalidMessages).toBe(0)
  await host.dispose()
})
it('rejects authority-bearing budget extras in created events before either port forwards them', async () => {
  const port = new Port()
  let sink!: RuntimeSink
  const host = serveHost(port, async init => { sink = init.sink; return { handle: async () => ({}), shutdown: async () => {} } })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' }); await Promise.resolve()
  const event = { runId: 'run', seq: 1, id: 'event', at: 0, payload: { type: 'run.created' as const, goal: 'Read', mode: 'local' as const, persistence: 'temporary' as const, budget: { ...DEFAULT_BUDGET, root: '/secret' } } }
  expect(() => parseHostToMain({ v: 1, kind: 'events', events: [event], runs: [] })).toThrow()
  sink.events([event], [])
  expect(JSON.stringify(port.sent)).not.toContain('/secret')
  expect(host.invalidMessages).toBe(1)
  await host.dispose()
})
it('carries the compatible endpoint through the host credential port and validates the optional binding', async () => {
  const port = new Port()
  let credentials!: CredentialSource
  const host = serveHost(port, async init => { credentials = init.credentials; return { handle: async () => ({}), shutdown: async () => {} } })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' }); await Promise.resolve()
  const pending = credentials('compatible', { baseURL: 'https://chosen.invalid/v1' })
  const request = { v: 1, kind: 'credential.request', id: 1, name: 'compatible', baseURL: 'https://chosen.invalid/v1' }
  expect(port.sent).toContainEqual(request)
  expect(parseHostToMain(request)).toEqual(request)
  expect(() => parseHostToMain({ ...request, baseURL: 12 })).toThrow('Invalid')
  port.emit('message', { v: 1, kind: 'credential', id: 1, ok: true, secret: 'synthetic' })
  await expect(pending).resolves.toBe('synthetic')
  await host.dispose()
})
it('accepts the main-picked bigint directory identity without accepting malformed authority', () => {
  const command = { ...localStart, grants: [{ id: 'grant', root: '/allowed', label: 'allowed', identity: '123:456' }] }
  expect(parseMainToHost({ v: 1, kind: 'command', id: 1, command })).toMatchObject({ command })
  for (const identity of ['not-an-inode', '1:2:3', '1:-2', 12]) expect(() => parseMainToHost({ v: 1, kind: 'command', id: 1, command: { ...command, grants: [{ ...command.grants[0], identity }] } })).toThrow('Invalid')
})
it('caps pending credentials and sanitizes a disconnected main port without leaving timers', async () => {
  vi.useFakeTimers()
  const port = new Port()
  let credentials!: CredentialSource
  const host = serveHost(port, async init => { credentials = init.credentials; return { handle: async () => ({}), shutdown: async () => {} } })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' }); await Promise.resolve()
  const pending = Array.from({ length: 128 }, () => credentials('openai').catch(error => (error as Error).message))
  await expect(credentials('openai')).rejects.toThrow('Agent credential unavailable.')
  await host.dispose()
  expect(await Promise.all(pending)).toEqual(Array(128).fill('Agent host stopped.'))
  await expect(credentials('openai')).rejects.toThrow('Agent host stopped.')
  await host.dispose()
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  expect(vi.getTimerCount()).toBe(0)
  const second = new Port()
  const live = serveHost(second, async init => { credentials = init.credentials; return { handle: async () => ({}), shutdown: async () => {} } })
  second.emit('message', { v: 1, kind: 'init', dataDir: '/data' }); await Promise.resolve()
  second.postMessage = () => { throw new Error('raw-secret-transport') }
  await expect(credentials('openai')).rejects.toThrow('Agent credential unavailable.')
  await live.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
const localStart: HostCommand = { kind: 'start', requestId: 'req', goal: 'Read files', mode: 'local', persistence: 'temporary', conversationId: 'conversation', grants: [{ id: 'grant', root: '/allowed', label: 'allowed' }], budget: DEFAULT_BUDGET, model: { provider: 'openai', model: 'model', effort: 'medium', baseURL: 'https://model.invalid' }, search: { provider: 'searxng', baseURL: 'https://search.invalid' } }
it.each([
  localStart, { ...localStart, search: { provider: 'brave' } },
  { kind: 'continue', runId: 'run', model: { provider: 'openai', model: 'model' } },
  { kind: 'continue', runId: 'run', model: { provider: 'openai', model: 'model' }, search: { provider: 'searxng', baseURL: 'https://search.invalid' } },
  { kind: 'purge' }, { kind: 'purge', before: 1234 },
  { kind: 'deleteConversation', conversationId: 'conversation' },
  { kind: 'approve', runId: 'run', approvalId: 'approval', decision: 'approved' },
  { kind: 'answer', runId: 'run', questionId: 'q', text: 'answer' },
  { kind: 'allowMix', runId: 'run' }, { kind: 'cancel', runId: 'run' }, { kind: 'delete', runId: 'run' },
  { kind: 'events', runId: 'run', afterSeq: 0, limit: 10 }, { kind: 'artifact', runId: 'run', artifactId: 'a' },
])('accepts the complete trusted command without losing fields: $kind', command => {
  const message = { v: 1, kind: 'command', id: 1, command }
  expect(parseMainToHost(message)).toEqual(message)
})
it.each([
  { ...localStart, grants: [{ id: 'g', root: 'relative', label: 'x' }] },
  { ...localStart, grants: [{ id: 'g', root: '/x', label: 'x', extra: true }] },
  { ...localStart, persistence: 'invalid' }, { ...localStart, budget: { ...DEFAULT_BUDGET, maxSteps: -1 } },
  { ...localStart, budget: { ...DEFAULT_BUDGET, extra: true } }, { ...localStart, model: { provider: 'openai', model: 'm', effort: 'invalid' } },
  { ...localStart, model: { provider: 'openai', model: 'm', secret: 'key' } },
  { ...localStart, search: { provider: 'brave', baseURL: 'https://no.invalid' } }, { ...localStart, search: { provider: 'unknown' } },
  { kind: 'pickFolder' }, { kind: 'stopAll' }, { kind: 'unknown' },
])('rejects malformed nested commands instead of accepting extra authority: %j', command => {
  expect(() => parseMainToHost({ v: 1, kind: 'command', id: 1, command })).toThrow()
})
it('rejects malformed transport replies and summaries while allowing typed failure summaries', () => {
  const run = { id: 'run', conversationId: 'conversation', goal: 'Read', mode: 'local', mixed: false, status: 'failed', persistence: 'temporary', created: 0, updated: 1, usage: { inputTokens: 0, outputTokens: 0 }, error: { code: 'host', message: 'Agent unavailable.' } }
  const message = { v: 1, kind: 'events', events: [], runs: [run] }
  expect(parseHostToMain(message)).toEqual(message)
  expect(parseHostToMain({ v: 1, kind: 'reply', id: 1, ok: false, message: 'Failed.' })).toMatchObject({ ok: false })
  const invalid = [
    { ...message, runs: [{ ...run, extra: true }] }, { ...message, runs: [{ ...run, error: { code: 'unknown', message: 'bad' } }] },
    { ...message, runs: [{ ...run, usage: { inputTokens: -1, outputTokens: 0 } }] },
    { v: 1, kind: 'unknown' }, { v: 1, kind: 'reply', id: 1, ok: true }, { v: 1, kind: 'reply', id: 1.5, ok: false, message: 'bad' },
    { v: 1, kind: 'partial', runId: 'run', step: 0, text: 'x'.repeat(64_001) },
    { ...message, runs: Array(257).fill(run) }, { ...message, events: Array(257).fill({}) },
  ]
  for (const value of invalid) expect(() => parseHostToMain(value)).toThrow('Invalid')
  for (const value of [{ v: 1, kind: 'unknown' }, { v: 1, kind: 'credential', id: 1, ok: 'yes', secret: 'x' }, { v: 1, kind: 'init', dataDir: 'relative' }]) expect(() => parseMainToHost(value)).toThrow('Invalid')
})
it('contains startup and synchronous runtime failures behind fixed safe replies', async () => {
  const port = new Port()
  const host = serveHost(port, async () => { throw new Error('provider-secret') })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  await Promise.resolve(); await Promise.resolve()
  port.emit('message', { v: 1, kind: 'command', id: 1, command: { kind: 'cancelAll' } })
  expect(port.sent).toContainEqual({ v: 1, kind: 'reply', id: 1, ok: false, message: 'Agent runtime unavailable.' })
  expect(JSON.stringify(port.sent)).not.toContain('provider-secret')
  await host.dispose()
  const second = new Port(), ready = serveHost(second, async () => ({ handle: () => { throw new Error('secret') }, shutdown: async () => {} }))
  second.emit('message', { v: 1, kind: 'init', dataDir: '/data' }); await Promise.resolve()
  second.emit('message', { v: 1, kind: 'command', id: 1, command: { kind: 'cancelAll' } })
  await vi.waitFor(() => expect(second.sent).toContainEqual({ v: 1, kind: 'reply', id: 1, ok: false, message: 'Agent request failed.' }))
  await ready.dispose()
})
it('revokes pending credentials and ignores late runtime completion after disposal', async () => {
  vi.useFakeTimers()
  const port = new Port()
  let finish!: (runtime: AgentRuntime) => void
  let credentials!: CredentialSource
  const host = serveHost(port, init => { credentials = init.credentials; return new Promise(resolve => { finish = resolve }) })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  const pending = expect(credentials('openai')).rejects.toThrow('Agent host stopped.')
  await host.dispose()
  await pending
  let shutdown = false
  finish({ handle: async () => ({}), shutdown: async () => { shutdown = true } })
  await Promise.resolve(); await Promise.resolve()
  expect(shutdown).toBe(true)
  expect(port.sent).not.toContainEqual({ v: 1, kind: 'ready' })
  expect(vi.getTimerCount()).toBe(0)
})
it('ignores and counts malformed envelopes and nested authority fields before dispatch', async () => {
  const port = new Port(), commands: unknown[] = []
  const host = serveHost(port, async () => ({ handle: async command => { commands.push(command); return {} }, shutdown: async () => {} }))
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  await vi.waitFor(() => expect(port.sent).toContainEqual({ v: 1, kind: 'ready' }))
  const malformed = [null, [], {}, { v: 2, kind: 'command', id: 1, command: { kind: 'cancelAll' } },
    { v: 1, kind: 'command', id: 1.5, command: { kind: 'cancelAll' } },
    { v: 1, kind: 'command', id: 1, command: { kind: 'cancelAll', secret: 'no' } },
    { v: 1, kind: 'command', id: 1, command: { kind: 'list', limit: 201 } },
    { v: 1, kind: 'init', dataDir: '/data', extra: true },
    { v: 1, kind: 'command', id: 1, command: { kind: 'start', requestId: 'req', goal: 'goal', mode: 'web', persistence: 'retained', grants: [{ id: 'g', root: '/x', label: 'x' }], budget: DEFAULT_BUDGET, model: { provider: 'openai', model: 'm' } } },
  ]
  for (const message of malformed) port.emit('message', message)
  expect(commands).toEqual([])
  expect(host.invalidMessages).toBe(malformed.length)
  await host.dispose()
})
it('resolves only matching credential replies and times out missing main replies without leaking errors', async () => {
  vi.useFakeTimers()
  const port = new Port()
  let credentials!: CredentialSource
  const host = serveHost(port, async init => { credentials = init.credentials; return { handle: async () => ({}), shutdown: async () => {} } })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  await Promise.resolve()
  const secret = credentials('openai')
  expect(port.sent).toContainEqual({ v: 1, kind: 'credential.request', id: 1, name: 'openai' })
  port.emit('message', { v: 1, kind: 'credential', id: 99, ok: true, secret: 'wrong' })
  port.emit('message', { v: 1, kind: 'credential', id: 1, ok: true, secret: 'test-secret' })
  await expect(secret).resolves.toBe('test-secret')
  const denied = expect(credentials('anthropic')).rejects.toThrow('Agent credential unavailable.')
  port.emit('message', { v: 1, kind: 'credential', id: 2, ok: false, message: 'sensitive-error' })
  await denied
  const timeout = expect(credentials('openai')).rejects.toThrow('Agent credential timed out.')
  await vi.advanceTimersByTimeAsync(10_000)
  await timeout
  await host.dispose()
  expect(vi.getTimerCount()).toBe(0)
})
it('drops invalid runtime events and partials before they cross the host port', async () => {
  const port = new Port()
  let sink!: RuntimeSink
  const host = serveHost(port, async init => { sink = init.sink; return { handle: async () => ({}), shutdown: async () => {} } })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  await Promise.resolve()
  const event = { runId: 'run', seq: 1, id: 'e1', at: 0, payload: { type: 'text' as const, step: 0, text: 'hello' } }
  sink.events([event, { ...event, seq: -1 }], [])
  sink.partial('run', 0, 'hello')
  sink.partial('run', -1, 'bad')
  expect(port.sent).toContainEqual({ v: 1, kind: 'events', events: [event], runs: [] })
  expect(port.sent).toContainEqual({ v: 1, kind: 'partial', runId: 'run', step: 0, text: 'hello' })
  expect(JSON.stringify(port.sent)).not.toContain('bad')
  expect(host.invalidMessages).toBe(2)
  await host.dispose()
})
it('initializes once and replies through the runtime without exposing thrown secrets', async () => {
  const port = new Port()
  let compositions = 0
  const host = serveHost(port, async () => {
    compositions++
    return { handle: async command => { if (command.kind === 'cancelAll') throw new Error('secret-key'); return { runs: [] } }, shutdown: async () => {} }
  })
  port.emit('message', { v: 1, kind: 'init', dataDir: '/data' })
  await vi.waitFor(() => expect(port.sent).toContainEqual({ v: 1, kind: 'ready' }))
  port.emit('message', { v: 1, kind: 'init', dataDir: '/other' })
  port.emit('message', { v: 1, kind: 'command', id: 1, command: { kind: 'list', limit: 10 } })
  port.emit('message', { v: 1, kind: 'command', id: 2, command: { kind: 'cancelAll' } })
  await vi.waitFor(() => expect(port.sent).toContainEqual({ v: 1, kind: 'reply', id: 1, ok: true, result: { runs: [] } }))
  expect(compositions).toBe(1)
  expect(port.sent).toContainEqual({ v: 1, kind: 'reply', id: 2, ok: false, message: 'Agent request failed.' })
  expect(JSON.stringify(port.sent)).not.toContain('secret-key')
  await host.dispose()
})
