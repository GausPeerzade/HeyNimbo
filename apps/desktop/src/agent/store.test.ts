import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStore, NewRun } from './contracts'
import { DEFAULT_BUDGET } from '../shared/agent-protocol'
import { MemoryAgentStore, SqliteAgentStore } from './store'

const stores: AgentStore[] = []
const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'heynimbo-agent-')); dirs.push(dir); return dir }
const run = (overrides: Partial<NewRun> = {}): NewRun => ({
  id: 'run_1', requestId: 'request_1', goal: 'Find the answer', mode: 'local', persistence: 'retained',
  grants: [{ id: 'grant_1', root: '/private/owner/docs', label: 'Docs' }], budget: { ...DEFAULT_BUDGET }, created: 100, ...overrides,
})
const tracked = <T extends AgentStore>(store: T): T => { stores.push(store); return store }
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

describe.each([
  ['SQLite', () => tracked(new SqliteAgentStore(join(temp(), 'agent.sqlite')))],
  ['memory', () => tracked(new MemoryAgentStore())],
] as const)('%s AgentStore contract', (_, create) => {
  it('purges runs strictly before the retention cursor including checkpoints and artifact references', () => {
    const store = create()
    store.createRun(run())
    store.createRun(run({ id: 'run_2', requestId: 'request_2', created: 200 }))
    store.appendEvent('run_1', { type: 'artifact', artifactId: 'old_blob', name: 'old', mediaType: 'text/plain', bytes: 3 }, 100)
    store.appendEvent('run_2', { type: 'artifact', artifactId: 'new_blob', name: 'new', mediaType: 'text/plain', bytes: 3 }, 200)
    store.saveCheckpoint({ runId: 'run_1', step: 1, messages: '[]', at: 100 })
    expect(() => store.deleteBefore(-1)).toThrow()
    expect(store.deleteBefore(200)).toEqual(['old_blob'])
    expect(store.getRun('run_1')).toBeUndefined()
    expect(store.events('run_1', 0, 10)).toEqual([])
    expect(store.latestCheckpoint('run_1')).toBeUndefined()
    expect(store.listRuns(10).map(run => run.id)).toEqual(['run_2'])
    expect(store.deleteBefore()).toEqual(['new_blob'])
    expect(store.listRuns(10)).toEqual([])
    expect(store.deleteBefore()).toEqual([])
  })
  it('creates an idempotent run while keeping grants out of public summaries', () => {
    const store = create()
    expect(store.createRun(run())).toEqual({ created: true, run: {
      ...run(), mixed: false, status: 'queued', updated: 100, usage: { inputTokens: 0, outputTokens: 0 }, nextSeq: 1,
    } })
    const duplicate = store.createRun(run({ id: 'other', goal: 'Do not overwrite the first goal' }))
    expect(duplicate.created).toBe(false)
    expect(duplicate.run).toEqual(store.getRun('run_1'))
    expect(() => store.createRun(run({ requestId: 'different_request' }))).toThrow('Run already exists.')
    expect(store.getRun('other')).toBeUndefined()
    expect(store.listRuns(20)).toEqual([{
      id: 'run_1', goal: 'Find the answer', mode: 'local', persistence: 'retained', mixed: false,
      created: 100, updated: 100, status: 'queued', usage: { inputTokens: 0, outputTokens: 0 },
    }])
    expect(JSON.stringify(store.listRuns(20))).not.toContain('/private/owner/docs')
    expect(store.getRun('missing')).toBeUndefined()
  })
  it.each(['succeeded', 'failed', 'cancelled'] as const)('refuses to move a %s run out of its terminal status', status => {
    const store = create()
    store.createRun(run())
    store.setStatus('run_1', status, 110, { code: 'internal', message: 'Task ended.' })
    expect(store.getRun('run_1')).toMatchObject({ status, updated: 110, error: { code: 'internal', message: 'Task ended.' } })
    expect(store.listRuns(1)[0]?.error).toEqual({ code: 'internal', message: 'Task ended.' })
    expect(() => store.setStatus('run_1', 'running', 111)).toThrow('terminal')
    expect(() => store.setStatus('run_1', status === 'failed' ? 'cancelled' : 'failed', 112)).toThrow('terminal')
    expect(store.getRun('run_1')?.updated).toBe(110)
    store.setStatus('run_1', status, 113)
    expect(store.getRun('run_1')?.status).toBe(status)
  })
  it('allows owner continuation of an interrupted run and clears its previous error', () => {
    const store = create()
    store.createRun(run())
    store.setStatus('run_1', 'interrupted', 110, { code: 'host', message: 'Restarted.' })
    store.setStatus('run_1', 'running', 120)
    expect(store.getRun('run_1')).toMatchObject({ status: 'running', updated: 120 })
    expect(store.getRun('run_1')?.error).toBeUndefined()
    expect(() => store.setStatus('missing', 'running', 121)).toThrow('Run not found.')
  })
  it('accumulates token usage and records explicit mixed-mode permission without resetting usage', () => {
    const store = create()
    store.createRun(run())
    store.addUsage('run_1', { inputTokens: 3, outputTokens: 5 }, 110)
    store.addUsage('run_1', { inputTokens: 7, outputTokens: 11 }, 120)
    store.setMixed('run_1', 130)
    expect(store.getRun('run_1')).toMatchObject({ mixed: true, updated: 130, usage: { inputTokens: 10, outputTokens: 16 } })
    expect(() => store.addUsage('missing', { inputTokens: 1, outputTokens: 1 }, 131)).toThrow('Run not found.')
    expect(() => store.setMixed('missing', 131)).toThrow('Run not found.')
  })
  it('upserts checkpoints by step and resumes from the highest step rather than the latest timestamp', () => {
    const store = create()
    store.createRun(run())
    expect(store.latestCheckpoint('run_1')).toBeUndefined()
    const highest = { runId: 'run_1', step: 2, at: 110, messages: '[{"role":"assistant","content":"done"}]' }
    store.saveCheckpoint(highest)
    store.saveCheckpoint({ runId: 'run_1', step: 1, at: 120, messages: '[]' })
    expect(store.latestCheckpoint('run_1')).toEqual(highest)
    store.saveCheckpoint({ ...highest, at: 130, messages: '[{"role":"user","content":"continue"}]' })
    expect(store.latestCheckpoint('run_1')).toEqual({ ...highest, at: 130, messages: '[{"role":"user","content":"continue"}]' })
    expect(store.latestCheckpoint('missing')).toBeUndefined()
    expect(() => store.saveCheckpoint({ ...highest, runId: 'missing' })).toThrow('Run not found.')
  })
  it('interrupts every unfinished run with a durable restart event while preserving completed outcomes', () => {
    const store = create()
    const unfinished = ['queued', 'running', 'waiting_approval', 'waiting_user', 'interrupted'] as const
    const completed = ['succeeded', 'failed', 'cancelled'] as const
    expect(store.interruptUnfinished(101)).toEqual([])
    for (const status of [...unfinished, ...completed]) {
      store.createRun(run({ id: status, requestId: `request_${status}` }))
      store.setStatus(status, status, 110)
      store.appendEvent(status, { type: 'text', step: 0, text: 'Before restart' }, 111)
    }
    expect(store.interruptUnfinished(120).sort()).toEqual([...unfinished].sort())
    for (const id of unfinished) {
      expect(store.getRun(id)).toMatchObject({ status: 'interrupted', updated: 120, nextSeq: 3 })
      expect(store.events(id, 1, 10)[0]).toMatchObject({ seq: 2, at: 120, payload: {
        type: 'status', status: 'interrupted', reason: 'HeyNimbo restarted before this task finished.',
      } })
    }
    for (const id of completed) {
      expect(store.getRun(id)).toMatchObject({ status: id, updated: 111, nextSeq: 2 })
      expect(store.events(id, 1, 10)).toEqual([])
    }
  })
  it('purges a deleted run and releases its request ID while returning only its artifact event references', () => {
    const store = create()
    store.createRun(run())
    store.createRun(run({ id: 'run_2', requestId: 'request_2' }))
    store.saveCheckpoint({ runId: 'run_1', step: 0, at: 101, messages: '[]' })
    for (const artifactId of ['artifact_a', 'artifact_a', 'artifact_b']) store.appendEvent('run_1', { type: 'artifact', artifactId, name: 'Report', mediaType: 'text/plain', bytes: 4 }, 102)
    store.appendEvent('run_1', { type: 'tool.result', callId: 'call_1', ok: true, summary: 'Not an artifact event', artifactId: 'not_a_reference' }, 103)
    store.appendEvent('run_2', { type: 'artifact', artifactId: 'keep', name: 'Other', mediaType: 'text/plain', bytes: 4 }, 104)
    expect(store.deleteRun('run_1').sort()).toEqual(['artifact_a', 'artifact_b'])
    expect(store.getRun('run_1')).toBeUndefined()
    expect(store.events('run_1', 0, 200)).toEqual([])
    expect(store.latestCheckpoint('run_1')).toBeUndefined()
    expect(store.events('run_2', 0, 200)).toHaveLength(1)
    expect(store.deleteRun('run_1')).toEqual([])
    expect(store.createRun(run({ id: 'replacement' })).created).toBe(true)
    expect(store.getRun('replacement')?.nextSeq).toBe(1)
  })
  it('deletes only the selected conversation including every matching run and checkpoint', () => {
    const store = create()
    for (const [id, conversationId] of [['a', 'conversation_1'], ['b', 'conversation_1'], ['c', 'conversation_2'], ['d', undefined]] as const) {
      store.createRun(run({ id, requestId: `request_${id}`, conversationId }))
      store.saveCheckpoint({ runId: id, step: 0, at: 101, messages: '[]' })
      store.appendEvent(id, { type: 'artifact', artifactId: `artifact_${id}`, name: 'Report', mediaType: 'text/plain', bytes: 4 }, 102)
    }
    expect(store.deleteConversation('conversation_1').sort()).toEqual(['artifact_a', 'artifact_b'])
    for (const id of ['a', 'b']) {
      expect(store.getRun(id)).toBeUndefined()
      expect(store.events(id, 0, 20)).toEqual([])
      expect(store.latestCheckpoint(id)).toBeUndefined()
    }
    expect(store.listRuns(20).map(run => run.id).sort()).toEqual(['c', 'd'])
    expect(store.latestCheckpoint('c')?.runId).toBe('c')
    expect(store.deleteConversation('conversation_1')).toEqual([])
  })
  it('orders equal timestamps identically and includes the largest valid timestamp without a cursor', () => {
    const store = create()
    for (const id of ['A', 'a', '_', 'Z', 'z']) store.createRun(run({ id, requestId: `request_${id}` }))
    expect(store.listRuns(10).map(run => run.id)).toEqual(['z', 'a', '_', 'Z', 'A'])
    store.createRun(run({ id: 'latest', requestId: 'latest', created: Number.MAX_SAFE_INTEGER }))
    expect(store.listRuns(1)[0]?.id).toBe('latest')
    expect(store.listRuns(10, Number.MAX_SAFE_INTEGER).map(run => run.id)).toEqual(['z', 'a', '_', 'Z', 'A'])
  })
  it('caps run and event pages and applies exclusive cursors in updated or sequence order', () => {
    const store = create()
    for (let i = 1; i <= 205; i++) store.createRun(run({ id: `run_${i}`, requestId: `request_${i}`, created: i }))
    expect(store.listRuns(999)).toHaveLength(200)
    expect(store.listRuns(2).map(run => run.id)).toEqual(['run_205', 'run_204'])
    expect(store.listRuns(2, 204).map(run => run.id)).toEqual(['run_203', 'run_202'])
    store.setMixed('run_1', 300)
    expect(store.listRuns(1)[0]?.id).toBe('run_1')
    for (let i = 1; i <= 205; i++) store.appendEvent('run_1', { type: 'text', step: 0, text: String(i) }, 300 + i)
    expect(store.events('run_1', 0, 999)).toHaveLength(200)
    expect(store.events('run_1', 200, 999).map(event => event.seq)).toEqual([201, 202, 203, 204, 205])
    expect(store.events('run_1', 4, 2).map(event => event.seq)).toEqual([5, 6])
    expect(store.listRuns(20, 0)).toEqual([])
  })
  it('keeps cursor pages consistent after non-monotonic updates and deletes across many runs', () => {
    const store = create(), expected = new Map<string, number>()
    for (let i = 0; i < 300; i++) {
      const id = `run_${i}`, created = (i * 37) % 997
      store.createRun(run({ id, requestId: `request_${i}`, created }))
      expected.set(id, created)
    }
    for (let i = 0; i < 300; i += 2) {
      const id = `run_${i}`, updated = (i * 61) % 997
      store.setMixed(id, updated)
      expected.set(id, updated)
    }
    for (let i = 0; i < 300; i += 3) { store.deleteRun(`run_${i}`); expected.delete(`run_${i}`) }
    for (const before of [undefined, 0, 200, 500, 1000]) {
      const page = [...expected].filter(([, updated]) => before === undefined || updated < before)
        .sort(([a, at], [b, bt]) => bt - at || (a < b ? 1 : -1)).slice(0, 200).map(([id]) => id)
      expect(store.listRuns(200, before).map(run => run.id)).toEqual(page)
    }
  })
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid page size %s rather than making an unbounded query', limit => {
    const store = create()
    expect(() => store.listRuns(limit)).toThrow()
    expect(() => store.events('missing', 0, limit)).toThrow()
  })
  it('rejects invalid run metadata, mutation timestamps and unsafe usage without changing retained state', () => {
    const store = create()
    expect(() => store.createRun(run({ id: '../escape' }))).toThrow()
    expect(() => store.createRun(run({ budget: { ...DEFAULT_BUDGET, maxSteps: -1 } }))).toThrow()
    expect(() => store.createRun(run({ grants: [{ id: 'g', root: 'relative/path', label: 'Docs' }] }))).toThrow()
    expect(() => store.createRun(run({ persistence: 'invalid' as NewRun['persistence'] }))).toThrow()
    expect(() => store.createRun(run({ mode: 'web' }))).toThrow()
    expect(store.listRuns(10)).toEqual([])
    store.createRun(run())
    const before = store.getRun('run_1')
    expect(() => store.setStatus('run_1', 'running', -1)).toThrow()
    expect(() => store.setStatus('run_1', 'bogus' as 'running', 110)).toThrow()
    expect(() => store.setMixed('run_1', NaN)).toThrow()
    expect(() => store.addUsage('run_1', { inputTokens: -1, outputTokens: 0 }, 110)).toThrow()
    expect(() => store.addUsage('run_1', { inputTokens: 0.5, outputTokens: 0 }, 110)).toThrow()
    expect(() => store.saveCheckpoint({ runId: 'run_1', step: -1, at: 110, messages: '[]' })).toThrow()
    expect(() => store.saveCheckpoint({ runId: 'run_1', step: 0, at: 110, messages: 'not json' })).toThrow()
    expect(() => store.saveCheckpoint({ runId: 'run_1', step: 0, at: 110, messages: '{}' })).toThrow('Invalid step checkpoint.')
    expect(() => store.listRuns(10, -1)).toThrow()
    expect(() => store.events('run_1', -1, 10)).toThrow()
    expect(store.getRun('run_1')).toEqual(before)
    expect(store.latestCheckpoint('run_1')).toBeUndefined()
    store.addUsage('run_1', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, 120)
    expect(() => store.addUsage('run_1', { inputTokens: 1, outputTokens: 0 }, 121)).toThrow()
    expect(store.getRun('run_1')?.usage.inputTokens).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('does not expose mutable aliases of runs, grants, budgets, event payloads or checkpoints', () => {
    const store = create(), input = run()
    const created = store.createRun(input)
    input.grants[0]!.root = '/attacker'
    created.run.budget.maxSteps = 999
    created.run.grants[0]!.root = '/attacker'
    const record = store.getRun('run_1')!
    record.usage.inputTokens = 999
    const payload = { type: 'text' as const, step: 0, text: 'original' }
    const appended = store.appendEvent('run_1', payload, 110)
    payload.text = 'changed'
    if (appended.payload.type === 'text') appended.payload.text = 'changed'
    const page = store.events('run_1', 0, 10)
    page[0]!.payload = { type: 'status', status: 'failed' }
    const checkpoint = { runId: 'run_1', step: 1, messages: '[]', at: 110 }
    store.saveCheckpoint(checkpoint)
    checkpoint.messages = '[1]'
    store.latestCheckpoint('run_1')!.messages = '[2]'
    expect(store.getRun('run_1')).toMatchObject({ grants: [{ root: '/private/owner/docs' }], budget: DEFAULT_BUDGET, usage: { inputTokens: 0 } })
    expect(store.events('run_1', 0, 10)[0]?.payload).toEqual({ type: 'text', step: 0, text: 'original' })
    expect(store.latestCheckpoint('run_1')?.messages).toBe('[]')
  })
  it('treats close as idempotent and refuses operations after disposal', () => {
    const store = create()
    store.createRun(run())
    store.close()
    expect(() => store.close()).not.toThrow()
    expect(() => store.createRun(run({ id: 'after' }))).toThrow()
    expect(() => store.getRun('run_1')).toThrow()
    expect(() => store.listRuns(10)).toThrow()
    expect(() => store.events('run_1', 0, 10)).toThrow()
    expect(() => store.latestCheckpoint('run_1')).toThrow()
    expect(() => store.deleteRun('run_1')).toThrow()
    expect(() => store.deleteConversation('conversation_1')).toThrow()
    expect(() => store.interruptUnfinished(200)).toThrow()
  })
  it('assigns isolated monotonic event sequences and rejects invalid payloads without consuming a sequence', () => {
    const store = create()
    store.createRun(run())
    store.createRun(run({ id: 'run_2', requestId: 'request_2' }))
    const first = store.appendEvent('run_1', { type: 'text', step: 0, text: 'First' }, 101)
    expect(first).toMatchObject({ runId: 'run_1', seq: 1, at: 101, payload: { type: 'text', text: 'First' } })
    expect(first.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(store.appendEvent('run_2', { type: 'status', status: 'running' }, 102).seq).toBe(1)
    expect(() => store.appendEvent('run_1', { type: 'text', step: 0, text: 'x'.repeat(64_001) }, 103)).toThrow()
    expect(() => store.appendEvent('run_1', { type: 'text', step: -1, text: 'bad' }, 103)).toThrow()
    const second = store.appendEvent('run_1', { type: 'text', step: 1, text: 'Second' }, 104)
    expect(second.seq).toBe(2)
    expect(second.id).not.toBe(first.id)
    expect(store.events('run_1', 0, 200)).toEqual([first, second])
    expect(store.events('run_1', 1, 1)).toEqual([second])
    expect(store.events('run_1', 2, 200)).toEqual([])
    expect(store.getRun('run_1')).toMatchObject({ nextSeq: 3, updated: 104 })
    expect(() => store.appendEvent('missing', { type: 'status', status: 'running' }, 105)).toThrow()
    expect(store.events('missing', 0, 10)).toEqual([])
  })
})

it('executes temporary run storage with every filesystem export denied and creates no files', async () => {
  const dir = temp()
  const before = readdirSync(dir)
  vi.resetModules()
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' ? () => { throw new Error('Filesystem access denied.') } : value]))
  })
  try {
    const { MemoryAgentStore: MemoryOnly } = await import('./store')
    const store = new MemoryOnly()
    store.createRun(run({ persistence: 'temporary' }))
    store.appendEvent('run_1', { type: 'text', step: 0, text: 'Never persist this' }, 110)
    store.saveCheckpoint({ runId: 'run_1', step: 0, messages: '[]', at: 110 })
    expect(store.interruptUnfinished(120)).toEqual(['run_1'])
    expect(store.events('run_1', 0, 10)).toHaveLength(2)
    store.deleteRun('run_1')
    store.close()
    expect(readdirSync(dir)).toEqual(before)
  } finally { vi.doUnmock('node:fs'); vi.resetModules() }
})

