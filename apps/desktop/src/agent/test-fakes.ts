import { randomUUID } from 'node:crypto'
import type { AgentStore, ArtifactMeta, ArtifactStore, NewRun, RunRecord, StepCheckpoint } from './contracts'
import type { AgentError, AgentEvent, AgentEventPayload, RunStatus, RunUsage } from '../shared/agent-protocol'

/** Deliberately small boundary fakes; runtime tests still use the real SDK loop. */
export class FakeStore implements AgentStore {
  runs = new Map<string, RunRecord>()
  log = new Map<string, AgentEvent[]>()
  checkpoints = new Map<string, StepCheckpoint>()
  createRun(input: NewRun) {
    const existing = [...this.runs.values()].find(run => run.requestId === input.requestId)
    if (existing) return { run: structuredClone(existing), created: false }
    const run: RunRecord = { ...structuredClone(input), mixed: false, status: 'queued', updated: input.created, nextSeq: 1, usage: { inputTokens: 0, outputTokens: 0 } }
    this.runs.set(run.id, run)
    this.log.set(run.id, [])
    return { run: structuredClone(run), created: true }
  }
  getRun(id: string) { const run = this.runs.get(id); return run && structuredClone(run) }
  listRuns(limit: number, before = Infinity) { return [...this.runs.values()].filter(run => run.updated < before).sort((a, b) => b.updated - a.updated).slice(0, limit).map(run => structuredClone(run)) }
  appendEvent(runId: string, payload: AgentEventPayload, at: number): AgentEvent {
    const run = this.runs.get(runId)!
    const event = { runId, seq: run.nextSeq++, id: randomUUID(), at, payload: structuredClone(payload) }
    run.updated = at
    this.log.get(runId)!.push(event)
    return event
  }
  events(runId: string, afterSeq: number, limit: number) { return (this.log.get(runId) ?? []).filter(event => event.seq > afterSeq).slice(0, limit) }
  setStatus(runId: string, status: RunStatus, at: number, error?: AgentError) { Object.assign(this.runs.get(runId)!, { status, updated: at, error }) }
  setMixed(runId: string, at: number) { Object.assign(this.runs.get(runId)!, { mixed: true, updated: at }) }
  addUsage(runId: string, usage: RunUsage, at: number) {
    const run = this.runs.get(runId)!
    run.usage.inputTokens += usage.inputTokens
    run.usage.outputTokens += usage.outputTokens
    run.updated = at
  }
  saveCheckpoint(checkpoint: StepCheckpoint) { this.checkpoints.set(checkpoint.runId, structuredClone(checkpoint)) }
  latestCheckpoint(runId: string) { return this.checkpoints.get(runId) }
  interruptUnfinished(at: number) {
    const ids = [...this.runs.values()].filter(run => ['queued', 'running', 'waiting_approval', 'waiting_user'].includes(run.status)).map(run => run.id)
    for (const id of ids) this.setStatus(id, 'interrupted', at)
    return ids
  }
  deleteRun(runId: string) {
    const ids = [...new Set((this.log.get(runId) ?? []).flatMap(event => event.payload.type === 'artifact' ? [event.payload.artifactId] : []))]
    this.runs.delete(runId); this.log.delete(runId); this.checkpoints.delete(runId)
    return ids
  }
  deleteConversation(conversationId: string) { return [...this.runs.values()].filter(run => run.conversationId === conversationId).flatMap(run => this.deleteRun(run.id)) }
  close() {}
}

export class FakeArtifacts implements ArtifactStore {
  values = new Map<string, { meta: ArtifactMeta; content: Uint8Array }>()
  async save(runId: string, name: string, mediaType: string, content: Uint8Array) {
    const id = randomUUID()
    const meta = { id, runId, name, mediaType, bytes: content.byteLength, sha256: id, created: 0 }
    this.values.set(id, { meta, content })
    return meta
  }
  async read(runId: string, artifactId: string) { const value = this.values.get(artifactId); return value?.meta.runId === runId ? value : undefined }
  async delete(ids: readonly string[]) { for (const id of ids) this.values.delete(id) }
}
