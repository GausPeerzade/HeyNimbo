# Drawing P1 validation

- Scope: paper cards, rows, handwriting, leaders, gel pills and scoped pointer interaction; no Rust or app/Home changes, commits or staging.
- Clean-room inputs: the approved I/H/J behavior notes and five approved reference images only. No extracted application code/assets or harness files were opened. New drawing code is independently authored; existing MIT buddy/reveal attributions remain.
- Font: unmodified Caveat variable TTF from google/fonts, downloaded into a new empty quarantine directory, identified as TrueType with `file`, then copied with its SIL OFL 1.1 license. SHA-256 and provenance are in THIRD_PARTY_NOTICES.md.
- `cd apps/desktop && pnpm test`: 74 tests passed across 16 files (53 baseline). Includes parser limits/references, card/leader transforms, fixed layout/growth/omission, grapheme/newline/RTL wrap and line reveal, real overlay action order/budget, delayed fonts, isolated close/cancellation, retained drag/capture and manager input-region aggregation.
- `cd apps/desktop && pnpm typecheck && pnpm build`: passed. The built renderer includes the local Caveat TTF; CSP remains self-only.
- Seven mutations were independently applied, tested and restored: ninth step accepted; shifted word anchor; simultaneous line exposure; words-before-badge row order; missing close cancellation; capture ignored on leave; resuming after the omission boundary. Every targeted suite failed for its mutation. Local ignored logs: `.validation/mutation-*.log`.
- `git diff --check`: passed. `git diff --cached --name-only`: empty. No Rust changes, so cargo tests were not needed.

## Independent-review fixes

All four follow-up findings are fixed without an Electron launch:
- Queued cards set `data-interactive="false"`; the matching CSS disables hit-testing on the card and every descendant. Region/control wiring is deferred until the reveal begins. The regression checks the disabled state and absence of region activation before reveal, then verifies activation afterward.
- Main runtime-validates region events before state changes: IDs must be exactly `clear` or `card:` plus the shared `[a-z0-9-]{1,16}` grammar, with a 21-character bound; both flags must be strict booleans. Active regions are capped at four per display. Regressions reject malformed object IDs, truthy non-booleans, missing flags, unknown/invalid/overlong IDs and trailing newlines, and prove excess regions cannot strand capture after valid regions release.
- Cards enforce a 320 CSS-pixel minimum width after screenshot scaling, bounded by the display, with their positions re-clamped. A 2× parse → geometry → layout regression checks readable 178px word space, an unshortened word, and display containment on a negative-origin display.
- Only pen strokes parented to cards become paper ink; marker highlights remain translucent washes. The renderer regression checks the owned highlight's marker class/wash layer and the neighboring pen stroke's paper class.
- Seven additional mutations were tested and restored against the new regressions: early queued-card wiring, premature interactive state, missing runtime validation, missing region cap, missing scaled width floor, missing position clamp and marker-to-paper conversion. All seven produced assertion failures. Local ignored logs: `.validation/review-mutation-*.log`.
- Final `pnpm test` (74/74), `pnpm typecheck`, `pnpm build`, `git diff --check` and the empty staging check passed. No Electron process was launched for these fixes; no files were committed or staged.

## Approved visual run

The supervisor approved a silent Electron run, required a 60-second warning delay and directed private captures to `/tmp/nimbo-p1-validation/` only. No capture was copied into the worktree.

After `sleep 60`, ran from apps/desktop: `pnpm build && NIMBO_DEBUG_DRAW_DEMO=1 NIMBO_DEBUG_NO_CONTENT_PROTECTION=1 ./node_modules/.bin/electron .`.
Recorded with `node scripts/record-overlay.cjs /tmp/nimbo-p1-validation 36`: 556 frames, 36.01 seconds, 15.4 capture fps (not a renderer-cadence claim).
Viewed these original frames with the read tool:
- f0195_013895ms: plain paper, original sun/cloud sketch and heading; transparent desktop elsewhere, no fullscreen opaque surface.
- f0225_015701ms and f0238_016501ms: partial then completed card heading, pen at the writing edge.
- f0246_017008ms, f0255_017593ms, f0268_018382ms and f0280_019117ms: badge, arrow, initial E, completed Evaporation in that order.
- f0344_023030ms, f0410_027004ms, f0442_029019ms and f0466_030489ms: subsequent rows reveal independently; card grows while prior anchors stay fixed; leaders persist.
- f0554_035899ms: all four semantic arrows/rows, both leaders, note, measured gel pill and Clear; legible dark writing on light paper over the dark desktop.
The demo self-quit. `pgrep -fl 'nimboguide-p1/node_modules/.pnpm/electron'` returned no processes; no other instance was stopped and no DevTools styles were changed.

## Boundaries for reviewer

Native drag/close and mixed-DPI behavior have automated SVG/input-manager coverage, not a manual OS-input exercise. Recording covers light paper against a dark desktop, not a separate light-desktop capture. Later edge-only changes (RTL reveal, exact vertical-fit allowance, approved omission policy and warnings) and the four independent-review fixes above passed tests/typecheck/build; the Latin teaching fixture was not relaunched for these changes.
Approved overflow policy: reserve fixed 80px rows, grow down only; once no readable row fits, omit it and every later step without skipping numbers, retain speech, and warn once per card with the omitted count at completion/close/clear. The prompt advises sizing H for all steps and choosing enough empty space.
Recommended gate: independent code review and, with renewed user consent, a manual native drag/close/clear and mixed-DPI smoke check. P2, sound redesign and Home/history remain untouched.
