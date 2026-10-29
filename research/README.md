# HeyNimbo harness research

Research date: October 29, 2026. This is planning and evidence, not implemented agent functionality.

## Start here

1. `../TECHNICAL_DESIGN.md` — recommended architecture, stack/reuse decisions, authority boundaries, storage, memory/skills, execution and self-hosting.
2. `../docs/agentic-roadmap.md` — acceptance-gated phases and bounded implementation tasks.
3. `04-codebase-assessment.md` — actual code trace and preservation boundaries.

## Supporting reports

| Report | Scope |
|---|---|
| `01-clicky-product.md` | Current official Clicky pages, privacy/changelog, demos, source and distribution distinctions |
| `02-harness-options.md` | Hermes, Codex app-server/SDK, Pi, OpenCode, AI SDK and exact integration costs |
| `03-execution-and-safety.md` | Playwright/MCP, sandboxing, durable effects, poisoning, skills and remote/local boundaries |
| `04-codebase-assessment.md` | Implemented versus planned features with exact repository line references |
| `05-verification.md` | Executed baseline checks and SDK probe; explicit unverified behavior |
| `06-design-review.md` | Independent review findings, applied corrections and remaining implementation gates |

External factual claims link to fetched primary sources in the reports. A source/retrieval audit establishes provenance, not universal truth or production safety. Product marketing, publisher demos, source inspection, mock execution and real integration are labeled separately.

## Evidence and reproducibility

See `evidence/README.md` for retained compact metadata and the runnable no-network SDK probe. Bulky downloaded media/pages/upstream trees are ignored locally to avoid accidentally vendoring competitor assets or whole source trees. No app source was changed, no dependency installed, and no commit/push performed.

The proposed approach is **keep the current stack and presentation plane; own the execution/control plane; reuse model/runtime/browser/protocol mechanics behind adapters**. Detailed fallback gates are in the design and roadmap, not hidden assumptions.
