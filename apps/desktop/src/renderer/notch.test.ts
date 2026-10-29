import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '../shared/app'

class TestNode {
  hidden = false; inert = false; textContent = ''; children: TestNode[] = []
  addEventListener = vi.fn()
  getAnimations = vi.fn((): Array<{ playState: string }> => [])
  getBoundingClientRect = () => ({ left: 72, right: 312, top: 0, bottom: 36 })
  replaceChildren() { this.children = [] }
  append(node: TestNode) { this.children.push(node) }
}
async function fixture() {
  vi.useFakeTimers(); vi.resetModules()
  const nodes = new Map<string, TestNode>()
  for (const id of ['surface', 'pill', 'peek', 'label', 'mark', 'home', 'new', 'stop', 'peek-status', 'privacy', 'recent', 'recent-empty']) nodes.set(id, new TestNode())
  nodes.get('peek')!.hidden = true; nodes.get('peek')!.inert = true
  let move!: (event: { clientX: number; clientY: number }) => void
  let publish!: (snapshot: AppSnapshot) => void
  const send = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }))
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name === '--hover-dwell' ? '200' : '120' }))
  vi.stubGlobal('document', { documentElement: {}, getElementById: (id: string) => nodes.get(id), createElement: () => new TestNode(), addEventListener() {} })
  vi.stubGlobal('window', { addEventListener: (_: string, handler: typeof move) => { move = handler }, nimbo: { sendNotchEvent: send, onNotchStatus() {}, onPeekSnapshot: (handler: typeof publish) => { publish = handler }, onPeekDismiss() {} } })
  await import('./notch')
  return { nodes, send, move, publish }
}
it('keeps peek exit controls inert and reverses an exit on renewed hover', async () => {
  const { nodes, move, send } = await fixture()
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
it('shows an empty-recents instruction only when there are no conversations', async () => {
  const { nodes, publish } = await fixture()
  const snapshot = { busy: false, saved: true, status: '', conversations: [] } as unknown as AppSnapshot
  publish(snapshot)
  expect(nodes.get('recent-empty')!.hidden).toBe(false)
  expect(nodes.get('recent')!.hidden).toBe(true)
  expect(nodes.get('recent')!.children).toEqual([])
  publish({ ...snapshot, conversations: [{ id: 'first', title: 'Find the export menu', updated: 1 }] } as AppSnapshot)
  expect(nodes.get('recent-empty')!.hidden).toBe(true)
  expect(nodes.get('recent')!.hidden).toBe(false)
  expect(nodes.get('recent')!.children[0]!.textContent).toBe('Find the export menu')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
