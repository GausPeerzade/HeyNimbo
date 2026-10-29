# 3D audit (P2-3D sharpen pass)

Scope: `shared/model-protocol.ts`, the model branches of `shared/beats.ts`,
`renderer/model-geometry.ts`, `renderer/model-sections.ts`,
`renderer/model-stage.ts`, the model code in `renderer/overlay.ts`,
`main/pump-demo.ts`, `main/draw-demo.ts`, `main/index.ts` and the 3D part of
`main/voice/brain.ts`. Line numbers refer to commit 670b40d, before this pass.

Evidence: a code read, plus the private run-4 demo frames in
`/tmp/nimbo-3d-validation/run4/`, which I viewed but did not copy. I compared
them with the two reference frames (`take2/f0552`, `take2/f0667`) by looking
only.

## Findings

Severity: **B** = bug, **A** = accuracy or look, **P** = performance,
**R** = robustness. Each finding lists where it is, its impact and the fix.

### Launch, focus and app menu

1. **B: the demo activates the app and installs an app menu.**
   - Where: `main/index.ts:94-101`. Nothing sets an activation policy before
     `ready`, and the demo returns before `AppShell`. That leaves Electron's
     default app menu in place.
   - Evidence: in run 4 the menu bar names "Electron File Edit Window" by
     3.2 s. The full-screen terminal's Space also switched to the desktop
     (`f0000` → `f0018`), so the launch both took focus and moved the user's
     Space.
   - Fix: the dev harnesses (demo and gallery) start with the `prohibited`
     activation policy and an empty app menu before `ready`. The demo then
     becomes an accessory through the existing `app.dock.hide()` and its
     non-activating panels.
   - Production overlays were already safe: `type: 'panel'`,
     `focusable: false` and `showInactive()` (`windows.ts:119-140`). The Home,
     Settings and setup windows activate on purpose.

### Framing and camera

2. **A: the model fills only about 50–60% of the card.**
   - Where: `illustratedDistance` (`model-geometry.ts:200-210`) fits one
     world AABB's eight corners at the current yaw and pitch.
   - Impact: at a 3/4 view the AABB corners of round, thin and offset parts
     (hose, foot, gauge) project far outside the real silhouette. The fit
     also adds the 0.78 vertical factor and a 1.0 horizontal reserve.
     Measured on `f0302`, the model fills 58% of the height and 27% of the
     width.
   - Fix: fit the projected corners of each part's own oriented box, which
     is tight for primitives, aiming at 76% of the viewport height.
3. **A: the FOV is wide for an illustration.**
   - Where: 30° (`model-stage.ts:35`).
   - Impact: visible perspective taper on tall parts; the reference reads
     close to orthographic.
   - Fix: a 20° FOV.
4. **A: the label margins are reserved symmetrically, whatever the
   labels.**
   - Where: `margin = min(120, 0.23·w)` (`model-stage.ts:63`), used in the
     fit and as the label wrap width (`overlay.ts:409`, `margin - 22` =
     98 px).
   - Impact: "Pressure gauge" wraps onto two lines, and a narrow model
     floats in unused space.
   - Fix: labels wrap at about 34% of the card width, and the fit reserves
     only a modest margin.
5. **A: the turntable is a slow, endless spin.**
   - Where: 0.86°/s (`model-stage.ts:189`).
   - Impact: it never idles, and a fixed-axis cut-away turns its open side
     away from the viewer after about 3 minutes. Labels then point at the
     back.
   - Fix: a gentle ±17° sway about the home yaw (period 14 s) that shows
     depth and keeps the section facing the viewer.
6. **P: the turntable keeps the context rendering at 60 Hz for
   sub-pixel motion.**
   - Outcome: kept at display rate. The sway is the motion the answer asked
     for, and it measures well within budget (see Measurements). Without a
     turntable or a motion, the stage still idles.

### Leaders and labels

