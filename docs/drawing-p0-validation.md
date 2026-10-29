# Drawing P0 validation

## Safety correction and reproduction

During the initial validation I used DevTools to set the live overlay body's background to white for a contrast fixture. This made the user's actual full-screen overlay opaque white. It was an unsafe test mutation, not a lost `transparent` flag. The mutation has been removed from every task-owned scratch probe script, and must not be repeated. The initial demo also instantiated the audio window and played scribble sounds; its early return prevented TalkSession/OpenAI startup, but did not prevent those sounds.

The corrected demo returns before creating the audio window, sound callback, gestures, capture self-test or voice pipeline. It plays **no sound**, accesses no credentials, and opens no microphone or AI connection. It fades immediately after its eight-second sequence, calls `app.quit()` three seconds later, and installs an `app.exit(0)` fallback at twenty seconds of total process uptime. Overlay and notch windows have explicit `backgroundColor: '#00000000'` native backing, remain hidden until successful load plus first paint, and hide on load failure.

Before **every** launch, obtain explicit user/supervisor coordination, verify that no NimboGuide Electron process exists, and run `pnpm --filter @nimboguide/desktop typecheck` and `pnpm --filter @nimboguide/desktop build`. Launch at most one instance, from `apps/desktop`:

```sh
NIMBO_DEBUG_DRAW_DEMO=1 NIMBO_DEBUG_DRAW_TRACE=1 ./node_modules/.bin/electron .
```

Verify self-exit; do not relaunch without another approval. Do not change live runtime styling. For separately consented recording only, add the dev-only `NIMBO_DEBUG_NO_CONTENT_PROTECTION=1` switch and run `node scripts/record-overlay.cjs /tmp/nimbo-draw 20` from the root. It requires existing Screen Recording permission, captures the cursor's initial display without moving the OS pointer, runs sequential captures at maximum sustainable rate, and writes JPEGs plus a timestamp manifest. Captures include your desktop: choose the output directory accordingly. All development switches are gated by `devFlag`, never active in a packaged app. If a run does not exit, stop only its verified `nimboguide/node_modules/.pnpm/electron` PID.

## Measured cadence

Measured on the available macOS / Electron 45 machine, with an unfocused, click-through overlay. Times below are milliseconds; pooled samples count successive rAF timestamps only, not the first callback's offset from a non-rAF timestamp.

| Configuration | Samples | Active sample span | p50 | p95 | Max gap | Longest stall >100ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original reveal, default background throttling (7 launches) | 1,982 | 33.94s | 16.7 | 17.1 | 433.4 | 433.4 (4 stalls) |
| Same original reveal, only overlay backgroundThrottling=false (1 launch) | 288 | 4.80s | 16.7 | 17.2 | 18.6 | 0 |
| Final pipeline, desktop + light fixture (pooled) | 2,101 | 35.04s | 16.7 | 17.6 | 33.4 | 0 |
| Final pipeline, native desktop recording | 426 | 7.10s | 16.7 | 18.6 | 18.7 | 0 |
| Final pipeline, light fixture recording + tip probe (historical unsafe styling; do not repeat) | 423 | 7.05s | 16.7 | 17.5 | 18.7 | 0 |
| Corrected silent demo, single approved trace-only run | 444 | 7.38s | 16.7 | 17.6 | 17.8 | 0 |

The corrected silent run was approved before launch, with no capture, DevTools or styling mutation. Preflight found no NimboGuide Electron process; it exited itself with code 0 after **17.017s wall time**, no forced kill, and no remaining task Electron process. Evidence: `/tmp/nimbo-silent-safe.log`, `/tmp/nimbo-silent-safe-exit.json`, `/tmp/nimbo-silent-safe-cadence.json`. No further visual run was made.

