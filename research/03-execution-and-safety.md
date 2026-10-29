# HeyNimbo execution, safety, skills and memory

Research date: **October 29, 2026**. Scope: a lean, local-first Electron/TypeScript + Rust app; recommendations, not implemented guarantees.
Inputs: `docs/architecture.md` and `docs/providers.md`; preserve drawings, 3D, voice, owner-controlled credentials and the existing native capture/input boundary.
Primary URLs were fetched; evidence records response status, content hash, timestamp and a short verified excerpt in `evidence/execution-sources.json`.

## 1. Findings → design consequences

| Finding | Consequence for HeyNimbo |
|---|---|
| Playwright persistent profiles contain cookies; default Chrome-profile automation is unsupported.[1][2] | Separate anonymous research from explicitly consented authenticated browsing (§4). |
| Playwright MCP explicitly disclaims being a security boundary; origin filters do not cover redirects.[3] | Reuse browser mechanics, not its flags as the isolation proof (§4). |
| The current MCP specification is **2026-07-28**, with stateless requests and per-request negotiation.[4] | Pin protocol support; do not copy obsolete session/SSE designs (§5). |
| Tool annotations and skill instructions are not independently enforced permissions.[9][10] | Broker-owned policy outranks metadata; quarantine imports (§2, §9). |
| Sandbox Runtime defaults to broad read access; bubblewrap requires a deliberately constructed policy.[12][13] | Treat platform containment as a tested adapter, never a checkbox (§6). |
| Checkpoint recovery can re-run code before an interruption.[21] | Journal individual effects; ambiguous external success requires reconciliation (§8). |
| Memory poisoning includes attacks that require only conversations, not direct database edits.[22][23] | Provenance and promotion gates apply to learned memory as well as installed skills (§9). |

## 2. Gating answer and enforceable trust boundary

**Can untrusted tools run without unrestricted host shell or browser cookies? Yes, conditionally.**
They must run outside Electron main/native privileges, with kernel-enforced filesystem/network/process restrictions and only narrow broker RPC.
No: not if “sandbox” means a working directory, prompt instructions, an MCP root, `readOnlyHint`, a container with host-home mounts, or an exposed CDP endpoint.
Until a platform adapter passes the denial tests in §10, untrusted executable tools are **unsupported**, not silently promoted to host execution.
A trusted built-in adapter may remain native; that is a deliberately privileged component, not an untrusted-tool sandbox.

Proposed authority path:

```text
Untrusted: model output / webpages / repository / memory / skill / MCP metadata
  → typed action request, never executable authority
Trusted: broker validates actor + session + policy + resource + approval + budget
  → sandbox supervisor / narrowly scoped connector / trusted browser helper
  → result labelled with provenance; it cannot mint new grants
```

- Electron main owns policy, durable state and approvals; Rust owns narrow OS primitives, secrets and the emergency-stop path.
- Run imported code and local MCP subprocesses out of process; never load their JavaScript/modules into Electron main.
- Give each worker an unguessable channel capability bound to its run, workspace and allowed methods; no generic `exec` RPC back into main.
- Keep long-lived secrets in the trusted secret/request broker; workers receive opaque handles, never host credential files or inherited token environments.
- The broker attaches credentials only to a validated account and exact upstream destination; it must not offer a generic credential-signing or HTTP-proxy oracle.
- If a third-party SDK requires raw credentials in-process, classify it as a privileged connector or issue an explicitly scoped short-lived credential; do not call it secret-isolated.
- Renderers receive allowlisted IPC only; validate sender/frame, schema and resource ownership, not merely a channel name.
- Retain Electron context isolation, renderer sandboxing and no Node integration for untrusted content; these are renderer controls, not shell containment.[19]
- Enforce tool identity as installation/endpoint + pinned artifact/schema digest; a renamed tool or changed schema invalidates its existing grants.
- An untrusted tool's declared “read only” or “idempotent” property is an assertion to verify, not a reason to bypass policy.[9]
- Reading can leak secrets or trigger remote effects; enforce both access and destination policies, not only a write/no-write distinction.
- A remote MCP service is outside local containment: its own credentials and side effects require an explicit connector trust decision.

## 3. Approvals must bind the operation, not the conversation

Proposed broker record: `approvalId`, actor/run/turn, installation digest, tool/schema version, normalized operation and canonical-argument digest.
Also bind workspace identity, resolved resource identities, account/tenant, exact endpoint/origin, payload/blob digest, spend ceiling, expiration and single-use nonce.
For code execution bind executable identity, argv, cwd, permitted environment, filesystem/network policy and input/artifact digests; show these as a readable preview.
For writes show the recipient/account, diff or exact content, destination and irreversible consequences; a generic “allow this tool” dialog is insufficient.

