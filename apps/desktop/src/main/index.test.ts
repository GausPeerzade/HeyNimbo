import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  audio: vi.fn(), ears: vi.fn(), mouth: vi.fn(), talk: vi.fn(), gestures: vi.fn(), key: vi.fn(), setup: vi.fn(),
  quit: vi.fn(), exit: vi.fn(),
  overlays: { sync: vi.fn(), clear: vi.fn(), drawBeat: vi.fn(), fadeSoon: vi.fn(), startFollowing: vi.fn(), onStrokeStarted: undefined },
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
  await vi.advanceTimersByTimeAsync(14000)
  expect(mocks.overlays.drawBeat).toHaveBeenCalledTimes(8)
  expect(mocks.overlays.onStrokeStarted).toBeUndefined()
  for (const dependency of [mocks.audio, mocks.ears, mocks.mouth, mocks.talk, mocks.gestures, mocks.key, mocks.setup]) {
    expect(dependency).not.toHaveBeenCalled()
  }
  expect(mocks.quit).toHaveBeenCalledOnce()
})
