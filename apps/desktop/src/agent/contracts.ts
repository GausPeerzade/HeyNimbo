// Internal contracts between agent-host modules. Each module is built and
// tested independently against these interfaces; the coordinator composes them.
// Nothing under src/agent may import Electron: the host runs in a utility
// process and, later, headless.
//
// Module ownership and export names (fixed so modules compose without edits):
//   src/agent/store.ts        SqliteAgentStore(path), MemoryAgentStore()      implements AgentStore
//   src/agent/artifacts.ts    FileArtifactStore(dir), MemoryArtifactStore()   implements ArtifactStore
//   src/agent/tools/files.ts  localTools(): AgentTool[]   (list_files, read_file, search_files) + artifactTools(): AgentTool[] (save_artifact)
//   src/agent/tools/web.ts    webTools(options): AgentTool[]  (web_search, fetch_url)
//   src/agent/net-policy.ts   isPublicAddress(ip), safeFetch(...)
//   src/agent/runtime.ts      createAgentRuntime(deps: RuntimeDeps): AgentRuntime
//   src/agent/host/serve.ts   serveHost(port, compose)  (utility-process side of the MessagePort)
//   src/main/agent-supervisor.ts  AgentSupervisor (main side: lazy spawn, kill, credential scoping)
import type { LanguageModel } from 'ai'
import type { AgentEvent, AgentEventPayload, FolderGrant, HostCommand, ModelSelection, Persistence, RunBudget, RunMode, RunStatus, RunSummary, RunUsage, AgentError, SearchConfig, CancelAllResult } from '../shared/agent-protocol'

// ---------------------------------------------------------------------------
// Store (agent.sqlite or in-memory)

export interface NewRun {
  id: string
  requestId: string
  goal: string
  mode: RunMode
  persistence: Persistence
  conversationId?: string
  /** Persisted with the run so Continue cannot widen or lose them. Empty for web runs. */
  grants: FolderGrant[]
  budget: RunBudget
  created: number
}

/** One model step's ordered messages, enough to continue the run after restart. */
export interface StepCheckpoint { runId: string; step: number; messages: string /* JSON ModelMessage[] */; at: number }

export interface RunRecord extends RunSummary { requestId: string; budget: RunBudget; grants: FolderGrant[]; nextSeq: number }

export interface AgentStore {
  /** Returns the existing run when `requestId` was already used (idempotent start). */
  createRun(run: NewRun): { run: RunRecord; created: boolean }
  getRun(id: string): RunRecord | undefined
  getRunByRequest(requestId: string): RunRecord | undefined
  /** Newest first; `before` is an `updated` cursor (exclusive). */
  listRuns(limit: number, before?: number): RunSummary[]
  /** Assigns the next per-run seq atomically and persists the event. */
  appendEvent(runId: string, payload: AgentEventPayload, at: number): AgentEvent
  events(runId: string, afterSeq: number, limit: number): AgentEvent[]
  setStatus(runId: string, status: RunStatus, at: number, error?: AgentError): void
  /** Atomically reactivates only interrupted or provider-failed runs. */
  resume(runId: string, at: number): void
  setMixed(runId: string, at: number): void
  addUsage(runId: string, usage: RunUsage, at: number): void
  saveCheckpoint(checkpoint: StepCheckpoint): void
  latestCheckpoint(runId: string): StepCheckpoint | undefined
  /** Marks every non-terminal run `interrupted`; returns their IDs. Called once at host start. */
  interruptUnfinished(at: number): string[]
  /** Purges the run, its events, checkpoints and artifact references. Returns artifact IDs to delete. */
  deleteRun(runId: string): string[]
  deleteConversation(conversationId: string): string[]
  deleteBefore(before?: number): string[]
  /** Content-free artifact deletion jobs, paged by opaque ID (exclusive). */
  cleanupJobs(after?: string): string[]
  enqueueCleanup(artifactId: string): void
  hasArtifact(runId: string, artifactId: string): boolean
  completeCleanup(artifactId: string): void
  close(): void
}