7. **B: label slots are solved against a transient camera and never
   revisited.**
   - Where: `reserveModelLabels` (`overlay.ts:372-390`) projects with the
     camera mid-glide (`model-stage.ts:181`, τ 240 ms). Later parts re-fit
     the camera, but the slots stay where they were.
   - Impact: the long, slanted leaders in `f0302`. "T-handle" sits about
     100 px above its handle.
   - Fix: solve slots against the settled (desired) camera. Re-solve when
     the framing changes, and glide the words to the new slot. Turning
     never re-slots.
8. **A: words are placed from loose AABB extents.**
   - Where: `labelEdges()` (`model-stage.ts:125-129`) uses projected AABB
     corners.
   - Impact: words start about 110 px from the visible silhouette, which
     makes leaders long.
   - Fix: use the tight per-part projected extents from item 2.
9. **A: the side choice uses the viewport centre rather than the model's
   centre.**
   - Where: `overlay.ts:377`.
   - Fix: choose the side from the model's projected centre.
10. **A: anchors are the centre of each part's AABB.**
    - Where: `model-geometry.ts:146-151`.
    - Impact: dots float in air inside tubes, sit inside the piston for
      "Seal rings", and can point at cut-away or hidden surfaces.
    - Fix: anchor on the visible surface. Cast a ray once at slot time,
      skipping clipped hits. Keep the hit in the part's local frame so it
      follows motion, and re-check only when the view settles.
11. **A: the "label colliding with the pen" in `f0302` is the idle
    buddy.** It rides 16,20 px from the parked OS pointer
    (`overlay.ts:59,150`), and the pointer was resting on "Hose nozzle".
    The label layout itself was fine. Following the pointer is P1
    behaviour, so it is unchanged. The hidden gallery has no pointer, so it
    can't confirm or rule out this case.

### Cut-away

12. **A: axis cuts pass through the world origin rather than the model.**
    - Where: `model-sections.ts:77`.
    - Impact: the pump's barrel sits at z = −0.3, so `@cut pump z` shaves a
      thin slit instead of halving it. Off-origin models aren't opened at
      all.
    - Fix: every cut passes through the centre of the parts built so far.
13. **A: every part is cut, including inner moving parts.**
    - Where: `model-sections.ts:24-27,67-70`.
    - Impact: the piston and seals become hatched half-discs. The reference
      keeps inner parts whole inside a cut casing. The pump fixture dodged
      this by pushing the rod behind z = 0.
    - Fix: a cut opens the parts built before it, and parts added after it
      stay whole. One line in the instructions documents this.
14. **A: the cap hatch frame is arbitrary.**
    - Where: `setFromUnitVectors(+z, n)` (`model-sections.ts:82`).
    - Impact: the hatch angle rolls as a view cut turns, and its density is
      in world units (12 lines per unit). Big models moiré and tiny ones show
      no hatch.
    - Fix: an up-stable basis, with spacing scaled to the model's framing
      radius so it stays about 7 px on screen.
15. **A: glass and water get opaque hatched caps.** Fix: transparent finishes
    aren't capped.
16. **P: applying a cut recompiles every surface program.** The
    clipping-plane count changes and `needsUpdate` is set
    (`model-sections.ts:67-70`). This is a likely cause of the 483–783 ms
    gaps in run 4's trace. Fix: every surface carries the plane from the
    start, parked so that it clips nothing.

### Lighting and materials

17. **A: the tone mapping and lighting are flat and washed out.**
    - Where: ACES (`model-stage.ts:70`) shifts hues and lifts darks. The
      four lights plus 0.8 environment flood tube interiors
      (`model-stage.ts:79-84`).
    - Impact: the steel reads pale grey-blue on cream paper with little
      depth. Reference interiors are dark.
    - Fix: Neutral tone mapping, a stronger key with a lower fill, and
      baked cavity darkening on inward-facing tube and lathe walls (vertex
      colours).
