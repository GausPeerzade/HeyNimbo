import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, HistoryTurn, SearchHit } from '../shared/app'
import { DEFAULT_SETTINGS } from '../main/settings'
import { ConversationController } from '../main/conversations'
import { HistoryRepository } from '../main/history'
import { TalkSession, type TalkDeps } from '../main/voice/talk'

class TestNode {
  children: TestNode[] = []
  parent: TestNode | undefined
  id = ''; className = ''; value = ''; hidden = false; dataset: Record<string, string> = {}
  scrollTop = 0; scrollHeight = 1000; clientHeight = 500; writes = 0
  private text = ''
  get textContent() { return this.text }
  set textContent(value: string) { this.text = value; this.writes++ }
  oninput?: () => void; onsubmit?: (event: { preventDefault(): void }) => void
  classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() }
  constructor(readonly tag: string) {}
  append(...nodes: TestNode[]) { for (const node of nodes) this.insertBefore(node, null) }
  insertBefore(node: TestNode, before: TestNode | null) { node.remove(); node.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node) }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  replaceChildren = vi.fn((...nodes: TestNode[]) => { for (const old of [...this.children]) old.remove(); this.append(...nodes) })
  setAttribute(name: string, value: string) { if (name === 'id') this.id = value }
  focus() {}; select() {}
  querySelectorAll(tag: string): TestNode[] { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]) }
}
const mocks = vi.hoisted(() => ({
  request: vi.fn(), element: undefined as unknown as (tag: string, className?: string, text?: string) => TestNode,
  snapshot: undefined as ((s: AppSnapshot) => void) | undefined, thumbnail: vi.fn(),
}))
vi.mock('./app-dom', () => ({
  request: mocks.request,
  element: (tag: string, className?: string, text?: string) => mocks.element(tag, className, text),
  button: (text: string) => mocks.element('button', '', text), icon: () => mocks.element('svg'),
  isSnapshot: (value: unknown) => Boolean(value && typeof value === 'object' && 'conversations' in value),
}))
vi.mock('./scene-thumbnail', () => ({ sceneThumbnail: mocks.thumbnail }))
const nodes = new Map<string, TestNode>()
let keydown: ((event: { key: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault(): void }) => void) | undefined
beforeEach(() => {
  vi.resetModules(); mocks.request.mockReset(); mocks.request.mockResolvedValue(undefined); mocks.thumbnail.mockReset(); nodes.clear()
  mocks.element = (tag, className = '', text = '') => { const node = new TestNode(tag); node.className = className; node.textContent = text; return node }
  for (const id of ['search', 'question', 'transcript', 'conversations', 'title', 'rename-form', 'rename', 'stop', 'send', 'feedback', 'saving', 'composer', 'new', 'new-top', 'toggle', 'settings']) { const node = new TestNode('div'); node.id = id; nodes.set(id, node) }
  nodes.get('rename-form')!.hidden = true
  vi.stubGlobal('document', { getElementById: (id: string) => nodes.get(id), activeElement: null, body: new TestNode('body'), set onkeydown(handler: typeof keydown) { keydown = handler } })
  vi.stubGlobal('window', { nimboApp: { onSnapshot: (handler: typeof mocks.snapshot) => { mocks.snapshot = handler }, onNavigate() {} } })
  vi.stubGlobal('requestAnimationFrame', (handler: () => void) => { handler(); return 0 })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function snapshot(turns: HistoryTurn[] = []): AppSnapshot {
  return { conversations: [{ id: 'c', title: 'Conversation', created: 1, updated: 1, pinned: false, archived: false, preview: '' }], currentId: 'c', turns, activeTurnId: turns.at(-1)?.id ?? null, busy: false, status: '', settings: DEFAULT_SETTINGS, keyPresent: true, saved: true, version: 'fixture', permissions: { microphone: '', screen: '', input: '' } }
}
function turn(id: string, answer: string): HistoryTurn { return { id, conversationId: 'c', created: 1, mode: 'text', question: `Question ${id}`, answer, state: 'complete', error: null, scene: { version: 1, beats: [] }, screenContextUsed: true } }
it('updates only the streaming turn in place without replacing old message nodes or their selected answer text', async () => {
  await import('./home')
  const old = turn('old', 'Saved answer'), current = turn('current', 'Partial')
  mocks.snapshot!(snapshot([old, current]))
  const transcript = nodes.get('transcript')!, oldNode = transcript.children[0]!, currentNode = transcript.children[1]!, oldAnswer = oldNode.children[2]!
  const writes = oldAnswer.writes
  transcript.replaceChildren.mockClear(); mocks.thumbnail.mockClear()
  mocks.snapshot!(snapshot([old, { ...current, answer: 'Partial answer continues' }]))
  expect(transcript.replaceChildren).not.toHaveBeenCalled()
  expect(transcript.children[0]).toBe(oldNode); expect(transcript.children[1]).toBe(currentNode)
  expect(oldNode.children[2]).toBe(oldAnswer); expect(oldAnswer.writes).toBe(writes)
  expect(currentNode.children[2]?.textContent).toBe('Partial answer continues')
  expect(mocks.thumbnail).not.toHaveBeenCalled()
})
it('Escape invalidates a pending search before its result can replace the restored recent list', async () => {
  vi.useFakeTimers()
  let resolve!: (hits: SearchHit[]) => void
  mocks.request.mockImplementation(async request => request.kind === 'search' ? new Promise<SearchHit[]>(done => { resolve = done }) : undefined)
  await import('./home'); mocks.snapshot!(snapshot())
  const search = nodes.get('search')!
  search.value = 'export'; search.oninput!(); await vi.advanceTimersByTimeAsync(120)
  search.value = 'export'; keydown!({ key: 'Escape', preventDefault() {} })
  expect(search.value).toBe('')
  resolve([{ conversationId: 'c', turnId: 't', title: 'Match', updated: 1, snippet: 'export match' }]); await vi.advanceTimersByTimeAsync(0)
  expect(nodes.get('conversations')!.children.some(node => node.textContent === 'Search results')).toBe(false)
})
it('keeps the draft when real TalkSession turn creation fails and an error snapshot arrives', async () => {
  const c = new ConversationController(new HistoryRepository(), () => DEFAULT_SETTINGS)
  const publish = () => mocks.snapshot!({ ...snapshot(), currentId: c.currentId, conversations: c.list(), turns: c.turns() })
  const talk = new TalkSession({ key: 'fixture', conversations: c, capture: () => new Promise(() => {}), ears: { cancel() {}, close() {} }, mouth: { cancel() {}, close() {} }, audio: { send() {} }, onStatus: publish, drawing: { draw() {}, answerDone() {} } } as unknown as TalkDeps)
  try {
    await import('./home'); publish()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(c.history, 'begin').mockImplementationOnce(() => { throw new Error('Disk full') })
    mocks.request.mockImplementation(async request => { if (request.kind === 'ask') { try { return talk.askText(request.question) } catch { return undefined } } })
    const question = nodes.get('question')!; question.value = 'Keep my unsent draft'; question.oninput!()
    nodes.get('composer')!.onsubmit!({ preventDefault() {} })
    await new Promise(resolve => setImmediate(resolve))
    expect(question.value).toBe('Keep my unsent draft')
    expect(c.currentId).toBeNull(); expect(c.list()).toEqual([])
  } finally { talk.close(); c.close() }
})
it('replaces the send action with Stop while a response is busy and restores it afterwards', async () => {
  await import('./home')
  mocks.snapshot!({ ...snapshot(), busy: true, status: 'Drawing an explanation…' })
  expect(nodes.get('send')!.hidden).toBe(true)
  expect(nodes.get('stop')!.hidden).toBe(false)
  mocks.snapshot!({ ...snapshot(), busy: false })
  expect(nodes.get('send')!.hidden).toBe(false)
  expect(nodes.get('stop')!.hidden).toBe(true)
})
