import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '../shared/app'
import type { ConnectionResult } from '../shared/providers'
import { DEFAULT_SETTINGS } from '../main/settings'

class TestNode {
  children: TestNode[] = []
  dataset: Record<string, string> = {}
  value = ''; id = ''; textContent = ''; open = false; scrollTop = 0
  constructor(readonly tag: string, readonly className = '', text = '') { this.textContent = text }
  append(...children: TestNode[]) { this.children.push(...children) }
  replaceChildren(...children: TestNode[]) { this.children = children }
  querySelectorAll(tag: string): TestNode[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]) }
  setAttribute() {}
  focus() {}
}
const mocks = vi.hoisted(() => ({ request: vi.fn(), renderConnections: vi.fn(), onSnapshot: undefined as ((value: AppSnapshot) => void) | undefined, onNavigate: undefined as ((value: { category: string }) => void) | undefined }))
vi.mock('./connections', () => ({ renderConnections: mocks.renderConnections }))
vi.mock('./app-dom', () => ({ icon: () => new TestNode('svg'), request: mocks.request, isSnapshot: (value: unknown) => Boolean(value && typeof value === 'object' && 'conversations' in value), element: (tag: string, className?: string, text?: string) => new TestNode(tag, className, text), button: (text: string, action: () => void) => Object.assign(new TestNode('button', '', text), { onclick: action }) }))
let pending: Array<(value: ConnectionResult) => void>
function snapshot(): AppSnapshot { return { conversations: [], currentId: null, turns: [], activeTurnId: null, busy: false, status: '', settings: DEFAULT_SETTINGS, keyPresent: false, saved: true, version: 'fixture', permissions: { microphone: '', screen: '', input: '' } } }
const tick = async () => { await new Promise(resolve => setImmediate(resolve)) }
beforeEach(() => {
  vi.resetModules(); mocks.request.mockReset(); mocks.renderConnections.mockReset(); pending = []
  const nodes = new Map(['fields', 'categories', 'heading', 'feedback'].map(id => [id, new TestNode('div')]))
  const all = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(all)]
  const main = new TestNode('main')
  vi.stubGlobal('document', { getElementById: (id: string) => nodes.get(id) ?? [...nodes.values()].flatMap(all).find(node => node.id === id), querySelector: () => main, activeElement: null })
  vi.stubGlobal('HTMLInputElement', class {})
  vi.stubGlobal('window', { heynimboApp: { onSnapshot: (handler: typeof mocks.onSnapshot) => { mocks.onSnapshot = handler }, onNavigate: (handler: typeof mocks.onNavigate) => { mocks.onNavigate = handler } } })
  mocks.request.mockImplementation(async value => value.kind === 'snapshot' ? snapshot() : new Promise<ConnectionResult>(resolve => { pending.push(resolve) }))
})
afterEach(() => vi.unstubAllGlobals())
it('discards stale details responses and clears hints when leaving Connection, without adding them to app snapshots', async () => {
  await import('./settings'); await tick()
  mocks.onNavigate!({ category: 'Connection' })
  mocks.onNavigate!({ category: 'General' })
  mocks.onNavigate!({ category: 'Connection' })
  const renders = mocks.renderConnections.mock.calls.length
  pending[0]!({ ok: true, message: '', keyHints: { openai: { suffix: 'old1', savedAt: 1 } } }); await tick()
  expect(mocks.renderConnections).toHaveBeenCalledTimes(renders)
  pending[1]!({ ok: true, message: '', keyHints: { openai: { suffix: 'new2', savedAt: 2 } } }); await tick()
  expect(mocks.renderConnections.mock.calls.at(-1)?.[3]).toEqual({ openai: { suffix: 'new2', savedAt: 2 } })
  expect(JSON.stringify(mocks.renderConnections.mock.calls.at(-1)?.[1])).not.toMatch(/keyHints|new2/)
  mocks.onNavigate!({ category: 'General' }); mocks.onSnapshot!(snapshot())
  expect(pending).toHaveLength(2)
  mocks.onNavigate!({ category: 'Connection' })
  expect(mocks.renderConnections.mock.calls.at(-1)?.[3]).toEqual({})
  pending[2]!({ ok: true, message: '', keyHints: {} }); await tick()
})
it('retains open Manage disclosures, keyboard focus and scroll on a snapshot, but resets scroll on navigation', async () => {
  mocks.renderConnections.mockImplementation((fields: TestNode) => {
    const details = new TestNode('details'); details.id = 'manage-openai'
    const action = new TestNode('button'); action.id = 'replace-key-openai'; action.focus = vi.fn()
    details.append(action); fields.append(details)
  })
  await import('./settings'); await tick(); mocks.onNavigate!({ category: 'Connection' })
  const details = document.getElementById('manage-openai') as unknown as TestNode; details.open = true
  Object.defineProperty(document, 'activeElement', { value: details.children[0], configurable: true })
  document.querySelector('main')!.scrollTop = 200
  mocks.onSnapshot!(snapshot())
  const updated = document.getElementById('manage-openai') as unknown as TestNode
  expect(updated).not.toBe(details); expect(updated.open).toBe(true)
  expect(updated.children[0]!.focus).toHaveBeenCalledWith({ preventScroll: true })
  expect(document.querySelector('main')!.scrollTop).toBe(200)
  mocks.onNavigate!({ category: 'General' }); expect(document.querySelector('main')!.scrollTop).toBe(0)
  for (const resolve of pending) resolve({ ok: true, message: '', keyHints: {} }); await tick()
})
it('offers an explicit first-time microphone action, a denied-permission recovery, and no dead action for missing metadata', async () => {
  await import('./settings'); await tick(); mocks.onNavigate!({ category: 'Voice' })
  const state = snapshot(); state.permissions.microphone = 'not-determined'; mocks.onSnapshot!(state)
  const action = document.getElementById('microphone-permission') as unknown as TestNode & { onclick(): void; disabled?: boolean }
  expect(action.textContent).toBe('Allow microphone…')
  expect(mocks.request).not.toHaveBeenCalledWith({ kind: 'permission', permission: 'microphone' })
  action.onclick()
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'permission', permission: 'microphone' })
  for (const resolve of pending) resolve({ ok: true, message: '' }); await tick()
  state.permissions.microphone = 'denied'; mocks.onSnapshot!(state)
  expect(document.getElementById('microphone-permission')?.textContent).toBe('Open System Settings')
  state.permissions.microphone = 'unavailable'; mocks.onSnapshot!(state)
  expect((document.getElementById('microphone-permission') as unknown as { disabled: boolean }).disabled).toBe(true)
})
it('does not request key hints if an old Connection action finishes after navigation away', async () => {
  await import('./settings'); await tick()
  mocks.onNavigate!({ category: 'Connection' })
  const refresh = mocks.renderConnections.mock.calls.at(-1)?.[4] as () => void
  mocks.onNavigate!({ category: 'General' }); refresh()
  expect(pending).toHaveLength(1)
  pending[0]!({ ok: true, message: '', keyHints: {} }); await tick()
})
