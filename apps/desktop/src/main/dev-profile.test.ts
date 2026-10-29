import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ packaged: false, path: vi.fn(), on: vi.fn(), make: vi.fn(() => '/tmp/nimbo-draw-demo-unique'), remove: vi.fn(), policy: vi.fn(), menu: vi.fn() }))
vi.mock('electron', () => ({ app: { get isPackaged() { return state.packaged }, setPath: state.path, on: state.on, setActivationPolicy: state.policy }, Menu: { setApplicationMenu: state.menu } }))
vi.mock('node:fs', () => ({ mkdtempSync: state.make, rmSync: state.remove }))
import { isolateDevProfile, launchInBackground } from './dev-profile'
afterEach(() => { vi.clearAllMocks(); state.packaged = false })
it('isolates both Electron paths in a fresh temporary directory and removes only that directory on quit', () => {
  const cleanup = isolateDevProfile('draw-demo')
  expect(state.make).toHaveBeenCalledWith('/tmp/nimbo-draw-demo-')
  expect(state.path.mock.calls).toEqual([['userData', '/tmp/nimbo-draw-demo-unique'], ['sessionData', '/tmp/nimbo-draw-demo-unique']])
  expect(state.on).toHaveBeenCalledWith('will-quit', cleanup)
  cleanup()
  expect(state.remove).toHaveBeenCalledWith('/tmp/nimbo-draw-demo-unique', { recursive: true, force: true })
})
it('cannot redirect or remove a profile in a packaged app', () => {
  state.packaged = true
  isolateDevProfile('draw-demo')()
  for (const dependency of [state.path, state.on, state.make, state.remove]) expect(dependency).not.toHaveBeenCalled()
})
it('launches a harness background-only with no app menu, so it never takes focus or switches Spaces', () => {
  launchInBackground()
  if (process.platform === 'darwin') expect(state.policy).toHaveBeenCalledWith('prohibited')
  expect(state.menu).toHaveBeenCalledWith(null)
  vi.clearAllMocks(); state.packaged = true
  launchInBackground()
  expect(state.policy).not.toHaveBeenCalled(); expect(state.menu).not.toHaveBeenCalled()
})
