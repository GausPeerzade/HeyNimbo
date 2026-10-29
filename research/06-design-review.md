# Architecture/roadmap review and disposition

Date: October 29, 2026. Scope: independent document review of `../TECHNICAL_DESIGN.md` and `../docs/agentic-roadmap.md`, then parent-applied corrections. No agent functionality was implemented or certified.

The independent review read both documents and cross-checked the four research reports plus targeted source. It found no blocking architecture issue or false claim of an already-working integration, but identified three missing contracts/gates. All three were incorporated into the documents; this is not a second independent approval of the edited text.

| Finding | Correction applied | Future implementation acceptance gate |
|---|---|---|
| Save-off/deletion covered app storage but not explicitly native engine and server stores | Design §6.3 now defines a run-level persistence contract, triggered by either `saveHistory = false` or `retention = 0`, passed to every storage-owning adapter. Coding §10.3 and self-host §13 require policy compliance, cleanup/expiry and no rehydration; noncompliant paths are unavailable without explicit retained-run consent. | P2.10, P4.1/P4.6 and P7.4: native resume/server reconnect cannot recover temporary or deleted content; test cleanup/retry/expiry and reject unsupported policies. |
| Focus-independent emergency stop first appeared too late, after coding and authenticated actions | Basic main-owned global revocation/supervisor stop moved into P2.7, required before coding or authenticated writes. P6.3 now extends that path for native input-state release and takeover. | Another app focused + agent host blocked/unresponsive: stop prevents new dispatch and verifies owned execution cleanup; completed/unknown remote effects remain honest. |
| AI SDK intent-ordering proof did not establish native coding per-command durability | Design §§7.2/10.3 now select a coarser contained delegation-attempt boundary, journaled before launch. Native internal commands are not falsely described as host-brokered individually. Unsettled delegation becomes unknown; automatic native resume/re-execution is prohibited until reconciliation. | P0.6 and P4.4/P4.6: crash after a native command but before its receipt cannot duplicate execution; retain native receipts/workspace evidence, reconcile first. |

The review also confirmed the direction of the utility-process-versus-sandbox distinction, trusted native adapters, provider reuse, argument-bound approvals, reviewed learning, and mode-specific canonical remote state. These are findings about document coherence, not executed guarantees.

## Parent verification

- Existing app source remains unchanged.
- Existing app baseline passed 419 Vitest and 24 Rust tests, typecheck and build during the assessment.
- Installed AI SDK mock probe was rerun successfully; source/retrieval audits passed.
- `research/evidence/verify-plan.py` checks deliverable presence, phase/task integrity, current-code citation bounds, source-change/download hygiene and recorded mock assertions.
- New runtime, sandbox, native coding, authenticated browsing, memory/skills and self-host acceptance gates remain future implementation work.