18. **A: plastic looks toy-like.**
    - Where: semantic colours at full saturation plus clearcoat 0.5
      (`model-stage.ts:99`).
    - Impact: the "plasticky footplate".
    - Fix: model colours are muted toward a neutral, clearcoat is dropped
      (it was also an extra shader variant), and plastic roughness is
      raised. The pump fixture uses a dark-steel foot.
19. **A: grounding is weak.** There is only a 13%-opacity directional shadow
    catcher (`model-stage.ts:84`), so there's no dark contact under the
    base. Fix: add a blurred contact shadow under the footprint, a port of
    three.js's contact-shadow technique (MIT, attributed), kept alongside a
    lighter directional shadow.
20. **B: `PCFSoftShadowMap` was removed in three r0.186.**
    - Where: `model-stage.ts:73`.
    - Impact: a console warning on every first shadow render, and a silent
      fallback.
    - Fix: `PCFShadowMap` with a radius.
21. **A: shadow bias, normal bias and bevels are absolute world units.**
    - Where: 0.015 and −0.0003 (`model-stage.ts:86`, `model-geometry.ts:71`).
    - Impact: they break for models much smaller or larger than about 1.
    - Fix: scale them from the framing radius and the part size.

### Geometry

22. **A: lathe normals smear across corners.**
    - Where: `LatheGeometry` averages normals at every profile point. That
      applies to the cylinder bevels, the tube, half spheres and user lathes
      (`model-geometry.ts:43-60`).
    - Impact: whole walls shade with a gradient (a puffy, "plastic" look),
      and the bottom discs of domes and lathes look soft.
    - Fix: an own revolve that splits normals at creases above 40° and
      rounds bevels with arc points.
23. **A: the tube's closed profile starts at a corner.** It leaves a normal
    seam around the bottom bevel (`model-geometry.ts:48`). Fix: covered by
    item 22, since the loop now starts mid-face.
24. **A: gear teeth are wrong.**
    - Where: `model-geometry.ts:61-71`.
    - Impact: depth is a fixed 18% of the radius, whatever the tooth count:
      too shallow at 8–12 teeth and too deep at 32. The flanks are straight
      radial ramps, and gears can't mesh at a predictable centre distance.
    - Fix: `r` is now the pitch radius with module m = 2r/teeth, addendum m
      and dedendum 1.25m, plus involute-approximated flanks. Gears mesh at
      r1 + r2.
25. **A: boxes have perfectly sharp edges by default.** Fix: an automatic
    2.5% bevel, the floor even when `round=0` is given.
26. **A: springs have no closed ends.** Fix: a flat, closed last turn at
    each end.

### Smoothness

27. **P: there are per-frame allocations in the render loop.**
    - Where:
      - `graph.bounds()` per tick clones a Box3 per placement
        (`model-stage.ts:204`, `model-geometry.ts:123-139`);
      - `sections.update` allocates vectors (`model-sections.ts:75-82`);
      - orbit allocates two vectors per motion (`model-stage.ts:197-198`);
      - `project()` / `anchor()` allocate for every label and visit
        (`model-stage.ts:119-123`, `overlay.ts:392-404`).
    - Fix: scratch vectors, cached bounds, and preallocated anchor points.
28. **P: there's no pre-compilation.** The first render of each new material
    variant compiles synchronously mid-build. Fix: fewer variants (items 16
    and 18), plus one hidden warm-up frame at stage creation that compiles
    every program and allocates its targets (item 37).

### Robustness

29. **R: there's no WebGL context-loss recovery.** Nothing listens for
    `webglcontextlost` or `webglcontextrestored`, and a GPU reset leaves a
    blank card with an empty environment map. Fix: pause on loss; on
    restore, regenerate the environment, mark the shadows dirty and
    re-render.
30. **R: DPR is read only at construction.** After a display-scale change
    the canvas stays blurry or oversized. Fix: check `devicePixelRatio` per
    tick and resize.
