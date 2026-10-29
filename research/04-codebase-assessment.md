# HeyNimbo: codebase assessment and harness-readiness gate

Date: October 29, 2026. Repository: `/Users/gauspeerzade/Documents/myprojects/heynimbo`.
Inspected baseline: `main` at `4eb07b65b65013c64945f9727627969ef8960797`; application sources were not changed.
Method: static definition-to-usage tracing, test-source inspection, tracked-file inventory, and read-only Git checks.
No Electron launch, microphone access, desktop capture, provider request, secret/profile access, install, test execution, or build was performed.
No `AGENTS.md` existed in repository ancestors or the repository traversal excluding dependency/build/Git directories; `research/AGENTS.md` was also absent immediately before writing.
Evidence references below are repository-relative `path:line-range`; conclusions and proposed changes are explicitly distinguished from implemented behavior.

## 1. Outcome

- **Keep the stack.** The inspected implementation already separates an Electron main process, narrow preloads, DOM/SVG/three.js renderers, SQLite history, SDK answer adapters, and Rust N-API OS services.
- Those boundaries are visible in `apps/desktop/electron.vite.config.ts:4-36`, `apps/desktop/src/main/windows.ts:37-55`, `apps/desktop/src/main/history.ts:9-41`, and `crates/heynimbo-native/src/lib.rs:1-15`.
- **This is an implemented screen-aware conversational companion, not an implemented general-purpose agent runtime.** Text/voice, answer streaming, local conversations, and bounded 2D/3D scene commands are connected end to end.
- Entry wiring: `apps/desktop/src/main/index.ts:75-96,133-182`; turn pipeline: `apps/desktop/src/main/voice/talk.ts:184-258`; rendering: `apps/desktop/src/renderer/overlay.ts:712-773,916-974`.
- **Missing harness work is a new execution/control plane**, not replacement of the presentation plane: engine lifecycle, executable tool registry, permissions/approvals, workspace isolation, run events, durable execution state, and cancellation beyond an answer stream.
- This absence is supported by the current app request union, provider invocation, turn schema, and native export surface, not merely by searching for roadmap words: `apps/desktop/src/shared/app.ts:28-55`, `apps/desktop/src/main/answer-provider.ts:43-73`, `crates/heynimbo-native/index.d.ts:12-116`.
- Do not treat a provider adapter, drawing `@command`, development evaluation branch, or OAuth client registration as an agent engine.
- No runtime quality, latency, visual correctness, live-provider compatibility, or passing-test baseline is claimed by this assessment.

## 2. Implemented versus aspirational architecture

| Area | Implemented evidence | Boundary / not yet implemented |
|---|---|---|
| Desktop shell | Home, Settings, tray/menu, notch peek, per-display overlays (`apps/desktop/src/main/app-shell.ts:94-159`; `apps/desktop/src/main/windows.ts:95-152,200-225`) | No task/approval/run inspector in the app contract (`apps/desktop/src/shared/app.ts:34-55`). |
| Answer providers | Seven provider IDs and SDK dispatch (`apps/desktop/src/shared/providers.ts:1-3`; `apps/desktop/src/main/answer-provider.ts:32-57`) | These are answer transports; no tool registry or iterative tool-result exchange is passed to `streamText`. |
| Scene protocol | Parsed sentence-associated marks, cards, models, references and resource limits (`apps/desktop/src/shared/beats.ts:147-229`; `apps/desktop/src/shared/model-protocol.ts:3-9,186-208`) | Not the full planned lifetime/edit/session protocol described in `docs/architecture.md:24-32`. |
| Native services | Modifier observation, capture/permissions, on-device listening and language detection (`crates/heynimbo-native/index.d.ts:12-116`) | No exported accessibility tree, text insertion, input actuation, credential broker, or browser-native-messaging registration. |
| Storage | Settings, encrypted provider/OAuth records, conversations/turns/FTS (`apps/desktop/src/main/settings.ts:40-59`; `apps/desktop/src/main/secrets.ts:6-23`; `apps/desktop/src/main/history.ts:17-41`) | No durable engine sessions, tools, approvals, artifacts, routines, or workspaces in this schema. |

- `docs/architecture.md:6,15-18` describes a capability broker, agent host, MCP client and engine adapter, including a first pinned Codex app-server **pending contract tests**; these are design intentions, not implementation evidence.
- Its native responsibilities also exceed actual exports: secrets currently use Electron `safeStorage`, not Rust (`apps/desktop/src/main/secrets.ts:3-21`).
- Its default JSON-lines `say/marks/tool` voice description is not the current wire format: the live prompt requests prose plus line-leading `@` drawing data (`docs/architecture.md:20-22`; `apps/desktop/src/main/voice/brain.ts:12-41`).
- Its late-roadmap “Depth: 3D” is behind the code: model cards, part preparation, animation and disposal are implemented (`docs/architecture.md:34-42`; `apps/desktop/src/renderer/overlay.ts:344-453,782-800`).
- README is more accurate about current scope: implemented voice/history/provider selection/drawing, with other detected gestures not full features (`README.md:3-13`).

## 3. Real application entry and shell ownership

