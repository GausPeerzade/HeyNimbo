# Opus 5.5 architecture review: parent triage

Date: October 29, 2026. Requested reviewer and verified served model: `claude-opus-5-5`.

**Status:** review complete; recommendations below are not yet applied to `TECHNICAL_DESIGN.md` or `docs/agentic-roadmap.md`. Application source is unchanged. The original reviewer response is preserved verbatim in `07-opus-5-5-review.md`; model/scope/hash evidence is in `evidence/opus-5-5-review-audit.json`.

## Verdict

Opus approves the **direction with required changes**, not the implementation, security or performance of an unbuilt system. It supports retaining the current stack and provider integration, but recommends a much smaller initial harness, isolation of Explain from background-agent availability, earlier information-flow/egress rules and more explicit worker/credential ownership. It proposes evaluating Pi before Codex as the coding default.

The review contains two P0, eight P1 and six P2 findings. Those are reviewer priorities for design work, not demonstrated vulnerabilities in currently nonexistent agent execution code.

## Findings accepted for the next architecture revision

| Area | Parent check | Recommended disposition / settling check |
|---|---|---|
| Explain depends on agent-host history after planned migration (P0-1) | Confirmed current `voice/talk.ts:184-188` reads context/writes history before answering; `askText:98-101` acknowledges afterward. Design §6.3 explicitly moves ownership to the host. | Keep Explain and current history independent initially; give Do a separate lazy host and agent-state DB. One writer per file. Define cross-store linkage/deletion honestly, not cross-database atomicity. Freeze/kill host and verify Explain admission/audio/3D/persistence against baseline. |
| Private-file reads plus web/search requests need explicit data-egress policy (P0-2) | Phase 2 combines those capabilities; private-network/SSRF denial is not prevention of private data appearing in public queries/URLs. No general broker is implemented, so a successful exploit is not established. | For the MVP, separate web-only and local-file runs unless the owner explicitly authorizes mixing/export. Apply policy to search queries, URL/path/query, bodies and redirects, not only write verbs. Use synthetic-secret injection fixtures and inspect attempted egress. |
| Broker and supervisor ownership (P1-1) | Design diagram/main-owned emergency stop and host/core descriptions do not completely assign every launch/revocation responsibility. | Name the policy authority and supervisor explicitly. Main or a narrow native supervisor retains independent stop/kill authority; a frozen host cannot be required to cooperate. Do not treat a process group alone as proven macOS containment. |
| Coding-engine credentials and outer/native containment (P1-2) | Design §10.3 specifies approved auth and containment but no concrete placement/credential protocol. | Prove the exact engine topology. A destination/model/run-bound credential-injecting adapter is a candidate, not an implemented generic proxy. No raw provider keys in repository-script scope; validate provider protocol/auth rights, short-lived handles, budget enforcement and direct-egress denial. |
| macOS privacy-permission attribution (P1-3) | Existing app requests screen/input permissions; this review did not exercise worker inheritance or helper attribution. | Add an explicit packaged-platform probe for screenshot, input-observation and Accessibility access from restricted workers. Helper signing/launch strategy must be validated, not assumed to solve it. |
| Explain/Do routing (P1-5) | Current Explain already has one answer-provider stream; future voice intent selection is underspecified. | Explain remains default and receives no extra classifier/model call. Use explicit UI/gesture or a confirmed handoff. Assert one answer-model request per Explain turn; do not count separate STT/TTS transport as extra answer-model calls. |
| Explicit memory-save authority (P1-6) | Design §9.2 distinguishes candidates from explicit preferences, but does not fully bind permission to actual owner input. | Require trusted user-turn provenance and exact requested content, or an owner confirmation card. A model-authored claim that the user asked is not authorization. Untrusted-content-derived writes remain candidates. |
| Premature extraction/negotiation/spikes (P1-7) | Explain has tightly coupled timing/preparation behavior; the plan refactors it before agent tasks need the internals. | Add a narrow facade first, not a wholesale presentation rewrite. Engine abstraction emerges with the second real engine. Move coding/browser containment gates to the corresponding authority phase, while still enforcing required MVP browser/network boundaries. |
| Performance contract and baseline (P1-8) | Timing marks, model preparation and frame-gap tracing exist; the roadmap lacks an explicit concurrent-load/host-down Explain acceptance matrix. | Add baseline, research load, multiple runs/extraction load, host crash/freeze, temporary mode and cold-start scenarios. Measure first token/audio/3D, skew, frame gaps, event-loop delay, RSS and stop-to-quiescence. Set thresholds from measured baseline, not invented numbers. |