31. **R: the authoring kit fails hard on small mistakes.**
    - `mat=chrome`, `color=yellow`, an out-of-range size or `inner ≥ r`
      drops the whole part. Its children, tags and moves then cascade away
      (`model-protocol.ts:78-110`).
    - `@model … turntable` without `=true` drops the whole model
      (`beats.ts:136`).
    - Fix: clamp and fall back. Unknown materials and colours fall back,
      dimensions are clamped, and common shape aliases are accepted. A
      line is dropped only when it is unusable.
32. **A: the prompt example is too small.** It has three bare parts, so
    typical answers come out sparse and boxy (`brain.ts:43-50`). Fix:
    tighter guidance on proportions, details from repeats, cuts and card
    size, with an example that shows those habits.

## Our frame vs the reference

| Aspect | Reference (`f0552`, `f0667`) | Ours (run 4, `f0286`/`f0302`) |
|---|---|---|
| Framing | Mechanism about 70% of the card height, centred, elevated 3/4 view, near-orthographic | About 58% of the height, small in a wide card, visible perspective taper |
| Lighting | Studio key with dark interiors and bright rims, so metal reads as metal | Pale and even; tube interiors as bright as exteriors; little value range |
| Materials | Neutral greys and steel; only the combustion chamber is coloured | Saturated blue glossy foot; brass and rubber read fine; steel is washed out |
| Shadow | Soft contact shadow under the block, plus a soft offset cast | Faint offset cast only; the model floats slightly |
| Detail | Springs, valve stems, rings on the piston, bolts and a crank | Comparable count (28 parts), but chunky handle grips and no rings on the piston |
| Cut faces | Pale grey caps with fine dark hatch, on the casing only | Tan caps with brown hatch, also on the piston and seals; the barrel is only slit open |
| Labels | Short, mostly horizontal leaders; words in aligned columns beside the model | Long diagonal leaders; words about 110 px from the silhouette; one label wraps |
| Motion | Crank and piston move; labels stay readable | Plunger slides smoothly and the leaders follow; the slow spin never idles |

## Found while fixing

33. **B: parts in the same beat as `@cut` were also cut.** Parts are
    prepared when their beat is queued, before the cut runs on that beat's
    timeline, so pins and windings listed after `@cut` were sectioned. Fix:
    a cut opens only parts already built when it runs.
34. **B: every view cut tilted its hatch cap out of the plane.** The cap's
    basis (camera X, camera Y, view direction) was left-handed. Rotating a
    mirror tilted the quad, which left an uncapped crescent through which
    the ink shell showed. Fix: the third axis is always u × v. A regression
    test checks that the cap lies in the plane.
35. **A: solid casings hid what they enclosed.** A coffee machine or house
    drawn as solid boxes showed only hatching. Fix: a cut container
    (not rock or soil) that encloses parts lying a quarter or more on the
    kept side becomes a shell. An inset inner surface faces the cavity, and
    its stencil passes count the other way, so only the wall is capped.
    Large parts inside a casing that cross the section (floors) are cut too.
36. **A: an ambiguous motion reading.** Blind scripts expected `spin` on a
    ring to turn each propeller in place, and `orbit amount=d` to circle the
    parent at distance d. Both are now so: spin turns copies in place;
    orbit circles the parent's origin at the part's own distance, with no
    jump at the start.
37. **P: there was a cold start of up to 783 ms (run 4), mostly at the
    first part.**
    - What it cost:
      - the context: 15–36 ms;
      - the PMREM environment: 54–72 ms;
      - the first render's shader compiles: about 70 ms;
      - the first cut's compiles: about 24 ms;
      - preparing parts: 5–12 ms each, at the beat.
    - Fix:
      - A warm spare stage is built when the overlay loads. One hidden
        frame compiles every program and allocates the shadow and contact
        targets.
      - A new `prepare` IPC forwards `@model` and `@part` lines as soon as
        the parser accepts them. The stage registers parts at once and
        dresses one per idle slot.
      - Model parts start without a pen pre-flight, and the card fades in
        alongside them.

