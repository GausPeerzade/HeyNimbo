# App-shell validation (2026-10-29)

## Boundaries

Only the `heynimbo-app` worktree was edited. No commit, staging, /Applications
copy, packaged-app launch, reference UI/assets, extracted binaries or forbidden
research paths were used. Original Cloudpath artwork is in `build/brand/logo.svg`.
Lucide paths and both applicable notices are recorded in THIRD_PARTY_NOTICES.md.

The supervisor approved the standalone offscreen asset renderer and separately
approved the fixture preview. Both use throwaway /tmp userData, reject non-file
requests and have a <30s hard exit. All Home/Settings preview windows stayed
hidden (`show:false`, `paintWhenInitiallyHidden:true`); no visible launch or
activation was necessary. No gestures, microphone, audio, AI or credential access
ran in the preview. PNGs contain only our web contents, not the desktop.

## Visual review

Viewed PNGs under `/tmp/nimbo-app-validation/`:
- home-empty-light/dark, home-unconnected-light/dark, home-populated-light/dark,
  home-narrow-dark;
- settings-light, settings-history-dark, settings-about-light/dark,
  settings-voice-light, settings-connection-dark.

Reviewed against the shared tokens and interface checklist. Fixed low-contrast
dark placeholders by using the secondary text token; collapsed the sidebar at
narrow widths (the keyboard-accessible toggle/search restores it); added a full
Settings title-bar drag region; tightened the connection-required empty state
so its privacy explanation fits without an unnecessary scrollbar. Hidden capture initially raced dark-logo image
decoding: the fixture now waits for image decode before capturing. Re-viewed
home-empty-dark and home-narrow-dark after these corrections. Transcript remains
selectable, controls have labels/focus rings, long rows truncate, semantic errors
include text, drawing thumbnails are static vectors on neutral paper, and motion
has a reduced-motion override. Native title-bar controls are outside capturePage.

## Tests and deliberate mutations

`pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm dist:mac` are the primary
checks. The initial implementation at `84587da` passed 75 Vitest tests and 20 Rust tests (including the packaging check). SQLite emits its upstream
experimental warning under Node 24.
The following deliberate mutations were applied individually, tests were run
and failed as expected, then original sources were restored and tests passed:
- retention `<` changed to `<=`: exact-boundary conversation incorrectly deleted;
- FTS delete trigger made a no-op: orphaned index rows caught by two tests;
- settings boolean validation bypassed: malformed file acceptance caught;
- New reused the existing conversation ID: context-reset regression caught;
- question persistence before dispatch removed: voice/text pipeline tests failed.

## Bundle inspection and remaining manual gates

`plutil -p Contents/Info.plist` verified display/product name, stable
`dev.heynimbo.desktop` identifier, version, icon and honest microphone purpose.
`codesign -dv` reported an arm64 ad-hoc signature. Native .node is unpacked at
`Contents/Resources/app.asar.unpacked/node_modules/@heynimbo/native/` and was
loaded with Node without starting gestures or capture. The asar contains the
workspace package's loader and package.json. No bundle was launched.

The supervisor must test the actual packaged app after stopping the existing
resident instance: Dock/minimize/reopen, login item, menu-bar visibility,
hover focus while typing elsewhere, Escape conflict, Spaces/fullscreen and
multiple displays, live OpenAI voice/text, revoking permissions and VoiceOver.
Hidden fixture checks do not establish these runtime guarantees. Notarization,
Windows, updates, cloud/accounts and drawing-lane changes remain out of scope.

## Approved follow-ups

The supervisor explicitly deferred durable composer drafts, scroll anchors and
current selection across restart, along with archive, replay and export UI.
Drafts/scroll are preserved only while switching within the existing Home
renderer. A restart intentionally has no current conversation: its first voice
ask creates a fresh ID unless the user explicitly opens a saved conversation.
This avoids silently attaching a new question to an old thread.


## Review follow-up on `84587da` (branch `app-shell`)

All eight accepted review findings are addressed without schema, dependency,
packaging, branding or gesture changes. No Electron process was launched for
this follow-up; BrowserWindow/WebContents and native services are test doubles.
The packaged bundle and earlier screenshots were **not** regenerated and are
not evidence for the changed runtime paths.

- **Navigation and IPC:** `loadPage` installs `will-navigate`, `will-redirect`
  and new-window denial before loading any app page. IPC requires the owned
  WebContents, its actual main frame, and its exact expected document URL.
  Packaged builds accept only the bundled file URL; an unpackaged development
  server uses its exact page URL instead. Home, Settings, notch and setup
  regression tests reject subframes and navigated documents.
