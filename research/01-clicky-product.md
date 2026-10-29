# HeyClicky: current public product, not inferred internals

**Retrieval date: October 29, 2026.** Research only; no product installation or authenticated testing.
Scope: official product pages, policies, release metadata, public source documents, and publisher-linked demos.

## Decision: what matters for HeyNimbo

| Finding | Design consequence |
|---|---|
| The product advertises both conversation and delegated work, not tutoring alone. [1](https://www.heyclicky.com/) | Preserve voice/screen/drawing, but make task handoff a first-class interaction. |
| Public evidence supports bounded autonomous work; see the agent gate below. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg) | Compete on usable delegation, not another chat panel. |
| The original source remains public; its author explicitly excludes newer work. [10](https://raw.githubusercontent.com/farzaa/clicky/main/README.md) | Do not equate an MIT ancestor with an open current product. |
| Cloud processing is explicit, not local-first inference. [2](https://www.heyclicky.com/trust) | Local execution and comprehensible data controls are meaningful differentiation. |

## Evidence discipline

- **C — claimed:** stated in current official material, without independent execution here.
- **D — publisher demonstration:** inspected official video frames/still; proves that example, not reliability or interactivity from a still.
- **T — demo transcript:** publisher-linked recording retrieved as timestamped captions; not visual verification.
- **V — artifact verified:** public file, license, repository listing, or release metadata actually fetched.
- **U — unresolved:** evidence insufficient; not a claim that the feature does not exist.
- No benchmark, safety audit, offline test, or cross-platform parity test was performed.
- Native `web.run` was not exposed in this delegated runtime; tool lookup returned `not_found`.
- Native extraction reported a search-only backend; a second search and direct public `curl` fetches supplied the evidence.
- Snapshots, HTTP outcomes, transcripts, sampled frames, and a citation ledger are under `research/evidence/clicky-*`.
- Captions were unavailable for the September Clickys video after retry; its feature claims below rely on the changelog instead.

## Current distribution checkpoint

- Mac latest-release API: **v1.1.1**, published **October 23, 2026**, with a DMG asset. [13](https://api.github.com/repos/farzaa/clicky-releases/releases/latest)
- Windows latest-release API: **v1.1.3**, published **October 25, 2026 UTC**, with installer/update assets. [14](https://api.github.com/repos/heyclicky/clicky-releases-windows/releases/latest)
- The website labels that Windows release **October 24**; preserve this date mismatch rather than inventing a timezone explanation. [3](https://www.heyclicky.com/changelog)
- Download instructions lead to DMG installation on Mac and an EXE installer on Windows. [5](https://www.heyclicky.com/mac) [6](https://www.heyclicky.com/windows)
- These are verified publication artifacts, not proof that every advertised capability works in the binaries.

## Verified feature matrix

| Area | Publicly supported breadth | Evidence / boundary |
|---|---|---|
| Voice | Hold-to-speak conversation; dictation and screen-conditioned drafting. [18](https://www.youtube.com/watch?v=km54y7Xd_7g) | T: Notes, Gmail, and a Claude terminal example; not a latency benchmark. |
| Screen | Hotkey-triggered screenshots; app-independent visual questions. [1](https://www.heyclicky.com/) | C: broad compatibility, not exhaustive app testing. |
| Spatial input | Point/circle an area to focus a question or request a website change. [19](https://www.youtube.com/watch?v=bLnkvjw7j84) | T: anatomy explanation and coding handoff examples. |
| 2D drawing | Screen overlays explain geometry and indicate FL Studio controls. [21](https://www.heyclicky.com/assets/heyclicky-draw.mp4) | D: sampled frames show added squares, labels, and targets. |
| 3D drawing | Labeled engine cutaway over an existing browser page. [22](https://www.heyclicky.com/assets/changelog/draw-3d.webp) | D: still inspected; drag/part-selection advertised, not exercised. [3](https://www.heyclicky.com/changelog) |
| Agents | Background task handoff, progress/results, follow-ups, concurrent jobs. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg) | T: see gate; not independently replayed. |
| Desktop control | Permissioned mouse/keyboard operation; user interruption. [3](https://www.heyclicky.com/changelog) | C; launch captions also describe image cropping. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg) |
| Browser | Extension reads page content/structure/screenshots and clicks/types in signed-in sites. [4](https://www.heyclicky.com/privacy-policy) | C: substantive browser action, not web search alone. |
| Coding | Historical app-building claim; spatial website-edit request shown in captions. [3](https://www.heyclicky.com/changelog) [19](https://www.youtube.com/watch?v=bLnkvjw7j84) | C/T: no independently verified repository edit, build, test, or deployment. |
| Memory | Persistent named Clickys, conversation/file continuity; daily conversational recall. [3](https://www.heyclicky.com/changelog) | C: retention/export semantics unresolved. |
| Connectors | Built-ins (Gmail/Calendar, Notion, Linear, Slack) plus custom MCP via URL/local command; multiple accounts. [3](https://www.heyclicky.com/changelog) | C: authentication modes include browser sign-in and API tokens. |
| Routines | Conversational scheduling; runs require the app open on the Mac. [3](https://www.heyclicky.com/changelog) | C: not an always-on hosted scheduler. |
| Platforms | macOS 14.2+; Windows 10/11; shared account. [1](https://www.heyclicky.com/) | C/V: releases exist; Linux/mobile availability not established. |
| Privacy | Cloud processing; raw screenshots discarded, prompts/analysis retained. [2](https://www.heyclicky.com/trust) | C: policy commitments, not independently audited behavior. |

## Gate A — does public evidence support autonomous agents?

**Yes, with boundaries.** The reviewed launch transcript records actual task delegation and subsequent results, including browser work and concurrent tasks; this is stronger evidence than an agent label alone. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg)

Evidence anchor in the October 23 launch recording: [17](https://www.youtube.com/watch?v=xOkfw1_ePhg)
- **45:36 onward:** a photo-cropping task requests desktop-control approval. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg)
- **55:13 onward:** Amazon ingredient shopping is delegated to Chrome; the initial start fails, then retries. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg)
- **57–61 minutes:** a separate AI-news scan runs concurrently and returns a report. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg)
- The shopping sequence includes a human-verification interruption and a missing ingredient requiring correction. [17](https://www.youtube.com/watch?v=xOkfw1_ePhg)

Interpretation: goal-directed, multi-step execution with progress, interruption, and follow-up qualifies as bounded autonomy.
It does **not** establish dependable unattended completion across arbitrary sites or desktop applications.

| Breadth question | Answer from this review |
|---|---|
| Research and artifact-producing work? | Supported at claim/transcript level, not benchmarked. |
| Authenticated website changes? | Explicitly permitted for requested tasks by the extension policy. [4](https://www.heyclicky.com/privacy-policy) |
| Autonomous checkout/password entry? | Not established; policy excludes password, verification-code, and payment-card field filling. [4](https://www.heyclicky.com/privacy-policy) |
| Human takeover? | Policy describes multiple stop controls; stopping cannot undo completed actions. [4](https://www.heyclicky.com/privacy-policy) |
| Full coding-agent parity? | U: require a clean-repository change/build/test demo before asserting it. |
| Durable execution while the app is quit? | U: do not present this as proven cloud-agent infrastructure. |

## Subscription versus BYO: separate products, separate economics

| Route | Verified public offer | What not to conflate |
|---|---|---|
| Current Free | $0; 25 talk and 25 agent messages/month; unspecified dictation allowance. [1](https://www.heyclicky.com/) | Free tier is not unlimited free agent execution. |
| Current Pro | $20/month billed monthly; unlimited talk/dictation; 150 agent messages/month. [1](https://www.heyclicky.com/) | Conversation allowance differs from agent allowance. |
| Current Max | $100/month billed monthly; unlimited talk/dictation; 1,000 agent messages/month. [1](https://www.heyclicky.com/) | Not unlimited agents. |
| Current annual option | Website displays a 20% annual-billing discount. [1](https://www.heyclicky.com/) | No checkout or final annual charge verified. |
| Current BYO model access | No documented customer model-key/local-model route found in the reviewed official product material. [1](https://www.heyclicky.com/) [2](https://www.heyclicky.com/trust) | Connector API tokens are not model-provider BYOK. |
| Original public source | Developer setup uses personal Anthropic, AssemblyAI, ElevenLabs credentials and a Cloudflare Worker. [10](https://raw.githubusercontent.com/farzaa/clicky/main/README.md) | Self-building the ancestor is not self-hosting current HeyClicky. |

Avoid claiming a single agent message equals a whole task: release notes discuss extra-allowance approval during long jobs. [3](https://www.heyclicky.com/changelog)
For an OSS alternative, separate software price, local hardware requirements, and optional external inference charges.

## Gate B — reusable source, or only binaries?

**Both exist, but for different generations:** historical MIT source and current binary distribution are separate. [10](https://raw.githubusercontent.com/farzaa/clicky/main/README.md) [13](https://api.github.com/repos/farzaa/clicky-releases/releases/latest)

| Public artifact | What was fetched | Reuse conclusion |
|---|---|---|
| Original Clicky README | Author's April 27, 2026 notice keeps the existing code public and newer work private. [10](https://raw.githubusercontent.com/farzaa/clicky/main/README.md) | Explicit provenance boundary; do not treat it as current-product source. |
| Original license | Actual MIT license file. [11](https://raw.githubusercontent.com/farzaa/clicky/main/LICENSE) | Reusable historical implementation under that license, not a license grant for private additions. |
| Original source | Actual Swift client and TypeScript Worker files, not merely repository metadata. [24](https://raw.githubusercontent.com/farzaa/clicky/main/leanring-buddy/ClaudeAPI.swift) [23](https://raw.githubusercontent.com/farzaa/clicky/main/worker/src/index.ts) | Real implementation available; no build attempted. |
| Mac distribution repository | Root contains README and appcast; release contains DMG. [15](https://api.github.com/repos/farzaa/clicky-releases/contents) [13](https://api.github.com/repos/farzaa/clicky-releases/releases/latest) | Public updater/distribution surface, not current app source. |
| Windows distribution repository | Root contains README; releases contain installer/update packages. [16](https://api.github.com/repos/heyclicky/clicky-releases-windows/contents) [14](https://api.github.com/repos/heyclicky/clicky-releases-windows/releases/latest) | Public binaries do not establish OSS status. |

Do not infer current architecture or feature parity from the ancestor, repository names, or community clones.
README references to Claude Code are developer setup instructions, not proof of an integrated current coding-agent backend. [10](https://raw.githubusercontent.com/farzaa/clicky/main/README.md)

## Privacy: claims, qualifications, and product implications

| Public statement | Qualification / implication |
|---|---|
| Trust promises no persistent raw screenshots, but retention of prompts and image analysis. [2](https://www.heyclicky.com/trust) | Distinguish raw-image retention from sensitive derived text. |
| Trust names Anthropic/OpenAI; the policy also names Deepgram/Cerebras. [2](https://www.heyclicky.com/trust) [4](https://www.heyclicky.com/privacy-policy) | Do not present the shorter provider list as exhaustive. |
| Trust identifies PostHog analytics and Sentry crash reporting, excluding screenshots from those services. [2](https://www.heyclicky.com/trust) | Not equivalent to zero telemetry. |
| Policy routes task/browser content through the backend and providers; browser-derived material may remain in conversation history. [4](https://www.heyclicky.com/privacy-policy) | A local extension transport does not make inference local. |
| Extension supports signed-in sites, but not incognito; it does not independently upload to its own server. [4](https://www.heyclicky.com/privacy-policy) | Account/session access materially expands task authority. |
| Policy targets deletion within 14 days after request confirmation, subject to legal retention. [4](https://www.heyclicky.com/privacy-policy) | Do not paraphrase deletion as instantaneous and unconditional. |
| Trust reports no SOC 2/ISO 27001 certification and says quitting stops local helpers. [2](https://www.heyclicky.com/trust) | Neither certification nor quit behavior independently audited here. |

The hotkey screenshot promise should not be interpreted as forbidding browser reads during an authorized background task; the extension policy expressly describes them. [4](https://www.heyclicky.com/privacy-policy)

## Current-state traps: do not carry old launches forward

- Proactive activity tracking was removed; Skills were paused; October's update also paused Suggestions. [3](https://www.heyclicky.com/changelog)
- Reddit/Monday connector additions were paused; working existing connections were preserved. [3](https://www.heyclicky.com/changelog)
- Trust still describes optional daily read-only integration scanning for suggestions. [2](https://www.heyclicky.com/trust)
- Treat that mismatch as stale/ambiguous documentation, not evidence that paused Suggestions remain active.
- Do not market a new alternative against an obsolete Mac-only or agent-free picture.

## Product opportunities for a free OSS, local-first alternative

These are recommendations, not claims about uninspected HeyClicky internals.

1. **Keep the distinctive interface.** Preserve fast voice, explicit screen sharing, spatial pointing, 2D explanations, and inspectable 3D views.
   Make task handoff an extension of this interaction rather than replacing it with a terminal-style workbench.
2. **Make autonomy legible.** Separate Explain, Draft, Act, and Schedule modes; show goal, authority, progress, outputs, and stop controls.
   Default to previews for external writes, destructive operations, identity-sensitive actions, and money.
3. **Make local-first measurable.** Offer an offline configuration test and per-feature network indicators, not an undifferentiated privacy badge.
   Keep memory/artifacts locally by default; distinguish local capture, local storage, local inference, and remote inference.
4. **Offer genuine BYO without hidden coupling.** Independent STT, vision/text, and TTS adapters; optional local models and user-owned remote credentials.
   Show endpoint, estimated spend, and degraded capabilities before a task starts; free software does not imply free remote compute.
5. **User-owned memory.** Editable project/persona scopes, inspectable sources, selective forgetting, export, and predictable deletion.
   Do not silently promote screen observations or connector content into permanent personal memory.
6. **Conservative connectors and routines.** Account labels, least privilege, local credential storage, connector health checks, and explicit recurring-task consent.
   Define missed-run, offline, sleep, retry, quota, and app-quit behavior; expose a run log and next scheduled time.
7. **Publish the product being shipped.** Source-linked releases, reproducible build instructions, versioned capability evidence, and an auditable telemetry policy.
   Prefer fewer reliable workflows over an expansive unmeasured agent catalog.

## Recommended acceptance gates before claiming parity

- Voice/screen/drawing: cold-start and follow-up tasks, multilingual input, multiple displays, interruption, and accessibility checks.
- Desktop/browser: clean-profile login handoff, visible authority, real readback after writes, takeover, navigation errors, and human-verification handoff.
- Coding: modify a disposable repository, run its tests, show a diff, and prove no unrelated files changed.
- Memory: restart, switch projects, inspect/edit/delete a memory, then confirm subsequent answers respect the deletion.
- Routines: sleep through a scheduled time, disconnect the network, restart the app, and check duplicate prevention and retry limits.
- Local-first: block network access and demonstrate exactly which features remain available.
- Security-critical actions require a separate review; none of the public evidence reviewed establishes blanket safety.

## Remaining questions for hands-on follow-up

| Question | Owner / milestone |
|---|---|
| Actual completion rate across desktop, browser, and connector tasks? | Product QA / before parity claims |
| Windows feature parity, resource use, and interruption behavior? | Platform QA / before cross-platform claims |
| Coding execution quality and supported artifacts? | Agent QA / before coding launch |
| Exact memory retention/export and current Suggestions status? | Product/privacy review / before competitor-facing comparison |
| Model BYO availability beyond reviewed public documentation? | Commercial review / before pricing comparison publication |

Evidence files retain retrieval output; binaries were neither installed nor reverse engineered.

## Sources

[1] https://www.heyclicky.com
[2] https://www.heyclicky.com/trust
[3] https://www.heyclicky.com/changelog
[4] https://www.heyclicky.com/privacy-policy
[5] https://www.heyclicky.com/mac
[6] https://www.heyclicky.com/windows
[10] https://raw.githubusercontent.com/farzaa/clicky/main/README.md
[11] https://raw.githubusercontent.com/farzaa/clicky/main/LICENSE
[13] https://api.github.com/repos/farzaa/clicky-releases/releases/latest
[14] https://api.github.com/repos/heyclicky/clicky-releases-windows/releases/latest
[15] https://api.github.com/repos/farzaa/clicky-releases/contents
[16] https://api.github.com/repos/heyclicky/clicky-releases-windows/contents
[17] https://www.youtube.com/watch?v=xOkfw1_ePhg
[18] https://www.youtube.com/watch?v=km54y7Xd_7g
[19] https://www.youtube.com/watch?v=bLnkvjw7j84
[21] https://www.heyclicky.com/assets/heyclicky-draw.mp4
[22] https://www.heyclicky.com/assets/changelog/draw-3d.webp
[23] https://raw.githubusercontent.com/farzaa/clicky/main/worker/src/index.ts
[24] https://raw.githubusercontent.com/farzaa/clicky/main/leanring-buddy/ClaudeAPI.swift
