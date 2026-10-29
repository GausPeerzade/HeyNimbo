# HeyNimbo: from screen companion to local-first agent harness

**Status:** proposed architecture, revision 2 (after the Opus 5.5 review, `research/07-opus-5-5-review.md`, triaged in `research/08-opus-review-triage.md`). Implementation of the revised MVP has started; see `docs/agentic-roadmap.md` §“Revised MVP”. **Research date:** October 29, 2026. **Inspected baseline:** `4eb07b65b65013c64945f9727627969ef8960797`.

HeyNimbo should become a general-purpose, user-controlled desktop agent that can research, browse, work with applications, edit code, remember approved information and learn reusable procedures. Keep Electron, TypeScript, Rust, SQLite, the current provider adapters, and the speech-paced 2D/3D presentation system. Add an app-owned execution/control plane, thinly composed over the already-installed AI SDK; use one optional, isolated coding harness rather than rebuilding a complete coding agent. Start with a trustworthy local agent, then add authenticated app actions, learning, routines and a single-owner self-host mode. The model proposes actions; trusted code owns authority. Free software does not mean free hosted inference.

**Reading order:** this decision document → `docs/agentic-roadmap.md` for implementation tickets → supporting research below. Existing `docs/architecture.md` is an earlier intent document; it is not an inventory of implemented capabilities.

| Companion report | Contents |
|---|---|
| `research/01-clicky-product.md` | Current Clicky product, evidence boundaries, policies and historical-source distinction |
| `research/02-harness-options.md` | Hermes, Codex, Pi, OpenCode, AI SDK; pinned source and installed-package probes |
| `research/03-execution-and-safety.md` | Browser/MCP/sandbox/recovery/skills/memory trust boundaries |
| `research/04-codebase-assessment.md` | Definition-to-usage code tracing with repository line references |
| `research/05-verification.md` | Commands actually executed and limitations |
| `research/06-design-review.md` | Independent design-review findings and applied corrections |
| `research/07-opus-5-5-review.md`, `08-opus-review-triage.md` | Opus 5.5 review (verbatim) and our accept/qualify triage that produced revision 2 |

## 0. Revision 2 decisions (supersede conflicting text below)

Where later sections disagree with this list, this list wins.

1. **Explain stays in main, unchanged.** Main keeps sole ownership of `history.sqlite` (schema v2) and the whole Explain path (capture → answer stream → BeatParser → speech → overlay). The agent host never sits on that path: no await on host IPC, availability or its database; no router/memory/summary model call; no browser/engine startup. The v2 migration (old P0.8/P1.5) is off the critical path.
2. **Do runs in a lazy agent host with its own `agent.sqlite`.** The host is an Electron utility process started on the first Do request (zero RSS before that). One writer per file. Runs link to conversations by ID; cross-file deletion is a retryable cleanup with content-free tombstones, not a cross-database transaction.
3. **Explain/Do selection is explicit.** Explain is the default and makes exactly one answer-model request per turn. Do is chosen in the UI (or later a confirmable handoff card proposed by Explain). No classifier call.
4. **Information-flow rule from day one.** In the MVP a run is either *web* (search/fetch) or *local* (granted folders + artifacts). Mixing requires an explicit owner step that is recorded as an event. Egress policy applies to search queries, URL path/query, bodies and redirects, not only writes. Later relaxation uses destination+data policies, not URL provenance alone.
5. **Ownership:** the host owns policy and grant checks for its built-in tools (no extra IPC hop per tool call). Main owns the emergency stop and is the only parent of any restricted worker process; it can kill the host and workers without the host's cooperation. Main renders approvals from a host-computed digest and returns only the decision.
6. **Durability proportional to effects.** MVP persists runs, run events (approvals/decisions as events) and per-step message checkpoints. On restart an unfinished run becomes `interrupted` with Continue. The `effects` ledger, reconciliation queue, persisted capability grants and tool-installation registry arrive with the first external write (Phase 5), not before.
7. **One loop:** `streamText` with `stopWhen`/`prepareStep`, `toolCallConcurrency: 1`, abort plus an effect-boundary check inside every tool handler. SDK approval request/response is only the pause transport; the host's approval record is the enforcement point.
8. **Memory saves need real owner provenance.** An “explicit” save requires either the exact text in the owner's own turn or a one-tap confirmation card; anything proposed in a run that ingested untrusted content can only become a candidate.
9. **Coding engine is a spike decision.** Evaluate Pi (RPC, in-memory sessions, `beforeToolCall`) and direct Codex app-server on the same fixture corpus inside the proven containment boundary; ship one default. The engine port is shaped by those two real adapters, not frozen earlier.
10. **Containment, Codex and authenticated-browser spikes become entry gates of Phases 4/5**, not blockers of the read-only MVP. Probes must include macOS privacy-permission (TCC) attribution for workers and credential placement for the engine.
11. **Hot-path contract** (§8.1) is a release gate, measured against an S0 baseline rather than invented thresholds.
12. **No wholesale TalkSession refactor during the MVP.** Add a narrow facade (`stopNarration()`, `speakSummary(text)`) only when Do needs it; existing talk/overlay suites must pass with those files essentially unchanged.

## 1. Findings → design consequences

External claims below are supported by those reports and their fetched primary sources. Recommendations and proposed contracts are ours, not APIs promised by an upstream library.

