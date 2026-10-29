# Agentic HeyNimbo: phased implementation roadmap

**Status:** planning only. **Baseline:** October 29, 2026, commit `4eb07b65b65013c64945f9727627969ef8960797`.
**Architecture:** `../TECHNICAL_DESIGN.md`. **Evidence:** `../research/01-clicky-product.md` through `05-verification.md`.

## How to use this plan

Each row is a bounded implementation/review task, not a promise that an entire phase fits in one coding-agent turn. Acceptance tests are requirements for future work, not tests claimed to exist today. Keep fixtures, credentials and execution environments disposable. A task is complete only with executed evidence and a reviewed diff.

**No big-bang rewrite.** The existing companion remains the default until the new path passes its gate. Introduce packages only when there is an independently testable boundary; do not create empty folders for the entire proposed tree.

**Critical path:** P0 contracts/isolation → P1 extraction/state ownership → P2 safe durable agent → P3 memory/skills → P4 coding and P5 authenticated apps → P6 native control/routines → P7 subagents/self-host → P8 platform/release expansion. P4 and P5 can run in parallel once P2 contracts are stable; P3 learning is not a prerequisite for simply invoking a browser or coding tool. Release hardening begins early and becomes mandatory when authority widens.

**Required after each merge:** `pnpm run test`, `pnpm run typecheck`, `pnpm run build`, focused new contract/security tests and `git diff --check`. No autonomous commit/push/deploy behavior is implied by this roadmap. Do not launch windows, use microphone/screen, install engines or make paid requests as a side effect of an offline test suite.

## Revised MVP (revision 2 — supersedes P0–P2 ordering below)

Adopted from the Opus 5.5 review (`../research/07-opus-5-5-review.md`, triage in `../research/08-opus-review-triage.md`). The phase tables below remain the long-term inventory; where they conflict with this section, this section wins. In particular P0.5–P0.7 move to the entry gates of Phases 4/5, P0.8/P1.5 leave the critical path (Explain keeps `history.sqlite` in main), and P1.2/P1.3 are replaced by a narrow narration facade added only when needed.

| # | Task | Acceptance (executed tests, not intentions) |
|---|---|---|
| M1 | Versioned agent protocol + validators (`src/shared/agent-protocol.ts`) | Unknown/extra fields, oversized payloads and authority-bearing fields from renderers are rejected; event sequence is monotonic per run. |
| M2 | `agent.sqlite` store: runs, events, step checkpoints; in-memory store for temporary mode | Restart turns non-terminal runs into `interrupted`; duplicate request IDs cannot create two runs; delete purges events/checkpoints/artifact refs; temporary mode writes nothing to disk. |
| M3 | `streamText` loop/coordinator: budgets, abort, `toolCallConcurrency: 1`, approvals and ask-user as events, capability-gated models | Mock model drives multi-step runs; denied tool executes zero times; abort mid-tool prevents later effects; budget exhaustion ends the run with a typed reason; Continue resumes from checkpoint without re-running finished tools. |
| M4 | Local tools: folder-grant scoped read/list/search, content-addressed artifact save | Traversal, symlink escape, oversized files, binary files and ungranted roots denied; artifact save never writes into granted folders. |
| M5 | Web tools: search adapter + fetch with SSRF guard and bounded extraction; run mode web vs local with explicit mixing | Private/loopback/link-local/metadata IPs denied incl. via redirects and DNS answers; size/time/decompression bounded; a local run cannot fetch, a web run cannot read files, mixing requires a recorded owner event; synthetic secret never appears in any outbound request in the injection fixture. |
| M6 | Lazy utility-process host + main supervisor + global Stop-all | Host not spawned until the first Do request; malformed port messages rejected; Stop-all kills a frozen host; host crash produces a typed state; events coalesced. |
| M7 | Home Do mode, task timeline, approval and ask-user cards, artifact preview, stop | Paginated events; approval card text is host-generated and inert; Explain composer behavior unchanged. |
| M8 | Explain regression gates | Exactly one answer-model request per Explain turn; Explain works with host never started, frozen or crashed; existing suites green. |

Next after the MVP: memory-lite (confirmed saves, frozen bounded block, FTS session search), skills-lite (inert `SKILL.md`, progressive loading, reviewed drafts), containment + coding-engine spike (Pi vs Codex), then effect ledger + first connector.