// ---------------------------------------------------------------------------
// Artifacts (content-addressed, outside any granted folder)

export interface ArtifactMeta { id: string; runId: string; name: string; mediaType: string; bytes: number; sha256: string; created: number }

export interface ArtifactStore {
  save(runId: string, name: string, mediaType: string, content: Uint8Array): Promise<ArtifactMeta>
  read(runId: string, artifactId: string): Promise<{ meta: ArtifactMeta; content: Uint8Array } | undefined>
  delete(artifactIds: readonly string[]): Promise<void>
}

// ---------------------------------------------------------------------------
// Tools

export type ToolEffect = 'read' | 'network-read' | 'artifact-write' | 'interaction'

/** Which run mode may use the tool. `any` tools never touch files or network. */
export type ToolScope = 'web' | 'local' | 'any'

export interface ToolContext {
  runId: string
  /** Grants resolved by main for this run; empty for web runs. */
  grants: readonly FolderGrant[]
  signal: AbortSignal
  /** Throws if the run was cancelled or its generation changed; call immediately before any effect. */
  checkpoint(): void
  artifacts: ArtifactStore
  /** Remaining tool-output budget in bytes; tools must truncate to this. */
  outputBudget: number
}

export interface ToolOutcome {
  ok: boolean
  /** Text returned to the model (already bounded). */
  content: string
  /** Short, plain-text summary shown in the timeline. */
  summary: string
  artifactId?: string
}

export interface AgentTool {
  name: string
  description: string
  /** JSON Schema for the input; `additionalProperties: false` required. */
  inputSchema: Record<string, unknown>
  effect: ToolEffect
  scope: ToolScope
  /** When true the coordinator pauses for an owner approval showing `preview(input)`. */
  needsApproval(input: unknown, ctx: Pick<ToolContext, 'grants'>): boolean
  /** Trusted, plain-text preview built from the validated input. */
  preview(input: unknown): string
  /** Validates and normalizes raw model input; throws a user-safe Error on invalid input. */
  parse(input: unknown): unknown
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutcome>
}

// ---------------------------------------------------------------------------
// Network policy (used by web tools; injectable for tests)

export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

// ---------------------------------------------------------------------------
// Runtime composition (host side)

/** Fetches a secret from main on demand; main answers only for configured names. */
export type CredentialSource = (name: string, binding?: { baseURL?: string }) => Promise<string>

/** Builds the SDK model for a run. Production wraps the existing `sdkModel`; tests pass a mock. */
export type ModelFactory = (selection: ModelSelection, credentials: CredentialSource) => Promise<LanguageModel>

/** Builds the tool set available to a run. The coordinator still enforces scope per call. */
export type ToolFactory = (options: { search?: SearchConfig; credentials: CredentialSource }) => AgentTool[]

export interface Clock { now(): number }

/** Batched output of the runtime; the host forwards it to main. */
export interface RuntimeSink {
  events(events: AgentEvent[], runs: RunSummary[]): void
  /** Transient streaming text; may be dropped or coalesced freely. */
  partial(runId: string, step: number, text: string): void
}

/** The whole agent runtime as the host process sees it. */
export interface AgentRuntime {
  handle(command: HostCommand): Promise<unknown>
  /** Reports held reservations after bounded drain; void supports lightweight host/test adapters. */
  shutdown(): Promise<CancelAllResult | void>
}

export interface RuntimeDeps {
  /** Retained runs. */
  store: AgentStore
  /** Temporary runs (history off / retention 0); never touches disk. */
  memoryStore: AgentStore
  artifacts: ArtifactStore
  memoryArtifacts: ArtifactStore
  models: ModelFactory
  tools: ToolFactory
  credentials: CredentialSource
  sink: RuntimeSink
  clock?: Clock
  /** Event batching window; default one animation frame (16 ms). */
  flushMs?: number
  /** Profile-wide execution reservations, including non-quiescing cancelled work. Default 3. */
  maxActiveRuns?: number
}