| Finding | Evidence | Consequence |
|---|---|---|
| Text and voice currently share a bounded answer/presentation pipeline, not an executable tool loop. | Assessment §§2–3, 7; `apps/desktop/src/main/voice/talk.ts:184-258`; `apps/desktop/src/main/answer-provider.ts:43-73` | Extract orchestration; do not grow shell/browser execution inside `TalkSession.respond`. |
| Drawing/3D are already substantive reusable systems, including validated data, early geometry preparation and cancellation. | Assessment §9; `apps/desktop/src/shared/model-protocol.ts:3-9`; `apps/desktop/src/main/voice/talk.ts:191-202` | Keep the presentation plane and its tests; agents publish validated scene/presentation events. |
| Existing history is SQLite/FTS and six completed exchanges, not personal memory or a durable task journal. | `apps/desktop/src/main/history.ts:23-41,57-58` | Extend state deliberately; separate transcripts, checkpoints, effects, memory and procedures. |
| Clicky currently advertises browser/app delegation, connectors, persistent companions and routines; some previously launched skills/suggestions features are paused. | Clicky report: “Verified feature matrix” and “Current-state traps”; current changelog | Target delegated workflows, not a screen-reader clone or obsolete feature list. |
| The public MIT Clicky ancestor excludes newer private implementation. | Clicky report: “Gate B — reusable source, or only binaries?”; fetched original README/license | Reuse permitted historical ideas/code selectively; do not plan to import the current private product. |
| Installed `ai@7.0.156` already supports multi-step loops, approvals, context channels, streaming and experimental boundary steering. | Harness report §4; rerun local no-network probe | Reuse existing model plumbing. Own admission, durable state and effect enforcement. |
| Complete engines can save coding/session machinery, but introduce another provider/history/tool authority model. | Harness report §§5–9 | Keep engine-neutral product state; add one coding adapter behind a versioned port. |
| The inspected AI SDK Codex bridge disables native approvals/sandboxing in favor of outer containment. | Harness report §9; pinned driver | Do not launch that bridge on an unrestricted Mac. Prefer direct app-server integration when native approvals matter. |
| Browser sessions, shell scripts and MCP servers carry real authority; metadata is not a security boundary. | Execution report §§2–7 | Separate anonymous research, authenticated actions and untrusted execution; fail closed. |
| Crashes can leave a remote effect committed without a local receipt. | Execution report §8 | Record intent/receipt and surface `unknown`; never promise exactly-once arbitrary actions. |
| Saved procedures and memories can carry hostile instructions. | Execution report §9; Hermes memory/skills references in harness report §5 | Learn reviewable data, not new privileges; retain provenance and rollback. |

## 2. Principles and non-negotiables

1. **Local-first and independently usable:** no HeyNimbo account or hosted control plane required. BYOK and documented local-model endpoints remain first-class.
2. **User can always leave:** export conversations, artifacts, memory and skills in documented formats; connector revocation and complete local deletion are accessible.
3. **Preserve the differentiator:** voice, screen-aware help, drawing and 3D remain available without enabling computer control or coding tools.
4. **Safety in code, not model assurances:** a model, skill, webpage, repository or connector cannot grant itself a capability.
5. **Hide complexity, not risk:** show the account, destination, effect and scope of a consequential action before approval.
6. **Adapters at third-party boundaries:** provider, engine, search, browser, connector, sandbox and speech implementations are replaceable.
7. **One canonical task record:** app events/effects are authoritative for HeyNimbo; delegated engines retain their own native context, referenced explicitly rather than mirrored as conflicting truth.
8. **Inspectability without chain-of-thought disclosure:** show goals, tool activity, evidence, results and approvals; do not require raw private reasoning.
9. **No silent privacy expansion:** generic tasks do not automatically capture the screen, inherit browser cookies or turn off history/privacy preferences.
10. **No unmeasured universality:** model/provider/platform support is a tested capability matrix, not a selector implying equal performance.
11. **Small initial runtime:** no mandatory Python, vector database, Redis, Kubernetes, hosted agent service, workflow engine or VM farm.
12. **Learning is not weight training:** initial improvement means memory, versioned skills, evaluations and better tool selection. No automatic model retraining or self-modification of application source.

## 3. Product scope and interaction model

### 3.1 One assistant, explicit authority

These are UI intents over one runtime, not separate personalities or unrelated chat products.

| Intent | Behavior | Default authority |
|---|---|---|
| **Explain** | Existing screen-aware conversation, speech, pointers, handwritten cards and live 3D | User-initiated screen context; no action tools |
| **Do** | Research or execute a bounded task, show progress and artifacts, accept follow-ups | Explicit tool/resource grants; no ambient desktop/account access |
| **Code** | Work in an approved repository copy, run allowed checks, return a reviewable patch | Isolated workspace; no push/deploy or personal credentials |
| **Automate** | Create an inspectable recurring task after a successful interactive workflow | Explicit schedule, account scope, budget and expiry; later phase |

Example completed outcomes:
- Compare documentation for three libraries and produce a cited recommendation with saved source evidence.
- Find relevant messages, draft a response, show the exact account/recipient/content, then send only after approval and verify the result.
- Fix a bug in an approved repository, run its checks, present the diff and test output without pushing.
- Explain an engine with the existing spoken 3D cutaway while keeping unrelated background research running.
- Remember an explicit preference, or propose a reusable skill after a successful task; let the owner inspect and remove it.

### 3.2 First agent MVP and later scope

**First agent MVP (through Phase 2):** text/voice task submission; typed run state; multiple tool steps; public research; scoped file reading; saved artifacts; explicit permission denials/approvals; cancellation; restart reconciliation; original Explain mode preserved.

**Broader daily-use release (through Phase 5):** reviewed memory and skills, one coding-engine integration, consented browser sessions, MCP plus a small connector set, external-write previews/readback.

**Later:** native desktop actuation, scheduled/background workers, bounded subagents, optional self-hosted control plane and Windows/Linux native support.

**Out of the initial MVP:** arbitrary downloaded plugins, app-store marketplace, automatic skill execution, unattended checkout, system administration, autonomous deployments, multi-user tenancy, synchronized credentials, mobile clients, guaranteed background work after the local app quits, fine-tuning and autonomous source-code self-updates.

## 4. Architecture and trust boundaries

```text
                          OWNER'S DEVICE
  Sandboxed Electron renderers
  Home/task timeline | approvals | memory/skills | notch | overlay | audio
                              |
                  narrow validated IPC / events
                              v
  Trusted Electron main (Explain path + history.sqlite stay here)
  - sender/account/resource validation; approval UI from host digests
  - existing secret store; capture/OS permission mediation
  - renderer projection; global stop; sole parent of host and workers
                |                         |
       authenticated local IPC     narrow privileged adapters
                v                         v
  Lazy agent-host utility         Native Rust / browser helper /
  process (not an OS sandbox)     scoped connector request broker
  - run admission/coordinator      (deliberately privileged code)
  - agent.sqlite writer; policy for          |
    its own built-in tools                   |
  - context, memory, skills                  | validated effects
  - selected provider SDK calls              v
  - engine adapters + event journal     OS / browser / application API
                |
       supervisor-controlled execution
                v
  Restricted per-run workers / optional coding engine
  - approved workspace + minimal runtime mounts
  - restricted network/environment/processes
  - no personal profiles, raw broker ports or inherited host secrets
                |
      optional approved inference/search/connector services
```