## Phase 0 — prove contracts and resolve blockers

**Outcome:** evidence for the selected loop, execution boundary, migration and optional coding engine before committing to their implementation.

| ID | Task / dependencies | Acceptance test or decision artifact |
|---|---|---|
| P0.1 | Record implemented architecture and preserve a fixture baseline | Existing test/typecheck/build pass; record explicit untested native/UI/provider cases. Use the assessment as input, not proof of future behavior. |
| P0.2 | Freeze v1 run/event/tool/approval vocabulary and capability negotiation | Synthetic traces cover text, tool call/result, question, approval, steering, cancel, error and terminal state; round-trip validation rejects unknown authority fields. |
| P0.3 | Prove installed AI SDK loop integration behind a tiny internal port | No-network mock: two tool steps, denied tool never executes, approval pauses, steering delivered/queued states, tool result round-trip, explicit model object (no hosted Gateway dependency). |
| P0.4 | Probe **durable effect ordering**, not just multi-step output; depends P0.2–3 | Fault-inject before intent, authorization, dispatch and receipt. If hooks cannot enforce ordering, choose controlled `streamText` steps; document exact fallback before P2. |
| P0.5 | Spike macOS execution containment/cleanup with synthetic secrets | Attempt disallowed reads, symlink escape, private-network/Unix-socket access, inherited descriptors, fork/double-fork and daemonization; verify actual denial/reaping. If unproven, require isolated VM/container or keep executable tools disabled. |
| P0.6 | Spike direct pinned Codex app-server contract, offline/fake transport first | Initialize/start/steer/interrupt/native approval/custom-tool/schema error traced with stable IDs; no user credential reuse. Choose and prove either per-command pre-dispatch mediation or a journaled contained delegation-attempt boundary with no automatic native resume after uncertainty. Live/provider compatibility remains a separately approved check. If required provider/auth contract fails, evaluate Pi once. |
| P0.7 | Spike browser account boundary on an empty disposable profile | Anonymous context cannot see personal state; authenticated helper design exposes no raw CDP/storage; own browser closes cleanly without touching unrelated browser processes. |
| P0.8 | Prove current SQLite v2 migration/backup design on fixtures | Preserve conversations, provider attribution, scenes, FTS and retention; fail halfway and restore a consistent backup. No writes to the real user profile. |
| P0.9 | Set product/QA workflows and measure baseline resource budgets | Select a small fixed workflow corpus: Explain/3D, research, repo fix, app draft/send, memory/forget. Measure rather than invent cold start/idle/task/cancel limits; document degraded modes. |

**Gate:** do not enable host shell, raw authenticated browser automation, or broad connector installs just to demonstrate an agent loop. A failed containment probe is a meaningful blocker, not an excuse for a prompt-based sandbox.

**Existing evidence:** the research SDK probe already verifies streaming, approval/denial and steering against installed `ai@7.0.156`. It does **not** satisfy durable-ordering, macOS containment or coding/browser integration gates.

## Phase 1 — extract a reusable host without regressing the companion

**Outcome:** the old experience works through maintainable boundaries; task execution no longer has to live inside microphone/playback code.

| ID | Task / dependencies | Acceptance test |
|---|---|---|
| P1.1 | Extract protocol validation and typed activity state; depends P0.2 | Home/Settings/notch show correct states without inspecting English status labels; invalid/late events are rejected; existing UI behavior retained. |
| P1.2 | Extract provider-neutral answer runner from `TalkSession.respond` | Existing Explain text/audio/beat output is equivalent under fixtures; terminal stream checks, no-vision behavior, error redaction and provider selection still pass. |
| P1.3 | Introduce presentation controller over existing draw/prepare/clear/audio facade | Geometry preparation remains early; marks reveal on the same speech clock; mute, trailing marks, drain, stop and stale callbacks preserve prior behavior. |
| P1.4 | Extract trusted Node agent-host entrypoint and supervisor | Main does not block on host work; no arbitrary imported code in host; malformed peer messages rejected; host crash/restart produces typed UI state; no accidental resident engine/browser pool. |
| P1.5 | Move canonical DB access to one host-owned writer; depends P0.8, P1.4 | Known-schema migration/backup fixture passes; main no longer writes that DB; paginated async reads match prior views; restore and retention tests pass. |
| P1.6 | Add explicit screen attachment/capture-session representation | Explain preserves current user-initiated behavior; generic Do/Code performs no capture by default; non-vision model never receives an image; session revoke invalidates late captures. |
| P1.7 | Tighten privileged IPC ownership before adding actions | Sender+main-frame+document+payload+run/resource checks applied consistently; forged/iframe/stale payload tests fail closed; listeners removed on service disposal/restart. |
| P1.8 | Decouple narration from task lifetime and preserve shortcut behavior | New Explain request interrupts prior Explain; muting/stopping speech does not mark unrelated background task cancelled; selected Stop task and Stop all are distinct. |