- Packaged main entry is `out/main/index.js`; build uses electron-vite; tests use Vitest (`apps/desktop/package.json:7-14`).
- Four independently bundled preloads and six renderer pages are explicit build inputs; the audio worklet remains a file because of CSP (`apps/desktop/electron.vite.config.ts:6-32`).
- Main configures development branches before taking the single-instance lock; normal startup proceeds through `app.whenReady` (`apps/desktop/src/main/index.ts:99-118`).
- Normal startup hides the Dock icon, creates notch/overlays, reconciles display changes, and starts cursor following (`apps/desktop/src/main/index.ts:115-129`).
- The drawing demo returns before constructing the normal voice/credential pipeline; other gallery/eval/show/preview branches are also early branches (`apps/desktop/src/main/index.ts:100-118,130`).
- **Do not assume every debug path is profile-isolated.** The eval/live-show branch explicitly shares the normal profile and instance lock (`apps/desktop/src/main/index.ts:106-109`; `apps/desktop/src/main/index.test.ts:114-142`).
- `AppShell` constructs `SettingsStore` and persistent `HistoryRepository` under Electron `userData`; `ConversationController` is shared by Home, peek and voice (`apps/desktop/src/main/app-shell.ts:45-47`).
- Shell actions inject ask/stop/clear, connection operations, permission summaries and settings callbacks rather than importing the whole voice runtime (`apps/desktop/src/main/app-shell.ts:15-25`; `apps/desktop/src/main/index.ts:135-156`).
- A typed question follows `home.ask` → renderer request helper → preload invoke → validated main handler → injected `talk.askText` (`apps/desktop/src/renderer/home.ts:104-111`; `apps/desktop/src/renderer/app-dom.ts:4-7`; `apps/desktop/src/preload/app.ts:4-9`; `apps/desktop/src/main/app-shell.ts:59-64,166-168`; `apps/desktop/src/main/index.ts:135-139`).
- Home clears the draft only on `{ accepted: true }`; `TalkSession.askText` creates its history record before returning acceptance, while capture/answer completion remains asynchronous (`apps/desktop/src/renderer/home.ts:104-108`; `apps/desktop/src/main/voice/talk.ts:89-105`).
- Connection changes close the old session, reset overlay listening, construct a new session, update answer readiness and publish (`apps/desktop/src/main/index.ts:158-163`).
- New/open-conversation actions stop the current response before switching ownership; snapshots are coalesced at 250 ms (`apps/desktop/src/main/app-shell.ts:83-95,131-132`).
- Shell busy state is currently derived from status-label text, not a typed task state machine (`apps/desktop/src/main/app-shell.ts:93`). This is a bounded refactor seam, not evidence of a present failure.
- Before quit, main stops gestures and closes talk/audio/overlays/peek/notch/history; closing all windows intentionally does not quit this menu-bar-style app (`apps/desktop/src/main/index.ts:169,185-187`).
- Shell owns menu/tray/preferences/window presentation and command dispatch together; an added harness should not make it also own subprocesses and tool authorization (`apps/desktop/src/main/app-shell.ts:94-227`; architectural recommendation).

## 4. IPC and security boundaries to preserve