**Trust model:** Electron main, the packaged agent host, built-in provider adapters, broker, native addon and authenticated browser/connector helpers are trusted application code. A utility process improves responsiveness and crash separation; it is **not** a security sandbox. Only separately contained workers execute repository scripts, skill scripts, imported plugins or local MCP servers. Never `eval` or import those into a trusted process.

Provider credentials remain owner-controlled in the existing main-owned encrypted store. A selected credential may be resolved into the trusted provider adapter's memory for its authorized request; it is not model context, public run state or a worker environment variable. Connector SDKs that require a raw token are privileged adapters, not secretly isolated tools. Authenticated browser state stays in its dedicated local helper. The Rust bridge gains narrow actuation primitives only in its later phase; today's input observer is not a controller.

The local broker can refuse access, but cannot undo a message accepted by a server. A remote inference provider necessarily receives selected prompt/context data. Local storage does not imply local inference, and encrypted credential storage does not encrypt transcripts. Trust and data disclosures must say these things plainly.

### 4.1 Process rollout, not a process explosion

Introduce **one** trusted agent-host process, started lazily on the first Do request. It owns the agent runtime and `agent.sqlite`; main keeps windows, secrets, `history.sqlite`, Explain, UI-mediated grants, native services and the kill authority over the host and any worker. Use anonymous inherited pipes/MessagePorts with peer/run binding, not an unauthenticated localhost server. A worker/engine has a different restricted channel from the trusted host and cannot invoke main's general IPC API.

A browser helper and restricted coding worker start lazily. No resident pool when idle. A headless launcher can reuse the agent-host package later without importing Electron.

## 5. Stack and reuse decisions

| Layer | Decision | Why / alternative rejected |
|---|---|---|
| Desktop | Keep Electron and existing DOM/CSS/preloads | Rewriting in Swift/Tauri does not supply agent semantics and risks working overlays/audio. |
| Native OS | Keep Rust N-API; extend per platform | Existing input/capture/speech code is reusable; do not rewrite the loop in Rust just because Codex uses it. |
| Model/provider abstraction | Keep pinned AI SDK and existing adapters | Already integrated; provider/auth/vision/billing tests matter. No required Vercel hosted service. |
| General agent loop | `streamText` with `stopWhen`/`prepareStep`, `toolCallConcurrency: 1` (revision 2) | Same primitive the existing answer adapter uses; `ToolLoopAgent` is only a wrapper. Effect checks live inside tool handlers either way. |
| Persistent state | Keep SQLite + FTS5; one writer per file: main owns `history.sqlite`, host owns `agent.sqlite` | No server database/vector store needed initially. Separate retrieval from prompt injection. |
| Coding engine | Spike Pi (RPC) and direct Codex app-server on one fixture corpus inside the proven boundary; ship one default | Pi fits BYOK/local providers and save-off sessions; Codex has rich native approvals for OpenAI users. Credential placement (destination-bound adapter vs raw key) is part of the spike. |
| Hermes | Reference memory/skills/context/runtime patterns; optional managed sidecar later | Viable full generalist but brings Python distribution and dual state/provider ownership. Not a required dependency of HeyNimbo. |
| OpenCode | Keep as evaluated alternative, not a parallel mandatory engine | New embedded SDK is real; package/source generation and Electron integration still need a spike. |
| AI SDK `HarnessAgent` | Optional later adapter detail | Experimental separate packages; normalized streams do not preserve/enforce all native permissions. |
| Browser | Playwright mechanics with HeyNimbo-owned structured browser tools | Do not build a browser engine. A generic MCP browser endpoint is not our security policy. |
| App integrations | Pinned MCP client plus a few native typed adapters | Reuse protocol/auth plumbing, not untrusted permission annotations. |
| Skills | Agent Skills-compatible Markdown/resources | Reuse interchange format. No Python runtime solely to parse skills. |
| Isolation | Test a native command-wrapper adapter; offer isolated container/VM fallback | No custom sandbox kernel. Unsupported policy means unavailable execution, not host fallback. |
| Durability framework | Do not add one initially | `WorkflowAgent` is a separate runtime integration, not durability obtained by installing `ai`. Own action receipts regardless of future workflow library. |

Sources and exact revisions: harness report §§3–12 and execution report §11. Software-license observations there are not permission to reuse provider subscription tokens. Review notices and dependency licenses for exact shipped artifacts before redistribution.

### Why not simply make this a Hermes skin?

That is viable if the product decision is to adopt Hermes as the authoritative runtime. It would buy mature general-agent behavior earlier, but it would not remove the desktop broker, browser authority, presentation migration, packaging, recovery and privacy work. It would also introduce Python and a second configuration/session system alongside already-working provider integration. For this codebase, incremental thin composition is the preferred baseline. Revisit only if the first vertical slice shows materially more custom runtime work than predicted; do not rewrite for ideological stack uniformity.

## 6. Domain model and persistence

### 6.1 Identities and state ownership

- **Profile:** local owner namespace; credentials/settings/skills/memory cannot bleed into another profile.
- **Workspace:** explicitly chosen root or isolated copy, revision identity, execution policy and artifact scope.
- **Conversation/turn:** user-visible interaction and presentation; a turn may launch or steer a run.
- **Run:** unit of requested work with independent lifetime, an explicit persistence policy and optional native engine session ID; durable only when retained mode permits it.
- **Step:** one model/tool coordination boundary. Retry attempts are explicit, not overwritten.
- **Tool installation:** trusted built-in or pinned external identity, schema digest, version and declared requirements.
- **Invocation/effect:** immutable requested operation, attempt, approval/grant reference and receipt/status.
- **Memory entry:** scoped fact/preference with source/trust/expiry/deletion state.
- **Skill revision:** versioned procedure/resources, provenance, tests and approval state.
- **Artifact:** immutable content reference plus media type, sensitivity, provenance and export rules.
- **Routine:** schedule/policy template; each occurrence creates its own run and occurrence key.

### 6.2 Proposed state rules

