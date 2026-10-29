# HeyNimbo

An open-source, screen-aware voice and drawing companion for macOS. Ask by text or hold Control + Option to speak: it explains what you’re looking at with speech, handwritten pages and live 3D models.

Bring your own model keys or run local models. No account or hosted backend is required.

> **Private, unreleased development build.** Voice, local history, provider/model/thinking selection and live 2D/3D drawing are implemented. Testing and polish are ongoing.

## Default shortcuts

Hold **Control + Option** to speak, then release to ask. Press again to interrupt.
You can also type a question in Home. Other detected shortcut gestures are not
yet implemented as full features.

## Layout

| Path | What it is |
|---|---|
| `crates/heynimbo-gestures` | Pure Rust detector for modifier-only holds and multi-taps |
| `crates/heynimbo-native` | Rust N-API module: OS input hooks (macOS today), permissions |
| `apps/desktop` | Electron shell: notch panel, one click-through overlay per display |
| `docs/` | Design notes and decisions |

## Develop

Requires Node 24+, pnpm 10, and Rust (stable).

```sh
pnpm install
pnpm --filter @heynimbo/native build   # builds the native module
pnpm --filter @heynimbo/desktop build
pnpm dev:speech-permissions  # macOS metadata for direct Electron launches
pnpm --filter @heynimbo/desktop exec electron .
cargo test --workspace
```

The app stores its local profile under `~/Library/Application Support/HeyNimbo`.
There is no runtime compatibility layer for older development names or schemas.

On macOS, global shortcuts need **Input Monitoring**. In development, grant it to the `Electron` app under System Settings → Privacy & Security → Input Monitoring, then restart.

## License

MIT
