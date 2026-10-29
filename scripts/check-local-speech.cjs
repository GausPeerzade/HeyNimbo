// Opt-in, offline fixture check. This may show one Speech Recognition prompt.
// Never loads the app, credentials, a BrowserWindow, or a microphone.
const { readFileSync, mkdtempSync, realpathSync } = require('node:fs')
const { join, resolve, sep } = require('node:path')
const { createRequire, Module } = require('node:module')
const { execFileSync, spawn } = require('node:child_process')
const root = resolve(__dirname, '..')
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'))
if (process.env.NIMBO_DEBUG_LOCAL_SPEECH_CHECK !== '1') throw new Error('Set NIMBO_DEBUG_LOCAL_SPEECH_CHECK=1 only after approval for the system permission prompt.')
if (!process.versions.electron) {
  const started = Date.now()
  const directory = mkdtempSync('/tmp/nimbo-speech-check-')
  const aiff = join(directory, 'sentence.aiff'), wav = join(directory, 'sentence.wav')
  execFileSync('/usr/bin/say', ['-o', aiff, 'The purple notebook is beside the window.'], { timeout: 15_000 })
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', '-c', '1', aiff, wav], { timeout: 15_000 })
  const electron = realpathSync(desktopRequire('electron'))
  if (!electron.startsWith(join(root, 'node_modules') + sep)) throw new Error('Refusing Electron outside this worktree.')
  const child = spawn(electron, [__filename, wav, join(directory, 'profile')], { stdio: 'inherit' })
  const timer = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1 }, Math.max(1, 60_000 - (Date.now() - started)))
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  const { app, session } = require('electron')
  app.setActivationPolicy('prohibited')
  app.setPath('userData', process.argv[3]); app.setPath('sessionData', process.argv[3])
  setTimeout(() => app.exit(1), 55_000).unref()
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((_details, done) => done({ cancel: true }))
    const native = desktopRequire('@nimboguide/native')
    if (!native.hasVoiceUsageDescriptions()) throw new Error('Missing usage strings; no authorization API called.')
    const authorization = await native.requestSpeechAuthorization()
    console.log(`Speech authorization: ${authorization}`)
    if (authorization !== 'authorized') { app.exit(1); return }
    const availability = native.speechAvailability('en-US')
    console.log(`Built-in listening: ${JSON.stringify(availability)}`)
    if (!availability.available) { app.exit(1); return }
    const source = join(root, 'apps/desktop/src/main/voice/builtin-ears.ts')
    const typescript = desktopRequire('typescript')
    const compiled = typescript.transpileModule(readFileSync(source, 'utf8'), { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText
    const adapter = new Module(source, module); adapter.filename = source; adapter.paths = Module._nodeModulePaths(join(root, 'apps/desktop'))
    adapter._compile(compiled, source)
    const wav = readFileSync(process.argv[2])
    let pcm
    for (let at = 12; at + 8 <= wav.length;) {
      const size = wav.readUInt32LE(at + 4)
      if (wav.toString('ascii', at, at + 4) === 'data') { pcm = wav.subarray(at + 8, at + 8 + size); break }
      at += 8 + size + (size % 2)
    }
    if (!pcm?.length) throw new Error('No PCM fixture data.')
    const ears = new adapter.exports.BuiltInEars('en-US')
    ears.begin()
    for (let at = 0; at < pcm.length; at += 4_800) ears.append(pcm.subarray(at, at + 4_800))
    const started = performance.now()
    try {
      const transcript = await ears.finish()
      console.log(`Transcript: ${transcript}`)
      console.log(`Finish-to-final latency: ${Math.round(performance.now() - started)} ms`)
      app.exit(/purple notebook.*beside.*window/i.test(transcript) ? 0 : 1)
    } finally { ears.close() }
  }).catch(error => { console.error(error.message); app.exit(1) })
}
