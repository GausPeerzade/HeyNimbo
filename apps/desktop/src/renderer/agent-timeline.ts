import type { AgentEvent, AgentRequest } from '../shared/agent-protocol'
import { button, element } from './app-dom'

/** Authority labels must not conceal suffixes or reorder surrounding UI. */
export const safeAgentLabel = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => `\\u{${char.codePointAt(0)!.toString(16)}}`)

export type Scheduler = (callback: () => void) => void
interface TimelineOptions { request: (value: AgentRequest) => Promise<unknown>; schedule?: Scheduler; announce?: (text: string) => void }
function insertionIndex(sequences: readonly number[], seq: number): number {
  let low = 0, high = sequences.length
  while (low < high) { const mid = (low + high) >>> 1; if (sequences[mid]! < seq) low = mid + 1; else high = mid }
  return low
}
/** Keep both replay and live projection bounded; old nodes preserve selection. */
export class AgentTimeline {
  private runId = ''
  private queued = false
  private disposed = false
  private direction: 'latest' | 'earlier' = 'latest'
  private readonly pending = new Map<number, AgentEvent>()
  private readonly pendingSequences: number[] = []
  private readonly nodes = new Map<number, HTMLElement>()
  private readonly ids = new Set<string>()
  private readonly sequences: number[] = []
  private streaming?: { step: number; text: string; node?: HTMLElement }
  private finalStep = -1
  private interactive = true
  private mixed = false
  private generation = 0
  private previewGeneration = 0
  private preview?: { nodes: HTMLElement[]; open: HTMLButtonElement }
  private readonly decisions = new Map<string, 'approved' | 'denied'>()
  private readonly answers = new Map<string, string>()
  private readonly controls = new Map<number, () => void>()
  constructor(private readonly container: HTMLElement, private readonly options: TimelineOptions) {}
  get firstSeq(): number { return this.sequences[0] ?? 0 }
  reset(runId: string, mixed: boolean): void {
    this.clearPreview()
    this.mixed = mixed; this.generation++
    this.runId = runId; this.pending.clear(); this.pendingSequences.length = 0; this.nodes.clear(); this.ids.clear(); this.sequences.length = 0
    this.streaming = undefined; this.finalStep = -1; this.container.replaceChildren()
    this.decisions.clear(); this.answers.clear(); this.controls.clear()
  }
  setMixed(value: boolean): void { if (!value || this.mixed) return; this.mixed = true; for (const update of this.controls.values()) update() }
  setInteractive(value: boolean): void { if (value === this.interactive) return; this.interactive = value; for (const update of this.controls.values()) update() }
  dispose(): void { this.disposed = true; this.pending.clear(); this.pendingSequences.length = 0; this.streaming = undefined; this.clearPreview() }
  partial(step: number, text: string): void {
    if (!Number.isSafeInteger(step) || step < 0 || step > 10000 || typeof text !== 'string' || text.length > 64000 || step <= this.finalStep || this.disposed) return
    if (this.streaming?.step === step) this.streaming.text = text
    else this.streaming = { step, text, node: this.streaming?.node }
    this.schedule()
  }
  append(events: AgentEvent[], direction: 'latest' | 'earlier' = 'latest'): void {
    if (this.disposed) return
    this.direction = direction
    for (const event of events) {
      if (event.runId !== this.runId || this.nodes.has(event.seq) || this.pending.has(event.seq) || this.ids.has(event.id)) continue
      this.pending.set(event.seq, event); this.ids.add(event.id)
      this.pendingSequences.splice(insertionIndex(this.pendingSequences, event.seq), 0, event.seq)
      // Replay can outrun animation frames. Bound the queue as well as the DOM.
      if (this.pending.size > 2000) {
        const seq = (direction === 'latest' ? this.pendingSequences.shift() : this.pendingSequences.pop())!
        this.ids.delete(this.pending.get(seq)!.id); this.pending.delete(seq)
      }
    }
    this.schedule()
  }
  private schedule(): void {
    if (this.queued) return
    this.queued = true
    ;(this.options.schedule ?? requestAnimationFrame)(() => { this.queued = false; if (!this.disposed) this.flush() })
  }
  private flush(): void {
    let changed = false
    for (const { payload } of this.pending.values()) {
      if (payload.type === 'approval.decided') { this.decisions.set(payload.approvalId, payload.decision); changed = true }
      if (payload.type === 'answer') { this.answers.set(payload.questionId, payload.text); changed = true }
      if (payload.type === 'mode.mixed') { this.mixed = true; changed = true }
    }
    if (changed) for (const update of this.controls.values()) update()
    for (const event of this.pending.values()) {
      if (event.payload.type === 'text') {
        this.finalStep = Math.max(this.finalStep, event.payload.step)
        if (this.streaming && this.streaming.step <= this.finalStep) { this.streaming.node?.remove(); this.streaming = undefined }
      }
      const node = this.renderEvent(event)
      node.dataset.eventId = event.id; node.dataset.seq = String(event.seq)
      const index = insertionIndex(this.sequences, event.seq), next = this.sequences[index]
      this.nodes.set(event.seq, node)
      this.container.insertBefore(node, next === undefined ? this.streaming?.node ?? null : this.nodes.get(next)!)
      this.sequences.splice(index, 0, event.seq)
      if (this.sequences.length > 2000) {
        const removed = (this.direction === 'latest' ? this.sequences.shift() : this.sequences.pop())!
        const node = this.nodes.get(removed)!
        this.ids.delete(node.dataset.eventId!); node.remove(); this.nodes.delete(removed)
        this.controls.delete(removed)
      }
    }
    this.pending.clear(); this.pendingSequences.length = 0
    while (this.decisions.size > 2000) this.decisions.delete(this.decisions.keys().next().value!)
    while (this.answers.size > 2000) this.answers.delete(this.answers.keys().next().value!)
    if (this.streaming) {
      if (!this.streaming.node) { this.streaming.node = element('pre', 'agent-streaming'); this.container.append(this.streaming.node) }
      this.streaming.node.textContent = this.streaming.text
    }
  }
  private renderEvent(event: AgentEvent): HTMLElement {
    const p = event.payload
    // Old pages cannot establish that a request is still pending. Reloading the
    // latest timeline is the only way to restore interactive owner controls.
    if (this.direction === 'earlier' && (p.type === 'approval.requested' || p.type === 'question' || p.type === 'tool.denied')) {
      const card = element('section', 'agent-card')
      card.append(element('pre', '', p.type === 'approval.requested' ? safeAgentLabel(p.preview) : p.type === 'question' ? p.text : p.reason), element('p', 'muted', 'Earlier request · select the task again to view current requests'))
      return card
    }
    if (p.type === 'question') return this.question(event, p)
    if (p.type === 'artifact') return this.artifact(event, p)
    if (p.type === 'tool.denied') return this.denial(event, p.reason)
    if (p.type !== 'approval.requested') {
      let text: string
      switch (p.type) {
        case 'text': case 'answer': text = p.text; break
        case 'run.created': text = p.goal; break
        case 'status': text = p.status; break
        case 'tool.call': text = `${p.tool}\n${p.input}`; break
        case 'tool.result': text = p.summary; break
        case 'approval.decided': text = p.decision; break
        case 'mode.mixed': text = 'Web and files allowed for this task'; break
        case 'usage': text = `Tokens: ${p.inputTokens} in · ${p.outputTokens} out`; break
        case 'error': text = p.message; break
      }
      return element('pre', `agent-event agent-${p.type.replace('.', '-')}`, text)
    }
    const card = element('section', 'agent-card'), state = element('p')
    card.append(element('pre', '', safeAgentLabel(p.preview)), state)
    let sent = false
    const actions = (['approved', 'denied'] as const).map(decision => button(decision === 'approved' ? 'Approve' : 'Deny', () => {
      if (sent || !this.interactive || this.decisions.has(p.approvalId)) return
      sent = true; update()
      void this.options.request({ kind: 'approve', runId: event.runId, approvalId: p.approvalId, decision }).catch(() => {
        sent = false; update(); this.options.announce?.('This action failed. Try again.')
      })
    }))
    const update = () => {
      const decision = this.decisions.get(p.approvalId)
      state.textContent = decision === 'approved' ? 'Approved' : decision === 'denied' ? 'Denied' : sent ? 'Decision sent; waiting for confirmation' : 'Approval required'
      for (const action of actions) { action.disabled = sent || !this.interactive; if (decision) action.remove() }
    }
    if (!this.decisions.has(p.approvalId)) card.append(...actions)
    this.controls.set(event.seq, update); update()
    return card
  }
  private question(event: AgentEvent, p: Extract<AgentEvent['payload'], { type: 'question' }>): HTMLElement {
    const card = element('section', 'agent-card'), input = element('textarea'), state = element('p')
    input.setAttribute('aria-label', 'Answer the agent'); input.maxLength = 16000
    let sent = false
    const send = button('Send', () => {
      if (sent || !this.interactive || this.answers.has(p.questionId) || !input.value.trim() || input.value.length > 16000) return
      sent = true; update()
      void this.options.request({ kind: 'answer', runId: event.runId, questionId: p.questionId, text: input.value }).catch(() => {
        sent = false; update(); this.options.announce?.('This action failed. Try again.')
      })
    })
    const update = () => {
      const answered = this.answers.has(p.questionId)
      input.disabled = send.disabled = sent || !this.interactive
      state.textContent = answered ? 'Answered' : sent ? 'Answer sent; waiting for confirmation' : 'Your answer is needed'
      if (answered) { input.remove(); send.remove() }
    }
    card.append(element('pre', '', p.text), state)
    if (!this.answers.has(p.questionId)) card.append(input, send)
    this.controls.set(event.seq, update); update(); return card
  }
  private denial(event: AgentEvent, reason: string): HTMLElement {
    const card = element('section', 'agent-card'); card.append(element('pre', '', reason))
    if (!this.mixed) {
      const warning = element('p', 'muted', 'This permits web requests and granted files in the same task. Local content may be sent to the web.')
      let sent = false
      const allow = button('Allow web and files for this task', () => {
        if (sent || this.mixed || !this.interactive) return
        sent = true; update()
        void this.options.request({ kind: 'allowMix', runId: event.runId }).catch(() => {
          sent = false; update(); this.options.announce?.('This action failed. Try again.')
        })
      })
      const update = () => { allow.disabled = sent || !this.interactive; if (this.mixed) { allow.remove(); warning.remove() } }
      card.append(warning, allow); this.controls.set(event.seq, update); update()
    }
    return card
  }
  private artifact(event: AgentEvent, p: Extract<AgentEvent['payload'], { type: 'artifact' }>): HTMLElement {
    const card = element('section', 'agent-card'), generation = this.generation
    const open = button(`${safeAgentLabel(p.name)} · ${p.bytes} bytes`, () => {
      if (open.disabled) return
      this.clearPreview(); const previewGeneration = this.previewGeneration
      open.disabled = true
      void this.options.request({ kind: 'artifact', runId: event.runId, artifactId: p.artifactId }).then(result => {
        if (this.disposed || generation !== this.generation || previewGeneration !== this.previewGeneration) { open.disabled = false; return }
        if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string' || result.text.length > 1_048_576) throw new Error('Invalid preview')
        const text = result.text
        const nodes = [element('pre', 'agent-preview', safeAgentLabel(text)), button('Copy', () => {
          void navigator.clipboard.writeText(text).catch(() => this.options.announce?.('Could not copy this preview.'))
        })]
        this.preview = { nodes, open }; card.append(...nodes)
      }).catch(() => { open.disabled = false; this.options.announce?.('Could not open this preview.') })
    })
    card.append(open); return card
  }
  private clearPreview(): void {
    this.previewGeneration++
    if (this.preview) { for (const node of this.preview.nodes) node.remove(); this.preview.open.disabled = false; this.preview = undefined }
  }
}