**Gate:** existing 2D/3D/voice, temporary-history and credential-isolation regressions pass. No agent features ship behind a refactor that silently removes current functionality.

## Phase 2 — first safe local agent MVP

**Outcome:** users ask for real multi-step research/file tasks, see execution, receive artifacts, and can stop/recover them. No personal browser/account privileges required.

| ID | Task / dependencies | Acceptance test |
|---|---|---|
| P2.1 | Implement coordinator and journaled run/step/events; depends Phase 1 | Ordered unique per-run events; restart from a retained checkpoint; duplicate input/event delivery cannot duplicate a run/effect. Terminal states do not depend on speech drain. |
| P2.2 | Implement typed registry + default-deny broker with immutable tool intent | Unknown installation/schema/actor/resources denied; denied call causes zero actual effects; broker outage denies; source text cannot mint capabilities. |
| P2.3 | Build argument-bound approval storage/UI | Approve exact fixture request once; reject changed content/account/path/origin/schema, expired/replayed approval and revoked run. Display is inert broker-generated text. |
| P2.4 | Add first tools: scoped read/search, ask-user and immutable artifact save | Path/symlink/output limits enforced; artifact creation does not grant repo writes; previews cannot execute in privileged UI; ask-user suspends/resumes without inventing an answer. |
| P2.5 | Add public search/fetch/extraction and optional anonymous Playwright page fallback | Cited report references actually fetched evidence; no personal cookies; deny file/private-network targets through redirects/DNS changes; oversized/hostile pages bounded; unavailable search is reported. |
| P2.6 | Add context/output budgets and capability-gated models | Known supported direct and local-compatible model paths tested where available; no-tool/unknown models stay Explain-only with visible reason, not simulated actions. Context overflow compacts safely. |
| P2.7 | Implement main-owned global emergency stop, revocation and supervisor cleanup; depends P0.5 | Shortcut/Stop all works while another app is focused and the agent host is blocked/unresponsive, before coding or authenticated writes ship. Stop during provider/tool/approval/browser waits prevents new effects; late callbacks denied; cleanup observed, not inferred from a signal. Remote uncertain effects remain visible. |
| P2.8 | Implement intent/receipt recovery and reconciliation queue; depends P0.4 | Crash after fixture send before receipt produces `unknown`; no automatic resend. Supported idempotency/status adapter reconciles once. UI event replay never invokes a tool. |
| P2.9 | Task timeline, progress, artifacts, structured errors and notifications | Multiple read jobs display separately; no private reasoning required; slow UI receives bounded deltas; user can inspect failures, permissions and evidence. |
| P2.10 | Privacy controls, deletion and local-mode/network test | Save-off **or retention = 0** sets a run-level temporary policy propagated to every storage-owning adapter; disable durable background recovery/learning in that mode. Native/remote paths that cannot comply are unavailable without explicit retained-run opt-in. Consequential external writes require a separate explicit minimal-ledger opt-in or stay unavailable. Delete purges task artifacts/checkpoints/indexes by policy. Network-disabled configuration truthfully reports available local capabilities. |

**Demo acceptance:** research a technical question from fetched sources, compare options, save a cited artifact and answer a follow-up; restart and inspect retained evidence; cancel a second task; display a valid old 3D explanation without regression. Use synthetic/local fixtures for deterministic checks; separately approved live calls establish model/browser quality, not policy correctness.

**Authority gate:** this release does not execute arbitrary repository/skill code unless P0.5 containment passed. It does not acquire personal browser sessions or connector tokens automatically.

## Phase 3 — user-owned memory and learned skills

**Outcome:** the assistant remembers approved information across sessions and can improve reusable workflows without changing its own privileges.