- **Validation:** app/notch payloads enter as `unknown` and are parsed into
  validated variants before dispatch. No string or boolean coercion remains.
  Live settings must be complete and valid; rejection leaves settings, files,
  retention and cancellation untouched. Only settings-file loading can fall
  back to defaults. Unknown live settings/request fields are rejected.
- **Cancellation/reconnect:** persistence errors are isolated from abort,
  microphone/speech cancellation and status cleanup; repository completion
  releases the controller's active owner in `finally`. `close()` follows the
  status-clearing cancel path and reconnect explicitly clears overlay listening.
- **Peek recovery:** renderer crash, unresponsiveness and reload restore native
  click-through and release Escape without sending to the renderer. Explicit
  dismissal completes native cleanup before attempting renderer messaging, even
  when that send fails.
- **Submission:** the real TalkSession synchronously creates the turn before
  returning acceptance, without waiting for capture/streaming/playback. Turn
  creation failure rejects IPC and does not change the selected conversation or
  erase the Home draft; a newly created empty conversation is removed on a
  best-effort basis if turn creation fails.
- **Streaming:** answer/scene writes are coalesced at 250 ms, with final flushes
  on stream completion, stop, error and completion. Snapshot work is coalesced
  at 250 ms and terminal status flushes immediately. Sidebar SQL returns at most
  200 pinned/recent conversations, plus the selected conversation if outside that
  bound (at most 201 in snapshots). Search still covers older history; individual
  loading/context menus and search-row titles work outside the sidebar bound.
  Brain context queries only the last six completed question/answer pairs,
  without decoding all turns/scenes. Keyed transcript nodes and unchanged
  thumbnails survive answer deltas, preserving selection in older messages.
- **Search:** every edit/clear, including Escape, immediately invalidates pending
  work; both the sequence and the live field query must match before applying
  results. The Home integration test exercises Escape during an in-flight request.

Regression sources: `main/{page-security,app-requests,setup-window,app-shell,
settings,notch-peek,index,history,conversations}.test.ts`,
`main/voice/talk.test.ts` and `renderer/{home,conversation-search}.test.ts`.
The Home tests execute the real renderer/controller code with a small DOM double;
submission failure exercises the real TalkSession, not a mocked `ask` failure.

### Follow-up validation and mutation evidence

Final commands after restoring every deliberate mutation:
- `pnpm test` — **133 Vitest tests / 25 files and 20 Rust tests pass**.
- `pnpm typecheck` — pass.
- `pnpm build` — pass (native release addon and Electron main/preload/renderers).
- `git diff --check` — pass; `git diff --cached --name-only` — empty.

26 mutations were applied one at a time, caught by assertion failures, and
restored in `finally` before the next mutation. Logs and exact target commands
are in `/tmp/nimbo-app-review-mutations/{results.json,*.log}`; the driver is
`/tmp/nimbo-review-mutations.py`. The checks below are independently runnable
with `pnpm --filter @heynimbo/desktop exec vitest run <test-path>`.

| Finding | Deliberate regressions detected | Tests that failed as intended |
| --- | --- | --- |
| Navigation / IPC (5) | remove each navigation/redirect/open denial; remove main-frame identity check; revert setup to sender-only authentication | `page-security.test.ts`, `setup-window.test.ts` |
| Strict payloads (4) | coerce rename title; coerce voice array; remove hover boolean check; remove expanded boolean check | `app-requests.test.ts`, `settings.test.ts`, `notch-peek.test.ts` |
| Cancellation (2) | let `conversations.finish()` escape; omit abort | `voice/talk.test.ts`: throwing persistence still aborts/cancels/clears status |
| Reconnect (2) | close via status-preserving interrupt; omit overlay listening reset | `voice/talk.test.ts`, `index.test.ts` |
| Peek fail-safe (4) | remove each crash/unresponsive/reload hook; send before native cleanup | `notch-peek.test.ts` |
| Submission (2) | acknowledge failed turn creation; change current ID before turn creation succeeds | `app-shell.test.ts`, `renderer/home.test.ts` (real TalkSession path and retained draft) |
| Streaming (5) | zero write interval; bypass snapshot coalescing; remove list limit; read full transcript for context; clear transcript on each snapshot | `voice/talk.test.ts`, `app-shell.test.ts`, `history.test.ts`, `conversations.test.ts`, `renderer/home.test.ts` |
| Search race (2) | stop advancing sequence; omit live query comparison | `renderer/conversation-search.test.ts` |

These automated checks do not replace the supervised packaged-runtime gates
above (native focus, Dock, permissions, accessibility, displays and live AI).
SQLite's experimental warning remains nonfatal. Existing approved persistence,
archive/replay/export deferrals remain unchanged.
