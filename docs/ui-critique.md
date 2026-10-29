# HeyNimbo: redesign review and specification

## Method and boundaries
Read the complete userinterface.wiki SKILL + AGENTS (152 expanded rules), Rams, MotionSites SKILL/craft/review, frontend-design, native-conventions, ship-readiness and Vercel guidelines; product context §5–6. Inspected the supplied pre-branch Home and Settings PNGs first. No competitor extraction, unlicensed examples/media or running checkout was opened or reused. The product's `buddy-shape.ts` was inspected as the requested branding reference; no 3D or drawing-behavior changes were made. Scores are a local heuristic review, not the hosted Rams engine or an accessibility certification.

## Before
Rams (0–10): Accessibility 7, Color 5, Typography 6, Spacing 5, Components 5, UX 6, Motion 4, Craft 3, Native 7 (mean 5.33).
MotionSites adapted to a desktop utility: First glance 5, Signature 3, Typography 6, Composition/space 4, Colour/light 5, Media integration 3, Motion 4, Narrow window (not a mobile product) 6, Copy 6, Polish 5 (mean 4.7).

### Findings, original source lines; fixed checklist
- `apps/desktop/src/renderer/tokens.css:5`: system AccentColor focus disagrees with petrol. [ux-similarity-consistency] One accent must identify action, selection and focus. **Fix:** plum accent, accent focus, tested opaque contrast pairs.
- `apps/desktop/src/renderer/tokens.css:19–23`: search, new, settings all get the same outlined box; no active transform. [ux-von-restorff-emphasis, physics-active-state, duration-press-hover] **Fix:** filled send, quiet chrome, inset search, 140ms press at .97.
- `apps/desktop/src/renderer/home.html:6–9`: duplicated wordmark and duplicate New actions. [ux-cognitive-load-reduce, ux-pragnanz-simplify] **Fix:** sidebar becomes Conversations; New is an unboxed compose row; titlebar New only appears with sidebar closed.
- `apps/desktop/src/renderer/home.css:30–39`: question and title repeat at the same visual weight, tiny ink floats inside a large border. [ux-proximity-grouping, ux-common-region-boundaries] **Fix:** compact titlebar, distinct question/answer scale, close-cropped drawing with a pen-margin edge and truthful caption.
- `apps/desktop/src/renderer/home.css:40–49`: centered empty hero stranded above a deep composer; two unrelated focus boundaries. [ux-fitts-target-size, ux-von-restorff-emphasis, visual-concentric-radius] **Fix:** left-aligned invitation in the reading column; compact composer, single accent focus-within, 44px send/stop.
- `apps/desktop/src/renderer/settings.css:7–13`: wall of equally strong separators and 17px checkbox targets. [ux-proximity-grouping, ux-fitts-hit-area] **Fix:** grouped rows, 20px native accent checkbox inside a fully clickable ≥64px label row; useful field descriptions, no category-introduction filler.
- `apps/desktop/src/renderer/setup.css:2–5`: no relationship between key, privacy explanation and next action; unstyled hierarchy. [ux-proximity-grouping, ux-peak-end-finish-strong] **Fix:** proper key label, connection action, inline checking/result, full-width primary.
- `apps/desktop/src/renderer/notch.css:8` and `notch.ts:18,51–62`: entrance-only animation, immediate disappearance, timing scattered in JS. [easing-entrance-ease-out, easing-exit-ease-in, presence-disable-interactions, timing-consistent] **Fix:** reversible CSS opacity/transform transitions with discrete hidden exit retention; inert during exit; CSS dwell and motion tokens, reduced-motion fallback.
- `apps/desktop/build/brand/logo.svg:3`: silhouette plus carved upward arrow reads as cloud upload, not a drawing tool. [ux-pragnanz-simplify] **Fix:** original upright pen buddy with a short rising ink trail, derived from the product's own triangular pen proportions. No cloud, sparkles or stock symbol.
- `apps/desktop/src/renderer/home.css:37`, `tokens.css:7–8`, `notch.css:4–18`: untokenized colors/dimensions, unrelated rounding. [visual-consistent-spacing-scale, visual-concentric-radius, type-optical-sizing-auto, type-tabular-nums-for-data] **Fix:** one neutral scale, role tokens, 4px spacing, 6/10/14px concentric radii, system type with optical sizing, tabular times, balanced headings.

