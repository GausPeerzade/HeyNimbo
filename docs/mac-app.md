# HeyNimbo macOS app

Run `pnpm dist:mac` for an arm64 ad-hoc-signed bundle in
`apps/desktop/dist/mac-arm64/HeyNimbo.app`. Do not copy a development build
into /Applications or run it beside an existing resident instance: both would
try to own Control–Option. The native workspace package is included by
electron-builder's dependency collector; `.node` files are unpacked beside
`app.asar` and the generated native loader resolves its sibling there.

A rebuilt ad-hoc-signed app can have a different signing identity/hash and may
need Microphone, Screen Recording and Input Monitoring granted again. A stable
bundle ID alone does not preserve these grants. Production distribution still
requires Developer ID signing and notarization; this build is not notarized.

`pnpm --filter @heynimbo/desktop brand` regenerates legacy ICNS, template
menu-bar PNGs and Home/About marks from `build/brand/logo.svg`. It uses only a
hidden offscreen Electron window and iconutil. The legacy icon field uses the
1024 grid's 100-pixel inset and rounded 824-pixel field, not a rounded window
frame. Layered Icon Composer appearance variants are not shipped. Palette
changes belong in `src/renderer/tokens.css`; mark changes belong in the source
SVG. No product assets were copied. System fonts are used for app UI.
