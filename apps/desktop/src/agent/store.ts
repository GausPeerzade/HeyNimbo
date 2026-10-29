import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AgentStore, NewRun, RunRecord, StepCheckpoint } from './contracts'
import { LIMITS, parseAgentEvent, parseAgentRequest } from '../shared/agent-protocol'
import type { AgentError, AgentEvent, AgentEventPayload, RunStatus, RunSummary, RunUsage } from '../shared/agent-protocol'

const clone = <T>(value: T): T => structuredClone(value)
const completed = (status: RunStatus): boolean => ['succeeded', 'failed', 'cancelled'].includes(status)
const RESTART: AgentEventPayload = { type: 'status', status: 'interrupted', reason: 'HeyNimbo restarted before this task finished.' }
function integer(value: number, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error('Invalid store value.')
}
function pageSize(limit: number): number { integer(limit, 1); return Math.min(limit, LIMITS.pageSize) }
function summary(run: RunRecord): RunSummary {
  const { id, conversationId, goal, mode, mixed, status, persistence, created, updated, usage, error } = run
  return { id, ...(conversationId === undefined ? {} : { conversationId }), goal, mode, mixed, status, persistence, created, updated, usage: clone(usage), ...(error === undefined ? {} : { error: clone(error) }) }
}
function initial(run: NewRun): RunRecord {
  parseAgentRequest({ kind: 'start', requestId: run.requestId, goal: run.goal, mode: run.mode, ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }), grantIds: run.grants.map(grant => grant.id) })
  event(run.id, 1, { type: 'run.created', goal: run.goal, mode: run.mode, persistence: run.persistence, budget: run.budget }, run.created)
  for (const value of [run.budget.maxSteps, run.budget.maxOutputTokens, run.budget.maxWallMs, run.budget.maxToolOutputBytes]) integer(value, 1)
  for (const grant of run.grants) {
    if (typeof grant.root !== 'string' || !isAbsolute(grant.root) || grant.root.includes('\0') || typeof grant.label !== 'string' || !grant.label.trim() || grant.label.length > 300) throw new Error('Invalid folder grant.')
  }
  return { ...clone(run), mixed: false, status: 'queued', updated: run.created, usage: { inputTokens: 0, outputTokens: 0 }, nextSeq: 1 }
}
function event(runId: string, seq: number, payload: AgentEventPayload, at: number): AgentEvent {
  return clone(parseAgentEvent({ runId, seq, payload, at, id: randomUUID().replaceAll('-', '') }))
}
function validateCheckpoint(checkpoint: StepCheckpoint): void {
  integer(checkpoint.step)
  integer(checkpoint.at)
  try {
    if (typeof checkpoint.messages !== 'string' || !Array.isArray(JSON.parse(checkpoint.messages))) throw new Error()
  } catch { throw new Error('Invalid step checkpoint.') }
}