1. Validate and freeze the request before displaying it; store large approved inputs as immutable content-addressed blobs.
2. Resolve paths inside an allowed root, reject traversal and symlink escapes, and use race-resistant handles/revalidation at execution time.
3. Recheck policy, target identity, payload digest, credentials' account binding, expiry and remaining budget immediately before dispatch.
4. Atomically consume an approval into an operation-attempt record; a retry refers to that attempt, not a fresh authorization.
5. Any changed recipient, path, account, browser origin/document, artifact, shell expansion or schema requires a new approval.
6. Offer session grants only for explicitly listed bounded operations; never let a model turn “remember this” into persistent authority.
7. Broker-generated UI displays arguments as inert text; tool names/descriptions and page content cannot replace the approval explanation.

Prefer `execFile`/spawn with explicit argv for built-ins; do not authorize a command prefix and later append an arbitrary shell program.
Shell strings, substitutions, interpreters, package scripts and build hooks are arbitrary code: their enforceable scope is the sandbox, not a textual allowlist.
For browser actions, bind profile/account, tab, origin, document generation and semantic target; invalidate if navigation or target identity changes.
DOM binding cannot prove what a hostile page will do after a click; consequential actions should use a scoped API or an additional human confirmation.

## 4. Browser execution: three explicit modes

**A. Public research — default.** Fresh isolated context, no imported storage state, no personal cookies, no local files or private-network targets.
Use the bundled browser with a pinned Playwright adapter; treat every response, download, screenshot and DOM string as untrusted task data.
Constrain downloads to a quarantine directory; opening/executing an artifact is a separate capability and approval.
Do not promise network “read only”: an HTTP GET can itself have effects; an anonymous context chiefly removes authenticated authority.

**B. Authenticated local work — opt in.** A distinct automation profile, user-driven sign-in, visible expiring session and account/origin-scoped consent.
The trusted browser helper alone opens that profile and holds CDP; workers get selected observations/actions, never profile paths, storage dumps or raw debugger access.
Do not expose arbitrary page JavaScript, unrestricted Playwright code or cookie/storage APIs as allegedly safe authenticated tools.
Authorized DOM/screenshots may still contain sensitive data; minimize observations and restrict their onward destinations, not just cookie export.
A browser extension controlling an existing browser is a separate high-trust integration; do not claim it isolates the user's other tabs.[3]

**C. Remote browser — later.** A remote ephemeral profile has its own identity and credentials; it is not the user's local authenticated browser.
Authenticate the browser service and bind ownership/expiry to the run; never publish raw CDP or share profiles across users.
A remote planner requests local actions through the authenticated local broker; it cannot directly drive local input or fetch browser cookies.
Do not upload local profiles, auth state or personal-session traces to make remote browsing appear seamless.

Playwright `launchPersistentContext(userDataDir)` returns the sole persistent context; closing it closes its browser; concurrent instances cannot share its data directory.[1]
CDP attachment is Chromium-only and documented as lower fidelity than the Playwright protocol; it is a privileged compatibility mode, not the default harness.[1]
Chrome **136** changed remote-debugging switches to require a non-default user-data directory; Chrome for Testing remains an automation option.[2]
Playwright MCP supplies isolated/persistent modes and an extension path, but expressly says its origin filter is not a security boundary and does not cover redirects.[3]
Its filesystem-root checks do not replace OS filesystem restrictions; deny unsafe capabilities, preserve Chromium's sandbox and test effective launch settings.[1][3]
Important launch caveat: Playwright documents `chromiumSandbox` as defaulting to false; configure and verify it rather than assuming a browser process is sandboxed.[1]

## 5. MCP: transport/authentication is not tool authorization

As fetched, **2026-07-28 is latest**; the overview describes stateless self-contained requests and per-request capability negotiation.[4]
Current transports include local stdio and Streamable HTTP; HTTP messages POST to one endpoint and receive JSON or a request-scoped SSE response.[5]
The latest HTTP binding no longer uses `Mcp-Session-Id`, standalone GET streams, DELETE sessions or resumable `Last-Event-ID` streams; those belong to older revisions.[6]
It requires protocol and request metadata headers, including `Mcp-Method` and operation-specific `Mcp-Name`, and validation against the request body.[6]
Server-to-client requests now use the multi round-trip request pattern: the client obtains requested input and retries the original request; this is a breaking change.[33]
Bind any continuation to the same operation/actor/account and effect record; protocol-level retries cannot mint another approval or justify replaying a committed effect.
Pin an SDK version proven against this revision; if supporting an older server, implement an explicit tested compatibility adapter, not a hybrid protocol.
Never mistake an HTTP/SSE reconnect or protocol response stream for HeyNimbo's durable action journal.

