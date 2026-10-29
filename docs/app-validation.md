# App-shell validation (2026-10-29)

## Boundaries

Only the `nimboguide-app` worktree was edited. No commit, staging, /Applications
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
checks. Final result: 75 Vitest tests and 20 Rust tests pass. SQLite emits its upstream
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
`dev.nimboguide.desktop` identifier, version, icon and honest microphone purpose.
`codesign -dv` reported an arm64 ad-hoc signature. Native .node is unpacked at
`Contents/Resources/app.asar.unpacked/node_modules/@nimboguide/native/` and was
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