What reads as AI-made is not the use of system type: that is correct here. It is *visual monotony without purpose*: the same outlined control for three different tasks, teal washed over the whole shell, a stock cloud mark enlarged as decoration, a framed empty thumbnail and landing-page empty-state composition. Keep the conventional window, native menus and good privacy semantics; remove the decoration rather than add a new dashboard kit.

## Direction and precise implementation spec
**Chosen: Pen margin. Mood: attentive, precise, personal.** Signature: the product's triangular pen buddy leaves a short ink trail; the same plum identifies a slim margin beside a generated drawing. The drawing is the only handwritten surface. The app is a reading workspace, not an AI dashboard.
Alternatives: **Signal desk**, cool cobalt, horizontal history ribbon and compact workbench; **Field notes**, olive, narrow date rail and side-by-side answer/drawing. All three are original populated-light static studies generated by `scripts/ui-directions.cjs`; no sample/media assets.

Palette: a single neutral gray scale (white, #F8F8F8, #EEEEEE, #DEDEDE, #858585, #626262, #323232, #282828, #1D1D1D). Accent light #70415F / dark #D8AFCB. Semantic green #276344/#9DCEAE, warning #805A16/#E4C17B, error #A62F46/#F0A6B2. Selected background #EEEEEE/#323232; selection identified additionally by a margin and aria-current. Borders needed to identify inputs use #858585 (both themes); decorative separators deliberately quieter, never relied on alone.
Drawing palette: buddy #70415F, ink #493644, paper #FCFCFC, highlight #D9BC61; supporting drawing colors remain semantic names in the *one* overlay palette block. The live buddy, light UI mark, action accent and Dock field deliberately share #70415F; the dark UI mark uses #D8AFCB, and the template is monochrome. White-on-plum Dock artwork is 8.05:1. No drawing behavior edits.
System font only; 12 metadata / 13 control / 15 body / 17 question / 20 section and empty heading, body 1.6, headings 1.25, medium 500/semibold 600; optical sizing auto, calt, no synthesis; tabular times, balanced headings, pretty prose. Caveat 500 only for generated drawing text. Removed unused `--text-ink`; `THUMBNAIL_TEXT_SIZE = 22` remains the single SVG-scene-unit size used for both drawing text and crop bounds, not a CSS UI-font role.
Spacing 4/8/12/16/24/32/48/64px. Sidebar 240px, Settings 188px. Reading column 640px. Toolbar 64px. Drawing viewport 320×176px with cropped scene viewBox, not saved screen pixels. Composer is an unboxed continuation of that column with a 2px top rule, 12px transcript clearance, 12px rule-to-input inset and 44px send/stop. Native `field-sizing: content` grows the textarea from one through five soft-wrapped lines (`--composer-lines: 5`), then scrolls; no JS height mirror. Control radius 6px, artifact 10px, peek 14px, pill 18px. Empty instructions finish 24px above the rule, 28px at 720×520. Native window corners/shadow remain OS-owned; no CSS elevation on app windows. Opaque surfaces also satisfy reduced transparency.
Motion: 140ms press/hover, 200ms peek entrance ease-out, 160ms exit ease-in; .97 pressed scale, .98 peek scale, 4px travel. Reversible CSS transitions preserve the current visual state on interruption; no spring/bounce because there is no gesture/overshoot. 200ms hover dwell, 120ms leave grace. No page/route/typing animations. Reduce Motion cuts all travel and timing. Brief's brand focus overrides generic native-accent advice; brief's restrained flat surfaces override wiki six-shadow/gradient button recipe. No motion library is introduced just to copy React-specific presence APIs.

## Contrast evidence
Automated test reads the actual CSS token blocks. Every text role is checked on canvas, raised, sidebar and selected backgrounds; on-accent on accent; required UI boundary ≥3:1; drawing ink/paper ≥4.5. There are 60 tested pairs (30 per theme). Minima below include the lowest-contrast background among canvas, raised, sidebar and selection; this is more conservative than checking only the reading canvas. Functional inputs use `boundary`; quiet group separators are decorative, not identifying edges.

| Pair (minimum over four surfaces) | Light | Dark |
|---|---:|---:|
| Main text / surface | 12.71:1 | 12.07:1 |
| Secondary text / surface | 5.26:1 | 6.82:1 |
| Accent / surface (also focus) | 6.93:1 | 6.66:1 |
| Success / surface | 6.13:1 | 7.25:1 |
| Warning / surface | 5.34:1 | 7.46:1 |
| Error / surface | 5.81:1 | 6.60:1 |
| Input boundary / surface | 3.18:1 | 3.47:1 |
| On accent / accent | 8.05:1 | 8.76:1 |
| Drawing ink / paper | 10.80:1 | 9.41:1 |

Dark thumbnails deliberately use #323232 paper and #E9D8E4 ink, avoiding a white spotlight in a night workspace. Desktop drawings retain #FCFCFC paper in the restricted overlay palette block. Highlight is non-text ink, accompanied by explanatory text; no contrast promise is made for naked ink over arbitrary desktop content.

## Look-and-fix log
### Round 1: screenshot, look, fix
Read every generated image from the initial partial capture pass, including both Home themes and every light Settings view, setup and peek. MotionSites scores: first glance 8, signature 8, type 8, composition 8, colour 8, media 8, motion 7, narrow 7, copy 7, polish 6 (mean 7.5).
Three weakest: **Polish 6** — removed the composer's separated double focus border (offset 3→0), reduced native checkbox artwork 32→20px while retaining whole-row labels, moved selected-row marker inside the paint containment. **Copy 7** — replaced the vague empty headline with “Ask about your screen”, shortened privacy copy without losing provider/local-storage distinctions. **Motion 7** — verified inert exits and added immediate reversal while a CSS exit is still running, tested with fake timers. Also changed dark drawing paper from white to neutral #323232 and increased the native notch capture region 320→420px: the maximum three recents measured 373px and would otherwise clip.

### Round 2: initial redesign validation (e76eb60)
Opened 32 hidden frames. Fixed preview-only paint throttling with background throttling disabled in the dev flow, two animation frames awaited, and an explicit disconnected-state assertion. The original self-score of Rams 8.22 / Craft 9 was too generous: independent review rated the result **7.2 overall / Craft 6** and correctly identified misleading capture copy, a still-boxed composer, floating instructions, generic branding, filler copy and an unused ink token. Those independent scores are the baseline for this follow-up, not a claim that the first pass was finished.

### Follow-up round 1: fix the independent findings
- `home.html:17–18`, `home.ts:63–67` [ux-cognitive-load-reduce, ux-pragnanz-simplify]: changed the capture label from a completed/ongoing-sharing claim to **“Includes a screen capture when you ask”**, associated through `aria-describedby`. The disconnected explanation also begins “When you ask”. No idle capture, provider request or credential path was introduced.
- `home.css:43–57` [ux-proximity-grouping, ux-common-region-boundaries]: moved compact empty instructions to the bottom of the reading column; removed the composer's raised rounded container. One rule now separates reading from writing, with the same 640px alignment. Intrinsic textarea sizing handles soft wraps, restored drafts and resizing, caps at five lines, then scrolls.
- `build/brand/logo.svg:3–5`, `overlay.css:11` [ux-pragnanz-simplify, ux-similarity-consistency]: replaced the pen-corner symbol with the product's own upright buddy triangle and ink trail. Matched the live buddy to the light mark/action/Dock accent; preserved the dark mark's lighter tone and monochrome template. The SVG remains the sole geometry source for `brand.cjs`.
- `notch.html:5`, `notch.ts:38–41` [ux-cognitive-load-reduce]: heading is “Recent conversations”; a real empty state replaces an empty recent list, and disappears when conversations arrive. No invented history.
- `settings.ts:35–67`, `settings.css:13` [ux-pragnanz-simplify]: removed all five category introductions. Retained descriptions that explain a field's consequences and the actual privacy disclosures. About now states the product's function rather than its mood.
- `tokens.css:9`, `scene-thumbnail.ts:5,19,47` [type-optical-sizing-auto]: removed unused `--text-ink` rather than create a CSS/scene-unit coupling. One existing named constant owns thumbnail text size and conservative crop bounds. Removed the now-unused empty-state width/display-size tokens and renamed the remaining peek radius for its actual consumer.

Three weakest areas on the first follow-up captures: **Signature 6**, because the curved trail read as a reload arrow; **Composition 7**, because a clipped drawing margin touched the composer rule at 720×520; **Polish 7**, because the mark's small-size silhouette had not been checked outside the app. Fixed the mark to an upright buddy with a short, non-circular rising stroke, added 12px clearance before the composer rule, and exported/inspected actual 1024px and 32px icons plus a 16px monochrome proof. No drawing geometry or animation was changed.

### Follow-up round 2: rerender and inspect
Opened **all 40 final window PNGs** and the three icon proofs with the read tool, in both themes, after the fixes. `/tmp/nimbo-ui-validation/diagnostics.json` records 40 `visible:false` frames, loaded fonts, no horizontal/body overflow and zero renderer/load errors. At the 720×520 minimum, wrapped text uses ~3 lines without scrolling; the long draft caps at ~5 lines with internal scrolling; clearing it returns to ~1 line. Fractional line counts (3.02/5.02/1.02) are integer `clientHeight` rounding, not extra lines. Composer bottom remains exactly 520px. Instructions finish 24px above the rule at normal size / 28px at minimum size.

Peek still retains `display:block`, opacity ≈0.85 and `inert:true` during exit, then becomes `display:none`. The empty version uses 278px of the 420px region; three recents fit within 374px. The 16px monochrome proof keeps the solid triangle and rising stroke recognizable, without a hairline corner or cloud silhouette. The 32px icon keeps a clear white mark on plum; the 1024px export shows the same geometry, not an embellished large-size variant. This is raster proof, not a packaged Dock/menu-bar installation check. After the final dead-token cleanup and peek-radius rename, the six resting pill/peek/empty-peek PNGs were byte-identical to the inspected versions; the full 40-frame hidden run passed again.

## Current heuristic scores (independent re-review still required)
These replace the earlier inflated self-scores. Craft is **7, not 9**: the UI is more coherent and the mark product-related, but it is still a restrained, conventional reading shell; brand recognition and native interaction have not been user-tested. The table does not recast the independent 7.2 as a formal before/after Rams result.

| Rams category | Original | Current | Evidence / remaining limit |
|---|---:|---:|---|
| Accessibility | 7 | 8 | Contrast tests, labels, accent focus, inert exits; no VoiceOver or enlarged-system-text pass. |
| Color | 5 | 9 | One gray scale, tested pairs, theme-specific ink, buddy/brand pairing. |
| Typography | 6 | 8 | System scale and weights; Caveat confined to generated ink; no decorative type. |
| Spacing | 5 | 8 | Reading/composer alignment, nearby instructions, 12px transcript clearance. |
| Components | 5 | 8 | Native form controls, one send/stop slot, bounded intrinsic textarea. |
| UX | 6 | 8 | Prospective capture copy, real empty recents, search recovery, no Settings filler. |
| Motion | 4 | 8 | Existing reversible, inert exits and reduced motion retained; no new animation. |
| Craft | 3 | 7 | Buddy-derived mark, cleaner composer; conventional shell and untested recognition remain. |
| Native | 7 | 8 | System type, window behavior and template icon retained; packaged checks deferred. |
| Mean | 5.33 | 8.00 | Local design judgement, not automated certification or independent acceptance. |

| MotionSites desktop-adapted area | Original | Current |
|---|---:|---:|
| First glance | 5 | 8 |
| Signature | 3 | 7 |
| Typography | 6 | 8 |
| Composition / space | 4 | 8 |
| Colour / light | 5 | 9 |
| Media integration | 3 | 8 |
| Motion | 4 | 8 |
| Narrow window | 6 | 8 |
| Copy | 6 | 8 |
| Polish | 5 | 8 |
| Mean | 4.7 | 8.0 |

Per-surface inspection, same score where the light/dark treatment is equivalent. Vector order is the ten MotionSites areas above; low Signature reflects restraint, not an assertion of distinctive branding:
- `home-empty-{light,dark}.png`, `home-empty-narrow-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); instructions now belong to the input, not the titlebar.
- `home-unconnected-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); prospective privacy copy, Connect is the sole filled action.
- `home-populated-{light,dark}.png`: 8,7,8,8,9,9,8,8,8,8 (8.1); ink is legible without saved screen pixels; composer aligns with the answer.
- `home-searching-{light,dark}.png`, `home-search-empty-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); meaningful results/clear recovery, transcript remains intact.
- `home-busy-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); Stop replaces Send, with status above the rule.
- `home-narrow-{light,dark}.png`, `home-draft-{wrapped,overflow}-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); full composer remains visible; the transcript intentionally scrolls as the draft grows. Drawing content can be partly below the viewport, not under the controls.
- `settings-{general,voice,connection,about}-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); controls follow headings directly, useful descriptions retained.
- `settings-history-{light,dark}.png`: 8,7,8,8,9,8,8,7,8,8 (7.9); necessary disclosure text remains dense and scrollable, not replaced with filler or silently removed.
- `setup-{light,dark}.png`: 8,7,8,8,9,7,8,8,8,8 (7.9); focused key form; brand/media expression deliberately minimal.
- `pill-{light,dark}.png`, `peek-{light,dark}.png`, `peek-empty-{light,dark}.png`, `peek-exiting-{light,dark}.png`: 8,7,8,8,9,8,8,8,8,8 (8.0); truthful heading, explicit empty state, no idle capture, intact exit behavior.
All review areas are ≥7 and the overall area mean is 8.0; two restrained/dense surfaces remain 7.9 rather than being rounded up to imply uniform polish. Independent acceptance may rate the work differently.

