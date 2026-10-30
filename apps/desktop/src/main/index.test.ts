import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setVoiceKey: undefined as ((key: string | undefined) => void) | undefined,
  connectionsChanged: undefined as (() => void) | undefined,
  builtinEars: vi.fn(), builtinMouth: vi.fn(),
  shellActions: undefined as { settingsChanged(settings: { voice: string; showNotch: boolean; muted: boolean }, previous: { voice: string }): void } | undefined,
  audio: vi.fn(), ears: vi.fn(), mouth: vi.fn(), talk: vi.fn(), gestures: vi.fn(), key: vi.fn(), setup: vi.fn(),
  quit: vi.fn(), exit: vi.fn(), lock: vi.fn(() => true), preview: vi.fn(), paths: vi.fn(), shell: vi.fn(), gallery: vi.fn(), evaluation: vi.fn(), show: vi.fn(),
  policy: vi.fn(), menu: vi.fn(), dockHide: vi.fn(), setStatus: vi.fn(),
  mkdtemp: vi.fn(() => '/tmp/heynimbo-draw-demo-fixture'), removeProfile: vi.fn(),
  overlays: { sync: vi.fn(), clear: vi.fn(), drawBeat: vi.fn(), fadeSoon: vi.fn(), answerDone: vi.fn(), startFollowing: vi.fn(), listen: vi.fn(), onStrokeStarted: undefined },
}))

