import { beforeEach, expect, it, vi } from 'vitest'
import { AudioWindow, ensureMicrophoneAccess, microphoneAccessStatus } from './audio-window'
const mocks = vi.hoisted(() => ({
  descriptions: vi.fn(), status: vi.fn(), ask: vi.fn(),
  request: undefined as ((requester: unknown, permission: string, callback: (allow: boolean) => void, details: { mediaTypes: string[] }) => void) | undefined,
  check: undefined as ((requester: unknown, permission: string) => boolean) | undefined,
  contents: {} as Record<string, unknown>,
}))
vi.mock('@heynimbo/native', () => ({ hasVoiceUsageDescriptions: mocks.descriptions }))
vi.mock('./windows', () => ({ loadPage: vi.fn(), secureWebPreferences: vi.fn() }))
vi.mock('electron', () => ({
  systemPreferences: { getMediaAccessStatus: mocks.status, askForMediaAccess: mocks.ask }, ipcMain: { on: vi.fn() },
  BrowserWindow: vi.fn(function () { return { webContents: mocks.contents } }),
}))
beforeEach(() => {
  vi.clearAllMocks(); mocks.descriptions.mockReturnValue(false)
  mocks.contents = { once: vi.fn(), session: { setPermissionRequestHandler: (handler: typeof mocks.request) => { mocks.request = handler }, setPermissionCheckHandler: (handler: typeof mocks.check) => { mocks.check = handler } } }
})
it('never calls microphone authorization APIs when bundle usage strings are missing', async () => {
  expect(await ensureMicrophoneAccess()).toBe(false)
  expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.ask).not.toHaveBeenCalled()
})
it('only asks for microphone access after the metadata guard passes', async () => {
  mocks.descriptions.mockReturnValue(true); mocks.status.mockReturnValue('not-determined'); mocks.ask.mockResolvedValue(true)
  expect(await ensureMicrophoneAccess()).toBe(true)
  expect(mocks.descriptions.mock.invocationCallOrder[0]!).toBeLessThan(mocks.status.mock.invocationCallOrder[0]!)
  expect(mocks.ask).toHaveBeenCalledWith('microphone')
})
it.each(['granted', 'denied', 'restricted', 'unknown'] as const)('reports %s without attempting a first-time prompt', async status => {
  mocks.descriptions.mockReturnValue(true); mocks.status.mockReturnValue(status)
  expect(microphoneAccessStatus()).toBe(status)
  expect(await ensureMicrophoneAccess()).toBe(status === 'granted')
  expect(mocks.ask).not.toHaveBeenCalled()
})
it('denies Chromium microphone requests without usage strings and restricts them to its audio window', () => {
  new AudioWindow(vi.fn())
  const callback = vi.fn()
  mocks.request!(mocks.contents, 'media', callback, { mediaTypes: ['audio'] })
  expect(callback).toHaveBeenLastCalledWith(false); expect(mocks.check!(mocks.contents, 'media')).toBe(false)
  mocks.descriptions.mockReturnValue(true)
  mocks.request!(mocks.contents, 'media', callback, { mediaTypes: ['audio'] })
  expect(callback).toHaveBeenLastCalledWith(true); expect(mocks.check!(mocks.contents, 'media')).toBe(true)
  mocks.request!({}, 'media', callback, { mediaTypes: ['audio'] }); expect(callback).toHaveBeenLastCalledWith(false)
  mocks.request!(mocks.contents, 'media', callback, { mediaTypes: ['video'] }); expect(callback).toHaveBeenLastCalledWith(false)
})
