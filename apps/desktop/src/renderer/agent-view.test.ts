import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_BUDGET, parseAgentRequest, type AgentApi, type AgentEvent, type AgentPush, type AgentRequest, type RunSummary } from '../shared/agent-protocol'
import { AgentView } from './agent-view'
import { DEFAULT_SETTINGS } from '../main/settings'
import type { AppSnapshot } from '../shared/app'

class TestNode {
  children: TestNode[] = []; parent?: TestNode
  id = ''; className = ''; textContent = ''; value = ''; hidden = false; disabled = false
  scrollTop = 0; scrollHeight = 1000; clientHeight = 500
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}
  onclick?: () => void; oninput?: () => void; onsubmit?: (e: { preventDefault(): void }) => void
  onkeydown?: (e: { key: string; shiftKey?: boolean; isComposing?: boolean; preventDefault(): void }) => void
  classList = { add() {}, remove() {}, toggle() {} }
  constructor(readonly tag: string) {}
  append(...nodes: TestNode[]) { for (const node of nodes) this.insertBefore(node, null) }
  insertBefore(node: TestNode, before: TestNode | null) { node.remove(); node.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node) }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  replaceChildren(...nodes: TestNode[]) { for (const old of [...this.children]) old.remove(); this.append(...nodes) }
  setAttribute(key: string, value: string) { this.attributes[key] = value }
  focus() {}; select() {}
  querySelectorAll(tag: string): TestNode[] { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]) }
}
const cast = (node: TestNode) => node as unknown as HTMLElement
const tick = () => new Promise(resolve => setImmediate(resolve))
function run(id = 'run', updated = 100): RunSummary { return { id, goal: `Goal ${id}`, mode: 'web', mixed: false, status: 'running', persistence: 'retained', created: 1, updated, usage: { inputTokens: 0, outputTokens: 0 } } }
function event(seq: number, runId = 'run'): AgentEvent { return { id: `e${seq}`, seq, at: seq, runId, payload: { type: 'text', step: seq, text: `Text ${seq}` } } }
let panel: TestNode, folders: TestNode, stopAll: TestNode, frames: (() => void)[], requests: AgentRequest[], push: (value: AgentPush) => void
let respond: (value: AgentRequest) => Promise<unknown>
let unsubscribe = vi.fn<() => void>()
let api: AgentApi
function flush() { while (frames.length) frames.shift()!() }
async function settle() { await tick(); flush(); await tick(); flush() }
function button(text: string, inNode = panel) { return inNode.querySelectorAll('button').find(node => node.textContent === text)! }
function setup() { return new AgentView(api, { panel: cast(panel), folders: cast(folders), stopAll: stopAll as unknown as HTMLButtonElement }, { schedule: callback => { frames.push(callback) } }) }
beforeEach(() => {
  panel = new TestNode('div'); folders = new TestNode('div'); stopAll = new TestNode('button'); frames = []; requests = []; unsubscribe = vi.fn()
  respond = async value => value.kind === 'list' ? { runs: [] } : value.kind === 'events' ? { events: [] } : { ok: true }
  api = { request: async value => { parseAgentRequest(value); requests.push(value); return respond(value) }, onPush: listener => { push = listener; return unsubscribe } }
  vi.stubGlobal('document', { createElement: (tag: string) => new TestNode(tag) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('leaves the host untouched until Do opens then sorts typed task rows and pages with the original updated cursor', async () => {
  const first = Array.from({ length: 50 }, (_, i) => run(`r${i}`, 100 - i))
  respond = async value => value.kind === 'list' ? { runs: value.before === undefined ? first : [run('older', 1)] } : { events: [] }
  const view = setup(); expect(requests).toEqual([])
  view.setActive(true); await settle()
  const rows = () => panel.querySelectorAll('button').filter(node => node.dataset.runId)
  expect(rows().map(node => node.dataset.runId)).toEqual(first.map(item => item.id))
  expect(rows()[0]!.querySelectorAll('span').at(-1)?.textContent).toBe('Running')
  push({ kind: 'events', events: [], runs: [run('r49', 999)] }); flush()
  expect(rows()[0]?.dataset.runId).toBe('r49')
  button('Load older').onclick!(); await settle()
  expect(requests.filter(value => value.kind === 'list')).toEqual([{ kind: 'list', limit: 50 }, { kind: 'list', before: 51, limit: 50 }])
  expect(rows().at(-1)?.dataset.runId).toBe('older'); expect(button('Load older').hidden).toBe(true)
  view.dispose(); expect(unsubscribe).toHaveBeenCalledOnce()
})
it('fetches history in 200-event pages using the fetched cursor rather than a newer live push', async () => {
  let next!: (value: unknown) => void
  respond = async value => {
    if (value.kind === 'list') return { runs: [run()] }
    if (value.kind === 'events' && value.afterSeq === 0) return new Promise(resolve => { next = resolve })
    return { events: [event(201)] }
  }
  const view = setup(); view.setActive(true); await settle()
  push({ kind: 'events', runs: [run()], events: [event(203), event(202)] }); flush()
  next({ events: Array.from({ length: 200 }, (_, i) => event(i + 1)) }); await settle()
  expect(requests.filter(value => value.kind === 'events')).toEqual([{ kind: 'events', runId: 'run', afterSeq: 0, limit: 200 }, { kind: 'events', runId: 'run', afterSeq: 200, limit: 200 }])
  const nodes = panel.querySelectorAll('pre').filter(node => node.dataset.seq)
  expect(nodes).toHaveLength(203); expect(nodes.map(node => Number(node.dataset.seq))).toEqual(Array.from({ length: 203 }, (_, i) => i + 1))
})
it('ignores other-run partials and stale history responses after task selection changes', async () => {
  let old!: (value: unknown) => void
  respond = async value => value.kind === 'list' ? { runs: [run(), run('other', 99)] } : value.kind === 'events' && value.runId === 'run' ? new Promise(resolve => { old = resolve }) : { events: [event(1, 'other')] }
  const view = setup(); view.setActive(true); await settle()
  panel.querySelectorAll('button').find(node => node.dataset.runId === 'other')!.onclick!(); await settle()
  old({ events: [event(1)] }); push({ kind: 'partial', runId: 'run', step: 2, text: 'Wrong run' }); await settle()
  expect(panel.querySelectorAll('pre').map(node => node.textContent)).toEqual(['Text 1'])
  push({ kind: 'partial', runId: 'other', step: 2, text: 'Current partial' }); flush()
  expect(panel.querySelectorAll('pre').at(-1)?.textContent).toBe('Current partial')
  expect(panel.querySelectorAll('p').filter(node => node.attributes['aria-live'] === 'polite').map(node => node.textContent).join('')).not.toContain('Current partial')
})
it('starts a validator-approved local task with opaque folder IDs and never sends grants in web mode', async () => {
  respond = async value => value.kind === 'pickFolder' ? { grant: { id: 'grant', label: '<img src=x onerror=alert(1)>' } } : value.kind === 'start' ? { runId: 'new_run' } : value.kind === 'list' ? { runs: [] } : { events: [] }
  const view = setup(); view.setActive(true); await settle()
  expect(button('Add folder', folders).disabled).toBe(true)
  button('Local files', folders).onclick!(); button('Add folder', folders).onclick!(); await settle()
  expect(folders.querySelectorAll('span').some(node => node.textContent === '<img src=x onerror=alert(1)>')).toBe(true)
  expect(folders.querySelectorAll('img')).toHaveLength(0)
  expect(await view.submit('Read the files')).toBe(true)
  const local = requests.find(value => value.kind === 'start')!
  expect(parseAgentRequest(local)).toMatchObject({ kind: 'start', goal: 'Read the files', mode: 'local', grantIds: ['grant'] })
  expect(local.kind === 'start' && /^[A-Za-z0-9_-]+$/.test(local.requestId)).toBe(true)
  button('Web research', folders).onclick!()
  expect(button('Add folder', folders).disabled).toBe(true)
  expect(folders.querySelectorAll('button').find(node => node.attributes['aria-label']?.startsWith('Remove folder'))?.disabled).toBe(true)
  expect(await view.submit('Find public sources')).toBe(true)
  const web = requests.filter(value => value.kind === 'start').at(-1)!
  expect(parseAgentRequest(web)).toMatchObject({ kind: 'start', mode: 'web' }); expect(web).not.toHaveProperty('grantIds')
  button('Local files', folders).onclick!()
  folders.querySelectorAll('button').find(node => node.attributes['aria-label']?.startsWith('Remove folder'))!.onclick!()
  expect(folders.querySelectorAll('span')).toHaveLength(0)
})
it('stops only the selected active task, continues interrupted tasks, confirms deletion and keeps Stop all available', async () => {
  respond = async value => value.kind === 'list' ? { runs: [run()] } : value.kind === 'events' ? { events: [] } : { ok: true }
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(false))
  const view = setup(); view.setActive(true); await settle()
  expect(stopAll.hidden).toBe(false); button('Stop task').onclick!(); await settle()
  expect(requests).toContainEqual({ kind: 'cancel', runId: 'run' })
  push({ kind: 'events', events: [], runs: [{ ...run('run', 101), status: 'interrupted' }] }); flush()
  expect(button('Stop task').hidden).toBe(true); expect(button('Continue').hidden).toBe(false)
  button('Continue').onclick!(); await settle(); expect(requests).toContainEqual({ kind: 'continue', runId: 'run' })
  button('Delete task').onclick!(); await settle(); expect(requests.some(value => value.kind === 'delete')).toBe(false)
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true)); button('Delete task').onclick!(); await settle()
  expect(requests).toContainEqual({ kind: 'delete', runId: 'run' })
  expect(panel.querySelectorAll('button').some(node => node.dataset.runId === 'run')).toBe(false)
  stopAll.onclick!(); await settle(); expect(requests).toContainEqual({ kind: 'stopAll' }); expect(stopAll.hidden).toBe(false)
  view.setActive(false); expect(stopAll.hidden).toBe(true)
})
it('shows fixed starting and crash banners without exposing host error details', async () => {
  const view = setup(); view.setActive(true); await settle()
  push({ kind: 'host', state: 'starting' }); flush()
  expect(panel.querySelectorAll('p').some(node => node.textContent === 'Starting the agent…')).toBe(true)
  push({ kind: 'host', state: 'crashed', message: 'secret provider diagnostic' }); flush()
  expect(panel.querySelectorAll('p').some(node => node.textContent === 'The agent stopped unexpectedly. Your tasks were saved; start or continue a task to restart it.')).toBe(true)
  expect(panel.querySelectorAll('p').some(node => node.textContent.includes('secret'))).toBe(false)
  push({ kind: 'host', state: 'ready' }); flush()
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-host')?.hidden).toBe(true)
})
async function home(agent: AgentApi | undefined) {
  vi.resetModules()
  const nodes = new Map<string, TestNode>()
  for (const id of ['search', 'question', 'transcript', 'conversations', 'title', 'rename-form', 'rename', 'stop', 'send', 'feedback', 'screen-context', 'agent-context', 'saving', 'composer', 'new', 'new-top', 'toggle', 'settings', 'mode-switch', 'explain-mode', 'do-mode', 'agent-panel', 'agent-folders', 'stop-all', 'composer-note']) { const node = new TestNode('div'); node.id = id; nodes.set(id, node) }
  nodes.get('rename-form')!.hidden = true
  const explainRequests: unknown[] = []
  let publish!: (snapshot: AppSnapshot) => void
  vi.stubGlobal('document', { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new TestNode(tag), createElementNS: (_ns: string, tag: string) => new TestNode(tag), body: new TestNode('body'), activeElement: null })
  vi.stubGlobal('window', { heynimboApp: { agent, request: async (value: { kind: string }) => { explainRequests.push(value); return value.kind === 'ask' ? { accepted: true } : undefined }, onSnapshot(callback: typeof publish) { publish = callback }, onNavigate() {} } })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return 1 })
  await import('./home')
  return { nodes, explainRequests, publish: (value: AppSnapshot) => publish(value) }
}
it('keeps Explain submit as ask and switches the actual composer to a validator-approved web start without screen capture', async () => {
  respond = async value => value.kind === 'start' ? { runId: 'new_run' } : { runs: [] }
  const { nodes, explainRequests } = await home(api)
  nodes.get('question')!.value = 'Explain this'; nodes.get('composer')!.onsubmit!({ preventDefault() {} }); await settle()
  expect(explainRequests).toContainEqual({ kind: 'ask', question: 'Explain this' }); expect(requests).toEqual([])
  nodes.get('do-mode')!.onclick!(); await settle()
  nodes.get('question')!.value = 'Research it'; nodes.get('composer')!.onsubmit!({ preventDefault() {} }); await settle()
  const start = requests.find(value => value.kind === 'start')!
  expect(parseAgentRequest(start)).toMatchObject({ kind: 'start', goal: 'Research it', mode: 'web' }); expect(start).not.toHaveProperty('grantIds')
  expect(nodes.get('question')!.value).toBe(''); expect(nodes.get('transcript')!.hidden).toBe(true)
  expect(nodes.get('stop-all')!.hidden).toBe(false)
  expect(nodes.get('question')!.attributes['aria-describedby']).toBe('agent-context')
  expect(nodes.get('agent-context')!.hidden).toBe(false)
  nodes.get('explain-mode')!.onclick!(); expect(nodes.get('transcript')!.hidden).toBe(false)
  expect(nodes.get('question')!.attributes['aria-describedby']).toBe('screen-context')
})
it('hides the Do switch when the agent preload is absent', async () => {
  const { nodes } = await home(undefined)
  expect(nodes.get('mode-switch')!.hidden).toBe(true)
})
it('pages Show earlier from the oldest retained sequence without keeping more than 2000 events', async () => {
  respond = async value => {
    if (value.kind === 'list') return { runs: [run()] }
    if (value.kind === 'events') return { events: Array.from({ length: Math.min(200, 2400 - value.afterSeq) }, (_, i) => event(value.afterSeq + i + 1)) }
    return { ok: true }
  }
  const view = setup(); view.setActive(true); await settle()
  expect(panel.querySelectorAll('pre')).toHaveLength(2000)
  expect(panel.querySelectorAll('pre')[0]?.dataset.seq).toBe('401')
  button('Show earlier').onclick!(); button('Show earlier').onclick!(); await settle()
  expect(requests.filter(value => value.kind === 'events').at(-1)).toEqual({ kind: 'events', runId: 'run', afterSeq: 200, limit: 200 })
  expect(panel.querySelectorAll('pre')[0]?.dataset.seq).toBe('201'); expect(panel.querySelectorAll('pre')).toHaveLength(2000)
})
it('retains the request ID across an uncertain start retry and blocks duplicate submissions while it is in flight', async () => {
  let finish!: (value: unknown) => void
  respond = async value => value.kind === 'start' ? new Promise(resolve => { finish = resolve }) : { runs: [] }
  const view = setup(); expect(await view.submit('Hidden mode')).toBe(false)
  view.setActive(true); await settle()
  expect(await view.submit(' ')).toBe(false); expect(await view.submit('x'.repeat(16001))).toBe(false)
  const pending = view.submit('A task'); expect(await view.submit('A task')).toBe(false)
  finish({ runId: 'bad.id' }); expect(await pending).toBe(false)
  const retry = view.submit('A task'); finish({ runId: 'run' }); expect(await retry).toBe(true)
  const starts = requests.filter(value => value.kind === 'start')
  expect(starts).toHaveLength(2); expect(starts[0]).toEqual(starts[1])
  push({ kind: 'events', events: [], runs: [run()] }); await settle()
  expect(button('Stop task').hidden).toBe(false)
})
it('preserves actionable error feedback after a rejected control instead of replacing it with Running', async () => {
  respond = async value => {
    if (value.kind === 'list') return { runs: [run()] }
    if (value.kind === 'events') return { events: [] }
    throw new Error('private transport error')
  }
  const view = setup(); view.setActive(true); await settle()
  button('Stop task').onclick!(); await settle()
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('This action failed. Try again.')
  expect(button('Stop task').disabled).toBe(false)
  stopAll.onclick!(); await settle()
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('Could not stop all tasks. Try again.')
})
it('does not resurrect a deleted task from a late push that was queued before deletion', async () => {
  respond = async value => value.kind === 'list' ? { runs: [run()] } : value.kind === 'events' ? { events: [] } : { ok: true }
  vi.stubGlobal('confirm', () => true)
  const view = setup(); view.setActive(true); await settle(); button('Delete task').onclick!(); await settle()
  push({ kind: 'events', events: [event(1)], runs: [run('run', 101)] }); flush()
  expect(panel.querySelectorAll('button').filter(node => node.dataset.runId)).toHaveLength(0)
})
it('keeps Do drafts out of Explain conversations while busy Explain snapshots arrive', async () => {
  const { nodes, publish } = await home(api)
  const snapshot = (id: string): AppSnapshot => ({ currentId: id, conversations: [{ id, title: id, created: 1, updated: 1, pinned: false, archived: false, preview: '' }], turns: [], activeTurnId: null, busy: false, status: '', settings: DEFAULT_SETTINGS, saved: true, keyPresent: true, version: 'fixture', permissions: { microphone: '', screen: '', input: '' } })
  publish(snapshot('c')); nodes.get('question')!.value = 'Explain draft'; nodes.get('question')!.oninput!()
  nodes.get('do-mode')!.onclick!(); await settle(); nodes.get('question')!.value = 'Do draft'
  publish({ ...snapshot('other'), busy: true })
  nodes.get('question')!.oninput!()
  expect(nodes.get('question')!.value).toBe('Do draft'); expect(nodes.get('send')!.hidden).toBe(false); expect(nodes.get('stop')!.hidden).toBe(true)
  nodes.get('explain-mode')!.onclick!(); expect(nodes.get('question')!.value).toBe('')
  publish(snapshot('c')); expect(nodes.get('question')!.value).toBe('Explain draft')
  nodes.get('do-mode')!.onclick!(); expect(nodes.get('question')!.value).toBe('Do draft')
})
it.each([undefined, { runs: [null] }, { runs: [{ ...run(), id: '../path' }] }, { runs: [{ ...run(), status: 'Finished nicely' }] }])('rejects malformed task lists and leaves a retry action rather than rendering unsafe rows', async result => {
  respond = async () => result
  const view = setup(); view.setActive(true); await settle()
  expect(panel.querySelectorAll('button').filter(node => node.dataset.runId)).toHaveLength(0)
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('Could not load tasks. Try again.')
  expect(button('Load older').disabled).toBe(false)
})
it.each([undefined, { events: [event(1, 'foreign')] }, { events: [{ ...event(1), seq: 0 }] }])('rejects invalid history pages without creating cross-task or malformed event nodes', async result => {
  respond = async value => value.kind === 'list' ? { runs: [run()] } : result
  const view = setup(); view.setActive(true); await settle()
  expect(panel.querySelectorAll('pre')).toHaveLength(0)
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('Could not load this task. Select it to retry.')
})
it('offers retry after earlier-event failure and refuses a non-advancing history cursor', async () => {
  let earlier = false
  respond = async value => {
    if (value.kind === 'list') return { runs: [run()] }
    if (value.kind === 'events') {
      if (earlier) throw new Error('secret')
      if (value.afterSeq >= 2200) return { events: [event(value.afterSeq)] }
      return { events: Array.from({ length: 200 }, (_, i) => event(value.afterSeq + i + 1)) }
    }
  }
  const view = setup(); view.setActive(true); await settle()
  expect(requests.filter(value => value.kind === 'events')).toHaveLength(12)
  earlier = true; button('Show earlier').onclick!(); await settle()
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('Could not load earlier events. Try again.')
  expect(button('Show earlier').disabled).toBe(false)
})
it('caps picked grants at eight and treats cancelled or malformed picker results as no authority', async () => {
  const view = setup(); view.setActive(true); await settle(); button('Local files', folders).onclick!()
  respond = async () => ({ cancelled: true }); button('Add folder', folders).onclick!(); await settle()
  expect(folders.querySelectorAll('span')).toHaveLength(0)
  respond = async () => ({ grant: { id: '../root', label: 'Bad' } }); button('Add folder', folders).onclick!(); await settle()
  expect(folders.querySelectorAll('span')).toHaveLength(0)
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('Could not add the folder. Try again.')
  for (let i = 0; i < 8; i++) { respond = async () => ({ grant: { id: `g${i}`, label: `Folder ${i}` } }); button('Add folder', folders).onclick!(); await settle() }
  expect(folders.querySelectorAll('span')).toHaveLength(8); expect(button('Add folder', folders).disabled).toBe(true)
  const before = requests.length; button('Add folder', folders).onclick!(); expect(requests).toHaveLength(before)
})
it('does not let malformed pushes corrupt the task list and ignores all pushes after disposal', async () => {
  respond = async value => value.kind === 'list' ? { runs: [run()] } : { events: [] }
  const view = setup(); view.setActive(true); await settle()
  push({ kind: 'events', runs: [], events: [{ ...event(1), id: '../bad' }] }); flush()
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('Could not update tasks. Try again.')
  const before = panel.querySelectorAll('pre').length; view.dispose()
  push({ kind: 'events', runs: [run('new')], events: [event(1)] }); flush()
  expect(panel.querySelectorAll('pre')).toHaveLength(before)
})
it('keeps a bounded 1000-task paging window while older pages remain reachable and selected controls keep their target', async () => {
  respond = async value => value.kind === 'list' ? { runs: Array.from({ length: 50 }, (_, i) => run(`r${(value.before ?? 2000) - i - 1}`, (value.before ?? 2000) - i - 1)) } : value.kind === 'events' ? { events: [] } : { ok: true }
  const view = setup(); view.setActive(true); await settle()
  for (let page = 0; page < 21; page++) { button('Load older').onclick!(); await settle() }
  const rows = () => panel.querySelectorAll('button').filter(node => node.dataset.runId)
  expect(rows()).toHaveLength(1000); expect(rows().at(-1)?.dataset.runId).toBe('r900')
  button('Stop task').onclick!(); await settle(); expect(requests).toContainEqual({ kind: 'cancel', runId: 'r1999' })
  button('Load newest').onclick!(); await settle()
  expect(rows()[0]?.dataset.runId).toBe('r1999'); expect(rows()).toHaveLength(50)
})