For local stdio, launch an exact pinned executable with an explicit minimal environment and sandbox; stdout is protocol, not terminal markup.
Stdio's authorization model differs from HTTP; do not infer that a local subprocess is safe merely because no OAuth exchange occurs.[7]
For HTTP, make authentication mandatory in HeyNimbo even though the MCP specification makes authorization support optional.[7]
Use its OAuth profile: resource-server metadata discovery, PKCE, resource indicators and validation of tokens issued for the intended resource; do not pass provider keys through.[7][8]
Bind loopback listeners to loopback, validate `Origin`/Host appropriately and authenticate requests; localhost is not an authentication mechanism.[6]
Validate discovered OAuth URLs, redirects and resolved IP destinations; distinguish approved local development endpoints from attacker-induced localhost/private-network access.[8]
Separate broker credentials from downstream connector credentials, minimize scopes and require per-account consent to avoid confused-deputy/token-passthrough failures.[8]
Reject server requests for sampling/elicitation or local resources unless an independently granted broker capability permits them.
Metadata changes, tool-list changes and descriptions are untrusted input; rerun policy checks and require review for changed effective privileges.[9]

## 6. Practical sandbox choices, not infrastructure shopping

| Option | Appropriate lean use | Actual boundary / remaining work |
|---|---|---|
| macOS restricted helper + native policy | Trusted built-ins now; untrusted execution only after proof | App Sandbox is entitlement-based; do not assume the broad Electron/native process is automatically constrained.[14] |
| Sandbox Runtime (`srt`) | Candidate cross-platform command-wrapper adapter | Uses macOS `sandbox-exec` / Linux bubblewrap and network proxies; research-preview dependency, not a turnkey safe policy.[12] |
| Linux bubblewrap + seccomp + cgroup v2 | Later native Linux tool worker | Isolation depends on mounts, namespaces and filters; add process/resource limits and supervised lifecycle.[13][17] |
| Hardened Linux container | Optional coding fallback / future self-host worker | Mount/network/daemon choices remain security-critical; Docker itself documents daemon and kernel/configuration risks.[15] |

**Critical `srt` configuration traps:** reads are allowed broadly by default; denying only writes does not protect keys, source or cookies.[12]
Its Linux Unix-socket filtering depends on seccomp availability; the README documents unrestricted sockets with a warning when seccomp is unavailable.[12]
Convert unsupported/missing enforcement into a startup failure; do not accept a warning as a successful restricted launch.
Use broad denied sensitive roots plus narrow runtime/workspace reads, not a few known secret filenames; validate effective rules against newly created paths.
Keep Unix sockets, inherited descriptors, SSH agents, D-Bus, Docker sockets, local brokers and TCC-sensitive desktop services inaccessible unless specifically brokered.
Bubblewrap warns that exposed D-Bus can execute host commands and requires terminal/session care against `TIOCSTI` when not blocked by seccomp.[13]
Use nonprivileged identities, no host PID/network namespace, no Docker socket, minimal read-only runtime mounts and a writable per-run workspace.
Disable network by default; a brokered allowlist must cover redirects, DNS/IP changes, IPv6 and proxy bypass, not just the initial URL text.
Do not mount `$HOME`, browser profiles, keychain material, provider state, host caches or the repository's real `.git` merely to make builds convenient.
A container with such mounts is not an answer to the gating question; containerization does not make leaked credentials or authorized harmful API calls safe.
Native macOS process-tree containment and packaged-policy behavior remain explicit pre-release probes; offer a container/VM fallback or refuse untrusted code if unproven.
No default VM farm, Kubernetes, service mesh or multi-tenant runner platform is justified for the local MVP.

## 7. Coding workspaces, cancellation and terminal output