vi.mock('electron', () => ({
  app: { setPath: mocks.paths, getLoginItemSettings: () => ({ wasOpenedAtLogin: false }), requestSingleInstanceLock: mocks.lock, isPackaged: false, whenReady: () => Promise.resolve(), on: vi.fn(), dock: { hide: mocks.dockHide }, quit: mocks.quit, exit: mocks.exit, setActivationPolicy: mocks.policy, isActive: () => false },
  Menu: { setApplicationMenu: mocks.menu },
  screen: {
    on: vi.fn(),
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}))
vi.mock('node:fs', async (load) => ({ ...await load<typeof import('node:fs')>(), mkdtempSync: mocks.mkdtemp, rmSync: mocks.removeProfile }))
vi.mock('./home-preview', () => ({ configureHomePreview: vi.fn(), runHomePreview: mocks.preview }))
vi.mock('./model-gallery', async (load) => ({ ...await load<typeof import('./model-gallery')>(), runModelGallery: mocks.gallery }))
vi.mock('./model-eval', async (load) => ({ ...await load<typeof import('./model-eval')>(), runModelEval: mocks.evaluation }))
vi.mock('./model-show', async (load) => ({ ...await load<typeof import('./model-show')>(), runModelShow: mocks.show }))
vi.mock('./app-shell', () => ({ AppShell: vi.fn(function (actions) { mocks.shell(); mocks.shellActions = actions; return { settings: { get: () => ({ voice: 'marin', showNotch: true, muted: false }) }, conversations: {}, openHome: vi.fn(), publish: vi.fn(), setStatus: mocks.setStatus } }) }))
vi.mock('./notch-peek', () => ({ NotchPeek: vi.fn(function () { return { publish: vi.fn() } }) }))
vi.mock('./audio-window', () => ({ AudioWindow: mocks.audio, ensureMicrophoneAccess: vi.fn(), microphoneAccessStatus: vi.fn(() => 'granted') }))
vi.mock('./capture', () => ({ captureCursorDisplay: vi.fn(), ensureScreenCaptureAccess: vi.fn(), restingStatus: vi.fn(), scheduleExclusionSelfTest: vi.fn() }))
vi.mock('./gestures', () => ({ startGestures: mocks.gestures }))
vi.mock('./connections', () => ({ Connections: vi.fn(function (_settings, changed) { mocks.connectionsChanged = changed; let key: string | undefined; mocks.setVoiceKey = value => { key = value }; return { load: async () => { key = await mocks.key() }, get voiceKey() { return key }, get voiceEngine() { return { engine: key ? 'openai' : 'builtin' } }, get answerReady() { return Boolean(key) }, snapshot: () => ({}), answer: vi.fn() } }) }))
vi.mock('./setup-window', () => ({ openSetupWindow: mocks.setup }))
vi.mock('./voice/ears', () => ({ Ears: mocks.ears }))
vi.mock('./voice/mouth', () => ({ Mouth: mocks.mouth }))
vi.mock('./voice/builtin-ears', () => ({ BuiltInEars: mocks.builtinEars.mockImplementation(function () { return { warm: vi.fn() } }) }))
vi.mock('./voice/builtin-mouth', () => ({ BuiltInMouth: mocks.builtinMouth.mockImplementation(function () { return { warm: vi.fn() } }) }))
vi.mock('./voice/talk', () => ({ TalkSession: mocks.talk }))
vi.mock('./windows', () => ({
  createNotchWindow: vi.fn(), positionNotch: vi.fn(), sendNotchStatus: vi.fn(), setNotchVisibility: vi.fn(),
  OverlayManager: vi.fn(function () { return mocks.overlays }),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('boots the real demo branch without constructing audio, starting talk or accessing credentials', async () => {
  vi.useFakeTimers()
  vi.stubEnv('HEYNIMBO_DEBUG_DRAW_DEMO', '1')
  vi.spyOn(process, 'uptime').mockReturnValue(0)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('./index')
  await vi.advanceTimersByTimeAsync(38600)
  expect(mocks.mkdtemp).toHaveBeenCalledWith('/tmp/heynimbo-draw-demo-')
  expect(mocks.paths.mock.calls).toEqual([['userData', '/tmp/heynimbo-draw-demo-fixture'], ['sessionData', '/tmp/heynimbo-draw-demo-fixture']])
  expect(mocks.paths.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.lock.mock.invocationCallOrder[0]!)
  // Launched background-only with no app menu, so it can never take focus or switch the user's Space.
  expect(mocks.policy).toHaveBeenCalledWith('prohibited'); expect(mocks.menu).toHaveBeenCalledWith(null)
  expect(mocks.policy.mock.invocationCallOrder[0]!).toBeLessThan(mocks.lock.mock.invocationCallOrder[0]!)
  expect(mocks.overlays.drawBeat.mock.calls.length).toBeGreaterThan(11)
  expect(mocks.overlays.onStrokeStarted).toBeUndefined()
  for (const dependency of [mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup, mocks.shell]) {
    expect(dependency).not.toHaveBeenCalled()
  }
  expect(mocks.quit).toHaveBeenCalledOnce()
})

it('starts each question on a clean screen and shows the ear only while talk is held', async () => {
  vi.resetModules()
  const session = { holdStarted: vi.fn(), holdEnded: vi.fn(), holdCancelled: vi.fn() }
  mocks.talk.mockImplementation(function () { return session })
  mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
  for (const voice of [mocks.ears, mocks.mouth, mocks.builtinEars, mocks.builtinMouth]) voice.mockImplementation(function () { return { warm: vi.fn() } })
  mocks.gestures.mockReturnValue({ ok: true, monitor: { stop: vi.fn() } })
  mocks.key.mockResolvedValue('sk-test')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('./index')
  await vi.waitFor(() => expect(mocks.talk).toHaveBeenCalled())
  const present = mocks.gestures.mock.calls[0]![0] as (message: { action: string; phase: string }) => void
  const { clear, listen } = mocks.overlays
  clear.mockClear()

  present({ action: 'talk', phase: 'started' })
  // Drawing still queued from the last answer must stop before the ear appears.
  expect(clear).toHaveBeenCalledOnce()
  expect(listen).toHaveBeenLastCalledWith(true)
  expect(clear.mock.invocationCallOrder[0]).toBeLessThan(listen.mock.invocationCallOrder.at(-1)!)
  expect(session.holdStarted).toHaveBeenCalledOnce()

  present({ action: 'talk', phase: 'ended' })
  expect(listen).toHaveBeenLastCalledWith(false)
  present({ action: 'talk', phase: 'started' })
  present({ action: 'talk', phase: 'cancelled' })
  expect(listen).toHaveBeenLastCalledWith(false)
  expect(session.holdEnded).toHaveBeenCalledOnce()
  expect(session.holdCancelled).toHaveBeenCalledOnce()
})

it('runs the hidden 3D gallery in its own profile, launched background-only, with no capture, gesture, audio or credential pipeline', async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('HEYNIMBO_DEBUG_3D_GALLERY', '1')
  vi.spyOn(process, 'uptime').mockReturnValue(0)
  await import('./index')
  await vi.waitFor(() => expect(mocks.gallery).toHaveBeenCalledOnce())
  expect(mocks.mkdtemp).toHaveBeenCalledWith('/tmp/heynimbo-model-gallery-')
  expect(mocks.policy).toHaveBeenCalledWith('prohibited'); expect(mocks.menu).toHaveBeenCalledWith(null)
  for (const before of [mocks.policy, mocks.paths]) expect(before.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.lock.mock.invocationCallOrder[0]!)
  for (const dependency of [mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup, mocks.shell, mocks.overlays.sync]) expect(dependency).not.toHaveBeenCalled()
})
it('runs the 3D eval on the normal profile, behind the instance lock, with no overlay, capture, gesture, audio or voice pipeline', async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL', '1')
  vi.spyOn(process, 'uptime').mockReturnValue(0)
  await import('./index')
  await vi.waitFor(() => expect(mocks.evaluation).toHaveBeenCalledOnce())
  // Saved keys live in the normal profile, so it is not swapped for a throwaway one.
  expect(mocks.mkdtemp).not.toHaveBeenCalled(); expect(mocks.paths).not.toHaveBeenCalled()
  expect(mocks.lock).toHaveBeenCalledOnce()
  expect(mocks.policy).toHaveBeenCalledWith('prohibited'); expect(mocks.menu).toHaveBeenCalledWith(null)
  for (const dependency of [mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup, mocks.shell, mocks.overlays.sync]) expect(dependency).not.toHaveBeenCalled()
})
it('replays an eval run as a showcase in a throwaway profile, never focusing, with no capture, gesture, audio or credential pipeline', async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW', '/tmp/heynimbo-3d-eval-synthetic/run')
  vi.spyOn(process, 'uptime').mockReturnValue(0)
  await import('./index')
  await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce())
  expect(mocks.mkdtemp).toHaveBeenCalledWith('/tmp/heynimbo-model-show-')
  for (const before of [mocks.policy, mocks.paths]) expect(before.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.lock.mock.invocationCallOrder[0]!)
  expect(mocks.policy).toHaveBeenCalledWith('prohibited')
  for (const dependency of [mocks.evaluation, mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup, mocks.shell, mocks.overlays.sync]) expect(dependency).not.toHaveBeenCalled()
})
it('runs the live showcase on the normal profile behind the instance lock, with no gesture, audio or voice pipeline', async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE', '1'); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_MODELS', 'openai:gpt-6.1-terra:low')
  vi.spyOn(process, 'uptime').mockReturnValue(0)
  await import('./index')
  await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce())
  expect(mocks.mkdtemp).not.toHaveBeenCalled(); expect(mocks.paths).not.toHaveBeenCalled()
  expect(mocks.lock).toHaveBeenCalledOnce(); expect(mocks.policy).toHaveBeenCalledWith('prohibited')
  for (const dependency of [mocks.evaluation, mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup, mocks.shell, mocks.overlays.sync]) expect(dependency).not.toHaveBeenCalled()
})
it('cannot start the 3D eval or its showcase in a packaged app', async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL', '1'); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW', '/tmp/heynimbo-3d-eval-synthetic/run'); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE', '1')
  const electron = await import('electron')
  Object.defineProperty(electron.app, 'isPackaged', { value: true, configurable: true })
  try {
    mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
    await import('./index')
    await vi.waitFor(() => expect(mocks.shell).toHaveBeenCalled())
    expect(mocks.evaluation).not.toHaveBeenCalled(); expect(mocks.show).not.toHaveBeenCalled(); expect(mocks.policy).not.toHaveBeenCalled()
    expect(mocks.mkdtemp).not.toHaveBeenCalled()
  } finally { Object.defineProperty(electron.app, 'isPackaged', { value: false, configurable: true }) }
})
it('routes Home preview before creating any capture, gesture, audio or credential pipeline', async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('HEYNIMBO_DEBUG_HOME_PREVIEW', '1')
  await import('./index')
  await vi.waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce())
  expect(mocks.lock).not.toHaveBeenCalled()
  for (const dependency of [mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup, mocks.overlays.sync]) expect(dependency).not.toHaveBeenCalled()
})
it('quits a second instance without starting background capabilities', async () => {
  vi.resetModules(); vi.clearAllMocks(); mocks.lock.mockReturnValueOnce(false)
  await import('./index')
  expect(mocks.quit).toHaveBeenCalledOnce()
  for (const dependency of [mocks.audio, mocks.gestures, mocks.key, mocks.overlays.sync]) expect(dependency).not.toHaveBeenCalled()
})