## Validation and residual limits
- Follow-up starts at **e76eb60**, `ui-redesign`; no staging or commit.
- `pnpm test`: **162 TypeScript tests in 31 files + 20 Rust tests passed**. This follow-up adds a real empty/populated-recents regression and a buddy/brand-pairing regression; existing contrast, thumbnail, busy-action and motion tests remain green.
- `pnpm typecheck`, `pnpm build`, `git diff --check`: passed. A source comparison excluding only the `:root` palette verified the rest of `overlay.css` is byte-identical to e76eb60; PNG headers verify 1024/32/16px exports. Hidden Electron preview additionally asserts prospective capture copy in every Home state, instruction proximity, wrapped/overflow/reset sizing at 720×520 in both themes and intrinsic-sizing support in the actual Electron renderer.
- `pnpm --filter @heynimbo/desktop brand`: regenerated SVG-derived iconset, ICNS, light/dark logos and 1×/2× monochrome templates. Exports: `/tmp/nimbo-ui-validation/icon-1024.png`, `icon-32.png`, `template-16-proof.png`.
- Reproduce final proofs: `pnpm --filter @heynimbo/desktop brand && pnpm build && HEYNIMBO_DEBUG_HOME_PREVIEW=1 apps/desktop/node_modules/.bin/electron apps/desktop`; then `pnpm test && pnpm typecheck && git diff --check`. Static direction studies remain in `/tmp/nimbo-ui-directions/{pen-margin,signal-desk,field-notes}.png`, generated by `scripts/ui-directions.cjs`; they document the original alternatives, not the revised logo.
- Both preview tools use never-shown app-owned windows, isolated temporary data and a file-only request allowlist. No live desktop capture, microphone, credentials or network execution was used.
- No visible-window, VoiceOver, real Keychain/network, packaged Dock/menu-bar installation, multi-monitor or increased-system-text test was performed. These remain authorized release checks, not claimed passes. Existing overlay bloom/motion was deliberately untouched: only `--buddy` changed in its top palette block during this follow-up. No drawing pipeline, prompts, history/schema, 3D or packaging behavior changed.
- Static alternatives are original studies, not extra shipped modes. No theme picker or speculative motion dependency was added. Next step is independent visual/code review, then separately authorized native release checks.

Local skill: heuristic checks. The full engine runs at
https://www.rams.ai/?utm_source=skill&utm_medium=footer
(356 scored rules, verified re-reviews, one-click fixes on every PR)