| ID | Task | Acceptance test |
|---|---|---|
| P3.1 | Scoped memory schema, source/trust classes and lexical retrieval | Explicit preference survives restart in its intended scope; another workspace/profile/account does not retrieve it; derived web content remains lower trust. |
| P3.2 | Memory inspect/edit/forget/export UI and tools | Edit affects future retrieval; forget removes indexes/caches and prevents checkpoint summaries from resurrecting the entry; disclose separate conversation/backups retention. |
| P3.3 | Agent Skills import/index/progressive loading | Validate frontmatter/resources and size/path limits; no hooks/scripts execute during scan; trust-review project skills; only selected skill body loaded. |
| P3.4 | Versioned candidate→review→active skill learning | Successful workflow creates an inspectable draft with evidence; activation requires owner review; old revision remains rollbackable. No permission or dependency auto-installation. |
| P3.5 | Disposable replay/evaluation of procedures | Run against fixture apps/repos within the same grants; measure completion/steps/cost; failed replay cannot promote candidate; scripts require restricted executor. |
| P3.6 | Memory/skill poisoning and deletion regression corpus | Malicious descriptions, imported resources, summaries and tool outputs cannot change policy/account/destinations; explicit user instructions are distinguished from quoted untrusted text. |
| P3.7 | Bounded feedback and curation | Stale/unused/conflicting entries generate review suggestions; no automatic global rewrite, infinite inference job or secret retention; opt-out honored. |

**Demo acceptance:** remember an explicit preference; teach a scoped task procedure; rerun it; inspect its sources/diff; reject a malicious proposed revision; forget the preference and prove it stays absent after restart.

**Do not build yet:** mandatory vector/RAG service, fine-tuning, a public marketplace, autonomous source patches or a curator that runs without a budget.

## Phase 4 — coding through one reusable harness

**Outcome:** meaningful repo changes with real check output, reviewable patches and no ambient host/deployment credentials.

| ID | Task / dependencies | Acceptance test |
|---|---|---|
| P4.1 | Dedicated engine package/version/config lifecycle; depends P0.6, P2 | Pin binary+protocol; isolated engine home; explicit auth route; missing/incompatible engine fails visibly; no scraping terminal UI or copying existing account tokens. Save-off/retention-zero content cannot be restored through engine resume; purge/expire native sessions with the run, or disable noncompliant temporary-mode integration. |
| P4.2 | Direct Codex app-server adapter (or single selected Pi fallback) | Start/resume/native approval/steer/interrupt/dispose contracts pass; preserve native IDs; distinguish queued guidance from delivered input and idle from final settlement. |
| P4.3 | Isolated repo copies and runtime/dependency-cache policy; depends P0.5 | Repo scripts cannot read host home/secrets/shared Git metadata or bypass egress. Dependency/test execution is explicit code authority; no inherited hooks/credential helpers. |
| P4.4 | Broker custom tools and native/host policy intersection | Native approval cannot authorize a desktop/API effect; containment blocks shell access to host secrets/broker bypasses. Internal native commands execute within a journaled delegation-attempt scope, not a fictional per-command host broker. Changed tool schemas invalidate grants. |
| P4.5 | Diff/check artifacts and reviewed application to real workspace | Fix a real disposable fixture bug, run its tests, preserve unrelated files, return actual diff/output. Reject apply if base revision/path identity changed. |
| P4.6 | Abort/crash/reconnect and provider capability matrix | Cancel long build/child processes; preserve native session mapping. Crash after native command/before receipt yields unknown; no automatic resume/re-execution until reconciliation. Deletion/expiry invalidates resume data. Required provider models tested rather than inferred from selectors. |

**Demo acceptance:** introduce a known regression in a disposable repo, ask HeyNimbo to fix it, inspect executed test output and final diff, approve application against the expected revision. No automatic commit/push/deploy.

**Gate:** ordinary file access or a worktree is not sufficient isolation. If native restriction is unsupported, use the explicit isolated fallback or keep coding unavailable.

## Phase 5 — authenticated browsing and apps

**Outcome:** do useful work in signed-in services while keeping accounts, sensitive browser state and irreversible actions explicit.

