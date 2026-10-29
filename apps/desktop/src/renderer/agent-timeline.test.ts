import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentEventPayload, AgentRequest } from '../shared/agent-protocol'
import { AgentTimeline } from './agent-timeline'

class TestNode {
  children: TestNode[] = []
  parent?: TestNode
  className = ''; textContent = ''; value = ''; hidden = false; disabled = false
  dataset: Record<string, string> = {}; attributes: Record<string, string> = {}
  onclick?: () => void
  constructor(readonly tag: string) {}
  append(...nodes: TestNode[]) { for (const node of nodes) this.insertBefore(node, null) }
  insertBefore(node: TestNode, before: TestNode | null) { node.remove(); node.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node) }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  replaceChildren(...nodes: TestNode[]) { for (const node of [...this.children]) node.remove(); this.append(...nodes) }
  setAttribute(key: string, value: string) { this.attributes[key] = value }
  all(tag: string): TestNode[] { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.all(tag)]) }
}
const event = (seq: number, payload: AgentEventPayload = { type: 'text', step: seq, text: `Text ${seq}` }): AgentEvent => ({ runId: 'run', seq, id: `e${seq}`, at: seq, payload })
const cast = (node: TestNode) => node as unknown as HTMLElement
let root: TestNode, frames: (() => void)[], created: number, requests: AgentRequest[]
let request: (value: AgentRequest) => Promise<unknown>
function flush() { while (frames.length) frames.shift()!() }
function setup(announce?: (text: string) => void) { return new AgentTimeline(cast(root), { request: value => request(value), schedule: callback => { frames.push(callback) }, announce }) }
beforeEach(() => {
  root = new TestNode('div'); frames = []; created = 0; requests = []
  request = async value => { requests.push(value); return { ok: true } }
  vi.stubGlobal('document', { createElement: (tag: string) => { created++; return new TestNode(tag) } })
})
afterEach(() => vi.unstubAllGlobals())
it('appends one event to 500 with exactly one new node and preserves existing text selection nodes', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append(Array.from({ length: 500 }, (_, index) => event(index + 1))); flush()
  const nodes = [...root.children], before = created
  timeline.append([event(501)]); expect(root.children).toHaveLength(500); flush()
  expect(created - before).toBe(1)
  expect(root.children.slice(0, 500)).toEqual(nodes)
  expect(root.children[500]?.textContent).toBe('Text 501')
})
it('orders out-of-order pushes by sequence and ignores duplicate or foreign events', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(1), event(3)]); flush()
  const first = root.children[0]
  timeline.append([event(2), event(3), { ...event(4), runId: 'other' }]); flush()
  expect(root.children.map(node => node.dataset.seq)).toEqual(['1', '2', '3'])
  expect(root.children[0]).toBe(first)
})
it('coalesces partial tokens into one non-live node and replaces it with final text', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.partial(0, 'a'); timeline.partial(0, 'ab'); expect(frames).toHaveLength(1); flush()
  const stream = root.children[0]!, before = created
  timeline.partial(0, 'abc'); flush()
  expect(root.children[0]).toBe(stream); expect(created).toBe(before)
  expect(stream.textContent).toBe('abc'); expect(stream.attributes['aria-live']).toBeUndefined()
  timeline.append([event(1, { type: 'text', step: 0, text: 'Final' })]); flush()
  expect(root.children).toHaveLength(1); expect(root.children[0]).not.toBe(stream)
  timeline.partial(0, 'late'); flush(); expect(root.children[0]?.textContent).toBe('Final')
})
it('caps the retained window at 2000 and can prepend earlier pages without keeping all history', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append(Array.from({ length: 2100 }, (_, i) => event(i + 1))); flush()
  expect(root.children).toHaveLength(2000); expect(timeline.firstSeq).toBe(101)
  timeline.append([event(1), event(2)], 'earlier'); flush()
  expect(root.children).toHaveLength(2000); expect(timeline.firstSeq).toBe(1)
  timeline.reset('other', false); timeline.append([event(1)]); flush(); expect(root.children).toHaveLength(0)
  timeline.partial(0, 'pending'); timeline.dispose(); flush(); expect(root.children).toHaveLength(0)
})
const hostile = '<img src=x onerror=alert(1)>'
const approval = (approvalId = 'approval'): AgentEventPayload => ({ type: 'approval.requested', approvalId, callId: 'call', tool: 'save_artifact', preview: hostile, digest: 'trusted_digest' })
const tick = () => new Promise(resolve => setImmediate(resolve))
it('renders host approval preview literally and locks both decisions until the persisted decision arrives', async () => {
  const timeline = setup(); timeline.reset('run', false); timeline.append([event(1, approval())]); flush()
  const card = root.children[0]!, buttons = card.all('button')
  expect(card.all('pre')[0]?.textContent).toBe(hostile); expect(root.all('img')).toEqual([])
  expect(buttons.map(node => node.textContent)).toEqual(['Approve', 'Deny'])
  buttons[0]!.onclick!(); expect(buttons.every(node => node.disabled)).toBe(true); await tick()
  expect(requests).toEqual([{ kind: 'approve', runId: 'run', approvalId: 'approval', decision: 'approved' }])
  timeline.append([event(2, { type: 'approval.decided', approvalId: 'approval', decision: 'approved' })]); flush()
  expect(root.children[0]).toBe(card); expect(card.all('button')).toHaveLength(0)
  expect(card.all('p')[0]?.textContent).toBe('Approved')
})
it('never offers buttons for stale approval replayed alongside or after its decision', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(2, { type: 'approval.decided', approvalId: 'approval', decision: 'denied' }), event(1, approval())]); flush()
  expect(root.all('button')).toHaveLength(0); expect(root.children[0]!.all('p')[0]?.textContent).toBe('Denied')
})
it('sends an owner answer once and removes the question input when its answer is persisted', async () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(1, { type: 'question', questionId: 'q', text: hostile })]); flush()
  const input = root.all('textarea')[0]!, send = root.all('button')[0]!
  send.onclick!(); expect(requests).toEqual([])
  input.value = 'Owner answer'; send.onclick!(); send.onclick!(); await tick()
  expect(requests).toEqual([{ kind: 'answer', runId: 'run', questionId: 'q', text: 'Owner answer' }]); expect(send.disabled).toBe(true)
  timeline.append([event(2, { type: 'answer', questionId: 'q', text: 'Owner answer' })]); flush()
  expect(root.all('textarea')).toHaveLength(0); expect(root.all('button')).toHaveLength(0)
})
it('offers explicit mixing after a denial only until mixing is recorded', async () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(1, { type: 'tool.denied', callId: 'call', reason: 'Mixing requires owner permission' })]); flush()
  expect(root.all('button')[0]?.textContent).toBe('Allow web and files for this task')
  root.all('button')[0]!.onclick!(); await tick(); expect(requests).toEqual([{ kind: 'allowMix', runId: 'run' }])
  timeline.setMixed(true); expect(root.all('button')).toHaveLength(0)
  timeline.append([event(2, { type: 'tool.denied', callId: 'call2', reason: 'Denied' })]); flush(); expect(root.all('button')).toHaveLength(0)
})
it('renders model text, tool input and summaries and artifact previews as inert wrapped text', async () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([
    event(1, { type: 'text', step: 0, text: hostile }),
    event(2, { type: 'tool.call', step: 1, callId: 'call', tool: 'fetch_url', input: hostile }),
    event(3, { type: 'tool.result', callId: 'call', ok: true, summary: hostile }),
    event(4, { type: 'artifact', artifactId: 'artifact', name: hostile, mediaType: 'text/plain', bytes: 29 }),
  ]); flush()
  expect(root.children[0]?.textContent).toBe(hostile)
  expect(root.children[1]?.textContent).toContain(hostile); expect(root.children[2]?.textContent).toContain(hostile)
  const copy = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
  request = async value => { requests.push(value); return { name: hostile, mediaType: 'text/plain', bytes: 29, text: hostile } }
  root.all('button')[0]!.onclick!(); await tick()
  expect(requests).toEqual([{ kind: 'artifact', runId: 'run', artifactId: 'artifact' }])
  expect(root.all('pre').at(-1)?.textContent).toBe(hostile); expect(root.all('img')).toHaveLength(0)
  root.all('button').find(node => node.textContent === 'Copy')!.onclick!(); await tick(); expect(copy).toHaveBeenCalledWith(hostile)
})
it('bounds queued history before a frame instead of creating and discarding thousands of DOM nodes', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append(Array.from({ length: 6000 }, (_, i) => event(i + 1))); flush()
  expect(root.children).toHaveLength(2000); expect(created).toBe(2000)
})
it('keeps event identity stable when a duplicate ID arrives with another sequence', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(1)]); flush(); const first = root.children[0]
  timeline.append([{ ...event(2), id: 'e1' }]); flush()
  expect(root.children).toEqual([first])
})
it('keeps only one bounded artifact preview and ignores a late preview for a no-longer-selected artifact', async () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([1, 2, 3].map(seq => event(seq, { type: 'artifact', artifactId: `a${seq}`, name: `Artifact ${seq}`, mediaType: 'text/plain', bytes: 4 }))); flush()
  let late!: (value: unknown) => void
  request = async value => value.kind === 'artifact' && value.artifactId === 'a2' ? new Promise(resolve => { late = resolve }) : { text: 'safe' }
  root.all('button')[0]!.onclick!(); await tick()
  root.children[1]!.all('button')[0]!.onclick!()
  root.children[2]!.all('button')[0]!.onclick!(); await tick(); late({ text: 'stale' }); await tick()
  expect(root.all('pre').map(node => node.textContent)).toEqual(['safe'])
  expect(root.all('button').filter(node => node.textContent === 'Copy')).toHaveLength(1)
})
it('does not offer actionable controls on an earlier history page whose decisions may have left the retained window', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(1, approval()), event(2, { type: 'question', questionId: 'old', text: 'Old question' })], 'earlier'); flush()
  expect(root.all('button')).toHaveLength(0); expect(root.all('textarea')).toHaveLength(0)
})
it('renders typed lifecycle, usage and error events without interpreting model markup', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([
    event(1, { type: 'run.created', goal: hostile, mode: 'web', persistence: 'retained', budget: { maxSteps: 24, maxOutputTokens: 60000, maxWallMs: 1000, maxToolOutputBytes: 1000 } }),
    event(2, { type: 'status', status: 'waiting_approval', reason: 'Done!' }),
    event(3, { type: 'usage', inputTokens: 4, outputTokens: 6 }),
    event(4, { type: 'error', code: 'tool', message: hostile }),
    event(5, { type: 'mode.mixed', allowed: 'local' }),
  ]); flush()
  expect(root.children.map(node => node.textContent)).toEqual([hostile, 'waiting_approval', 'Tokens: 4 in · 6 out', hostile, 'Web and files allowed for this task'])
})
it.each(['approval', 'question', 'mix'] as const)('keeps %s controls inert during history loading and allows retry after a safe request failure', async kind => {
  const notices: string[] = [], timeline = setup(text => notices.push(text)); timeline.reset('run', false)
  timeline.setInteractive(false)
  timeline.append([event(1, kind === 'approval' ? approval() : kind === 'question' ? { type: 'question', questionId: 'q', text: 'Answer?' } : { type: 'tool.denied', callId: 'call', reason: 'Mixing denied' })]); flush()
  const action = root.all('button').at(-1)!
  if (kind === 'question') root.all('textarea')[0]!.value = 'Owner text'
  action.onclick!(); expect(requests).toEqual([])
  timeline.setInteractive(true); request = async () => { throw new Error('secret') }
  action.onclick!(); await tick(); expect(notices).toEqual(['This action failed. Try again.']); expect(action.disabled).toBe(false)
  request = async value => { requests.push(value); return { ok: true } }; action.onclick!(); action.onclick!(); await tick()
  expect(requests).toHaveLength(1)
  if (kind === 'approval') expect(requests[0]).toMatchObject({ decision: 'denied' })
})
it.each([null, {}, { text: 1 }, { text: 'x'.repeat(1_048_577) }])('rejects a malformed or oversized artifact preview without rendering its content', async result => {
  const notices: string[] = [], timeline = setup(text => notices.push(text)); timeline.reset('run', false)
  timeline.append([event(1, { type: 'artifact', artifactId: 'a', name: 'Report', mediaType: 'text/plain', bytes: 1 })]); flush()
  request = async () => result
  root.all('button')[0]!.onclick!(); await tick()
  expect(root.all('pre')).toHaveLength(0); expect(notices).toEqual(['Could not open this preview.']); expect(root.all('button')[0]!.disabled).toBe(false)
})
it('reports clipboard denial with a fixed message and ignores preview completion after task reset', async () => {
  const notices: string[] = [], timeline = setup(text => notices.push(text)); timeline.reset('run', false)
  const artifact = event(1, { type: 'artifact', artifactId: 'a', name: 'Report', mediaType: 'text/plain', bytes: 1 })
  timeline.append([artifact]); flush(); request = async () => ({ text: 'safe' })
  vi.stubGlobal('navigator', { clipboard: { writeText: async () => { throw new Error('secret') } } })
  root.all('button')[0]!.onclick!(); await tick(); root.all('button').at(-1)!.onclick!(); await tick()
  expect(notices).toEqual(['Could not copy this preview.'])
  timeline.reset('run', false); timeline.append([artifact]); flush()
  let finish!: (value: unknown) => void; request = async () => new Promise(resolve => { finish = resolve })
  root.all('button')[0]!.onclick!(); timeline.reset('other', false); finish({ text: 'late' }); await tick(); expect(root.children).toHaveLength(0)
})
it('does not widen a run again after a recorded mixing event even if an older summary says mixed is false', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.append([event(1, { type: 'mode.mixed', allowed: 'local' })]); flush(); timeline.setMixed(false)
  timeline.append([event(2, { type: 'tool.denied', callId: 'call', reason: 'Denied' })]); flush()
  expect(root.all('button')).toHaveLength(0)
})
it('defers streaming-node replacement to its scheduled frame when the step changes', () => {
  const timeline = setup(); timeline.reset('run', false); timeline.partial(1, 'Step one'); flush()
  const first = root.children[0]
  timeline.partial(2, 'Step two'); expect(root.children[0]).toBe(first); flush()
  expect(root.children).toHaveLength(1); expect(root.children[0]?.textContent).toBe('Step two')
})
it('rejects malformed and oversized partial pushes without allocating a streaming node', () => {
  const timeline = setup(); timeline.reset('run', false)
  timeline.partial(-1, 'bad'); timeline.partial(Number.NaN, 'bad'); timeline.partial(10001, 'bad'); timeline.partial(0, 'x'.repeat(64001)); flush()
  expect(root.children).toHaveLength(0)
  timeline.dispose(); timeline.append([event(1)]); timeline.partial(1, 'late'); flush(); expect(root.children).toHaveLength(0)
})
