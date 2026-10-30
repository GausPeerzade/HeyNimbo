import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
let panel: TestNode, stopAll: TestNode, frames: (() => void)[], requests: AgentRequest[], push: (value: AgentPush) => void
let respond: (value: AgentRequest) => Promise<unknown>
let unsubscribe = vi.fn<() => void>()
let api: AgentApi
function flush() { while (frames.length) frames.shift()!() }
async function settle() { await tick(); flush(); await tick(); flush() }
function button(text: string, inNode = panel) { return inNode.querySelectorAll('button').find(node => node.textContent === text)! }
function setup() { return new AgentView(api, { panel: cast(panel), stopAll: stopAll as unknown as HTMLButtonElement }, { schedule: callback => { frames.push(callback) } }) }
beforeEach(() => {
  panel = new TestNode('div'); stopAll = new TestNode('button'); frames = []; requests = []; unsubscribe = vi.fn()
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
it('keeps paging byte-bounded history pages that are shorter than the limit while the host reports more', async () => {
  respond = async value => {
    if (value.kind === 'list') return { runs: [run()] }
    if (value.kind === 'events') return value.afterSeq === 0 ? { events: [event(1), event(2)], more: true } : value.afterSeq === 2 ? { events: [event(3)], more: false } : { events: [] }
    return { ok: true }
  }
  const view = setup(); view.setActive(true); await settle(); await settle()
  expect(requests.filter(value => value.kind === 'events').map(value => value.kind === 'events' && value.afterSeq)).toEqual([0, 2])
  expect(panel.querySelectorAll('pre').filter(node => node.dataset.seq).map(node => Number(node.dataset.seq))).toEqual([1, 2, 3])
  view.dispose()
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
it('offers Continue only for interrupted or provider-failed runs and dispatches provider recovery', async () => {
  respond = async value => value.kind === 'list' ? { runs: [{ ...run(), status: 'failed', error: { code: 'provider', message: 'Continue to retry.' } }] } : value.kind === 'events' ? { events: [] } : { ok: true }
  const view = setup(); view.setActive(true); await settle()
  expect(button('Continue').hidden).toBe(false)
  button('Continue').onclick!(); await settle()
  expect(requests).toContainEqual({ kind: 'continue', runId: 'run' })
  for (const code of ['policy', 'budget', 'tool'] as const) {
    push({ kind: 'events', events: [], runs: [{ ...run('run', 101), status: 'failed', error: { code, message: 'Not resumable.' } }] }); flush()
    expect(button('Continue').hidden).toBe(true)
  }
})
it('renders selected-run partials from a combined events push without a second Home message', async () => {
  respond = async value => value.kind === 'list' ? { runs: [run()] } : { events: [] }
  const view = setup(); view.setActive(true); await settle()
  push({ kind: 'events', runs: [], events: [event(1)], partials: [{ runId: 'foreign', step: 2, text: 'Wrong' }, { runId: 'run', step: 2, text: 'Combined live text' }] }); flush()
  expect(panel.querySelectorAll('pre').map(node => node.textContent)).toEqual(['Text 1', 'Combined live text'])
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
  for (const id of ['search', 'question', 'transcript', 'conversations', 'title', 'rename-form', 'rename', 'stop', 'send', 'feedback', 'screen-context', 'saving', 'composer', 'new', 'new-top', 'toggle', 'settings', 'tasks', 'agent-panel', 'stop-all', 'composer-note']) { const node = new TestNode('div'); node.id = id; nodes.set(id, node) }
  nodes.get('rename-form')!.hidden = true
  const explainRequests: unknown[] = []
  let publish!: (snapshot: AppSnapshot) => void
  let navigate!: (navigation: { runId?: string; turnId?: string }) => void
  vi.stubGlobal('document', { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new TestNode(tag), createElementNS: (_ns: string, tag: string) => new TestNode(tag), body: new TestNode('body'), activeElement: null })
  vi.stubGlobal('window', { heynimboApp: { agent, request: async (value: { kind: string }) => { explainRequests.push(value); return value.kind === 'ask' ? { accepted: true } : undefined }, onSnapshot(callback: typeof publish) { publish = callback }, onNavigate(callback: typeof navigate) { navigate = callback } } })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return 1 })
  await import('./home')
  return { nodes, explainRequests, publish: (value: AppSnapshot) => publish(value), navigate: (value: Parameters<typeof navigate>[0]) => navigate(value) }
}
const fixtureSnapshot = (turns: AppSnapshot['turns'] = [], busy = false): AppSnapshot => ({ currentId: 'c', conversations: [{ id: 'c', title: 'c', created: 1, updated: 1, pinned: false, archived: false, preview: '' }], turns, activeTurnId: null, busy, status: '', settings: DEFAULT_SETTINGS, saved: true, keyPresent: true, version: 'fixture', permissions: { microphone: '', screen: '', input: '' } })
it('has one composer: every submission is an ask, even from the Tasks view, and the agent host is never asked to start work', async () => {
  const { nodes, explainRequests, publish } = await home(api)
  publish(fixtureSnapshot())
  const page = readFileSync(join(__dirname, 'home.html'), 'utf8')
  for (const id of ['mode-switch', 'explain-mode', 'do-mode', 'agent-folders', 'agent-context']) expect(page).not.toContain(`id="${id}"`)
  expect(page).toContain('id="tasks"')
  nodes.get('question')!.value = 'Research M5 laptop prices'; nodes.get('composer')!.onsubmit!({ preventDefault() {} }); await settle()
  nodes.get('tasks')!.onclick!(); await settle()
  expect(nodes.get('transcript')!.hidden).toBe(true); expect(nodes.get('agent-panel')!.hidden).toBe(false); expect(nodes.get('stop-all')!.hidden).toBe(false)
  nodes.get('question')!.value = 'Explain this chart'; nodes.get('composer')!.onsubmit!({ preventDefault() {} }); await settle()
  expect(explainRequests.filter(value => (value as { kind: string }).kind === 'ask')).toEqual([{ kind: 'ask', question: 'Research M5 laptop prices' }, { kind: 'ask', question: 'Explain this chart' }])
  // Asking from Tasks returns to the conversation where the answer appears.
  expect(nodes.get('transcript')!.hidden).toBe(false); expect(nodes.get('agent-panel')!.hidden).toBe(true)
  expect(requests.some(value => value.kind === 'start' || value.kind === 'pickFolder')).toBe(false)
})
it('keeps each conversation draft with its conversation while Tasks is open and sends exactly the visible question', async () => {
  const { nodes, explainRequests, publish } = await home(api)
  const q = nodes.get('question')!, other = (id: string) => ({ ...fixtureSnapshot(), currentId: id })
  publish(other('a')); q.value = 'A draft'; q.oninput!()
  nodes.get('tasks')!.onclick!(); await settle()
  publish(other('b')); expect(q.value).toBe('')
  q.value = 'B draft'; q.oninput!()
  nodes.get('tasks')!.onclick!(); await settle()
  expect(q.value).toBe('B draft')
  publish(other('a')); expect(q.value).toBe('A draft')
  publish(other('b')); expect(q.value).toBe('B draft')
  nodes.get('tasks')!.onclick!(); await settle()
  q.value = 'Visible question'; q.oninput!(); nodes.get('composer')!.onsubmit!({ preventDefault() {} }); await settle()
  expect(explainRequests.filter(value => (value as { kind: string }).kind === 'ask')).toEqual([{ kind: 'ask', question: 'Visible question' }])
})
it('clears only the sent question when the conversation changes before its ask is accepted', async () => {
  const { nodes, publish } = await home(api)
  const q = nodes.get('question')!, other = (id: string) => ({ ...fixtureSnapshot(), currentId: id })
  let accept!: (value: unknown) => void
  ;(window as unknown as { heynimboApp: { request: (value: unknown) => Promise<unknown> } }).heynimboApp.request = async () => new Promise(resolve => { accept = resolve })
  publish(other('b')); q.value = 'B draft'; q.oninput!()
  publish(other('a')); q.value = 'Sent from A'; q.oninput!()
  nodes.get('composer')!.onsubmit!({ preventDefault() {} }); await settle()
  publish(other('b')); expect(q.value).toBe('B draft')
  accept({ accepted: true }); await settle()
  expect(q.value).toBe('B draft')
  publish(other('a')); expect(q.value).toBe('')
})
it('opens a retained task outside the loaded page by ID and never answers the link with an unrelated task', async () => {
  const newest = Array.from({ length: 50 }, (_, i) => ({ ...run(`new_${i}`, 100 - i), status: 'succeeded' as const }))
  const target = { ...run('older_target', 1), status: 'succeeded' as const }
  respond = async value => value.kind === 'list' ? { runs: newest, more: true } : value.kind === 'run' ? (value.runId === target.id ? { run: target } : Promise.reject(new Error('Run not found.'))) : { events: [] }
  const view = setup(); view.open(target.id); await settle(); await settle()
  const current = () => panel.querySelectorAll('button').filter(node => node.attributes['aria-current'] === 'true').map(node => node.dataset.runId)
  expect(current()).toEqual(['older_target'])
  expect(requests).toContainEqual({ kind: 'run', runId: 'older_target' })
  expect(requests).toContainEqual({ kind: 'events', runId: 'older_target', afterSeq: 0, limit: 200 })
  expect(requests.some(value => value.kind === 'events' && value.runId !== 'older_target')).toBe(false)
  view.open('deleted_run'); await settle(); await settle()
  expect(panel.querySelectorAll('p').find(node => node.className === 'agent-status')?.textContent).toBe('This task is no longer available.')
  expect(current()).toEqual(['older_target'])
  view.dispose()
})
it('opens the exact task from a turn card and from a main navigation, and hides Tasks when the agent preload is absent', async () => {
  const runs = [run('first', 200), run('run_7', 100)]
  respond = async value => value.kind === 'list' ? { runs } : value.kind === 'run' ? { run: runs.find(item => item.id === value.runId) } : value.kind === 'events' ? { events: [] } : { ok: true }
  const { nodes, publish, navigate } = await home(api)
  const turn = { id: 't', conversationId: 'c', created: 1, mode: 'text' as const, question: 'Research', answer: 'Started.', state: 'complete' as const, error: null, screenContextUsed: false, scene: { version: 1 as const, beats: [], tasks: [{ goal: 'Find prices', mode: 'web' as const, state: 'started' as const, runId: 'run_7' }] } }
  publish(fixtureSnapshot([turn])); await settle()
  const card = nodes.get('transcript')!.querySelectorAll('aside')[0]!
  // The card records the handoff; live status belongs to the task list, so it never claims the task is still running.
  expect(card.querySelectorAll('p').map(node => node.textContent)).toEqual(['Web task · started', 'Find prices'])
  card.querySelectorAll('button').find(node => node.textContent === 'View task')!.onclick!(); await settle()
  expect(nodes.get('transcript')!.hidden).toBe(true)
  expect(nodes.get('agent-panel')!.querySelectorAll('button').find(node => node.dataset.runId === 'run_7')!.attributes['aria-current']).toBe('true')
  navigate({ turnId: 't' }); expect(nodes.get('transcript')!.hidden).toBe(false)
  navigate({ runId: 'first' }); await settle()
  expect(nodes.get('agent-panel')!.querySelectorAll('button').find(node => node.dataset.runId === 'first')!.attributes['aria-current']).toBe('true')
  const bare = await home(undefined)
  expect(bare.nodes.get('tasks')!.hidden).toBe(true)
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
it('fills the whole Show earlier window across byte-limited pages instead of skipping its tail', async () => {
  // The host returns at most 50 events per reply and says when more remain.
  respond = async value => {
    if (value.kind === 'list') return { runs: [run()] }
    if (value.kind === 'events') {
      const end = Math.min(2400, value.afterSeq + Math.min(value.limit, 50))
      return { events: Array.from({ length: end - value.afterSeq }, (_, i) => event(value.afterSeq + i + 1)), more: end < 2400 }
    }
    return { ok: true }
  }
  const view = setup(); view.setActive(true)
  for (let i = 0; i < 60; i++) await settle()
  const seqs = () => panel.querySelectorAll('pre').map(node => Number(node.dataset.seq))
  expect(seqs()[0]).toBe(401)
  button('Show earlier').onclick!()
  for (let i = 0; i < 10; i++) await settle()
  const shown = seqs()
  expect(shown[0]).toBe(201)
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, i) => 201 + i))
  expect(shown.length).toBeLessThanOrEqual(2000)
  view.dispose()
})
it('keeps Load older available when a byte-limited task page is short but the host reports more', async () => {
  respond = async value => value.kind === 'list' ? (value.before === undefined ? { runs: [run('a', 10), run('b', 9)], more: true } : { runs: [run('c', 8)], more: false }) : { events: [] }
  const view = setup(); view.setActive(true); await settle()
  expect(button('Load older').hidden).toBe(false)
  button('Load older').onclick!(); await settle()
  expect(requests.filter(value => value.kind === 'list')).toEqual([{ kind: 'list', limit: 50 }, { kind: 'list', before: 9, limit: 50 }])
  expect(button('Load older').hidden).toBe(true)
  view.dispose()
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