it('reconnect resets overlay listening before installing the replacement session', async () => {
  vi.resetModules(); vi.clearAllMocks()
  const close = vi.fn()
  mocks.talk.mockImplementation(function () { return { close } })
  mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
  for (const voice of [mocks.ears, mocks.mouth, mocks.builtinEars, mocks.builtinMouth]) voice.mockImplementation(function () { return { warm: vi.fn() } })
  mocks.gestures.mockReturnValue({ ok: true, monitor: { stop: vi.fn() } }); mocks.key.mockResolvedValue('sk-fixture')
  await import('./index')
  await vi.waitFor(() => expect(mocks.talk).toHaveBeenCalledOnce())
  mocks.overlays.listen.mockClear()
  mocks.shellActions?.settingsChanged({ voice: 'cedar', showNotch: true, muted: false }, { voice: 'marin' })
  expect(close).toHaveBeenCalledOnce()
  expect(mocks.overlays.listen).toHaveBeenCalledWith(false)
  expect(mocks.overlays.listen.mock.invocationCallOrder[0]!).toBeLessThan(mocks.talk.mock.invocationCallOrder.at(-1)!)
})

it.each([true, false])('tells the owner in Home, not only the notch, when hold-to-talk lacks Input Monitoring (granted: %s)', async granted => {
  vi.resetModules(); vi.clearAllMocks()
  mocks.talk.mockImplementation(function () { return { holdStarted: vi.fn() } })
  mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
  for (const voice of [mocks.ears, mocks.mouth, mocks.builtinEars, mocks.builtinMouth]) voice.mockImplementation(function () { return { warm: vi.fn() } })
  mocks.gestures.mockReturnValue(granted ? { ok: true, monitor: { stop: vi.fn() } } : { ok: false, reason: 'inputMonitoring' })
  mocks.key.mockResolvedValue('sk-test')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('./index'); await vi.waitFor(() => expect(mocks.talk).toHaveBeenCalled())
  // The notch can be hidden in Settings, so the reason must also reach Home.
  const notices = mocks.setStatus.mock.calls.map(([label]) => String(label))
  if (granted) expect(notices.filter(label => label.includes('Input Monitoring'))).toEqual([])
  else expect(notices).toContain('Hold-to-talk unavailable: turn on HeyNimbo in System Settings → Privacy & Security → Input Monitoring, then reopen HeyNimbo.')
})

