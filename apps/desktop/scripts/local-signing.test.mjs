import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { identity, setup, sign } from './local-signing.mjs'

// Real security/codesign on a throwaway keychain and a small app shaped like the packaged one.
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`)
  return `${result.stdout}${result.stderr}`
}
let dir = '', keychain = '', searchList = ''
beforeAll(() => {
  if (process.platform !== 'darwin') return
  dir = mkdtempSync(join(tmpdir(), 'heynimbo-local-signing-test-'))
  keychain = join(dir, 'signing.keychain-db')
  searchList = run('security', ['list-keychains', '-d', 'user'])
})
afterAll(() => {
  if (!dir) return
  spawnSync('security', ['delete-keychain', keychain])
  rmSync(dir, { recursive: true, force: true })
})
/** Rebuilds the probe app the way electron-builder leaves it: ad-hoc signed, with entitlements. */
function build(content) {
  const app = join(dir, 'Probe.app'), native = join(app, 'Contents/Resources/app.asar.unpacked/native')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true }); mkdirSync(native, { recursive: true })
  copyFileSync('/usr/bin/true', join(app, 'Contents/MacOS/Probe'))
  copyFileSync('/usr/bin/true', join(native, 'addon.node'))
  writeFileSync(join(app, 'Contents/Resources/content.txt'), content)
  writeFileSync(join(app, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.heynimbo.probe</string><key>CFBundleExecutable</key><string>Probe</string></dict></plist>')
  const entitlements = join(dir, 'entitlements.plist')
  writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>')
  run('codesign', ['--force', '--sign', '-', join(native, 'addon.node')])
  run('codesign', ['--force', '--sign', '-', '--entitlements', entitlements, app])
  return app
}
const designated = app => run('codesign', ['-d', '-r-', app]).split('\n').find(line => line.includes('designated =>'))
const details = path => run('codesign', ['-dvvv', path])

it.skipIf(process.platform !== 'darwin')('signs every rebuild with one unchanging requirement, so macOS privacy grants survive, without touching the login keychain', () => {
  // Before setup the build stays ad-hoc: its requirement is the content hash, which changes every build.
  expect(identity(keychain)).toBeUndefined()
  const app = build('first')
  expect(sign(app, keychain)).toBeUndefined()
  expect(designated(app)).toMatch(/cdhash H"/)

  const id = setup(keychain)
  // The empty-password keychain holds a private key, so only this user account may read it.
  expect(statSync(keychain).mode & 0o777).toBe(0o600)
  // Setup is idempotent: a second run reuses the certificate instead of adding another one.
  expect(setup(keychain)).toBe(id)
  expect(run('security', ['find-identity', '-p', 'codesigning', keychain]).match(/\b[0-9A-F]{40} "HeyNimbo Local Signing"/g)).toEqual([`${id} "HeyNimbo Local Signing"`])

  const requirement = `designated => identifier "dev.heynimbo.probe" and certificate leaf = H"${id.toLowerCase()}"`
  expect(sign(build('first'), keychain)).toBe(requirement)
  const firstHash = /CDHash=(\w+)/.exec(details(app))[1]
  expect(sign(build('second build with different content'), keychain)).toBe(requirement)
  expect(/CDHash=(\w+)/.exec(details(app))[1]).not.toBe(firstHash)
  run('codesign', ['--verify', '--deep', '--strict', app])

  // Native modules are re-signed too, and electron-builder's entitlements are kept.
  expect(details(join(app, 'Contents/Resources/app.asar.unpacked/native/addon.node'))).toContain('Authority=HeyNimbo Local Signing')
  expect(run('codesign', ['-d', '--entitlements', '-', '--xml', app])).toContain('com.apple.security.cs.allow-jit')
  // The signing keychain never joins the search list, so nothing else sees or prompts for it.
  expect(run('security', ['list-keychains', '-d', 'user'])).toBe(searchList)
}, 60_000)
