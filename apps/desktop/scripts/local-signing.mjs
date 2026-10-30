// Stable local code signing for development builds.
//
// macOS ties Microphone, Screen Recording and Input Monitoring grants to an app's designated
// requirement. An ad-hoc signature's requirement is its content hash, so every rebuild looked
// like a new app and lost those grants. Signing with one self-signed certificate gives every
// build the same requirement ("identifier dev.heynimbo.desktop and certificate leaf = H..."),
// so grants survive rebuilds. This is not a distribution signature (no Developer ID, no
// notarization) and changes nothing about how the app runs.
//
// The certificate lives in its own keychain file, never added to the keychain search list, so
// the login keychain is not touched and nothing prompts for a password. Like credentials.json,
// it is protected by this user account's file permissions.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const NAME = 'HeyNimbo Local Signing'
export const KEYCHAIN = join(homedir(), 'Library/Keychains/heynimbo-local-signing.keychain-db')
const OPENSSL = '/usr/bin/openssl'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}
const unlock = keychain => run('security', ['unlock-keychain', '-p', '', keychain])

/** SHA-1 of the signing identity in `keychain`, or undefined if it has not been set up. */
export function identity(keychain = KEYCHAIN) {
  if (!existsSync(keychain)) return undefined
  // Self-signed, so it is listed as a matching (not "valid") identity; codesign accepts it by hash.
  const listed = spawnSync('security', ['find-identity', '-p', 'codesigning', keychain], { encoding: 'utf8' }).stdout ?? ''
  return new RegExp(`\\b([0-9A-F]{40}) "${NAME}"`).exec(listed)?.[1]
}

/** Creates the keychain and certificate once; later calls return the existing identity. The
 *  keychain has no password, so it is kept readable by this user account only. */
export function setup(keychain = KEYCHAIN) {
  const existing = identity(keychain)
  if (existing) { chmodSync(keychain, 0o600); return existing }
  const work = mkdtempSync(join(tmpdir(), 'heynimbo-signing-'))
  try {
    const config = join(work, 'cert.cnf'), key = join(work, 'key.pem'), cert = join(work, 'cert.pem'), bundle = join(work, 'identity.p12')
    writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${NAME}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n`, { mode: 0o600 })
    run(OPENSSL, ['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-config', config, '-keyout', key, '-out', cert])
    const transfer = randomBytes(16).toString('hex')
    run(OPENSSL, ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', bundle, '-passout', `pass:${transfer}`])
    if (!existsSync(keychain)) {
      run('security', ['create-keychain', '-p', '', keychain])
      run('security', ['set-keychain-settings', keychain]) // no auto-lock timeout
    }
    chmodSync(keychain, 0o600)
    unlock(keychain)
    run('security', ['import', bundle, '-k', keychain, '-P', transfer, '-T', '/usr/bin/codesign'])
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', '', keychain])
  } finally { rmSync(work, { recursive: true, force: true }) }
  const created = identity(keychain)
  if (!created) throw new Error('The signing identity was not created.')
  return created
}

/** Native modules under Resources (app.asar.unpacked); `codesign --deep` only reaches nested bundles. */
const nativeModules = app => readdirSync(join(app, 'Contents/Resources'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(node|dylib)$/.test(entry.name))
  .map(entry => join(entry.parentPath, entry.name))

/** Re-signs a built app (and the code inside it) with the local identity, keeping each part's
 *  entitlements. Returns its designated requirement, or undefined (left ad-hoc) without setup. */
export function sign(app, keychain = KEYCHAIN) {
  const id = identity(keychain)
  if (!id) return undefined
  unlock(keychain)
  const options = ['--force', '--timestamp=none', '--preserve-metadata=identifier,entitlements', '--keychain', keychain, '--sign', id]
  for (const module of nativeModules(app)) run('codesign', [...options, module])
  run('codesign', [...options, '--deep', app])
  run('codesign', ['--verify', '--deep', '--strict', app])
  const shown = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' })
  return `${shown.stdout}${shown.stderr}`.split('\n').find(line => line.startsWith('designated =>'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, app] = process.argv.slice(2)
  if (process.platform !== 'darwin') process.exit(0)
  if (command === 'setup') {
    console.log(`${NAME}: ${setup()} in ${KEYCHAIN}`)
  } else if (command === 'sign' && app) {
    const requirement = sign(app)
    console.log(requirement
      ? `Signed with ${NAME}; macOS permissions carry over to the next build.\n${requirement}`
      : `No ${NAME} identity: the app stays ad-hoc signed and macOS may ask for permissions again after each rebuild. Run "pnpm signing:setup" once to keep them.`)
  } else {
    console.error('Usage: local-signing.mjs setup | sign <path/to/App.app>')
    process.exit(2)
  }
}