Run transitions: `queued → running → waiting_approval | waiting_user → running → succeeded | failed | cancelled | interrupted | needs_reconciliation`. In the MVP (read-only tools) a run that was not terminal at restart becomes `interrupted` and may be continued by the owner from its last checkpoint; `needs_reconciliation` appears only once external writes exist. A restored run is never automatically called running or successful. `needs_reconciliation` blocks further dependent effects until unknown outcomes are resolved. A cancelled run can retain an unresolved effect flag; cancellation is not a clean rollback.

Effect transitions: `prepared → awaiting_approval → authorized → dispatching → succeeded | failed | unknown`. Cancellation/revocation is a separate record. Reads may be repeatable only when the adapter contract says so; an HTTP GET is not universally effect-free.

Events have a unique event ID and monotonic sequence **within a run**. A unique operation/attempt ID deduplicates local dispatch; external idempotency is available only when the provider supports it. Use integer token counts and integer minor currency units/microunits with recorded currency and price version; unknown model cost remains unknown, not zero. Store raw token usage alongside estimates.

### 6.3 Abbreviated planned schema

The following is a design inventory, not executable migration SQL:

| Table | Key fields / constraints |
|---|---|
| Existing `conversations`, `turns`, FTS | Keep IDs, text, provider attribution and scene compatibility; add stable run linkage where needed |
| `workspaces` | profile, root identity, base revision, isolation adapter/config digest |
| `runs` | conversation/turn/profile/workspace, goal, engine/session IDs, persistence/retention/deletion policy, typed status, cancellation epoch, budget, next event sequence |
| `run_events` | `(run_id, seq)` unique, event ID unique, version, typed payload/reference, timestamp |
| `step_checkpoints` | run/step/attempt unique, provider/model, ordered messages/tool references, context-policy revision |
| `tool_installations` | installation ID, origin, version, artifact/schema digests, review state |
| `capability_grants` | actor/run, operation/resources/account, scope, expiry, revocation epoch |
| `approvals` | exact normalized operation digest, account/target, nonce, expiry, decision, consumed-attempt |
| `effects` | unique operation ID, attempt, immutable input reference, state, idempotency key, receipt, unknown reason |
| `artifacts` | content hash, media type, byte size, sensitivity, retention owner, approved export destinations |
| `memory_entries` | scope, content, source event/explicit user statement, trust class, expiry, revision, tombstone |
| `skill_revisions` | skill/scope/revision, content/resource digests, source, replay results, promotion state |
| `routine_occurrences` | routine + scheduled occurrence unique, run ID, lease, outcome |

**Storage decision (revision 2):** `history.sqlite` (schema v2) stays main-owned and unchanged for Explain. Agent tables live in a separate host-owned `agent.sqlite`; `runs` carries an optional conversation ID for linkage. Deleting a conversation or applying retention enqueues a retryable host cleanup; tombstones are content-free. A future consolidation, if ever needed, follows measurements and a fixture-proven backup/migration/restore. Rows above marked for `effects`, `capability_grants`, `approvals` persistence, `tool_installations` and `routine_occurrences` are Phase 5+ inventory, not MVP tables.

Append-only event history means immutable **while retained**, not forever. User deletion/retention purges associated events, checkpoints, derived memory/indexes and artifacts according to disclosed policy. Minimal tombstones may prevent reimport/rehydration; they must not contain deleted content.

**Run-level persistence contract:** derive temporary mode from either `saveHistory = false` **or** `retention = 0`, preserving the current behavior. Before accepting input, every storage-owning adapter receives the run's mode, retention deadline, deletion generation and any separately approved minimal effect-ledger exception. This includes native engine sessions/homes, caches, browser traces, delegated workers and remote server journals. Retained-mode expiry/deletion must purge or invalidate native resume data as well as HeyNimbo records, with retryable cleanup status; an engine cannot restore deleted data into a new run. If an engine/server cannot honor the policy, disable that path or ask for an explicit retained-run opt-in—never silently save. Disposable homes and cleanup alone are not proof of no on-disk history or forensic erasure. Owner-requested output files and separately saved account credentials have their own explicit lifetimes.

**Temporary/no-save runs:** use in-memory context, approvals and effects plus ephemeral artifacts; no hidden disk checkpoints, learned candidates or recoverable background jobs. Consequential non-idempotent external writes are unavailable unless the owner separately opts into a clearly disclosed minimal durable effect ledger for that run; otherwise a crash cannot be reconciled reliably. Turning history off is not permission to erase an in-flight effect record or replay uncertain work. Explicitly saving a personal memory is a separate visible persistent action, never an inferred exception to no-save mode.

## 7. Execution services, contracts and tool design

### 7.1 App-owned engine port

Design a small internal versioned port for capabilities, start/resume, user input, steering, interrupt, approval resolution, event subscription and disposal. Negotiate images/tools/steering/native approvals/resume support. These are HeyNimbo interface requirements, not a claim that every engine has matching method names.

Keep native engine IDs and request IDs in event metadata. Preserve request/response approval semantics rather than flattening everything into text. Distinguish steering **queued**, **delivered**, **rejected** and **undelivered**. Persist steering as a user event before handing it off; the installed SDK's returned message array alone is not a complete steering journal (harness report §4).

Only the coordinator marks a run terminal after required tool receipts/artifacts are settled. An engine saying “done”, an idle event, completed TTS, or EOF is insufficient on its own.

### 7.2 Tool registry and broker dispatch

A tool describes ID/version/schema, typed output, effect class, required resources, timeout/output limits and executable handler identity. External tool metadata is a claim; broker classification is authoritative. Discovery lists are compact; load detailed schemas for a selected stable toolset at task boundaries rather than dumping all connectors into every prompt.

Dispatch path:
1. Authenticate actor/run; validate schema and normalize arguments.
2. Resolve workspace/account/origin and check resource freshness.
3. Persist immutable intent and inspect policy/budget/cancellation.
4. Obtain exact, expiring approval if required.
5. Immediately before effect: revalidate authority and consume approval into the recorded attempt.
6. Execute through the trusted narrow adapter or restricted worker.
7. Persist receipt/error/unknown; publish bounded provenance-bearing result.
8. Read back consequential external state before claiming completion.

For app-owned effects this dispatch sequence is enforced per operation. Native coding operations that cannot be intercepted before execution use the explicitly coarser delegation-attempt boundary in §10.3; post-execution notifications do not satisfy a pre-dispatch guarantee.

Deny is a normal tool result, never a reason to try another unrestricted executor. Broker outage is deny. Tools cannot create grant records. SDK approval hooks are useful interaction plumbing, not the final enforcement boundary.

