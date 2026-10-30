import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryRepository } from './history'

const repositories: HistoryRepository[] = []
const repository = () => { const r = new HistoryRepository(); repositories.push(r); return r }
afterEach(() => repositories.splice(0).forEach(r => r.close()))

describe('HistoryRepository', () => {
  it('creates the current schema, saves the question before dispatch, and retains partial answers after interruption', () => {
    const r = repository()
    expect(r.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
    const c = r.create(100), t = r.begin(c, '  Find the export button  ', 'voice', 101)
    expect(r.turns(c)[0]).toMatchObject({ id: t, question: '  Find the export button  ', answer: '', state: 'interrupted', screenContextUsed: false })
    expect(r.list()[0]?.title).toBe('Find the export button')
    r.update(t, 'At the top', { version: 1, beats: [] }, true)
    r.finish(t, 'interrupted')
    expect(r.turns(c)[0]).toMatchObject({ answer: 'At the top', state: 'interrupted', screenContextUsed: true })
    const t2 = r.begin(c, 'Continue', 'text', 102)
    r.finish(t2, 'complete')
    expect(r.turns(c)[1]?.state).toBe('complete')
  })
  it('indexes title and streamed answer with snippets, accepts punctuation safely, and cascades deletes into FTS', () => {
    const r = repository(), c = r.create(), t = r.begin(c, 'Where is export?', 'text')
    r.update(t, 'Choose the turquoise download control.', { version: 1, beats: [] }, false)
    expect(r.search('turquoise')[0]).toMatchObject({ turnId: t, conversationId: c })
    expect(r.search('turquoise')[0]?.snippet).toContain('[turquoise]')
    r.rename(c, 'Invoice workflow')
    expect(r.search('invoice')[0]?.title).toBe('Invoice workflow')
    expect(() => r.search('" OR *:')).not.toThrow()
    r.delete(c)
    expect(r.turns(c)).toEqual([])
    expect(r.search('turquoise')).toEqual([])
    expect(r.db.prepare('SELECT count(*) AS n FROM turn_search').get()).toMatchObject({ n: 0 })
  })
  it('prunes strictly before the retention boundary including pinned items; keep/off do not delete', () => {
    const r = repository(), now = 30 * 86400000, boundary = now - 7 * 86400000
    const expired = r.create(boundary - 1), retained = r.create(boundary)
    r.pin(expired, true)
    r.prune('forever', now); r.prune(0, now)
    expect(r.list()).toHaveLength(2)
    r.prune(7, now)
    expect(r.list().map(c => c.id)).toEqual([retained])
  })
  it('orders pinned ahead of recent and delete-all clears every index row', () => {
    const r = repository(), old = r.create(10), recent = r.create(20)
    r.begin(old, 'oldest', 'voice', 10); r.begin(recent, 'newest', 'text', 20)
    r.pin(old, true)
    expect(r.list().map(c => c.id)).toEqual([old, recent])
    r.pin(old, false)
    expect(r.list().map(c => c.id)).toEqual([recent, old])
    r.deleteAll()
    expect(r.search('oldest')).toEqual([])
    expect(r.db.prepare('SELECT count(*) AS n FROM turns').get()).toMatchObject({ n: 0 })
  })
})
it('marks task handoffs left undecided by a previous session as not started, without touching settled tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-history-tasks-')), path = join(dir, 'history.sqlite')
  try {
    const r = new HistoryRepository(path), c = r.create()
    const pending = r.begin(c, 'Research', 'text'), settled = r.begin(c, 'Read', 'text')
    r.update(pending, 'Started.', { version: 1, beats: [], tasks: [{ goal: 'Research', mode: 'web', state: 'starting' }] }, false)
    r.update(settled, 'Started.', { version: 1, beats: [], tasks: [{ goal: 'Read', mode: 'local', state: 'started', runId: 'run_1' }] }, false)
    r.close()
    const reopened = new HistoryRepository(path)
    expect(reopened.turns(c).map(turn => turn.scene.tasks)).toEqual([
      [{ goal: 'Research', mode: 'web', state: 'failed', error: 'HeyNimbo closed before this task started.' }],
      [{ goal: 'Read', mode: 'local', state: 'started', runId: 'run_1' }],
    ])
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('reopens a private WAL file without rebuilding its schema or losing content', async () => {
  const { mkdtempSync, rmSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = mkdtempSync('/tmp/heynimbo-history-test-'), path = join(dir, 'history.sqlite')
  try {
    const first = new HistoryRepository(path), c = first.create(), t = first.begin(c, 'Remember this', 'text')
    first.finish(t, 'complete')
    expect(first.db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    first.close()
    const reopened = new HistoryRepository(path)
    expect(reopened.turns(c)[0]?.question).toBe('Remember this')
    expect(reopened.search('Remember')).toHaveLength(1)
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('bounds the sidebar query while old conversations remain searchable and individually loadable', () => {
  const r = repository()
  const old = r.create(1); r.begin(old, 'Ancient waypoint', 'text', 1)
  for (let i = 2; i <= 250; i++) r.create(i)
  expect(r.list()).toHaveLength(200)
  expect(r.list().some(c => c.id === old)).toBe(false)
  expect(r.conversation(old)?.title).toBe('Ancient waypoint')
  expect(r.search('waypoint')[0]).toMatchObject({ conversationId: old, updated: 1 })
})

it('retains explicit provider/model attribution across reopen and rejects unsupported schemas instead of migrating them', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dir = mkdtempSync('/tmp/heynimbo-history-schema-test-'), path = join(dir, 'history.sqlite')
  try {
    const original = new HistoryRepository(path), c = original.create(), old = original.begin(c, 'Old question', 'voice')
    original.update(old, 'Old answer', { version: 1, beats: [] }, true); original.finish(old, 'complete')
    original.close()
    const migrated = new HistoryRepository(path)
    expect(migrated.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
    expect(migrated.turns(c)[0]).toMatchObject({ provider: 'openai', model: 'gpt-6.1-terra', question: 'Old question', answer: 'Old answer' })
    migrated.begin(c, 'New question', 'text', Date.now(), { provider: 'anthropic', model: 'claude-sonnet-5-5' })
    expect(migrated.turns(c).at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
    expect(migrated.context(c)).toEqual([{ question: 'Old question', answer: 'Old answer' }])
    migrated.close()
    const reopened = new HistoryRepository(path); expect(reopened.turns(c)).toHaveLength(2)
    reopened.db.exec('PRAGMA user_version=1'); reopened.close()
    expect(() => new HistoryRepository(path)).toThrow('Unsupported HeyNimbo history schema.')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