abstract class Store implements AgentStore {
  abstract createRun(run: NewRun): { run: RunRecord; created: boolean }
  abstract getRun(id: string): RunRecord | undefined
  abstract getRunByRequest(requestId: string): RunRecord | undefined
  abstract listRuns(limit: number, before?: number): RunSummary[]
  abstract appendEvent(runId: string, payload: AgentEventPayload, at: number): AgentEvent
  abstract events(runId: string, afterSeq: number, limit: number): AgentEvent[]
  abstract close(): void
  protected requireRun(id: string): RunRecord {
    const run = this.getRun(id)
    if (!run) throw new Error('Run not found.')
    return run
  }
  protected abstract mutate(runId: string, change: (run: RunRecord) => void): void
  resume(runId: string, at: number): void {
    integer(at)
    this.mutate(runId, run => {
      if (!(run.status === 'interrupted' || (run.status === 'failed' && run.error?.code === 'provider'))) throw new Error('Only an interrupted or provider-failed run can continue.')
      run.status = 'running'
      run.updated = at
      delete run.error
    })
  }
  setStatus(runId: string, status: RunStatus, at: number, error?: AgentError): void {
    event(runId, 1, { type: 'status', status }, at)
    if (error !== undefined) event(runId, 1, { type: 'error', ...error }, at)
    this.mutate(runId, run => {
      if (completed(run.status) && run.status !== status) throw new Error('Run is terminal.')
      run.status = status
      run.updated = at
      if (error === undefined) delete run.error
      else run.error = clone(error)
    })
  }
  setMixed(runId: string, at: number): void { integer(at); this.mutate(runId, run => { run.mixed = true; run.updated = at }) }
  addUsage(runId: string, usage: RunUsage, at: number): void {
    event(runId, 1, { type: 'usage', ...usage }, at)
    this.mutate(runId, run => {
      run.usage.inputTokens += usage.inputTokens
      run.usage.outputTokens += usage.outputTokens
      integer(run.usage.inputTokens)
      integer(run.usage.outputTokens)
      run.updated = at
    })
  }
  abstract saveCheckpoint(checkpoint: StepCheckpoint): void
  abstract latestCheckpoint(runId: string): StepCheckpoint | undefined
  abstract interruptUnfinished(at: number): string[]
  abstract deleteRun(runId: string): string[]
  abstract deleteConversation(conversationId: string): string[]
  abstract deleteBefore(before?: number): string[]
  abstract cleanupJobs(after?: string): string[]
  abstract enqueueCleanup(artifactId: string): void
  abstract hasArtifact(runId: string, artifactId: string): boolean
  abstract completeCleanup(artifactId: string): void
}

type RunKey = Pick<RunSummary, 'id' | 'updated'>
interface RunNode extends RunKey { priority: string; left?: RunNode; right?: RunNode }
const compare = (a: RunKey, b: RunKey): number => a.updated - b.updated || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)
function split(root: RunNode | undefined, key: RunKey): [RunNode | undefined, RunNode | undefined] {
  if (!root) return [undefined, undefined]
  if (compare(root, key) < 0) {
    const [left, right] = split(root.right, key)
    root.right = left
    return [root, right]
  }
  const [left, right] = split(root.left, key)
  root.left = right
  return [left, root]
}
function merge(left: RunNode | undefined, right: RunNode | undefined): RunNode | undefined {
  if (!left || !right) return left ?? right
  if (left.priority < right.priority) { left.right = merge(left.right, right); return left }
  right.left = merge(left, right.left)
  return right
}
function remove(root: RunNode | undefined, key: RunKey): RunNode | undefined {
  if (!root) return undefined
  const order = compare(key, root)
  if (!order) return merge(root.left, root.right)
  if (order < 0) root.left = remove(root.left, key)
  else root.right = remove(root.right, key)
  return root
}
// A randomized ordered index makes memory-mode pages O(log runs + page size),
// without sorting/scanning retained history or shifting an array on every event.
class RunIndex {
  private root?: RunNode
  add(run: RunKey): void {
    const [left, right] = split(this.root, run)
    this.root = merge(merge(left, { id: run.id, updated: run.updated, priority: randomUUID() }), right)
  }
  delete(run: RunKey): void { this.root = remove(this.root, run) }
  page(limit: number, before?: number): string[] {
    const ids: string[] = []
    const visit = (node: RunNode | undefined): void => {
      if (!node || ids.length === limit) return
      if (before !== undefined && node.updated >= before) { visit(node.left); return }
      visit(node.right)
      if (ids.length < limit) ids.push(node.id)
      visit(node.left)
    }
    visit(this.root)
    return ids
  }
}

