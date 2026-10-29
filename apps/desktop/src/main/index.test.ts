import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  audio: vi.fn(), ears: vi.fn(), mouth: vi.fn(), talk: vi.fn(), gestures: vi.fn(), key: vi.fn(), setup: vi.fn(),
  quit: vi.fn(), exit: vi.fn(),
  overlays: { sync: vi.fn(), clear: vi.fn(), drawBeat: vi.fn(), fadeSoon: vi.fn(), answerDone: vi.fn(), startFollowing: vi.fn(), listen: vi.fn(), onStrokeStarted: undefined },
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, whenReady: () => Promise.resolve(), on: vi.fn(), dock: { hide: vi.fn() }, quit: mocks.quit, exit: mocks.exit },
  screen: {
    on: vi.fn(),
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}))
vi.mock('./audio-window', () => ({ AudioWindow: mocks.audio, ensureMicrophoneAccess: vi.fn() }))
vi.mock('./capture', () => ({ captureCursorDisplay: vi.fn(), ensureScreenCaptureAccess: vi.fn(), restingStatus: vi.fn(), scheduleExclusionSelfTest: vi.fn() }))
vi.mock('./gestures', () => ({ startGestures: mocks.gestures }))
vi.mock('./secrets', () => ({ loadOpenAIKey: mocks.key }))
vi.mock('./setup-window', () => ({ openSetupWindow: mocks.setup }))
vi.mock('./voice/ears', () => ({ Ears: mocks.ears }))
vi.mock('./voice/mouth', () => ({ Mouth: mocks.mouth }))
vi.mock('./voice/talk', () => ({ TalkSession: mocks.talk }))
vi.mock('./windows', () => ({
  createNotchWindow: vi.fn(), positionNotch: vi.fn(), sendNotchStatus: vi.fn(),
  OverlayManager: vi.fn(function () { return mocks.overlays }),
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('boots the real demo branch without constructing audio, starting talk or accessing credentials', async () => {
  vi.useFakeTimers()
  vi.stubEnv('NIMBO_DEBUG_DRAW_DEMO', '1')
  vi.spyOn(process, 'uptime').mockReturnValue(0)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('./index')
  await vi.advanceTimersByTimeAsync(34100)
  expect(mocks.overlays.drawBeat).toHaveBeenCalledTimes(11)
  expect(mocks.overlays.onStrokeStarted).toBeUndefined()
  for (const dependency of [mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup]) {
    expect(dependency).not.toHaveBeenCalled()
  }
  expect(mocks.quit).toHaveBeenCalledOnce()
})

it('starts each question on a clean screen and shows the ear only while talk is held', async () => {
  vi.resetModules()
  const session = { holdStarted: vi.fn(), holdEnded: vi.fn(), holdCancelled: vi.fn() }
  mocks.talk.mockImplementation(function () { return session })
  mocks.audio.mockImplementation(function () { return { send: vi.fn() } })
  for (const voice of [mocks.ears, mocks.mouth]) voice.mockImplementation(function () { return { warm: vi.fn() } })
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
