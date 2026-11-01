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
| Rust native crate (`heynimbo-native`) | Global gestures, screen capture, accessibility context and text insertion, input actuation, secrets, native-messaging registration. One crate, per-OS modules. |
| Electron main | Windows (notch panel, per-display overlays, buddy), brain orchestration, agent host, MCP client, capability broker, storage. |
| Renderers (sandboxed) | Notch/Home UI and the overlay renderer: SVG strokes and three.js for 3D. They receive only allowlisted IPC. |
| Agent | One agent for every request, on Pi's SDK in Electron main, with web, file and shell tools behind code-enforced approvals. See [agent.md](agent.md). |

## A turn

Hold Control + Option (or type in Home) → the display under the cursor is captured → the answer model streams sentences and drawing lines (`@card`, `@model`, …) → each sentence is spoken while its drawings are paced to the audio. A `@model` line starts a separate designer request that streams the 3D parts, then looks at the finished model and polishes it. Tools (web, files, shell) run in the same turn, behind the approvals in [agent.md](agent.md).

Drawing lines are declarative and validated before anything is drawn; no model-written code runs.