export class MemoryAgentStore extends Store {
  private closed = false
  private assertOpen(): void { if (this.closed) throw new Error('Agent store is closed.') }
  private runs = new Map<string, RunRecord>()
  private index = new RunIndex()
  private requests = new Map<string, string>()
  private log = new Map<string, AgentEvent[]>()
  private checkpoints = new Map<string, Map<number, StepCheckpoint>>()
  private latest = new Map<string, number>()
  private cleanup = new Set<string>()
  cleanupJobs(after = ''): string[] { this.assertOpen(); return [...this.cleanup].filter(id => id > after).sort().slice(0, 200) }
  enqueueCleanup(artifactId: string): void { this.assertOpen(); this.cleanup.add(artifactId) }
  completeCleanup(artifactId: string): void { this.assertOpen(); this.cleanup.delete(artifactId) }
  hasArtifact(runId: string, artifactId: string): boolean {
    this.assertOpen()
    return this.log.get(runId)?.some(event => event.payload.type === 'artifact' && event.payload.artifactId === artifactId) ?? false
  }
  createRun(input: NewRun): { run: RunRecord; created: boolean } {
    this.assertOpen()
    const existing = this.requests.get(input.requestId)
    if (existing) return { run: this.requireRun(existing), created: false }
    if (this.runs.has(input.id)) throw new Error('Run already exists.')
    const run = initial(input)
    this.remember(run)
    this.requests.set(run.requestId, run.id)
    this.log.set(run.id, [])
    return { run: clone(run), created: true }
  }
  getRun(id: string): RunRecord | undefined { this.assertOpen(); return clone(this.runs.get(id)) }
  getRunByRequest(requestId: string): RunRecord | undefined { this.assertOpen(); const id = this.requests.get(requestId); return id === undefined ? undefined : this.getRun(id) }
  private remember(run: RunRecord): void {
    const previous = this.runs.get(run.id)
    if (previous) this.index.delete(previous)
    this.runs.set(run.id, run)
    this.index.add(run)
  }
  protected mutate(runId: string, change: (run: RunRecord) => void): void {
    const run = this.requireRun(runId)
    change(run)
    this.remember(run)
  }
  listRuns(limit: number, before?: number): RunSummary[] {
    this.assertOpen()
    if (before !== undefined) integer(before)
    limit = pageSize(limit)
    return this.index.page(limit, before).map(id => summary(this.runs.get(id)!))
  }
  appendEvent(runId: string, payload: AgentEventPayload, at: number): AgentEvent {
    const run = this.requireRun(runId)
    const next = event(runId, run.nextSeq, payload, at)
    this.log.get(runId)!.push(next)
    run.nextSeq++
    run.updated = at
    this.remember(run)
    return clone(next)
  }
  events(runId: string, afterSeq: number, limit: number): AgentEvent[] {
    this.assertOpen()
    integer(afterSeq)
    limit = pageSize(limit)
    return clone(this.log.get(runId)?.slice(afterSeq, afterSeq + limit) ?? [])
  }
  saveCheckpoint(checkpoint: StepCheckpoint): void {
    validateCheckpoint(checkpoint)
    this.requireRun(checkpoint.runId)
    const steps = this.checkpoints.get(checkpoint.runId) ?? new Map<number, StepCheckpoint>()
    steps.set(checkpoint.step, clone(checkpoint))
    this.checkpoints.set(checkpoint.runId, steps)
    this.latest.set(checkpoint.runId, Math.max(this.latest.get(checkpoint.runId) ?? -1, checkpoint.step))
  }
  latestCheckpoint(runId: string): StepCheckpoint | undefined {
    this.assertOpen()
    return clone(this.checkpoints.get(runId)?.get(this.latest.get(runId)!))
  }
  interruptUnfinished(at: number): string[] {
    this.assertOpen()
    integer(at)
    const pending = [...this.runs.values()].filter(run => !completed(run.status)).map(run => clone(run))
    // Validate the entire recovery batch before changing any in-memory state.
    const events = pending.map(run => event(run.id, run.nextSeq, RESTART, at))
    for (const [i, run] of pending.entries()) {
      run.status = 'interrupted'
      run.updated = at
      run.nextSeq++
      delete run.error
      this.log.get(run.id)!.push(events[i]!)
      this.remember(run)
    }
    return pending.map(run => run.id)
  }
  deleteRun(runId: string): string[] {
    this.assertOpen()
    const run = this.runs.get(runId)
    if (!run) return []
    const artifacts = this.log.get(runId)!.flatMap(e => e.payload.type === 'artifact' ? [e.payload.artifactId] : [])
    for (const id of artifacts) this.cleanup.add(id)
    this.requests.delete(run.requestId)
    this.index.delete(run)
    this.runs.delete(runId)
    this.log.delete(runId)
    this.checkpoints.delete(runId)
    this.latest.delete(runId)
    return [...new Set(artifacts)]
  }
  deleteConversation(conversationId: string): string[] {
    this.assertOpen()
    const ids = [...this.runs.values()].filter(run => run.conversationId === conversationId).map(run => run.id)
    return [...new Set(ids.flatMap(id => this.deleteRun(id)))]
  }
  close(): void { this.closed = true; this.runs.clear(); this.index = new RunIndex(); this.requests.clear(); this.log.clear(); this.checkpoints.clear(); this.latest.clear(); this.cleanup.clear() }
  deleteBefore(before?: number): string[] {
    this.assertOpen()
    if (before !== undefined) integer(before)
    const ids = [...this.runs.values()].filter(run => before === undefined || run.updated < before).map(run => run.id)
    return [...new Set(ids.flatMap(id => this.deleteRun(id)))]
  }
}