### 7.3 Core modules

| Module | Responsibility |
|---|---|
| Coordinator | Run/step lifecycle, budgets, admission, concurrency, steering and recovery |
| Provider adapter | Current model clients, capability tests, stream terminal handling and sanitized errors |
| Context service | Scoped retrieval, bounded tool outputs, summaries and checkpoint reconstruction |
| Tool catalog | Schema/version discovery and installation identity |
| Capability broker | Grants, argument-bound approvals, account/resource identity and revocation |
| Execution supervisor | Restricted worker launch, environment/mount/network policy, process ownership and cleanup |
| Browser service | Separate anonymous/authenticated sessions, structured observations/actions, quarantine downloads |
| Connector service | MCP/native adapter lifecycle, auth/account binding, draft/commit/readback |
| Memory/skills service | Retrieval, candidate creation, review/promotion, revisions, export and forgetting |
| Presentation adapter | Speech summaries, current scene protocol, playback and screen-context mapping |
| Artifact service | Immutable blobs, limits, sensitivity, safe preview and export |
| Evaluation runner | Deterministic tools, regression workflows, prompt-injection cases and crash fixtures |

### 7.4 Minimal initial tools; later expansion

- First: ask-user; scoped read/search files; public search/fetch with citations; write an artifact; inspect task status. Writes to the user repository are not implied by permission to save an artifact.
- Coding: isolated read/edit/search/test/diff; optional coding-engine delegation. No push/deploy/global installation by default.
- Browser: open/observe/navigate, semantically targeted actions and safe downloads; authenticated capabilities are separate from public research.
- Apps: search/read/draft, then approve/commit/readback; explicit account labels throughout.
- Knowledge: search sessions/memory, propose memory changes, list/read/propose skills. No memory tool can modify policy.
- Presentation: validated `say`, beat/scene publication, point/draw/model; never shell instructions hidden in `@` drawing lines.
- Later: native accessibility observe/act, scheduling, bounded subagent delegation and app-specific skills.

## 8. Preserving and evolving voice, screen, drawing and 3D

The existing `TalkSession` mixes input, capture, answer generation, history, speech and scene timing. Split responsibilities incrementally:
- **Input adapter:** hold-to-talk/typed request → user input and explicit screen-context attachment.
- **Answer/run service:** Explain or Do/Code orchestration → typed task/presentation events.
- **Presentation controller:** sentence/mark scheduling → existing ears/mouth/audio and overlay facade.

Keep `BeatParser`, `Mark`, model limits, geometry, scene ownership and playback clocks. Preserve one explanation model/stream for speech+2D+3D by default; do not introduce a separate 3D “agent” merely for architectural symmetry. Continue preparing geometry before its sentence reveals it. Do not parse arbitrary research results or tool stdout as scene commands; only an explicitly validated presentation channel may draw.

General task answers may contain Markdown, code, citations and files. The existing voice prompt bans these for speech, so **do not use that prompt for the general agent**. Produce a rich task transcript and a concise optional spoken summary. Never read raw shell output or an entire research report aloud by default.

### 8.1 Hot-path contract (release gate)

Never on the Explain critical path: an await on the agent host; any extra model call; memory/skill retrieval unless precomputed and frozen; changes to the cached instruction prefix; run-event fan-out to overlays; synchronous disk writes larger than one row per sentence; browser/engine startup; anything delaying `capture()` at hold time. Agent traffic: host → main in coalesced batches (≤ one per animation frame; progress coalesces to latest, approval/terminal events are never dropped); main → Home as paginated deltas, not full snapshots. Token deltas are never persisted individually; step text persists at step end plus a coalesced partial ≥ 1 s.

Measurement matrix: S0 idle baseline, S1 one research run, S2 three runs plus a 5 MB extraction, S3 host frozen/killed, S4 temporary mode, S5 cold launch. Metrics: release→transcript/first token/first audio, first 3D prepare→draw, draw vs `startsInMs` skew, overlay frame p95/max, main event-loop delay p99, RSS per process, stop→quiescence by process listing. Gates: S1–S3 Explain medians within a small measured margin of S0; zero extra provider requests per Explain turn; Explain unaffected in S3; host RSS zero before the first Do run.

Explain retains its user-initiated screenshot behavior and no-image fallback. Generic Do/Code starts with no screen unless the owner attaches it or grants a visible scoped capture session. In a new desktop-control session, tag observations with capture/display/document generation; recapture/revalidate before actions instead of trusting stale coordinates.

One foreground narration/overlay owner initially; background tasks return artifacts and notifications, not competing screen marks. New voice input may stop current narration while background tasks continue. **Stop task** cancels the selected run; **Stop all** revokes all active local runs. Existing Explain interruption remains unchanged. Do not falsely show “task complete” because audio drained, or “task cancelled” merely because speech stopped.

For headless runs, screen coordinates have no target. Save the same declarative 3D/diagram data as artifacts and show it later in a standalone canvas; do not invent a screenshot to make 3D available.

## 9. Context, memory, skills and learning

### 9.1 Four different persistence needs

| Layer | Purpose | Visibility/lifetime |
|---|---|---|
| Working context/checkpoint | Current goal, tool observations, pending decisions | Run-scoped; bounded and reconstructable |
| Episodic history | What happened and what sources/results were used | Searchable sessions; retention applies |
| Semantic memory | Approved stable preferences/facts about owner/project | Editable, scoped, expiring where appropriate |
| Procedural skills | How to repeat a workflow | Versioned Markdown/resources with evidence and review |

Start with SQLite FTS for memory/history and file-backed skill resources plus indexed metadata. Add embeddings only after an evaluation shows retrieval failures that lexical search and better indexing do not solve. An external memory service is an adapter, not a requirement.

Context assembly: stable identity/tool guidance → explicit project rules → selected task authority summary → compact relevant memories/skill index → recent conversation and bounded sourced observations. Policy remains outside the prompt. Hold the system prefix stable during a run; load skills/tool results as scoped additions and version changes at clear boundaries. Budget model-specific context and reserve room for tool results/output.

Compaction must preserve user goals, unresolved approvals/effect IDs, exact references and source/trust labels. Do not summarize a hostile page instruction into a higher-trust user preference. Persist both a compact checkpoint and references to retained raw records; no need to reinsert all logs into the prompt.