- Start with a user-chosen disposable copy; a worktree is convenient but not a security boundary and can expose shared Git metadata.
- Grant only that run's workspace; do not inherit host shell startup files, credential helpers, Git hooks, `.env`, npm credentials or package-manager user configuration.
- Treat dependency installation, tests and compilers as executable repository content; approval to read a repo is not approval to run its lifecycle scripts.
- Use isolated writable dependency caches and pinned toolchains; cache reuse is another mutable trust/input surface, not universally safe shared storage.
- Return patches/artifacts for review; apply through the trusted file broker after checking workspace revision and path identity, not by copying arbitrary worker paths.
- No pushes, releases, deploys or global installs through the coding shell's environment; expose separately approved scoped connectors if needed.

Cancellation is a broker state transition: revoke run capabilities first, stop new dispatch, abort requests, close automation contexts and terminate supervised work.
Keep an operation-level cancellation token; a stopped model stream is not proof that a tool or remote operation stopped.
Node documents that `subprocess.killed` means a signal was sent, not that a process terminated; killing a shell need not terminate its descendants.[16]
Use process groups/sessions plus bounded TERM→KILL and wait/reap checks; detached descendants can escape a process-group-only design.
On Linux, place workers in a non-migratable delegated cgroup and use `cgroup.kill`; the kernel documents descendant killing with concurrent-fork handling.[17]
On macOS, test fork/double-fork/daemonization and orphan recovery; do not advertise equivalent guarantees without evidence.
On restart, reconcile journaled child identities and owned resources; never blindly kill a reused PID or close an unrelated user's browser.
Cancellation cannot undo an already accepted payment/message; mark it `unknown` or `completed`, then reconcile rather than implying rollback.

Use bounded plain-text tool logs by default; sanitize control characters before display, persistence and model consumption.
If offering an interactive terminal, isolate its renderer and disable unnecessary clipboard/OSC/link integrations; links must pass a scheme/destination broker.
A terminal renderer is privileged UI: xterm.js warns that page JavaScript can acquire direct shell access and see terminal keystrokes.[18]
Do not put remote HTML, model-written HTML or skill previews in that origin; no `shell.openExternal` of unvalidated tool-provided strings.[19]

## 8. Durable execution without pretending “exactly once”

Keep one local SQLite journal initially; this is a proposed app-level design, not a claim that a runtime automatically makes external effects atomic.
Separate conversational checkpoints from effect records, approvals, leases and artifact references; never put provider secrets into serialized runtime state.
Suggested effect states: `prepared → awaiting_approval → authorized → dispatching → succeeded | failed | unknown`; cancellation is recorded separately.
Persist immutable intent, policy/artifact digests, account/target, approval consumption, attempt ID and idempotency key before the external call.
Persist the outcome/provider receipt after the call; the gap between external success and local commit is the unavoidable ambiguity to handle.

| Crash/retry case | Required recovery |
|---|---|
| Before durable authorization | No dispatch; request approval if still needed. |
| Authorized, never dispatched | Revalidate expiry, policy/account and cancellation before considering dispatch. |
| Dispatch begun, result not durably recorded | Mark `unknown`; query receipt/operation status, or reuse a provider-supported idempotency key. |
| Provider has no idempotency/status API | Do not blindly replay sends, purchases, deletes or browser clicks; surface uncertainty for reconciliation. |
| Confirmed success | Return stored receipt; retrying the model turn must not repeat the effect. |

An outbox ensures an intent can be retried; it cannot alone ensure an external non-idempotent operation happens once.
For file edits use expected-revision checks plus atomic replacement; for remote writes prefer APIs with explicit idempotency/conditional-write support.
LangGraph offers persistent checkpointers separately from memory stores; its in-memory savers lose checkpoints on process restart.[20]
Its interrupt docs explicitly state that resuming restarts the node and requires idempotent pre-interrupt effects; approval should precede the effect.[21]
Reuse these patterns or a proven adapter if already selected by the engine; do not add a second durable framework before a crash-recovery slice needs one.

## 9. Memory and skills: data cannot promote itself into authority

Agent Skills specifies `SKILL.md` frontmatter/body with optional scripts, references and assets; progressive disclosure is a context/loading mechanism.[10]
The optional `allowed-tools` field is experimental preapproval metadata, not an OS sandbox or an authorization decision that HeyNimbo must honor.[10]
Its client guidance explicitly identifies repository-level skills as potentially untrusted and recommends a project trust check.[11]