type Row = Record<string, unknown>
function decodeSummary(row: Row): RunSummary {
  return {
    id: String(row.id), ...(row.conversation_id === null ? {} : { conversationId: String(row.conversation_id) }),
    goal: String(row.goal), mode: row.mode as RunSummary['mode'], persistence: row.persistence as RunSummary['persistence'],
    mixed: Boolean(row.mixed), status: row.status as RunStatus, created: Number(row.created), updated: Number(row.updated),
    usage: { inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) },
    ...(row.error === null ? {} : { error: JSON.parse(String(row.error)) as AgentError }),
  }
}
function decode(row: Row): RunRecord {
  return { ...decodeSummary(row), requestId: String(row.request_id), grants: JSON.parse(String(row.grants)), budget: JSON.parse(String(row.budget)), nextSeq: Number(row.next_seq) }
}
const SUMMARY_COLUMNS = 'id,conversation_id,goal,mode,persistence,mixed,status,created,updated,input_tokens,output_tokens,error'
export class SqliteAgentStore extends Store {
  private db: DatabaseSync
  private statements
  private closed = false
  constructor(path: string) {
    super()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
    closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
    this.db = new DatabaseSync(path)
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
      if (version !== 0 && version !== 1 && version !== 2) throw new Error('Unsupported HeyNimbo agent schema.')
      // WAL+NORMAL survives app crashes. Power loss may lose the last commits;
      // that tradeoff is acceptable for read-only run events, not an effects ledger.
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON;')
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
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
        COMMIT;
      `)
      if (version < 2) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE cleanup_jobs(artifact_id TEXT PRIMARY KEY);
        PRAGMA user_version=2;
        COMMIT;
      `)
      this.statements = {
        insert: this.db.prepare('INSERT INTO runs(id,request_id,conversation_id,goal,mode,persistence,grants,budget,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)'),
        get: this.db.prepare('SELECT * FROM runs WHERE id=?'),
        request: this.db.prepare('SELECT * FROM runs WHERE request_id=?'),
        list: this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM runs WHERE updated < ? ORDER BY updated DESC,id DESC LIMIT ?`),
        newest: this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM runs ORDER BY updated DESC,id DESC LIMIT ?`),
        insertEvent: this.db.prepare('INSERT INTO run_events(run_id,seq,id,at,payload) VALUES(?,?,?,?,?)'),
        advance: this.db.prepare('UPDATE runs SET next_seq=next_seq+1, updated=? WHERE id=?'),
        state: this.db.prepare('UPDATE runs SET status=?,mixed=?,input_tokens=?,output_tokens=?,error=?,updated=? WHERE id=?'),
        events: this.db.prepare('SELECT run_id,seq,id,at,payload FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?'),
        checkpoint: this.db.prepare('INSERT INTO step_checkpoints(run_id,step,messages,at) VALUES(?,?,?,?) ON CONFLICT(run_id,step) DO UPDATE SET messages=excluded.messages,at=excluded.at'),
        latest: this.db.prepare('SELECT run_id,step,messages,at FROM step_checkpoints WHERE run_id=? ORDER BY step DESC LIMIT 1'),
        unfinished: this.db.prepare("SELECT id FROM runs WHERE status NOT IN ('succeeded','failed','cancelled')"),
        interrupt: this.db.prepare("UPDATE runs SET status='interrupted',error=NULL WHERE id=?"),
        artifacts: this.db.prepare("SELECT DISTINCT json_extract(payload,'$.artifactId') AS id FROM run_events WHERE run_id=? AND json_extract(payload,'$.type')='artifact'"),
        conversationArtifacts: this.db.prepare("SELECT DISTINCT json_extract(e.payload,'$.artifactId') AS id FROM run_events e JOIN runs r ON r.id=e.run_id WHERE r.conversation_id=? AND json_extract(e.payload,'$.type')='artifact'"),
        deleteRun: this.db.prepare('DELETE FROM runs WHERE id=?'),
        deleteConversation: this.db.prepare('DELETE FROM runs WHERE conversation_id=?'),
        purgeArtifacts: this.db.prepare("SELECT DISTINCT json_extract(e.payload,'$.artifactId') AS id FROM run_events e JOIN runs r ON r.id=e.run_id WHERE (? IS NULL OR r.updated < ?) AND json_extract(e.payload,'$.type')='artifact'"),
        purge: this.db.prepare('DELETE FROM runs WHERE (? IS NULL OR updated < ?)'),
        enqueueCleanup: this.db.prepare('INSERT OR IGNORE INTO cleanup_jobs(artifact_id) VALUES(?)'),
        cleanupJobs: this.db.prepare('SELECT artifact_id FROM cleanup_jobs WHERE artifact_id > ? ORDER BY artifact_id LIMIT 200'),
        completeCleanup: this.db.prepare('DELETE FROM cleanup_jobs WHERE artifact_id=?'),
        hasArtifact: this.db.prepare("SELECT 1 FROM run_events WHERE run_id=? AND json_extract(payload,'$.type')='artifact' AND json_extract(payload,'$.artifactId')=? LIMIT 1"),
      }
    } catch (error) { this.db.close(); throw error }
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = action(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  createRun(input: NewRun): { run: RunRecord; created: boolean } {
    return this.transaction(() => {
      const existing = this.statements.request.get(input.requestId)
      if (existing) return { run: decode(existing), created: false }
      if (this.statements.get.get(input.id)) throw new Error('Run already exists.')
      const run = initial(input)
      this.statements.insert.run(run.id, run.requestId, run.conversationId ?? null, run.goal, run.mode, run.persistence, JSON.stringify(run.grants), JSON.stringify(run.budget), run.created, run.updated)
      return { run, created: true }
    })
  }
  getRun(id: string): RunRecord | undefined {
    const row = this.statements.get.get(id)
    return row ? decode(row) : undefined
  }
  getRunByRequest(requestId: string): RunRecord | undefined {
    const row = this.statements.request.get(requestId)
    return row ? decode(row) : undefined
  }
  protected mutate(runId: string, change: (run: RunRecord) => void): void {
    this.transaction(() => {
      const run = this.requireRun(runId)
      change(run)
      this.statements.state.run(run.status, Number(run.mixed), run.usage.inputTokens, run.usage.outputTokens, run.error === undefined ? null : JSON.stringify(run.error), run.updated, runId)
    })
  }
  listRuns(limit: number, before?: number): RunSummary[] {
    limit = pageSize(limit)
    if (before !== undefined) integer(before)
    return (before === undefined ? this.statements.newest.all(limit) : this.statements.list.all(before, limit)).map(decodeSummary)
  }
  appendEvent(runId: string, payload: AgentEventPayload, at: number): AgentEvent {
    return this.transaction(() => this.insertEvent(runId, payload, at))
  }
  private insertEvent(runId: string, payload: AgentEventPayload, at: number): AgentEvent {
    const run = this.requireRun(runId)
    const next = event(runId, run.nextSeq, payload, at)
    this.statements.insertEvent.run(runId, next.seq, next.id, at, JSON.stringify(next.payload))
    this.statements.advance.run(at, runId)
    return next
  }
  events(runId: string, afterSeq: number, limit: number): AgentEvent[] {
    integer(afterSeq)
    return this.statements.events.all(runId, afterSeq, pageSize(limit)).map(row => ({ runId: String(row.run_id), seq: Number(row.seq), id: String(row.id), at: Number(row.at), payload: JSON.parse(String(row.payload)) as AgentEventPayload }))
  }
  saveCheckpoint(checkpoint: StepCheckpoint): void {
    validateCheckpoint(checkpoint)
    this.requireRun(checkpoint.runId)
    this.statements.checkpoint.run(checkpoint.runId, checkpoint.step, checkpoint.messages, checkpoint.at)
  }
  latestCheckpoint(runId: string): StepCheckpoint | undefined {
    const row = this.statements.latest.get(runId)
    return row ? { runId: String(row.run_id), step: Number(row.step), messages: String(row.messages), at: Number(row.at) } : undefined
  }
  interruptUnfinished(at: number): string[] {
    integer(at)
    return this.transaction(() => {
      const ids = this.statements.unfinished.all().map(row => String(row.id))
      for (const id of ids) { this.insertEvent(id, RESTART, at); this.statements.interrupt.run(id) }
      return ids
    })
  }
  deleteRun(runId: string): string[] {
    return this.deleting(() => {
      const ids = this.statements.artifacts.all(runId).map(row => String(row.id))
      for (const id of ids) this.statements.enqueueCleanup.run(id)
      this.statements.deleteRun.run(runId)
      return ids
    })
  }
  deleteConversation(conversationId: string): string[] {
    return this.deleting(() => {
      const ids = this.statements.conversationArtifacts.all(conversationId).map(row => String(row.id))
      for (const id of ids) this.statements.enqueueCleanup.run(id)
      this.statements.deleteConversation.run(conversationId)
      return ids
    })
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
  deleteBefore(before?: number): string[] {
    if (before !== undefined) integer(before)
    return this.deleting(() => {
      const ids = this.statements.purgeArtifacts.all(before ?? null, before ?? null).map(row => String(row.id))
      for (const id of ids) this.statements.enqueueCleanup.run(id)
      this.statements.purge.run(before ?? null, before ?? null)
      return ids
    })
  }
  cleanupJobs(after = ''): string[] { return this.statements.cleanupJobs.all(after).map(row => String(row.artifact_id)) }
  enqueueCleanup(artifactId: string): void { this.statements.enqueueCleanup.run(artifactId) }
  hasArtifact(runId: string, artifactId: string): boolean { return this.statements.hasArtifact.get(runId, artifactId) !== undefined }
  completeCleanup(artifactId: string): void { this.statements.completeCleanup.run(artifactId) }
  private deleting(action: () => string[]): string[] {
    const ids = this.transaction(action)
    // Truncate live journal remnants after logical deletion. This is not
    // forensic erasure: SSD snapshots, backups and external readers still apply.
    const result = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!
    if (result.busy) throw new Error('Agent cleanup is pending.')
    return ids
  }
}