### 9.2 Safe memory path

Explicit “remember this preference” can authorize the exact bounded memory write only when the text comes from the owner's own turn or is confirmed on a one-tap card showing it; a model claim that the user asked is not authorization, and writes proposed in a run that ingested untrusted content are candidates only. Inferred facts, tool observations and summaries start as candidates, not globally injected truths. Track source event, owner/workspace/account namespace, trust class, timestamps, confidence/verification status and revision. Memory does not contain passwords/tokens and cannot widen permissions.

Provide inspect/edit/forget/export UI. Forgetting invalidates FTS/embeddings/caches and prevents later summaries from restoring the deleted content. Explain what remains in existing conversation logs/backups and offer their separate deletion. A routine may not quietly extract personal memory from every open app.

### 9.3 Agent Skills-compatible procedures

Use `SKILL.md` frontmatter/body with optional `references/`, `scripts/` and `assets/`; index short descriptions and load full relevant content on demand. Support global owner-installed and workspace-scoped skills. Workspace skills/project rules are untrusted until the project is trusted; automatic discovery must not execute code.

Lifecycle: **observed workflow → candidate → replay/evaluation → owner-reviewed active revision → usage feedback → improved candidate or archived revision**. Preserve source/license and previous versions. Learning may propose better steps after a failure; it may not silently rewrite trusted skills or enable scripts. `allowed-tools` metadata is informative, not authorization (execution report §9).

Success criteria for an early learned skill: it reproduces the intended workflow on a disposable fixture, uses fewer unnecessary steps than the no-skill baseline where measurable, and never increases granted authority. Record completion/cost/latency separately; one success does not prove broad reliability. Background curation comes later, bounded by the same privacy/cost policy.

## 10. Browser, apps and coding

### 10.1 Three browser modes

1. **Public research:** ephemeral profile, no user cookies, deny private-network/file targets, quarantine downloads, provenance-bearing extraction. A search provider is swappable; a free app may offer direct fetching but cannot promise a free reliable web-search service.
2. **Authenticated local work:** dedicated automation profile, owner signs in directly, visible expiring account/origin scope. Trusted helper keeps CDP/storage private; worker receives narrow observations/actions, not raw browser Python/JS, cookie export or arbitrary debugger access.
3. **Remote research later:** ephemeral server profile with its own identity. Do not upload local cookies or assume a remote worker can access local signed-in sites.

Playwright is reused for mechanics; current browser-profile/debugging and sandbox caveats are documented in execution report §4. Browser reads can contain private data and browser navigation can have effects. Consequential clicks need action-level policy; DOM matching does not prove a hostile site will honor the displayed action. Prefer a scoped API for sensitive sends/deletes/purchases, or require human completion. CAPTCHA, password, 2FA and payment details remain owner handoffs.

### 10.2 Connectors and MCP

Start with one high-value read/draft workflow and one approved external write, not dozens of shallow integrations. MCP discovery/auth does not authorize tool execution. Pin the actual supported protocol/SDK revision; the current fetched specification is 2026-07-28 and differs from older session/resumption designs (execution report §5). Feature-detect and explicitly test any older-server adapter.

Local MCP executables are executable dependencies: pinned, minimal environment, contained where untrusted. Remote endpoints need authenticated account binding, scope review and destination validation. Inspect tool/schema changes; invalidate grants when effective authority changes. Do not allow a server's sampling, elicitation or resource requests to call arbitrary local capabilities.

Separate model-provider login from Gmail/Notion/etc. login, and label multiple accounts. Do not reuse answer OAuth grants as connector or Codex credentials. Existing ChatGPT plan access is not a generic proxy or blanket background-automation authorization; retain the repository's current restrictions until current official terms and technical scope are explicitly revalidated.

### 10.3 Coding without rebuilding a coding product

The first full coding adapter is chosen by the Phase 4 spike between Pi (RPC) and direct pinned Codex app-server, each with a dedicated config/home/workspace, bounded environment and a proven credential placement: repository scripts in the same boundary must not be able to read a real provider key (candidate: destination/run-bound injecting adapter outside the boundary). Preserve native approval requests, steer/interrupt IDs and native session references. Host-defined desktop/app tools still pass our broker; native shell tools must be actually contained. Do not infer full existing AI SDK provider parity from Codex's provider selector.

**Native execution durability:** a coding run's only exported effect is a reviewed patch, so a crash marks the delegation `interrupted`, preserves the disposable workspace and allows Continue after inspection; it becomes `unknown` only when an effect could have left the boundary. Journal a contained coding delegation attempt as one app-level operation before launching it. Native shell/file actions remain inside the approved disposable workspace/network policy; do not pretend every internal command passes our broker or is individually journaled first. Retain native command/receipt identifiers and checkpoints as subordinate evidence under the run's persistence policy. If the engine/host crashes or disconnects after a command may have run but before settlement, mark the delegation `unknown`, inspect workspace/process/native receipts, and prohibit automatic native resume/re-execution until reconciliation. A future adapter may provide finer pre-dispatch mediation only after proving it with crash tests. App-visible file application, credentials and external desktop/API effects still require separate broker operations.

Native session persistence, retention and cleanup must implement §6.3. Save-off/retention-zero tasks cannot use an engine that secretly persists resumable transcripts; if its storage policy cannot comply, that coding path is unavailable until explicit retained-run consent.

Use a disposable repository copy first. A worktree shares Git metadata and is not containment. Dependency installs, tests and build scripts are arbitrary code, not safe merely because the requested task is coding. Keep host SSH/Git/package credentials, `.env`, browser profiles and Docker sockets out. Return a patch plus executed-check output; apply to the real workspace only through reviewed, revision-bound file changes. No automatic commits, pushes, deploys or secrets access.

If Codex cannot serve a required provider/use case under the validated boundary, choose Pi as the alternative adapter after the same contract tests; do not ship two competing defaults. The app-owned tools can still perform small edits, but advanced coding ergonomics should be reused, not recreated wholesale.

## 11. Algorithms, budgets, recovery and security gates

### 11.1 Budgets and concurrency

For MVP Do runs, wall time is budgeted per start/Continue activation (downtime is excluded); step, token and tool-output budgets remain cumulative across checkpoints.