- Browser windows use `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and a selected preload (`apps/desktop/src/main/windows.ts:37-47`).
- These Chromium renderer sandboxes are **not** future workspace/process sandboxes for tools; no OS execution isolation is established by those flags.
- `protectPage` blocks renderer navigation, redirects and new windows; main owns document loading (`apps/desktop/src/main/page-security.ts:14-22`; `apps/desktop/src/main/windows.ts:50-55`).
- `isPageSender` checks exact `WebContents`, exact main frame and expected document URL, permitting anchors but not substituted query/document URLs (`apps/desktop/src/main/page-security.ts:24-31`).
- App commands accept only Home/Settings senders; key-detail requests additionally require Settings (`apps/desktop/src/main/app-shell.ts:59-63`).
- Main validates unknown payloads, strict fields, bounded text, settings categories and permission enums before dispatch (`apps/desktop/src/main/app-requests.ts:5-46`).
- Preloads expose fixed methods/channels, not arbitrary `ipcRenderer` or filesystem/process APIs (`apps/desktop/src/preload/app.ts:4-16`; `apps/desktop/src/preload/index.ts:11-22`; `apps/desktop/src/preload/voice.ts:4-15`; `apps/desktop/src/preload/setup.ts:5-11`).
- Notch requests also use exact-page authentication plus payload parsing; its Escape shortcut exists only while peek is expanded (`apps/desktop/src/main/notch-peek.ts:17-35,48-64`).
- Therefore current Escape behavior is **not a global, always-available emergency stop for a future background tool runner**; Home also handles Escape only in its own document (`apps/desktop/src/renderer/home.ts:120-127`).
- Setup authenticates its exact page, parses connection commands, refuses credential hints, and removes its invoke handler when closed (`apps/desktop/src/main/setup-window.ts:25-34`).
- Audio permission handlers restrict media requests to the hidden audio `WebContents`, audio-only request types and valid usage descriptions (`apps/desktop/src/main/audio-window.ts:22-30`).
- **Boundary consistency target:** audio events currently check sender identity only and use a TypeScript payload type; overlay events identify registered contents, with dedicated runtime validation for interactive-region payloads (`apps/desktop/src/main/audio-window.ts:31-33`; `apps/desktop/src/main/windows.ts:15-20,173-196`).
- Extending those channels with privileged actions should first add exact-frame/document checks and full event parsers; this is defense-in-depth, not a demonstrated exploit claim.
- Renderer Home uses CSP restricting scripts/styles to self; audio similarly restricts scripts (`apps/desktop/src/renderer/home.html:2`; `apps/desktop/src/renderer/voice.html:5`). Do not load agent/provider pages into these privileged app documents.
- Text rendering uses `textContent`; drawing preview creates SVG data rather than embedding desktop images (`apps/desktop/src/renderer/app-dom.ts:8-10`; `apps/desktop/src/renderer/turn-transcript.ts:15,34-44`; `apps/desktop/src/renderer/scene-thumbnail.ts:28-49`).
- Native confirmation defaults to Cancel for destructive history/settings/connection changes; those dialogs are not reusable proof of per-tool authorization (`apps/desktop/src/main/app-shell.ts:179,185-207,221-225`).

## 5. Providers, credentials and billing-path behavior

- `Connections` owns provider keys, endpoint-bound compatible credentials, model catalogs and ChatGPT auth; settings store only provider/model/effort/baseURL selections (`apps/desktop/src/main/connections.ts:11-38`; `apps/desktop/src/shared/providers.ts:8-9`).
- `answer()` snapshots the selected configuration into an `AnswerConnection`; credential resolution remains an async main-process closure (`apps/desktop/src/main/connections.ts:89-111`; `apps/desktop/src/main/answer-provider.ts:12-18`).
- Catalog discovery validates keys/models before saving or using custom models; model capabilities determine whether screen context is available (`apps/desktop/src/main/connections.ts:71-87,101-109,121-135`).
- SDK dispatch covers OpenAI/ChatGPT Responses, Anthropic, Google, DeepSeek, OpenRouter and OpenAI-compatible chat (`apps/desktop/src/main/answer-provider.ts:32-40`).
- The adapter normalizes provider streams into **text deltas only**, checks terminal completion, reports optional token usage, disables retries, and sanitizes outward errors (`apps/desktop/src/main/answer-provider.ts:43-92`).
- `streamText` receives messages/instructions/options/abort signal, not tools, tool execution callbacks or a multi-step loop (`apps/desktop/src/main/answer-provider.ts:48-57`).
- History is text question/answer exchanges; only the current screenshot is attached, gated by `connection.vision` (`apps/desktop/src/main/answer-provider.ts:21-30`).
- Recommended models and “tested” hints are code/config facts, not verification of current provider offerings or live account eligibility (`apps/desktop/src/shared/providers.ts:39-66`; `apps/desktop/src/main/model-catalog.ts:11-23`).
- Compatible endpoints permit HTTPS or exact HTTP `localhost`/`127.0.0.1`, rejecting embedded credentials, query and fragment; credential-bearing fetches reject redirects (`apps/desktop/src/main/provider-settings.ts:3-8,63-64`).
- Compatible keys are bound to normalized endpoint URLs, including paths; an endpoint change clears the selected compatible model rather than forwarding the previous endpoint's key (`apps/desktop/src/main/connections.ts:24-30,64-66,76-80,124-127`).
- Local Ollama discovery uses `/api/tags` and `/api/show` capability metadata; other compatible endpoints use `/models`, with bounded discovery pagination (`apps/desktop/src/main/model-catalog.ts:25-57`).
- Saving an OpenAI key does not silently change answer billing selection except in explicit first-run selection mode (`apps/desktop/src/main/connections.ts:133-145`). Preserve that distinction when adding an engine.
- Voice choice is independent: a saved OpenAI key wins; otherwise authorized on-device speech is used, otherwise voice is unavailable (`apps/desktop/src/main/voice/engine.ts:4-16`; `apps/desktop/src/main/index.ts:75-85`).
- ChatGPT support is a native OAuth/Responses answer path, not a Codex subprocess: PKCE/state/nonce, loopback callback, JWT verification, scopes, refresh rotation and local sign-out are implemented (`apps/desktop/src/main/chatgpt-auth.ts:16-98,132-199`).
- OAuth discovery endpoints are issuer-constrained; callback state/registration/code are checked; refresh is coalesced and remote revocation uncertainty is reported honestly (`apps/desktop/src/main/chatgpt-auth.ts:32-43,100-130,160-199`).
- Secrets are encrypted `safeStorage` files with owner-only atomic replacement; unavailable encryption or `basic_text` storage is rejected on save (`apps/desktop/src/main/secrets.ts:6-23`). No actual secret files were read.
- General snapshots exclude raw credentials; only Settings-specific details expose at most a four-character suffix and saved date, never OAuth token hints (`apps/desktop/src/main/connections.ts:39-58,113-115`; `apps/desktop/src/main/app-shell.ts:61-62`).
- A future engine must not inherit every saved provider credential or reinterpret an answer-provider change as authorization for shell/network tools; this is a proposed new boundary.

## 6. History, privacy and durable-state limits

- `HistoryRepository` uses synchronous `node:sqlite`, foreign-key cascades, WAL, secure deletion, FTS5 triggers and schema version 2 (`apps/desktop/src/main/history.ts:1-41`).
- Disk DB files are mode `0600`; new parent directories request `0700`; settings writes use a temporary file, fsync and rename (`apps/desktop/src/main/history.ts:11-20`; `apps/desktop/src/main/settings.ts:47-57`).
- Current schema stores conversation metadata and turn question/answer/mode/state/error/scene/screen-used/provider/model, not screenshot/audio blobs (`apps/desktop/src/main/history.ts:23-38`).
- Persistent history is not encrypted by this repository; filesystem restrictions and `secure_delete` are not a full at-rest encryption or forensic-erasure guarantee (`apps/desktop/src/main/history.ts:13-20`; distinction, not a new bug claim).
- A turn begins transactionally in `interrupted` state before dispatch; updates retain partial answer/scene, and completion/error state is explicit (`apps/desktop/src/main/history.ts:69-85`).
- Save-off or retention `0` routes new conversations to an in-memory repository; this is not deletion of existing disk history (`apps/desktop/src/main/conversations.ts:7-12`; `apps/desktop/src/main/history.ts:98-100`).
- Settings changes stop/reset conversation ownership when persistence mode changes; shorter retention requires confirmation (`apps/desktop/src/main/app-shell.ts:182-195`).
- Context is the last six completed exchanges excluding the active turn; restart starts without an implicitly resumed current conversation (`apps/desktop/src/main/history.ts:57-58`; `apps/desktop/src/main/conversations.ts:7,35-36`).
- Sidebar queries cap at 200 conversations; search caps at 100 hits and safely tokenizes input; full current transcript/scene reads are not similarly paginated (`apps/desktop/src/main/history.ts:48-67,91-96`).
- Retention prunes by conversation update time, including pinned conversations; deletes cascade through turns/FTS and trigger WAL checkpointing (`apps/desktop/src/main/history.ts:24,37,89-104`).
- Active-turn updates/finish are identity-gated and retain their original repository, preventing persistence-mode selection from changing an active record's target (`apps/desktop/src/main/conversations.ts:38-62`).
- Unsupported schema versions are rejected, not migrated (`apps/desktop/src/main/history.ts:18-19`). New agent tables require an explicit compatibility/migration decision, not an assumed existing migration framework.
- Scenes store generated marks and capture geometry, not pixels; marks can nevertheless contain sensitive text inferred from the screen (`apps/desktop/src/shared/app.ts:17-31`; privacy implication).
- Tool outputs, paths, commands, approvals and artifacts would introduce new sensitive data classes and retention requirements; do not put arbitrary execution logs into the current answer field.

## 7. Voice and answer trace sufficient for extension decisions

- Global gesture defaults map talk to Control+Option, with additional detected text/always-on/dictation/hands-free gestures (`apps/desktop/src/main/gestures.ts:18-28`).
- Only talk drives an implemented session; other gesture phases currently present notch labels (`apps/desktop/src/main/index.ts:34-71`). Detected gestures do not establish text insertion or always-on listening.
- Talk press clears old drawing, shows listening, interrupts the old turn, starts ears, captures once when vision is enabled, and starts the tagged microphone (`apps/desktop/src/main/index.ts:48-59`; `apps/desktop/src/main/voice/talk.ts:70-86`).
- Text requests join the same answer pipeline without requiring a microphone or available speech backend (`apps/desktop/src/main/voice/talk.ts:89-105,213-217,255`).
- Hidden audio owns `getUserMedia`; commands serialize microphone start/stop and flush the worklet remainder before closing tracks/context (`apps/desktop/src/renderer/voice.ts:25-84`).
- Audio is mono PCM16 at 24 kHz; the worklet chunks and flushes samples; microphone events carry recording IDs (`apps/desktop/src/shared/ipc.ts:60-87`; `apps/desktop/src/renderer/pcm-capture-worklet.js:1-38`).
- Release stops capture audio, waits for stop acknowledgment or timeout, finishes transcription, saves the question and starts answering (`apps/desktop/src/main/voice/talk.ts:117-126,174-188`).
- OpenAI ears reuse a warm transcription socket and match acknowledgments/late transcripts by committed item; mouth correlates line responses and cancels even before response acknowledgment (`apps/desktop/src/main/voice/ears.ts:21-29,53-63,103-117`; `apps/desktop/src/main/voice/mouth.ts:60-66,110-127`).
- Realtime transport stays in main and uses the OpenAI WSS endpoint; this is separate from SDK answer transport (`apps/desktop/src/main/openai/realtime.ts:16-31,60-69`).
- Built-in ears feed the same PCM into one native session per hold and generation-gate late completion; built-in mouth queues local speech in the audio renderer (`apps/desktop/src/main/voice/builtin-ears.ts:14-43`; `apps/desktop/src/main/voice/builtin-mouth.ts:4-13`).
- System speech selects installed local-service voices only and emits the same playback-start/line/drain lifecycle; mute preserves drawing/completion events (`apps/desktop/src/renderer/system-speech.ts:5-14,44-65,81-106,123-129`).
- Answer text passes through `BeatParser`; accepted model/part lines may prepare geometry early, but draw waits for the associated sentence's audio start (`apps/desktop/src/main/voice/talk.ts:191-202,213-251`; `apps/desktop/src/main/voice/talk.ts:157-161`).
- Playback queues PCM back-to-back and reports line timing; final turn completion waits for drain, or finishes immediately after answer/drawing dispatch when no mouth exists (`apps/desktop/src/renderer/voice.ts:104-130,179-196`; `apps/desktop/src/main/voice/talk.ts:164-168,250-257`).
- Saves are coalesced at 250 ms, drawing command lines are stripped from stored answer text, and interrupted/error outcomes retain partial work (`apps/desktop/src/main/voice/talk.ts:206-211,260-271`).
- Interruption aborts network response work and cancels ears/mouth/mic/playback through nested cleanup even if persistence fails; stale drawing checks current turn identity (`apps/desktop/src/main/voice/talk.ts:274-320`).
- This is one foreground turn, not multiplexed background runs; extending it directly into a multi-agent scheduler would couple independent tool lifetimes to audio drain.

## 8. Native capabilities and OS limitations

- Native `GestureMonitor.start` creates a pure Rust detector thread, then an OS input source; failure/stop joins worker threads (`crates/heynimbo-native/src/lib.rs:76-123`).
- macOS uses a listen-only CGEventTap; callbacks translate modifiers/key/pointer activity and forward to the detector instead of running JS on the OS callback (`crates/heynimbo-native/src/platform/macos.rs:73-108,131-156`; `crates/heynimbo-native/src/runtime.rs:14-45`).
- The detector handles hold cancellation, shortcut contamination and multi-tap deadlines; it is reusable independently of Electron (`crates/heynimbo-gestures/src/lib.rs:147-199,225-315`).
- Capture runs as an N-API async task, JPEG-encodes in memory and returns display geometry/cursor/pixel dimensions (`crates/heynimbo-native/src/lib.rs:198-270`).
- ScreenCaptureKit explicitly excludes this process's application windows; capture selects cursor display first and normally truncates to one display (`crates/heynimbo-native/src/capture/macos.rs:20-69`).
- App capture requests a 1280-pixel longest edge and catches failures, allowing text-only fallback; only an unpackaged debug directory enables JPEG writes (`apps/desktop/src/main/capture.ts:24-44`; `apps/desktop/src/main/dev.ts:3-10`).
- Startup may request Input Monitoring and Screen Recording permissions; that is distinct from a continuous capture session (`apps/desktop/src/main/gestures.ts:33-46`; `apps/desktop/src/main/index.ts:171-178`).
- Built-in recognition checks bundle usage strings before authorization APIs, requires on-device recognition and consumes supplied PCM rather than opening another audio device (`crates/heynimbo-native/src/speech.rs:1-2,26-69`; `crates/heynimbo-native/src/speech/macos.rs:59-88,205-209,222-255`).
- Microphone metadata guarding also exists in Electron before macOS authorization queries; speech authorization is an explicit connection action (`apps/desktop/src/main/audio-window.ts:50-61`; `apps/desktop/src/main/connections.ts:149`).
- Capture backend targets macOS 14+ APIs (`crates/heynimbo-native/src/capture/macos.rs:1-3`; `crates/heynimbo-native/Cargo.toml:26`). This is not proof of compatibility on every later macOS version.
- Non-macOS gesture/capture backends return explicit “not implemented” errors; their permission probes return true, so those probes alone cannot indicate feature support (`crates/heynimbo-native/src/platform/mod.rs:9-35`; `crates/heynimbo-native/src/capture/mod.rs:9-26`).
- Built-in listening is unavailable off macOS (`crates/heynimbo-native/src/speech.rs:59-69,113-130`). Do not advertise a complete Windows/Linux voice/screen companion from the shared TypeScript shell.
- N-API target declarations include macOS ARM64/x64 and Windows x64, and Windows dependencies exist, but these are not implemented Windows OS backends (`crates/heynimbo-native/package.json:8-14`; `crates/heynimbo-native/Cargo.toml:28-29`).
- Current distribution script is macOS ARM64 directory output with ad-hoc identity and hardened runtime disabled; signed/notarized cross-platform distribution is not established here (`apps/desktop/package.json:14,68-83`).
- Accessibility observation/insertion and consented OS actuation require new platform capability implementations; existing input monitoring is observation, not input driving.

## 9. Scene/drawing preservation boundary

- `Mark` is a declarative union; parsers validate/clamp numbers, shapes, references and budgets rather than execute model-authored code (`apps/desktop/src/shared/beats.ts:17-36,54-105,202-220`).
- Preserve separate budgets: 20 non-model commands, three shared cards, eight steps/card; model limits include two models, 40 parts including copies, repeats/points/tags/vertices (`apps/desktop/src/shared/beats.ts:206-218`; `apps/desktop/src/shared/model-protocol.ts:3-9,186-205`).
- Screen pixels map through captured frame/image geometry into per-display overlay CSS coordinates; negative display origins and card minimum sizing are handled (`apps/desktop/src/main/overlay-geometry.ts:18-71`).
- One overlay per connected display is reconciled by `sync`; only one display owns the buddy; drawing pins buddy ownership until idle (`apps/desktop/src/main/windows.ts:155-169,200-225,240-290`).
- Overlay clear increments an epoch, resets interaction regions and restores click-through; stale stroke events do not start scribble audio (`apps/desktop/src/main/windows.ts:173-189,317-325`).
- Renderer prepares model stages/parts separately from reveal, then adopts prepared resources on a beat (`apps/desktop/src/renderer/overlay.ts:367-453`; `apps/desktop/src/renderer/model-stage.ts:198-216`).
- Beat scheduling accounts for queue delay, travel and drawing budget; card drag/close removes owned animation/resources without clearing unrelated cards (`apps/desktop/src/renderer/overlay.ts:751-773,829-887`).
- Explicit clear disposes live/prepared model stages and releases pointer capture; `ModelStage.dispose` is idempotent and releases GPU resources/context (`apps/desktop/src/renderer/overlay.ts:782-800`; `apps/desktop/src/renderer/model-stage.ts:626-634`).
- Saved scene previews are static SVG previews on blank paper, not live replay of the complete interactive 3D scene (`apps/desktop/src/renderer/scene-thumbnail.ts:28-51`; `apps/desktop/src/renderer/turn-transcript.ts:40-45`).
- Planned stable-id erase/recolor/move semantics for arbitrary marks, capture IDs and lifetime classes are not present in `DrawingScene`; model-part `@move` is animation, not that general edit protocol (`apps/desktop/src/shared/app.ts:17-24`; `apps/desktop/src/shared/model-protocol.ts:26-29`; `docs/architecture.md:28-32`).

## 10. Gate: what a general tool-running harness still needs

The following are **new requirements**, not claims that current conversational scope is broken. The limiting contracts are `apps/desktop/src/shared/app.ts:28-55`, `apps/desktop/src/main/answer-provider.ts:43-73`, and `crates/heynimbo-native/index.d.ts:12-116`.

1. An engine port with negotiated/versioned `start/turn/steer/interrupt/events/approvals`, lifecycle supervision, restart policy and contract tests; there is no implemented Codex/Claude engine to “enable.”
2. A run coordinator independent of microphone and playback: explicit run/step IDs, state transitions, foreground/background ownership, ordered typed events and task completion separate from speech completion.
3. A validated executable tool registry: typed arguments/results/errors, caller identity, deadlines, cancellation, output limits and safe structured error redaction; drawing marks are not tools.
4. Workspace-scoped execution: explicit cwd/roots, canonical path and symlink policy, scoped environment, controlled file/process/network access, and a selected actual isolation mechanism.
5. A capability/approval broker in trusted code: read/write/execute/network/screen-drive/spend categories, resource scopes, expiration and revocation; prompts alone cannot grant privileges.
6. A user-facing approval protocol and UI: exact action/resource consequences, deny/default-cancel, one-shot versus bounded session approval, no hidden expansion of consent, durable decision attribution.
7. Hard execution cancellation: stop child process trees/connectors, invalidate pending approvals/events and reconcile interrupted side effects; current `AbortSignal` only covers the answer pipeline.
8. An emergency-stop policy across focused windows and background work; the existing peek-only global Escape registration is not that facility.
9. Durable runs/tool invocations/approval decisions/artifact references and crash recovery, with schema compatibility, retention, size limits and sensitive-output handling.
10. MCP/connector client lifecycle and trust boundaries if selected: discovery, validated schemas, server identity/configuration, auth scope, transport/process supervision and policy checks on each invocation.
11. Credential delegation separate from answer selection: no automatic access to all saved keys, no secrets in renderer/run events/logs, and endpoint-bound scoped credentials for connectors.
12. Explicit observation/actuation services for screen/browser/files: provenance, freshness, session scope and re-authorization for new surfaces; capture is not permission to click/type.
13. Budget enforcement for model steps, tool duration/output, token/cost usage and retries; the current optional usage callback is not a durable budget system (`apps/desktop/src/main/answer-provider.ts:16-19,67-71`).
14. A testable first safe execution slice: synthetic/read-only tool, mocked engine and policy denials, replayable event trace, cancellation/crash tests, then carefully approved real side effects.

## 11. Bounded refactors, risks and preservation requirements

| Target | Keep | Bounded change / reason |
|---|---|---|
| Composition root | Existing startup, lifecycle, platform permission and connection selection | Inject an optional run service beside current actions, not executable tools inside renderer IPC (`apps/desktop/src/main/index.ts:133-182`). |
| Turn orchestration | Ears/mouth/audio adapters and speech/drawing timing | Extract a provider-neutral answer/event runner from `TalkSession.respond`; let conversation/voice subscribe without tying task completion to playback (`apps/desktop/src/main/voice/talk.ts:191-258`). |
| Shell state | Home/Settings/peek/tray behavior and narrow request vocabulary | Replace label-derived busy state with typed activity/run state while preserving existing snapshot UI during migration (`apps/desktop/src/main/app-shell.ts:75-93`). |
| Security | Exact-page guards, strict parsers, no redirects, endpoint-bound keys, safeStorage | Apply consistent validation/disposal to audio/overlay IPC before adding privileged event variants (`apps/desktop/src/main/audio-window.ts:31-33,42`; `apps/desktop/src/main/windows.ts:173-197,328-332`). |
| Storage | SQLite/FTS, temporary mode, partial-turn recording, explicit retention | Add separate bounded execution tables/projections and a deliberate migration policy; profile before moving synchronous queries to a worker (`apps/desktop/src/main/history.ts:17-41,61-85`). |
| Scene plane | Bounded declarative marks, geometry mapping, warm/prepared model stages | Keep a stable draw/prepare/clear facade; do not make scene text a command execution transport (`apps/desktop/src/main/voice/talk.ts:29-35`). |

- **Risk, not measured bug:** synchronous DB queries, JSON scene serialization and whole-current-transcript snapshots share main with orchestration; richer tool/event logs increase this workload (`apps/desktop/src/main/history.ts:61-83`; `apps/desktop/src/main/app-shell.ts:75-91`).
- **Risk, not observed leak:** audio/overlay IPC listeners are registered in constructors while close destroys windows without explicit matching listener removal; revisit ownership before repeated service creation/hot restart (`apps/desktop/src/main/audio-window.ts:31-42`; `apps/desktop/src/main/windows.ts:173-197,328-332`).
- **Risk, not exploit claim:** screenshots and tool-returned content are untrusted model context; adding an executable loop requires policy enforcement outside model interpretation, even though current drawing data is bounded.
- Preserve new-turn interruption, late-transcript isolation, capture cancellation guards, partial/error outcomes, and cleanup despite storage failure (`apps/desktop/src/main/voice/talk.test.ts:20-102`; `apps/desktop/src/main/voice/ears.test.ts:19-37`).
- Preserve no-capture/non-vision behavior, independent voice/answer billing, local-only built-in speech, mute/drain behavior and permission-description guards (`apps/desktop/src/main/voice/talk.test.ts:125-150`; `apps/desktop/src/main/connections.test.ts:15-24,52-61`; `apps/desktop/src/main/audio-window.test.ts:19-45`).
- Preserve screen-image/audio non-persistence, temporary-mode isolation, provider/model attribution, retention including pins, FTS delete cascades and restart continuity only on explicit open (`apps/desktop/src/main/history.test.ts:9-99`; `apps/desktop/src/main/conversations.test.ts:6-64`).
- Preserve drafts until acknowledgment, stable transcript nodes/selection, search invalidation, click-through region limits, epoch clearing and model disposal; these are existing behavior contracts, not cosmetic details (`apps/desktop/src/renderer/home.test.ts:54-109`; `apps/desktop/src/main/overlay-follow.test.ts:105-210`; `apps/desktop/src/renderer/overlay.test.ts:168-205,324-337`).
- No replacement of Electron, TypeScript, Rust, SQLite, SDK adapters or three.js is justified by these integration gaps; isolate the new trusted execution service and revisit infrastructure only against measured constraints.

## 12. Existing tests and what remains unverified

- Root `test` delegates workspace JS tests then Rust workspace tests; desktop uses `vitest run` (`package.json:10-15`; `apps/desktop/package.json:8-14`). No suite was executed in this inspection.
- Security sources cover unknown/malformed commands, exact sender/frame/URL, navigation/popup rejection, restricted details, destructive confirmation and metadata-gated media permissions (`apps/desktop/src/main/app-requests.test.ts:5-19`; `apps/desktop/src/main/page-security.test.ts:9-35`; `apps/desktop/src/main/app-shell.test.ts:29-115`; `apps/desktop/src/main/audio-window.test.ts:19-45`).
- Provider tests use synthetic credentials and injected transports for each adapter, terminal stream failures, screenshot omission and redaction; they do not verify live account eligibility (`apps/desktop/src/main/answer-provider.test.ts:4-130`).
- Connection/OAuth tests exercise billing separation, endpoint binding, discovery, hints, PKCE/state/JWT, refresh rotation and sign-out uncertainty (`apps/desktop/src/main/connections.test.ts:15-229`; `apps/desktop/src/main/chatgpt-auth.test.ts:24-156`).
- History tests cover schema/reopen, owner-only file, FTS, delete/prune behavior, attribution, temporary mode and bounded context; voice tests cover cancellation, partial outcomes, pacing/preparation and save coalescing (`apps/desktop/src/main/history.test.ts:8-101`; `apps/desktop/src/main/conversations.test.ts:6-65`; `apps/desktop/src/main/voice/talk.test.ts:20-242`).
- Stalled OpenAI/Anthropic fetch cancellation is tested through the real answer-adapter path with injected fetch (`apps/desktop/src/main/voice/talk-provider.test.ts:8-34`).
- Scene test sources include parser/reference/resource limits, timeline budgeting, retained cards, procedural geometry/fuzzing, model sections, stage interaction/disposal and system-speech lifecycle; title-index inspection is distinguished from full-body inspection below.
- Rust has pure gesture/geometry/JPEG/PCM/usage-string tests and detector-thread tests (`crates/heynimbo-gestures/src/lib.rs:356-648`; `crates/heynimbo-native/src/capture/mod.rs:110-195`; `crates/heynimbo-native/src/speech.rs:161-205`; `crates/heynimbo-native/src/runtime.rs:49-103`).
- **Test safety caveat:** the macOS input start/stop test actually attempts event-tap creation and can short-circuit on failure; it is not a purely mocked integration test (`crates/heynimbo-native/src/platform/macos.rs:188-205`).
- Mocks and source-level assertions do not prove TCC flows, real microphone/installed voices, capture exclusion pixels, mixed-DPI Spaces behavior, GPU visuals, packaged signing or provider service compatibility.
- A future harness needs new engine/MCP contract, authorization-denial, workspace escape, subprocess termination, replay/crash recovery and privacy/redaction tests; existing conversational tests cannot certify nonexistent execution behavior.

## 13. Exact inspection manifest

Full-body reads (paths below are exact; grouped by directory to avoid repeated prefixes):
- Root: `README.md`, `package.json`, `Cargo.toml`, `docs/architecture.md`.
- `apps/desktop/`: `package.json`, `electron.vite.config.ts`.
- `apps/desktop/src/main/`: `index.ts`, `app-shell.ts`, `app-requests.ts`, `page-security.ts`, `windows.ts`, `notch-peek.ts`, `setup-window.ts`, `audio-window.ts`, `capture.ts`, `gestures.ts`, `connections.ts`, `provider-settings.ts`, `secrets.ts`, `settings.ts`, `history.ts`, `conversations.ts`, `answer-provider.ts`, `model-catalog.ts`, `chatgpt-auth.ts`, `dev.ts`, `dev-profile.ts`, `lifecycle.ts`.
- `apps/desktop/src/main/openai/`: `realtime.ts`.
- `apps/desktop/src/main/voice/`: `talk.ts`, `brain.ts`, `engine.ts`, `ears.ts`, `mouth.ts`, `builtin-ears.ts`, `builtin-mouth.ts`.
- `apps/desktop/src/shared/`: `app.ts`, `ipc.ts`, `providers.ts`, `beats.ts`, `model-protocol.ts`.
- `apps/desktop/src/preload/`: `app.ts`, `index.ts`, `setup.ts`, `voice.ts`.
- `apps/desktop/src/renderer/`: `home.ts`, `home.html`, `voice.ts`, `voice.html`, `pcm-capture-worklet.js`, `system-speech.ts`, `app-dom.ts`, `turn-transcript.ts`, `scene-thumbnail.ts`.
- `apps/desktop/src/main/`: `page-security.test.ts`, `app-requests.test.ts`, `app-shell.test.ts`, `index.test.ts`, `audio-window.test.ts`, `history.test.ts`, `conversations.test.ts`, `connections.test.ts`, `provider-settings.test.ts`, `secrets.test.ts`, `chatgpt-auth.test.ts`, `answer-provider.test.ts`, `overlay-follow.test.ts`.
- `apps/desktop/src/main/voice/`: `talk.test.ts`, `talk-provider.test.ts`.
- `crates/heynimbo-native/`: `Cargo.toml`, `package.json`, `index.js`, `index.d.ts`.
- `crates/heynimbo-native/src/`: `lib.rs`, `runtime.rs`, `speech.rs`, `platform/mod.rs`, `platform/macos.rs`, `capture/mod.rs`, `capture/macos.rs`, `speech/macos.rs`.
- `crates/heynimbo-gestures/src/`: `lib.rs` (read across two contiguous ranges).

Targeted reads/search-only inspection, not claims of full-body review:
- `apps/desktop/src/main/overlay-geometry.ts` was read in full; `apps/desktop/src/renderer/overlay.ts` was inspected through definition/use searches and body ranges `326-460`, `712-974`.
- `apps/desktop/src/renderer/model-stage.ts`: definition/use search plus body ranges `156-280`, `620-636`.
- Additional test-body ranges: `apps/desktop/src/main/voice/ears.test.ts:1-50`, `apps/desktop/src/renderer/home.test.ts:50-110`, `apps/desktop/src/renderer/overlay.test.ts:168-205,318-337`.
- Main test title indexes: `apps/desktop/src/main/windows.test.ts`; voice indexes: `apps/desktop/src/main/voice/engine.test.ts`, `ears.test.ts`, `mouth.test.ts`, `builtin-ears.test.ts`, `builtin-mouth.test.ts`.
- Shared test title indexes: `apps/desktop/src/shared/sentences.test.ts`, `beats.test.ts`, `model-protocol.test.ts`.
- Renderer test title indexes: `apps/desktop/src/renderer/tokens.test.ts`, `ink.test.ts`, `settings.test.ts`, `system-speech.test.ts`, `scene-thumbnail.test.ts`, `buddy-shape.test.ts`, `model-geometry.test.ts`, `home.test.ts`, `conversation-search.test.ts`, `model-fuzz.test.ts`, `model-sections.test.ts`, `notch.test.ts`, `connections.test.ts`, `model-stage.test.ts`, `drawing-timeline.test.ts`, `card-scene.test.ts`, `handwriting.test.ts`, `overlay.test.ts`.
- Broad runtime-keyword search also inspected matching lines in `apps/desktop/src/main/model-catalog.test.ts`, `apps/desktop/src/renderer/settings.css`, `apps/desktop/src/renderer/connections.ts`; a match is not a full implementation review.
- Tracked-file inventory and rule-file discovery covered repository structure; dependency/build trees, binaries, lockfile bodies, real app data, secrets and unrelated research reports were not opened.
