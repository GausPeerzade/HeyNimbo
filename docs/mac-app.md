# HeyNimbo macOS app

Run `pnpm dist:mac` for an arm64 bundle in
`apps/desktop/dist/mac-arm64/HeyNimbo.app`. Do not copy a development build
into /Applications or run it beside an existing resident instance: both would
try to own Control–Option. The native workspace package is included by
electron-builder's dependency collector; `.node` files are unpacked beside
`app.asar` and the generated native loader resolves its sibling there.

macOS ties Microphone, Screen Recording and Input Monitoring grants to the
app's designated requirement. An ad-hoc signature's requirement is its content
hash, so every rebuild looked like a new app and lost those grants. Run
`pnpm signing:setup` once: it creates a self-signed "HeyNimbo Local Signing"
certificate in its own keychain file
(`~/Library/Keychains/heynimbo-local-signing.keychain-db`, not added to the
keychain search list, no password prompt). `pnpm dist:mac` then re-signs the
bundle and its native modules with it, so every build has the same requirement
and keeps its grants. Without setup the build stays ad-hoc signed. To remove
it, delete that keychain file. Production distribution still requires
Developer ID signing and notarization; this build is not notarized.

`pnpm --filter @heynimbo/desktop brand` regenerates legacy ICNS, template
menu-bar PNGs and Home/About marks from `build/brand/logo.svg`. It uses only a
hidden offscreen Electron window and iconutil. The legacy icon field uses the
1024 grid's 100-pixel inset and rounded 824-pixel field, not a rounded window
frame. Layered Icon Composer appearance variants are not shipped. Palette
changes belong in `src/renderer/tokens.css`; mark changes belong in the source
SVG. No product assets were copied. System fonts are used for app UI.
