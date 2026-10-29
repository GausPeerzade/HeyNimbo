# NimboGuide

An open-source AI buddy that lives on your computer. Hold a shortcut and ask out loud: it sees your screen, answers by voice, points and draws on screen to walk you through things, types for you, and hands bigger jobs to agents.

Bring your own model keys or run local models. No account or hosted backend is required.

> Status: **Phase 0** (de-risking spikes). Nothing here is usable yet.

## Default shortcuts

| Action | macOS | Windows |
|---|---|---|
| Talk (hold) | Ctrl+Option | Ctrl+Alt |
| Text box | double-tap Ctrl | double-tap Ctrl |
| Always-on voice | triple-tap Ctrl | triple-tap Ctrl |
| Dictate (hold) | Fn+Ctrl | Ctrl+Win |
| Hands-free dictation | double-tap Fn+Ctrl | double-tap Ctrl+Win |

## Layout

| Path | What it is |
|---|---|
| `crates/nimbo-gestures` | Pure Rust detector for modifier-only holds and multi-taps |
| `crates/nimbo-native` | Rust N-API module: OS input hooks (macOS today), permissions |
| `apps/desktop` | Electron shell: notch panel, one click-through overlay per display |
| `docs/` | Design notes and decisions |

## Develop

Requires Node 24+, pnpm 10, and Rust (stable).

```sh
pnpm install
pnpm --filter @nimboguide/native build   # builds the native module
pnpm --filter @nimboguide/desktop build
pnpm --filter @nimboguide/desktop exec electron .
cargo test --workspace
```

On macOS, global shortcuts need **Input Monitoring**. In development, grant it to the `Electron` app under System Settings → Privacy & Security → Input Monitoring, then restart.

## License

MIT