it('shows an actionable voice message without displaying the listening ear for a typed-only connection', async () => {
  vi.resetModules(); vi.clearAllMocks()
  const session = { voiceAvailable: false, holdStarted: vi.fn() }
  mocks.talk.mockImplementation(function () { return session })
  mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
  mocks.gestures.mockReturnValue({ ok: true, monitor: { stop: vi.fn() } }); mocks.key.mockResolvedValue(undefined)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('./index'); await vi.waitFor(() => expect(mocks.talk).toHaveBeenCalled())
  const present = mocks.gestures.mock.calls[0]![0] as (message: { action: string; phase: string }) => void
  mocks.overlays.listen.mockClear()
  present({ action: 'talk', phase: 'started' })
  expect(session.holdStarted).not.toHaveBeenCalled(); expect(mocks.overlays.listen).not.toHaveBeenCalledWith(true)
})

it('a connection key change reconnects from local to OpenAI and back', async () => {
  vi.resetModules(); vi.clearAllMocks()
  const close = vi.fn()
  mocks.talk.mockImplementation(function () { return { close } })
  mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
  for (const voice of [mocks.ears, mocks.mouth, mocks.builtinEars, mocks.builtinMouth]) voice.mockImplementation(function () { return { warm: vi.fn() } })
  mocks.gestures.mockReturnValue({ ok: true, monitor: { stop: vi.fn() } }); mocks.key.mockResolvedValue(undefined)
  await import('./index'); await vi.waitFor(() => expect(mocks.talk).toHaveBeenCalledOnce())
  expect(mocks.builtinEars).toHaveBeenCalledOnce(); expect(mocks.ears).not.toHaveBeenCalled()
  mocks.setVoiceKey?.('synthetic-voice'); mocks.connectionsChanged?.()
  expect(close).toHaveBeenCalledOnce(); expect(mocks.ears).toHaveBeenCalledWith('synthetic-voice')
  expect(mocks.mouth).toHaveBeenCalledWith('synthetic-voice', 'marin')
  mocks.setVoiceKey?.(undefined); mocks.connectionsChanged?.()
  expect(close).toHaveBeenCalledTimes(2); expect(mocks.builtinEars).toHaveBeenCalledTimes(2)
  expect(mocks.builtinMouth).toHaveBeenCalledTimes(2)
})
