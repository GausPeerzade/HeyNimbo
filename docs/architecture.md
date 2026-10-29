# Architecture

## Principles

- **Bring your own keys, local-first.** Users choose providers, including local models. No backend is required; an optional self-hosted gateway must authenticate callers and enforce quotas.
- **Safety in code, not prompts.** A capability broker enforces typed approvals: external writes, screen driving, spending and budget. Agents get workspace-scoped sandboxes by default. Escape always takes back control.
- **Capture is user-initiated.** Extra captures happen only inside a session the user started (walkthrough, drive, follow-up), and that session is visible, scoped, expiring and cancelable. Our own windows are excluded from captures by the capture layer itself: OS content protection alone is not enough, because ScreenCaptureKit can still capture protected windows.
- **Telemetry is off by default.** When on, it is content-free.
- **Open, versioned protocols** for scenes, agent events and the browser bridge.

## Components

| Layer | Responsibility |
|---|---|
| Rust native crate (`nimbo-native`) | Global gestures, screen capture, accessibility context and text insertion, input actuation, secrets, native-messaging registration. One crate, per-OS modules. |
| Electron main | Windows (notch panel, per-display overlays, buddy), brain orchestration, agent host, MCP client, capability broker, storage. |
| Renderers (sandboxed) | Notch/Home UI and the overlay renderer: SVG strokes and three.js for 3D. They receive only allowlisted IPC. |
| Agent engines | Adapter interface (`start`, `turn`, `steer`, `interrupt`, `events`, `approvals`). The first engine is a pinned Codex app-server, pending contract tests; the Claude Agent SDK and an own loop come later. |

## Voice turn (cascade, default)

Hold → streaming STT → vision LLM streams JSON lines (`say`, `marks`, `tool`) → TTS reports per-line durations → the renderer paces marks to the playback clock. A realtime-model path is optional.

## Scene protocol v1 (planned)

Declarative and validated. No model-written code is executed.

- **Beats:** `{ say, marks[] }`.
- **Coordinates:** screenshot pixels tagged with `captureId`/`displayId`.
- **Lifetime:** each mark has a class (`pointer` clears on screen change; `card` persists).
- **Edits:** stable ids allow `erase`, `recolor`, `move` and `startOver`.
- **Interruptions:** explicit `append`/`cancel`/`continue` turn boundaries.

## Roadmap

0. **Spikes:** gestures ✅ (macOS), overlays ✅, capture ✅ (macOS: about 140 ms, own windows excluded), full-duplex audio, AX/UIA insertion, Codex contract tests, Windows input and capture.
1. **Talk + Look + Point:** ask about the screen, get a spoken answer plus a pointer.
2. **Draw:** scene protocol, speech-paced drawing, walkthroughs with click detection.
3. **Type:** dictation, cleanup, safe insertion.
4. **Agents:** persistent agents, MCP connectors, routines, approvals.
5. **Hands:** browser extension, consented screen driving.
6. **Depth:** 3D, live-note objects, suggestions, Linux, mobile companions.