At run admission, reserve finite steps, tokens/cost, wall time, tool output and artifact bytes. Check before each model/tool call and reconcile reported usage afterward. Unknown prices use token/time limits plus a visible unknown cost; a monetary estimate cannot guarantee an exact provider charge. No automatic fallback from an exhausted plan/local model to a paid key.

Initial concurrency: one active mutating operation per workspace/account/browser session; public read/research jobs may run concurrently under one aggregate profile budget. Native desktop control is exclusive. Add parent/child run budgets and inherited capability subsets before enabling subagents. Never recursively delegate without a depth/concurrency ceiling.

### 11.2 Approval binding

Bind the exact operation to actor/run, installation/schema digest, canonical args/content digest, workspace/resource identity, account, endpoint/origin/document, spend limit, expiry and single-use nonce. Show a readable preview from the broker, not tool-authored approval HTML. Changed inputs or account/document require a new decision. Bounded session grants list allowed operations/resources; they are not “allow everything for this agent”.

For file operations reject traversal/symlink escapes and use race-resistant handles or final identity checks. Shell strings/package scripts cannot be made safe by command-prefix matching; containment is the boundary. Check cancelled/revoked generations immediately before an effect, including delayed SDK callbacks.

### 11.3 Recovery and the unknown-effect gap

- Persist intent and authorization before dispatch; persist result/receipt after dispatch.
- Crash before dispatch: revalidate authority/expiry before attempting work.
- Crash after dispatch without receipt: `unknown`; query provider status or safely retry using its supported idempotency key.
- No status/idempotency API: request reconciliation; do not repeat browser clicks, sends, purchases or arbitrary shell commands automatically.
- Confirmed success: return the stored result and verify external state where appropriate; do not re-execute on UI reconnect.
- UI replay replays **events**, not executable actions. Tool results remain immutable references.

### 11.4 Stop is an execution operation

The main-owned emergency shortcut is `Command+Option+Shift+.` (no Control, so no intermediate chord triggers Explain hold-to-talk or dictate).

Revoke capabilities first; stop new dispatch; abort model requests; invalidate approvals; close browser work; terminate supervised processes with bounded escalation; verify/reap descendants. A sent signal or `AbortSignal` alone is not proof of termination. Detached descendants and macOS packaged containment are explicit Phase 0 blockers. If containment cannot be proven, disable untrusted local code and offer a properly isolated fallback—never quietly run it on the host.

Already committed remote actions remain committed or uncertain. Say what was stopped and what may already have happened. A “Stop all” button and an always-available emergency shortcut must work independently of the agent loop and current window focus. Implement the main-owned revocation/supervisor path in **Phase 2 before coding or authenticated writes**, and test it while another app is focused and the agent host is unresponsive. Phase 6 adds native input-state release and human-takeover semantics; it does not introduce the first emergency stop.

### 11.5 Release gates

- Zero unauthorized effects in the deterministic broker/sandbox test corpus; completion quality reported separately.
- Reject forged/stale/changed approvals, tool-schema changes, confused accounts and broker outage.
- Deny home/secret/profile reads, unsafe descriptors/sockets, private-network egress, path escapes and orphan execution under claimed restricted modes.
- Redact structured errors/logs; plain text by default; safely sandbox HTML/artifact previews without privileged IPC.
- Exercise prompt injection through pages, tool metadata, project rules, skill updates and memory. Existing model/scene tests alone do not cover these.
- Test crash edges and cancellation under each engine/OS update; no “safe by default” claim from a benchmark alone.
- Signed/notarized binaries and native helpers, dependency notices, update integrity/rollback, privacy terms and exact provider/OAuth rights are release blockers, not a final polish ticket.

## 12. Frontend evolution and repository layout

Do not redesign every screen first. Add a task timeline beside the existing conversation, then approval cards, artifact previews and a run inspector. Keep the notch as a concise foreground/progress/attention surface, not the full agent workbench. Add Memory, Skills and Automations as inspectable management screens only when the underlying lifecycle exists.

Use typed states rather than deriving `busy` from English labels (`apps/desktop/src/main/app-shell.ts:93`). Paginate transcripts/events, stream bounded deltas, coalesce projection updates and keep large artifacts outside UI snapshots. Load browser/coding/3D resources lazily; retain the existing prewarmed scene strategy within its measured idle budget. Keep keyboard/reduced-motion/accessibility flows and no-voice operation.

Proposed layout, introduced only as the phases need it:

```text
apps/desktop/                  existing shell/renderers/preloads/native bridge
packages/agent-protocol/        versioned commands/events/schema validation
packages/agent-core/            coordinator, context, tools, state, memory, skills
packages/agent-host/            trusted Node host, SQLite ownership, engine supervision
packages/agent-engines/         AI SDK default, then one optional coding adapter
packages/agent-tools/           trusted built-ins + narrow broker clients
packages/agent-evals/           deterministic fixtures and workflow regressions
crates/heynimbo-native/         existing OS services; future narrow actuation
skills/                        reviewed bundled inert procedures/resources
research/                      research reports + source/probe audit records
docs/agentic-roadmap.md         ordered implementation tasks and gates
```

Avoid empty framework packages. First extract a protocol/core boundary from the current main code; split further when an independently tested responsibility exists. Do not rename working app paths merely to match this proposed tree.

## 13. Operations and self-hosting

**Local baseline:** app open means local runs/routines can proceed; app quit or machine asleep means no promise of continued work. No mandatory server, external queue or telemetry. Content-free diagnostics opt in; logs have retention/size limits and exclude credentials. Track cold start/idle RSS, first task event, time-to-first-speech/3D, tool latency, completion, approval waits, cost and cancel-to-quiescence. Establish measured budgets in Phase 0 before setting numeric performance promises.

**Single-owner self-host later:** run the same headless coordinator/journal/public-research workers on an owner-controlled machine. Start with one writer/server and SQLite on a local filesystem, not multiple replicas against a shared database. Desktop attaches as an authenticated client and separately grants local execution. Server credentials are independently authorized; local provider plan tokens, browser state, Keychain data and OS permissions are not synchronized.

When remote mode is selected, that server owns the run journal; the desktop has a local projection and its own effect receipts, not another conflicting canonical run DB. Offline local runs remain local; do not invent transparent merge/resume across different execution identities. Local effects bind remote user/device/run/operation digests, require local approval, and return receipts. Device revocation immediately blocks new requests. Server outage yields unavailable/reconciling, not an unrestricted local fallback.