| ID | Task | Acceptance test |
|---|---|---|
| P5.1 | Dedicated local automation profile and owner login handoff | Fresh profile cannot see personal default cookies; helper alone retains debugger/storage authority; user signs in; per-account/origin consent expires and revokes. |
| P5.2 | Structured browser observations/actions with freshness binding | Navigation/document/account changes invalidate grants; no arbitrary evaluate/Python/CDP exposed as safe signed-in tools; screenshots/DOM are bounded sensitive observations. |
| P5.3 | Browser approve/commit/readback and takeover | Exact consequential action preview; user can stop/take over; confirmation uses actual state. CAPTCHA/password/2FA/payment fields hand off instead of bypass. |
| P5.4 | Pinned MCP client lifecycle/auth/protocol tests | Explicit 2026-07-28/selected compatibility set; no old/new transport hybrid; minimal-env pinned local servers, authenticated remote endpoints, schema-change review, safe cancellation/restart. |
| P5.5 | One read/draft connector and one approved-write workflow | Product owner chooses initial apps. Account labels/scopes enforced; draft produces no send; approval binds destination/content/account; send/delete receipt followed by readback. |
| P5.6 | Connector health/revoke/multi-account UI and scoped secrets | Switching accounts cannot reuse stale approval/token; revoked auth stops new calls; no raw secrets in renderer, prompts, logs or skill files. |
| P5.7 | Untrusted metadata, sampling/elicitation and browser-data exfil tests | Tool metadata cannot widen grants; malicious requests for local resources rejected; observations cannot be exported to an unapproved endpoint merely by renaming a tool. |

**Demo acceptance:** read selected app data, prepare a response/artifact, show exact preview, approve once, perform the real change in a disposable account and verify it; repeat with denial, changed account, lost network, stale document and uncertain remote outcome.

**No parity claim from a connector menu:** each shipped connector has its own positive, denial, revoke and readback evidence.

## Phase 6 — native hands and reliable routines

These are two independent workstreams over the same broker; one does not require the other.

| ID | Task | Acceptance test |
|---|---|---|
| P6.1 | Native accessibility observation, insertion and input primitives | Explicit OS support/permissions; narrow typed actions; no general native exec; unavailable permissions degrade visibly without requesting access at render/startup unexpectedly. |
| P6.2 | Scoped visible desktop-control session | App/window/capture/display identity, fresh target observation, action limits and exclusive control; stale coordinates or changed application deny/reobserve. |
| P6.3 | Extend P2.7 emergency stop with native input-state release and human takeover | Existing focus-independent blocked-host stop remains tested; release pressed input state; no competing automation resumes after user takeover; completed effects disclosed honestly. |
| P6.4 | Routine schema and reviewed creation from a successful task | Explicit timezone/DST, goal, tool/account scope, budget, expiry and missed-run policy; schedule never implies approval for arbitrary future writes. |
| P6.5 | Durable scheduler leases and occurrence deduplication | Sleep/offline/restart, duplicate ticks and clock changes produce documented outcomes; unique occurrence key, bounded retries, unknown effects block replay. |
| P6.6 | Clarify app-quit behavior; optional separate owner-installed worker later | Initial app-open requirement displayed; no hidden daemon installation. Explicit worker can run headless without opening audio/overlays and can be stopped/uninstalled. |
| P6.7 | Routine run log, failure alerts and pause/revoke | Next run/timezone visible; revoked account/grant pauses future occurrences; late/failed run never silently reported successful. |

**Demo acceptance:** safely operate a disposable native app with takeover, then schedule a read-only report; sleep/restart around a due time and verify deduplication and honest missed-run behavior. Consequential recurring writes require a bounded recurring authorization policy, not replay of an expired one-shot approval.

## Phase 7 — bounded delegation and optional self-hosting

**Outcome:** scale task composition without losing per-run authority, then move planning to an owner-operated server without transferring desktop ownership.