## Recommendations to qualify rather than accept literally

1. **Reduced durability for a read-only MVP is sensible (P1-4), but not every read is harmless or every sandboxed command safely repeatable.** Keep run/step checkpoints and monotonic UI events initially. Defer full external-write reconciliation until a real irreversible action requires it. Do not universally resume a native engine from an uncertain checkpoint without checking native/tool semantics, workspace state and permitted network effects. Preserve unknown/reconciliation for genuine uncertainty outside replay-safe work.
2. **Pi-first coding is a credible candidate, not a proven winner.** Pinned source shows in-memory sessions and pre-tool hooks; the parent verified those definitions. That does not establish that RPC exposes every embedding hook, that all providers work through an injecting proxy, or that in-memory session history eliminates every possible engine/log/cache write. Compare complete integration, model quality, credential containment and temporary-mode behavior in a disposable spike before changing the default.
3. **Two databases reduce the initial Explain regression surface, but do not eliminate coordination.** Cross-store association, deletion, retention, memory retrieval and recovery need a small explicit contract. Avoid duplicate canonical run stores; future consolidation should follow measurements.
4. **The proposed URL-provenance rule is not a complete information-flow defense.** A permitted destination can still receive sensitive search/body data, and dynamically generated legitimate requests are common. Separating web/file modes is easier to reason about initially; later use narrowly authorized exports and destination/data policies, not a blanket claim that following links is safe.
5. **Receipt metadata is not necessarily content-free (P2-4).** Account, recipient/destination, timestamp and even a digest can be sensitive or correlatable. Do not silently persist it behind history-off. Product policy must disclose its content, retention and opt-in/exception behavior.
6. **Skill replay cannot be mandatory for every personal procedure (P2-3).** Use deterministic fixtures for shipped executable/security-sensitive workflows; allow inert personal Markdown drafts to improve through owner review and normally approved first use. Do not discard evaluation of bundled skills or executable scripts.
7. **The 66-task inventory is a long-term roadmap, not itself a reason to reject the product scope.** Opus's roughly twelve-task first slice is more practical. Keep later goals as themes; do not require all later native/coding/self-host security machinery before a web-only research MVP.
8. **Current storage/publish costs (P2-1) are source-level risks, not measured bottlenecks.** Parent confirmed synchronous whole-answer/scene writes and FTS updates in `history.ts:33-36,81-83`, plus full conversation snapshots in `app-shell.ts:75-91`. Profile before changing a working cadence or claiming a latency regression.
9. **Choose one SDK loop integration, not two independently maintained loops (P2-2).** Installed source confirms sequential tool-execution and lifecycle options. `ToolLoopAgent` is a wrapper over core generation, so the choice is about required control and complexity, not an automatic safety difference. Enforce effect checks in the handler regardless.

## Suggested revised first slice

Preserve current Explain/provider/audio/overlay/history behavior. Add a lazy agent host for Do with only coordinator, provider, tools/policy, bounded context and artifacts. Start with public research or separately scoped local files, explicit approvals, temporary mode, paginated task events and independent emergency stop. Add confirmed memory and inert skills next; coding and authenticated app writes arrive only with their own verified containment, credentials and recovery contracts.

The reviewer report's §4 contains a concrete proposed hot-path contract and measurement matrix; §5 contains the approximately twelve-task consolidation. Those are proposals, not measured performance or completed implementation.

## Verification

- Successful reviewer assistant events and terminal model-usage metadata both name `claude-opus-5-5`; no fallback model was used.
- Only Read/Glob/Grep were invoked; no reviewer shell, network, edits, subagents or tests.
- Both architecture/roadmap file-read results included their ending sections without truncation errors.
- Snapshot hash comparison found no changes to the 187 original files at review completion. The parent also checked selected current-source and pinned upstream definitions before triage.
- No runtime test, packaged sandbox proof or performance benchmark was executed for this review request. Previous baseline checks are documented separately in `05-verification.md`.
