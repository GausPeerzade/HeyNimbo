import { afterEach, expect, it, vi } from 'vitest'

it('keeps peek exit controls inert and reverses an exit on renewed hover', async () => {
  vi.useFakeTimers(); vi.resetModules()
  const nodes = new Map<string, { hidden: boolean; inert: boolean; getAnimations: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; getBoundingClientRect(): { left: number; right: number; top: number; bottom: number } }>()
  for (const id of ['surface', 'pill', 'peek', 'label', 'mark', 'home', 'new', 'stop']) nodes.set(id, { hidden: id === 'peek', inert: id === 'peek', getAnimations: vi.fn(() => []), addEventListener: vi.fn(), getBoundingClientRect: () => ({ left: 72, right: 312, top: 0, bottom: 36 }) })
  let move!: (event: { clientX: number; clientY: number }) => void
  const send = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }))
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name === '--hover-dwell' ? '200' : '120' }))
  vi.stubGlobal('document', { documentElement: {}, getElementById: (id: string) => nodes.get(id), addEventListener() {} })
  vi.stubGlobal('window', { addEventListener: (_: string, handler: typeof move) => { move = handler }, nimbo: { sendNotchEvent: send, onNotchStatus() {}, onPeekSnapshot() {}, onPeekDismiss() {} } })
  await import('./notch')
  const peek = nodes.get('peek')!
  move({ clientX: 192, clientY: 20 }); vi.advanceTimersByTime(199)
  expect(peek.hidden).toBe(true)
  vi.advanceTimersByTime(1)
  expect(peek.hidden).toBe(false); expect(peek.inert).toBe(false)
  move({ clientX: 0, clientY: 300 }); vi.advanceTimersByTime(120)
  expect(peek.hidden).toBe(true); expect(peek.inert).toBe(true)
  peek.getAnimations.mockReturnValue([{ playState: 'running' }])
  move({ clientX: 192, clientY: 20 })
  expect(peek.hidden).toBe(false); expect(peek.inert).toBe(false)
  expect(send).toHaveBeenLastCalledWith({ kind: 'expanded', expanded: true })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