describe('SQLite restart and schema safety', () => {
  it('reopens a private versioned WAL database and recovers interrupted runs without losing grants or checkpoints', () => {
    const dir = join(temp(), 'private'), path = join(dir, 'agent.sqlite')
    const first = tracked(new SqliteAgentStore(path))
    first.createRun(run({ conversationId: 'conversation_1' }))
    first.setStatus('run_1', 'running', 110)
    first.addUsage('run_1', { inputTokens: 4, outputTokens: 8 }, 111)
    first.saveCheckpoint({ runId: 'run_1', step: 3, messages: '[]', at: 112 })
    const originalEvent = first.appendEvent('run_1', { type: 'text', step: 3, text: 'Saved before restart' }, 113)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const inspect = new DatabaseSync(path)
    try {
      expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
      expect(inspect.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      // synchronous is connection-local; inspect the owned connection for this setting.
      const db = (first as unknown as { db: DatabaseSync }).db
      expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 1 })
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
    } finally { inspect.close() }
    first.close()
    first.close()
    const reopened = tracked(new SqliteAgentStore(path))
    expect(reopened.getRun('run_1')).toMatchObject({ grants: run().grants, budget: DEFAULT_BUDGET, conversationId: 'conversation_1', usage: { inputTokens: 4, outputTokens: 8 } })
    expect(reopened.latestCheckpoint('run_1')).toEqual({ runId: 'run_1', step: 3, messages: '[]', at: 112 })
    expect(reopened.interruptUnfinished(200)).toEqual(['run_1'])
    expect(reopened.events('run_1', 0, 20)[0]).toEqual(originalEvent)
    expect(reopened.getRun('run_1')).toMatchObject({ status: 'interrupted', nextSeq: 3 })
    reopened.close()
    const third = tracked(new SqliteAgentStore(path))
    expect(third.events('run_1', 1, 10)[0]?.payload).toMatchObject({ type: 'status', status: 'interrupted' })
    third.setStatus('run_1', 'running', 210)
    expect(third.appendEvent('run_1', { type: 'status', status: 'running' }, 211).seq).toBe(3)
  })
  it('rejects a newer schema without changing its version or data', () => {
    const path = join(temp(), 'future.sqlite')
    const future = new DatabaseSync(path)
    future.exec("PRAGMA user_version=3; CREATE TABLE future(value TEXT); INSERT INTO future VALUES('keep');")
    future.close()
    expect(() => new SqliteAgentStore(path)).toThrow('Unsupported HeyNimbo agent schema.')
    const inspect = new DatabaseSync(path)
    try {
      expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
      expect(inspect.prepare('SELECT value FROM future').get()).toMatchObject({ value: 'keep' })
      expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name='runs'").get()).toBeUndefined()
    } finally { inspect.close() }
  })
  it('deduplicates concurrent-ish starts across connections and serializes their sequence allocation', async () => {
    const path = join(temp(), 'agent.sqlite')
    const first = tracked(new SqliteAgentStore(path)), second = tracked(new SqliteAgentStore(path))
    const results = await Promise.all([Promise.resolve().then(() => first.createRun(run())), Promise.resolve().then(() => second.createRun(run({ id: 'duplicate' })))])
    expect(results.map(result => result.created)).toEqual([true, false])
    expect(first.listRuns(20)).toHaveLength(1)
    expect(second.getRun('duplicate')).toBeUndefined()
    const events = await Promise.all([first, second].map(store => Promise.resolve().then(() => store.appendEvent('run_1', { type: 'status', status: 'running' }, 110))))
    expect(events.map(event => event.seq)).toEqual([1, 2])
  })
  it('rolls back event inserts and the whole restart batch when a database update fails', () => {
    const path = join(temp(), 'agent.sqlite'), store = tracked(new SqliteAgentStore(path))
    store.createRun(run())
    store.createRun(run({ id: 'run_2', requestId: 'request_2' }))
    const db = new DatabaseSync(path)
    try {
      db.exec("CREATE TRIGGER block_advance BEFORE UPDATE OF next_seq ON runs BEGIN SELECT RAISE(ABORT,'blocked'); END;")
      expect(() => store.appendEvent('run_1', { type: 'status', status: 'running' }, 110)).toThrow('blocked')
      expect(store.events('run_1', 0, 10)).toEqual([])
      expect(store.getRun('run_1')).toMatchObject({ nextSeq: 1, updated: 100 })
      db.exec("DROP TRIGGER block_advance; CREATE TRIGGER block_restart BEFORE UPDATE OF status ON runs WHEN NEW.id='run_2' BEGIN SELECT RAISE(ABORT,'blocked'); END;")
      expect(() => store.interruptUnfinished(120)).toThrow('blocked')
      for (const id of ['run_1', 'run_2']) {
        expect(store.events(id, 0, 10)).toEqual([])
        expect(store.getRun(id)).toMatchObject({ status: 'queued', nextSeq: 1, updated: 100 })
      }
      db.exec('DROP TRIGGER block_restart')
      expect(store.appendEvent('run_1', { type: 'status', status: 'running' }, 130).seq).toBe(1)
    } finally { db.close() }
  })
  it('paginates a 10000-event run without scanning or returning the full history', () => {
    const store = tracked(new SqliteAgentStore(join(temp(), 'agent.sqlite')))
    store.createRun(run())
    for (let i = 1; i <= 10_000; i++) store.appendEvent('run_1', { type: 'text', step: 0, text: `Event ${i}` }, i)
    for (const after of [0, 5000, 9800]) {
      const start = performance.now()
      const page = store.events('run_1', after, 200)
      const elapsed = performance.now() - start
      expect(page).toHaveLength(200)
      expect(page[0]?.seq).toBe(after + 1)
      expect(page[199]?.seq).toBe(after + 200)
      expect(elapsed).toBeLessThan(50)
    }
  })
})