Proposed import path: inspect archive/path limits → safe YAML parse/schema validation → inert preview and source/license provenance → owner review → immutable installed digest.
Do not execute installation hooks or scripts while scanning; reject traversal/symlink escapes, oversized resources and metadata/control-character tricks.
Catalog descriptions can themselves carry injection; keep discovery inert and authority-neutral, not only the eventual skill body.
Skill scripts run in the same restricted worker as any untrusted code; scripts cannot obtain a stronger capability merely because they shipped beside Markdown.
Changes to scripts, instructions or tool requirements create a new reviewable version; signatures prove provenance/integrity, not harmlessness.
Learning may create **draft skills**, never silently replace approved skills or grant persistent permissions; show diffs, evidence and replay results first.

Keep task checkpoints, user preferences, retrieved facts and learned procedures as distinct local records with source, author, namespace, timestamps and trust class.
Scope retrieval by user/workspace/connector; keep explicit user statements separate from model summaries and web/tool-derived claims.
Use candidate → reviewed → active promotion, expiration/revalidation and deletion/tombstones; a summary must not erase provenance or turn an instruction into a fact.
No memory or retrieved skill may change the broker policy, approved endpoints, credential scopes or approval requirements.
Keep secrets out of prompts/embeddings/logs; deletion must also address derived indexes and backups under a documented retention policy.
AgentPoison demonstrates poisoning long-term memory/RAG; MINJA's latest fetched revision (**February 12, 2026**) studies query-only memory injection.[22][23]
These are evidence of an attack class, not a measured HeyNimbo failure rate or proof that prompt wrappers prevent it.

## 10. Evaluation and the local→self-host boundary

Use AgentDojo's executable prompt-injection benchmark as a reusable development baseline, then add HeyNimbo-specific broker/sandbox tests.[24]
Release gate: deterministic denial tests have **zero unauthorized effects** in the tested corpus; report task completion and attack success separately, not a single blended score.
Test malicious tool metadata, read-only lies, skill updates, poisoned retrieved memory, forged approvals and argument/account changes after approval.
Test symlink/race escapes, home/credential/profile reads, inherited FDs, network redirects/private IPs, socket access, daemonization and terminal-control payloads.
Fault-inject crashes immediately before/after dispatch and commit; assert no automatic replay of an unresolved non-idempotent action.
Test cancellation during model streaming, shell descendants, browser navigation and remote writes; verify actual cleanup and capability revocation.
Use synthetic secrets/accounts and a disposable browser profile; inspect attempted egress and OS denials, not just the assistant's final text.
Rerun this matrix for every engine, platform, package/sandbox-policy update and imported skill version; passing a benchmark is not universal security proof.

Start local: broker, SQLite, artifacts, secrets and authenticated browser stay on the owner's device; only chosen inference/connector data leaves it.
The existing provider design keeps plan tokens local and disallows a general-purpose plan-token proxy; do not export them to a self-host gateway.
Later single-owner self-hosting may move planning/journal/public-research workers; use separately authorized server credentials, not copied local provider/browser state.
A local agent initiates an authenticated encrypted connection to the server; requests still pass local approvals, resource checks, quotas and cancellation.
Bind user/device/run and operation digest end to end; no inbound unauthenticated shell/CDP port, ambient VPN trust or unrestricted “remote terminal” tunnel.
Keep capture, accessibility/input, local files and cookie-bearing browsing local by default; remote access is an individually granted connector, not full desktop ownership.
Multi-user tenancy, shared browser pools, automatic credential sync and privileged remote workers are explicitly outside the first self-host milestone.

## 11. Build versus reuse

| Component | Decision | Verified reuse/license and boundary |
|---|---|---|
| Browser transport and page automation | Reuse Playwright; evaluate selected Playwright MCP mechanics | Both Apache-2.0; still build the account/session/action broker.[1][3][25][26] |
| MCP wire protocol/auth plumbing | Reuse a pinned SDK, contract-test the actual revision | TypeScript SDK is in MIT→Apache-2.0 transition; inspect pinned files/notices, do not label all revisions MIT.[27] |
| Skill parsing/validation | Follow Agent Skills; use reference validator in development if useful | `skills-ref` declares Apache-2.0 and Python ≥3.11; do not add Python to the app solely for parsing.[10][28] |
| Native command containment | Spike `srt`; do not build a new sandbox kernel | Apache-2.0; configure fail-closed policy and test packaged behavior.[12][29] |
| Linux namespace primitive | Reuse bubblewrap as a separate native dependency | Source SPDX is LGPL-2.0-or-later; retain notices and review packaging obligations.[13][30] |
| Checkpoint/replay machinery | Reuse engine/runtime facilities; keep effect ledger app-owned | LangGraphJS is MIT if chosen; no requirement to adopt its hosted service.[20][21][31] |
| Prompt-injection evaluation | Reuse AgentDojo as development tooling | MIT; supplement with deterministic privilege-boundary tests.[24][32] |
| Policy, argument binding, secret access, cancellation | Build small HeyNimbo-owned broker/supervisor interfaces | Core product/security ownership; no prompt or third-party tool metadata substitutes for it. |