| ID | Task | Acceptance test |
|---|---|---|
| P7.1 | Parent/child runs, inherited capability subsets and shared budgets | Child cannot widen parent grants, choose another account or exceed shared quotas; depth/concurrency capped; child outcome is evidence, not automatically verified success. |
| P7.2 | Parent cancellation, result collection and event backpressure | Parent revocation prevents delayed child effects; all descendants accounted for; bounded parallel research produces provenance-bearing results without flooding UI/context. |
| P7.3 | Headless Node launcher using the same core/host | Boots without Electron/audio/native permissions; local SQLite writer, artifacts and API auth tested; no feature logic fork. |
| P7.4 | Single-owner server deployment and mode-specific canonical journal | One server owns remote runs; desktop keeps projections/local receipts. Propagate temporary/retention/deletion policy to server journals and engine sessions; save-off/retention-zero data cannot resume or rehydrate after deletion/reconnect. Reject noncompliant mode. Separate local runs do not silently merge; no shared-file multi-replica SQLite. |
| P7.5 | Authenticated outbound device connection, local effect broker and revocation | Bind owner/device/run/operation digest; revoked/lost device cannot act; no unauthenticated shell/CDP/listening shortcut. Remote request still needs local approval/resource freshness. |
| P7.6 | Credential/data placement and outage recovery | Server uses separately authorized credentials; no local browser/profile/Keychain/plan-token sync. Server outage leaves clear unavailable/unknown state and no host-execution fallback. |
| P7.7 | Optional separately managed Hermes worker | Only if explicitly chosen: isolated profile/Python deployment, versioned RPC approvals/steer/stop contract, canonical host-memory policy and containment. Not a default install requirement. |

**Demo acceptance:** remote public-research job, locally approved artifact export/action, device revocation and outage; prove the server never receives personal browser storage or local provider plan tokens. A server cannot drive an asleep/offline desktop, even though remote research may continue.

**Out of phase:** public multi-user SaaS, multi-tenant browsers, arbitrary remote terminal tunnels, shared credential pools and HA worker infrastructure.

## Phase 8 — OSS distribution and additional platforms

**Outcome:** installable, auditable releases rather than a developer-only harness.

| ID | Task | Acceptance test |
|---|---|---|
| P8.1 | Clean-machine packaging and update integrity | Install/start/use without developer Rust/Python/Bun toolchains; sign/notarize required binaries/helpers; failed update rolls back; no post-install surprise authority grants. |
| P8.2 | Source-linked releases, dependency SBOM/notices and exact license review | Shipped source/binary versions match; retain required notices, inspect transitive/native dependencies and provider terms; current private Clicky assets/code are not bundled as ours. |
| P8.3 | Windows and Linux native adapters incrementally | Per-OS gestures/capture/speech/AX/input/containment tests; support matrix lists unavailable pieces. Shared TypeScript builds do not count as native parity. |
| P8.4 | Accessibility/performance/offline/reduced-motion QA | Measured resource and task budgets meet agreed targets; voice unavailable does not block text tasks; no hidden telemetry/inference/network fallback. |
| P8.5 | Public contributor architecture, skill/connector safety and eval instructions | New contributor can run deterministic checks; every privileged adapter documents authority, threat model, cleanup and test evidence. |

## Cross-phase release checklist

- [ ] Existing companion tests/typecheck/build stay green; live voice/drawing/3D checks performed only with approval.
- [ ] Tool capability matrix and model quality documented separately from transport connectivity.
- [ ] Effect journal tested with crashes, duplicates and reconciliation; no invented exactly-once claim.
- [ ] Denied and cancelled operations cause zero new unauthorized fixture effects.
- [ ] Containment tested on actual packaged OS builds; no silent host fallback.
- [ ] Multiple account/profile/workspace isolation and revoked grants verified.
- [ ] Screenshots/audio are not silently persisted; sensitive derived text is disclosed and deletable.
- [ ] Save-off or retention zero propagates to native/remote stores; cleanup/expiry prevents resume/rehydration, and noncompliant paths are disabled rather than silently saving.
- [ ] Focus-independent emergency stop works with a blocked agent host before coding or authenticated writes are enabled.
- [ ] Native coding crash-after-command/before-receipt stays unknown and cannot automatically resume/re-execute.
- [ ] Skills/memory never become permissions; imported code never runs in trusted main/host.
- [ ] Spending, sending, destructive actions and public publication have explicit policies/readback.
- [ ] Logs/artifacts/previews cannot leak secrets or execute privileged UI code.
- [ ] Release license/terms/signing/update/privacy gates pass for exact distributed artifacts.

## What to build first

Start with **P0.2–P0.5**, then **P1.1–P1.3**. The first implementation demo should be a two-tool research/file workflow that can be denied, stopped, restarted and inspected while an existing 3D explanation still works. Do not start with a marketplace, vector database, four coding engines, always-on desktop observation or a rewritten UI.

No calendar estimates are asserted here. After Phase 0, estimate remaining tasks from measured contract, isolation and migration work; track completed workflows and passed gates rather than lines of new code.