Remote run admission must enforce the same persistence contract before receiving task content. Temporary mode requires no retained server/native-engine checkpoints or logs; if unavailable, refuse the remote run. Retention/deletion must cover server journals, artifacts, native sessions, local projections and backup policy, with acknowledgments and visible pending cleanup rather than a false instantaneous-erasure claim. An offline/revoked device must not resurrect deleted state on reconnect; deletion generations/tombstones invalidate stale replicas without retaining their deleted content.

Start with an outbound authenticated encrypted local connection, no public CDP/shell port. Public anonymous research can be remote; local screen/input/files/cookie-bearing browser stay local unless individually authorized. Multi-user hosting, worker pools, credential sync and production HA are a separate future architecture and threat-model exercise.

**Cost:** software is free/open source; local hardware/electricity, optional model/search APIs and an optional self-host machine are owner expenses. Do not quote a fabricated monthly operating price or promise local models match frontier tool reliability. Provide actual per-run usage and budget controls first.

## 14. Build sequence and decision gates

Full agent-sized tasks and acceptance checks are in `docs/agentic-roadmap.md`.

| Phase | Shippable outcome | Gate before widening authority |
|---|---|---|
| MVP (revised P0–P2, ~12 tasks) | Lazy host + `agent.sqlite`, `streamText` loop, scoped files/artifacts, web search/fetch with egress rule, approvals as events, global stop, timeline, temporary mode | Explain unchanged incl. host-down; zero unauthorized/egress fixture effects; interrupted runs continue without duplication |
| 3 — Memory + skills | Inspectable scoped memory, skill import/use and reviewed learning | Poisoning/forgetting/replay and permission non-escalation tests pass |
| 4 — Coding | One isolated coding-engine adapter and reviewed patches/check output | No host escape, correct native/host approvals, real disposable-repo verification |
| 5 — Browser + apps | Authenticated browser and a few connectors with draft/approve/commit/readback | Account/origin/target-bound authority and cancellation/privacy checks |
| 6 — Native hands + routines | Scoped desktop observe/act and reliable bounded scheduled work | Stale-screen/takeover tests; occurrence dedupe, sleep/offline/restart behavior |
| 7 — Delegation + self-host | Bounded children and optional single-owner headless server | Shared-budget/subset grants, device revocation and no secret/cookie synchronization |
| 8 — Distribution/platforms | Reproducible OSS release and additional native OS adapters | Clean-machine packaging, signing/update and per-platform capability evidence |

Browser public-research mechanics arrive in Phase 2; Phase 5 is authenticated authority, not the first ability to browse. Basic memory/skill **interfaces** belong in Phase 1/2, with real learning in Phase 3. Coding/browser spikes happen in Phase 0 to avoid discovering a fatal boundary problem after building the UI.

Do not assign calendar estimates before Phase 0 establishes packaged isolation, engine-contract and migration costs. This is an ordered acceptance-gated plan, not a claim that a full Hermes/Clicky-equivalent is a weekend project.

## 15. Open decisions and owners

Roles below are responsibilities for the maintainer/team, not assertions that a staffed team exists.

| Question | Owner | Resolve by / fallback |
|---|---|---|
| Can the native macOS worker actually deny sensitive reads/egress and contain descendants in a packaged app? | Native/security maintainer | Phase 0; otherwise isolated VM/container or disable untrusted local execution |
| Does ToolLoopAgent support required intent/checkpoint ordering without hidden execution? | Runtime maintainer | Phase 0; controlled single-step `streamText` behind same port |
| Can direct Codex provide required provider/auth/tool behavior under our boundary? | Runtime maintainer | Phase 0/4; choose Pi once if not, no dual mandatory engine |
| Which two workflows define the first app-connector release? | Product owner | Before Phase 5; choose by user value and safe API/readback availability |
| Do current ChatGPT grants authorize each proposed tool/background/self-host operation? | Maintainer/provider-terms review | Before enabling that path; BYOK/local remains baseline, never repurpose/pool grants |
| Exact MCP SDK/protocol version and notices? | Integration maintainer | Phase 5; pin tested revision/explicit compatibility set |
| Current v2 data-preservation and backup policy? | Runtime/data maintainer | Phase 1; fixture-proven migration/restore before real profile writes |
| May inferred memory or learned skills activate without review? | Product/security owner | Phase 3; default is reviewed promotion, explicit preference saves allowed |
| When should tasks continue after app quit? | Product/operations owner | Phase 6/7; initially require app open, later explicit separate worker/server |
| Is full disk-history encryption a release requirement? | Product/privacy owner | Before broader release; do not describe existing SQLite as encrypted |
| Which OS follows macOS? | Product/platform owner | Phase 8; per-platform proof, no shared-UI parity assumption |

## 16. Verification and implementation boundary

Actually executed during this assessment: `pnpm run test` passed **419 Vitest tests and 24 Rust tests**; `pnpm run typecheck` and `pnpm run build` passed. A separate no-network installed-AI-SDK probe was rerun: denied effects **0**, pending approval **1**, steering delivered at step **1**, streaming passed; a deliberately uncooperative mock demonstrated why cancellation must also be checked at the effect boundary. Details and caveats are in `research/05-verification.md`.

No runtime feature was implemented, no app UI was launched, no live model/browser/account task was validated, no saved credential/profile was read, and nothing was committed or pushed. Engine comparisons include fetched source/contracts, not successful in-app engine integrations. Treat proposed guarantees as phase acceptance criteria until exercised.

## 17. Glossary

- **Harness:** the loop plus tools, context, permissions, persistence, lifecycle and evaluation—not merely the underlying model.
- **Broker:** trusted code that admits and scopes effects independently of model instructions.
- **Capability:** a bounded grant to perform an operation on particular resources/accounts for a limited lifetime.
- **Checkpoint:** durable model/run context; distinct from an external side-effect receipt.
- **Unknown effect:** dispatch may have succeeded but the outcome is not durably confirmed; it requires reconciliation.
- **Skill:** reusable procedural context/resources; not a permission grant or automatically trusted executable plugin.
- **Learning:** reviewed improvement of memory/procedures/policies through evidence, not automatic model weight updates.
- **Presentation plane:** voice/scene/3D behavior and its timing; independent from task execution authority.