## 12. Ordered probes and unresolved ownership

| Milestone / owner | Acceptance or fallback |
|---|---|
| Local capability broker / app security owner | Reject mutated approvals and forged worker requests; no generic host-shell capability. |
| Platform sandbox / native owner | Prove secret/profile read, socket and descendant-process denial on packaged macOS; if not, disable untrusted code or require isolated fallback. |
| Browser adapter / browser owner | Anonymous context cannot access personal state; authenticated helper exposes no raw CDP/storage; account/tab changes invalidate grants. |
| Recovery slice / runtime owner | Kill/restart at each journal edge; unresolved send stays unknown until status/reconciliation, never automatically duplicates. |
| Skills + memory / agent owner | Malicious imports/retrieval cannot alter policy; learning produces drafts with reviewable provenance. |
| Dependency release / maintainers | Pin source versions, verify MCP 2026-07-28 compatibility and license/notices, including SDK transition and LGPL dependency packaging. |
| Self-host follow-up / owner | Threat-model one owner/device first; prove revoked device cannot dispatch and server never receives local cookies or plan tokens. |

No application code, dependency installation, real credentials, personal browser sessions or networked execution tests were changed/run for this report.

## Sources

[1] https://playwright.dev/docs/api/class-browsertype — Playwright BrowserType
[2] https://developer.chrome.com/blog/remote-debugging-port — Chrome remote-debugging profile restrictions
[3] https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md — Playwright MCP implementation README
[4] https://modelcontextprotocol.io/specification/2026-07-28 — MCP current specification 2026-07-28
[5] https://modelcontextprotocol.io/specification/2026-07-28/basic/transports — MCP transport overview
[6] https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http — MCP Streamable HTTP binding
[7] https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization — MCP HTTP authorization
[8] https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices — MCP security best practices
[9] https://modelcontextprotocol.io/specification/2026-07-28/server/tools — MCP tools and untrusted annotations
[10] https://agentskills.io/specification — Agent Skills specification
[11] https://agentskills.io/client-implementation/adding-skills-support — Agent Skills client integration and project trust
[12] https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/main/README.md — Sandbox Runtime primitives, defaults and limitations
[13] https://raw.githubusercontent.com/containers/bubblewrap/main/README.md — Bubblewrap policy responsibility
[14] https://developer.apple.com/documentation/security/app-sandbox.md — Apple App Sandbox documentation Markdown
[15] https://docs.docker.com/engine/security — Docker Engine security boundaries
[16] https://nodejs.org/api/child_process.html — Node child-process lifecycle and signals
[17] https://docs.kernel.org/admin-guide/cgroup-v2.html — Linux cgroup v2 process-tree termination
[18] https://xtermjs.org/docs/guides/security — xterm.js security
[19] https://www.electronjs.org/docs/latest/tutorial/security — Electron renderer and IPC security
[20] https://docs.langchain.com/oss/javascript/langgraph/persistence — LangGraph persistence
[21] https://docs.langchain.com/oss/javascript/langgraph/interrupts — LangGraph replay and interrupt side effects
[22] https://arxiv.org/abs/2407.12784 — AgentPoison paper, latest v1
[23] https://arxiv.org/abs/2503.03704 — MINJA paper, latest v5 revised 2026-02-12
[24] https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/README.md — AgentDojo evaluation implementation
[25] https://raw.githubusercontent.com/microsoft/playwright/main/LICENSE — Playwright license
[26] https://raw.githubusercontent.com/microsoft/playwright-mcp/main/LICENSE — Playwright MCP license
[27] https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/LICENSE — MCP TypeScript SDK licensing transition
[28] https://raw.githubusercontent.com/agentskills/agentskills/main/skills-ref/pyproject.toml — skills-ref package license and runtime
[29] https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/main/LICENSE — Sandbox Runtime license
[30] https://raw.githubusercontent.com/containers/bubblewrap/main/bubblewrap.c — Bubblewrap native source SPDX
[31] https://raw.githubusercontent.com/langchain-ai/langgraphjs/main/LICENSE — LangGraphJS license
[32] https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/LICENSE — AgentDojo license
[33] https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr — MCP multi round-trip requests breaking change