## Hidden gallery

Run it with `pnpm build && HEYNIMBO_DEBUG_3D_GALLERY=1 ./node_modules/.bin/electron .`
from `apps/desktop` (dev only). Optional settings:
- `HEYNIMBO_DEBUG_3D_GALLERY_ONLY=core|blind|<names>` picks the fixtures;
- `HEYNIMBO_DEBUG_3D_GALLERY_LABEL=<dir>` names the output folder;
- `HEYNIMBO_DEBUG_DRAW_TRACE=1` records frame traces and latency;
- `HEYNIMBO_DEBUG_3D_GALLERY_PREPARE=0` is a control run without streamed
  lines.

It uses an isolated /tmp profile, the prohibited activation policy and no
app menu. Windows are never shown, and the network is blocked. It writes
`/tmp/nimbo-3d-gallery/<label>/`, quits by itself within 58 s, and stops at
a hard deadline. Fixtures run 6 at a time at 0.6× speech pace; a set takes
20–28 s.

There are two sets:
- **core**: pump, desk fan, water molecule, gear train, padlock and atom.
  These are mine.
- **blind**: rocket, heart, solar system, house, volcano, guitar, bicycle,
  tree, castle, DNA, espresso machine and drone. I wrote them from the
  INSTRUCTIONS text alone and froze them; sha256 of the block is
  `782abe59…`, unchanged at the end.

Never edit a fixture for looks; fix the kit. The core fixtures were
reverted to their first versions. One semantic migration was needed:
atom rings use `orbit`.

Blind results: round 0 passed 8/12. The final round passes 12/12 against
the bar: fills the card, clear silhouette, lit depth and contact shadow,
readable labels. Remaining caveats:
- solar: two leaders cross the Sun;
- tree: the script buries the fruit in the crown and the roots under the
  soil, so those tags point at what covers them;
- DNA: copies can't twist, so the rungs stay parallel.

## Real-model eval and showcase

All of these are dev-only and can't run in a packaged app. They run from
`apps/desktop` after `pnpm build`.

- **Eval** (`HEYNIMBO_DEBUG_3D_EVAL=1`): asks each model in
  `HEYNIMBO_DEBUG_3D_EVAL_MODELS` (`provider:model[:low|medium]`, comma
  separated) every request in `scripts/eval-3d-subjects.txt`.
  - It uses the real answer path, a blank 1440×900 screenshot and no
    history.
  - It reads saved keys from the normal profile, read-only, so quit
    HeyNimbo first.
  - Answers render in hidden windows to `/tmp/nimbo-3d-eval/<label>/`, with
    `summary.json` and `summary.md`.
  - `HEYNIMBO_DEBUG_3D_EVAL_REPLAY=<run dir>` re-renders a saved run with no keys.
