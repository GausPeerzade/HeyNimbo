import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStore, NewRun } from './contracts'
import { DEFAULT_BUDGET } from '../shared/agent-protocol'
import { MemoryAgentStore, SqliteAgentStore } from './store'

const dirs: string[] = [], stores: AgentStore[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'heynimbo-cleanup-')); dirs.push(dir); return dir }
const run = (id = 'run'): NewRun => ({ id, requestId: id, goal: 'Finish safely', mode: 'web', persistence: 'retained', grants: [], budget: DEFAULT_BUDGET, created: 100 })
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe.each([
  ['memory', () => new MemoryAgentStore()],
  ['SQLite', () => new SqliteAgentStore(join(temp(), 'agent.sqlite'))],
] as const)('%s cleanup jobs', (_, make) => {
  it('tracks an uncommitted artifact cleanup job independently of run existence and committed references', () => {
    const store = make(); stores.push(store)
    expect(store.hasArtifact('missing', 'gap')).toBe(false)
    store.enqueueCleanup('gap')
    store.enqueueCleanup('gap')
    expect(store.cleanupJobs()).toEqual(['gap'])
    store.createRun(run())
    store.appendEvent('run', { type: 'text', step: 1, text: 'Not an artifact' }, 101)
    expect(store.hasArtifact('run', 'gap')).toBe(false)
    store.appendEvent('run', { type: 'artifact', artifactId: 'committed', name: 'Private', mediaType: 'text/plain', bytes: 1 }, 102)
    expect(store.hasArtifact('run', 'committed')).toBe(true)
    store.deleteRun('run')
    expect(store.hasArtifact('run', 'committed')).toBe(false)
    expect(store.cleanupJobs()).toEqual(['committed', 'gap'])
    store.completeCleanup('gap')
    store.completeCleanup('committed')
    expect(store.cleanupJobs()).toEqual([])
  })
  it.each(['deleteRun', 'deleteConversation', 'deleteBefore'] as const)('%s retains content-free cleanup jobs until completion', kind => {
    const store = make(); stores.push(store)
    store.createRun({ ...run(), conversationId: 'conversation' })
    for (const id of ['b', 'a', 'b']) store.appendEvent('run', { type: 'artifact', artifactId: id, name: 'Private name', mediaType: 'text/plain', bytes: 4 }, 101)
    if (kind === 'deleteRun') store.deleteRun('run')
    else if (kind === 'deleteConversation') store.deleteConversation('conversation')
    else store.deleteBefore(102)
    expect(store.getRun('run')).toBeUndefined()
    expect(store.cleanupJobs()).toEqual(['a', 'b'])
    expect(store.cleanupJobs('a')).toEqual(['b'])
    store.completeCleanup('a')
    expect(store.cleanupJobs()).toEqual(['b'])
    store.completeCleanup('b')
    store.completeCleanup('b')
    expect(store.cleanupJobs()).toEqual([])
  })
})

it('migrates real v1 DDL to v2 without losing runs, events, checkpoints or grants', () => {
  const path = join(temp(), 'agent.sqlite'), db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE runs(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, conversation_id TEXT,
      goal TEXT NOT NULL, mode TEXT NOT NULL, persistence TEXT NOT NULL, grants TEXT NOT NULL, budget TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', mixed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, error TEXT, next_seq INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX runs_updated ON runs(updated DESC,id DESC);
    CREATE INDEX runs_conversation ON runs(conversation_id);
    CREATE TABLE run_events(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,seq));
    CREATE TABLE step_checkpoints(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step INTEGER NOT NULL, messages TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(run_id,step));
    PRAGMA user_version=1;
  `)
  const grants = [{ id: 'grant', root: '/private/docs', label: 'Docs', identity: '1:2' }]
  db.prepare('INSERT INTO runs(id,request_id,goal,mode,persistence,grants,budget,created,updated,input_tokens,output_tokens,next_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('old', 'old-request', 'Preserve', 'local', 'retained', JSON.stringify(grants), JSON.stringify(DEFAULT_BUDGET), 100, 110, 7, 9, 2)
  db.prepare('INSERT INTO run_events VALUES(?,?,?,?,?)').run('old', 1, 'event', 110, JSON.stringify({ type: 'text', step: 1, text: 'Saved evidence' }))
  db.prepare('INSERT INTO step_checkpoints VALUES(?,?,?,?)').run('old', 1, '[]', 110)
  db.close()
  const store = new SqliteAgentStore(path); stores.push(store)
  const inspect = new DatabaseSync(path)
  try {
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
    expect(inspect.prepare('SELECT * FROM cleanup_jobs').all()).toEqual([])
    expect(store.getRun('old')).toMatchObject({ goal: 'Preserve', grants, usage: { inputTokens: 7, outputTokens: 9 }, nextSeq: 2 })
    expect(store.events('old', 0, 200)[0]?.payload).toEqual({ type: 'text', step: 1, text: 'Saved evidence' })
    expect(store.latestCheckpoint('old')).toEqual({ runId: 'old', step: 1, messages: '[]', at: 110 })
  } finally { inspect.close() }
})

it('rolls back a run deletion if inserting its durable cleanup job fails', () => {
  const path = join(temp(), 'agent.sqlite'), store = new SqliteAgentStore(path); stores.push(store)
  store.createRun(run())
  store.appendEvent('run', { type: 'artifact', artifactId: 'blob', name: 'Private', mediaType: 'text/plain', bytes: 1 }, 101)
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TRIGGER reject_cleanup BEFORE INSERT ON cleanup_jobs BEGIN SELECT RAISE(ABORT,'blocked'); END")
    expect(() => store.deleteRun('run')).toThrow('blocked')
    expect(store.getRun('run')?.goal).toBe('Finish safely')
    expect(store.events('run', 0, 200)).toHaveLength(1)
    expect(store.cleanupJobs()).toEqual([])
  } finally { db.close() }
})

it.each(['deleteRun', 'deleteConversation', 'deleteBefore'] as const)('%s truncates the live SQLite WAL after logical deletion', kind => {
  const path = join(temp(), 'agent.sqlite'), store = new SqliteAgentStore(path); stores.push(store)
  const marker = 'SYNTHETIC_DELETED_TRANSCRIPT_MARKER'
  store.createRun({ ...run(), conversationId: 'conversation', goal: marker })
  store.saveCheckpoint({ runId: 'run', step: 1, messages: JSON.stringify([{ role: 'user', content: marker }]), at: 101 })
  expect(readFileSync(path + '-wal').includes(Buffer.from(marker))).toBe(true)
  if (kind === 'deleteRun') store.deleteRun('run')
  else if (kind === 'deleteConversation') store.deleteConversation('conversation')
  else store.deleteBefore()
  expect(statSync(path + '-wal').size).toBe(0)
  expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false)
})