Historical raw samples, source log paths and summaries are at `/tmp/nimbo-draw-evidence/cadence.json`. The final pool includes 27.99s of desktop samples plus the 7.05s light recording. Two repeated launch attempts did not finish the entire demo, so only their emitted active trace segments are counted; no missing interval is treated as a zero gap. These are observed samples, not a guarantee about every fullscreen/occlusion configuration. The same-reveal flag-only comparison isolates that change, but does not establish that throttling caused every original stall.

An initial full-viewport-mask implementation had a 300ms first-reveal stall during capture (`/tmp/nimbo-draw-final.log`). Restricting each immutable mask to its stroke bounds eliminated that stall in the subsequent recordings. This unsuccessful intermediate run is not included in final measurements.

## Frames actually viewed

- Desktop recording: `/tmp/nimbo-draw-tight-mask/` (298 frames / 19.01s, 15.7fps). Viewed `f0054_003560ms.jpg`, `f0056_003697ms.jpg`, `f0058_003831ms.jpg`, `f0061_004026ms.jpg`: travel, initial arc, advancing circle and stable prior ink. `f0075_004920ms.jpg` shows the arrow starting; `f0099_006493ms.jpg` shows a two-sided box still being traced. The triangle is attached to the visible leading end, not a diagonal shortcut.
- Historical light fixture: `/tmp/nimbo-draw-light4/` (325 frames / 20.04s, 16.2fps). This used the unsafe live-body white mutation described above; do not repeat it. No product background was added. Viewed `f0058_003645ms.jpg`, `f0060_003769ms.jpg`, `f0064_004014ms.jpg` for progressive circle states; `f0114_007120ms.jpg` for the yellow buddy traveling toward the highlight; `f0181_011333ms.jpg` for the completed translucent highlight, note and both compact labels (right-edge label flipped left); `f0282_017489ms.jpg` for partial scene opacity; `f0285_017675ms.jpg` and `f0294_018227ms.jpg` for cleared ink with the same buddy returning near the OS cursor.
- A temporary rAF DevTools probe compared the buddy's transformed tip with SVG `getPointAtLength` on the currently revealing centerline: 156 drawing samples, maximum error **0.000069 CSS px**, zero outline `d` mutations, one retained buddy, and zero ink nodes after the fade. Probe source/results: `/tmp/nimbo-draw-evidence/probe.cjs` and `probe.json`. This is a geometric alignment check, not a claim of subpixel accuracy from JPEGs.

## Automated validation and boundaries

`pnpm --filter @nimboguide/desktop test`: 45 tests pass, including the original 18. New safety suites test the real main-process demo branch's exclusion of audio/AI/credentials/gestures, normal quit and hard cap, packaged/dev guards, transparent native backing, successful-load/paint ordering, and failure-before/after-paint handling. The two drawing suites exercise uneven curve arc lengths, immutable geometry, connected contours, shaft/head topology, natural durations/clamps, groups, gaps, travel-inclusive overrun compression (1/10/50 strokes), and flight endpoints/bow/tangent/scale/glow/duration. An initial endpoint assertion caught floating-point endpoint drift; bowed paths now retain exact input endpoints.

Desktop `typecheck`, desktop `build`, workspace `pnpm build`, `node --check scripts/record-overlay.cjs`, and `git diff --check` pass. No files were staged or committed. Only the approved behavior notes and MIT license files were read in the research tree; no prohibited extraction/download/harness path was opened. Full Farza and Jason Kneen MIT notices and adaptation descriptions are in `THIRD_PARTY_NOTICES.md`.

The supervisor approved retaining the single declared `durationMs` speech estimate while PCM streams; exact PCM-end fitting and audio/visual drift are **unverified**. Per-stroke sound starts from renderer reveal events and uses their remaining visible duration, but acoustic latency was not measured. Cross-display return choreography is explicitly deferred: old-display ownership is relinquished and the buddy fades over 180ms if the cursor moved to another display; same-display clear/fade returns along the flight path. Multi-display/fullscreen/occlusion, packaged-runtime checks and native compositing of multiply against arbitrary desktop applications still need broader manual coverage. No paper, fonts, cards, badges, photos, 3D or sound redesign was added.
