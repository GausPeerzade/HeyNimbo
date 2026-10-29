// Only patches this worktree's downloaded Electron bundle; never requests access.
const { copyFileSync, constants, existsSync, realpathSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve, sep } = require('node:path')
const root = resolve(__dirname, '..')
if (process.platform !== 'darwin') throw new Error('Development speech permissions require macOS.')
const electron = realpathSync(require.resolve('electron', { paths: [join(root, 'apps/desktop')] }))
if (!electron.startsWith(join(root, 'node_modules') + sep)) throw new Error('Refusing to modify Electron outside this worktree’s node_modules.')
const plist = join(electron, '..', 'dist/Electron.app/Contents/Info.plist')
const backup = `${plist}.before-heynimbo-speech`
if (!existsSync(backup)) copyFileSync(plist, backup, constants.COPYFILE_EXCL)
const descriptions = {
  NSSpeechRecognitionUsageDescription: 'HeyNimbo transcribes your voice questions on this Mac when you hold Control + Option. Built-in speech never sends your audio to a server.',
  NSMicrophoneUsageDescription: 'HeyNimbo uses your microphone when you ask by voice. Speech is processed on this Mac, or sent to OpenAI when you have saved an OpenAI API key.',
}
for (const [key, text] of Object.entries(descriptions)) {
  let present = false
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'ignore' }); present = true } catch {}
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `${present ? 'Set' : 'Add'} :${key}${present ? '' : ' string'} ${text}`, plist])
}
console.log(`Prepared this worktree's Electron speech usage descriptions. Backup: ${backup}. Restart Electron before testing.`)