- **Showcase replay** (`HEYNIMBO_DEBUG_3D_EVAL_SHOW=<run dir>`): replays a saved
  run on the desktop of the cursor's display. It uses a throwaway profile, no
  network or keys, and never takes focus.
  - **Layout:** per subject, each model's answer gets an equal column, with
    the request in a pill on top and the measured first-part time and part
    count under each card.
  - **What changes:** only the answer's first `@model` line, whose rect and
    title (the model's display name) are overridden. Its `@part`, `@move`,
    `@cut` and `@tag` lines and its sentences are kept byte for byte.
  - **What's dropped:** 2D side cards, headings, steps, notes and pointers,
    plus any second model, so the columns compare the 3D alone.
  - **Pacing:** a model's first part appears at its measured first-part
    time. Each later beat lasts as long as its sentence would be spoken, and
    never starts before its text could have streamed in. Streaming is taken
    as steady from the first `@part` line to the measured total.
  - **Fitting:** a subject that would run past 40 s is shown uniformly
    faster, keeping the models' order, and its pill says by how much.
  - **After building:** finished models hold for 6 s, then clear.
  - **Options:** `HEYNIMBO_DEBUG_3D_EVAL_SHOW_ONLY=<number|slug|word>` shows one
    subject, and `HEYNIMBO_DEBUG_3D_EVAL_SHOW_SPEED` (0.25–8, default 1) scales
    the pacing.
- **Live showcase** (`HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE=1`): real requests, with
  the same models, subjects and label variables as the eval.
  - It uses the eval's normal read-only profile and lock, so quit HeyNimbo
    first.
  - **Flow:** per subject, each model is asked in turn, and its answer draws
    in its column as lines stream in. Like a text-only answer in talk.ts, each
    beat draws on arrival with an 800 ms budget.
  - **Pills:** one shows the request; one shows "<model> · n/N · first part
    x.x s", updated live.
  - **Sequencing:** the next model starts when the last has finished
    drawing, and finished models hold for 6 s before the next subject.
  - **Results:** answers, timings and usage are saved like an eval run, for
    comparison.
  - **Bounds:** 90 s per request; failures are recorded and the show goes
    on.
- **Interaction and look:** each column is its own click-through overlay
  window, so models build in parallel or in turn. Cards can't be dragged or
  closed during a show, and each column has its own pen.
- **Hidden validation knobs:**
  - `HEYNIMBO_DEBUG_3D_EVAL_SHOW_CAPTURE=<dir>` renders either mode in hidden
    windows and writes composited frames.
  - `HEYNIMBO_DEBUG_3D_EVAL_SHOW_MOCK=<run dir>` feeds the live mode a saved
    run's answers at their recorded times, in a throwaway profile, with no
    keys.

## Measurements

These are frame gaps from the existing `HEYNIMBO_DEBUG_DRAW_TRACE` trace, at
60 Hz in hidden windows, covering build, motion, sway and a drag.

| Run | p50 | p95 | max |
|---|---|---|---|
| Pump alone | 16.7 ms | 17.4 ms | 17.8 ms |
| 6 core windows rendering at once | 16.7 ms | ≤ 17.8 ms | 18.8 ms |
| 12 blind fixtures, 6 at a time | 16.7 ms | ≤ 17.6 ms | 17.7 ms; one 33–50 ms first-render frame in 5 first-wave windows |

- **p95 vs the 16.7 ms target:** p95 sits at 17.4–17.8 ms because rAF
  timestamps jitter around the vsync interval. No frame was dropped at
  p95.
- **Cold start:** six windows cold-starting on one GPU at once show a
  single 33–50 ms frame at first render. A real overlay warms long before
  an answer.
- **Stress lane:** with the robustness lane running alongside, 20 back to
  back WebGL context creations on the shared GPU process caused 150–166 ms
  frames in the other windows at the same moments.
- **Beat start → first visible part:** 7–47 ms across all 18 fixtures,
  against a 150 ms target. From the streamed `@model` line it is about
  350 ms when the line streams 300 ms before its beat, and the sentence
  gap otherwise.
- **Leaks:** after 20 open/clear cycles there were 0 canvases and no
  "too many WebGL contexts" warnings. After a drag and a close mid-build
  there were 0 canvases.
- **Focus:**
  - Inside the app: `isActive` was false at ready and at the end, and
    `did-become-active` fired 0 times, in every run.
  - From outside: the frontmost app's pid never changed during runs.

## Remaining gaps against the reference

- **Leader occlusion.** A leader can cross other parts. Anchors re-check
  visibility only when the layout changes, so a part that spins or orbits
  behind another can keep its dot on the occluder until then.
- **Cut edges.** There is no ink line along the section boundary; the
  reference outlines its cut edges.
- **Detail variety.** No per-copy variation (twist, size or colour along
  a repeat), no fillets between parts, and no textures (wood grain, knurls).
- **Visible demo.** The visible on-screen demo wasn't re-run (it needs
  approval). Its launch path matches the gallery's, which was verified
  hidden.
