import { RUN_STATUSES, isTerminal, parseAgentEvent, parseAgentRequest, type AgentApi, type AgentEvent, type AgentPush, type HostState, type RunMode, type RunSummary } from '../shared/agent-protocol'
import { button, element } from './app-dom'
import { AgentTimeline, safeAgentLabel, type Scheduler } from './agent-timeline'

interface ViewElements { panel: HTMLElement; folders: HTMLElement; stopAll: HTMLButtonElement }
interface ViewOptions { schedule?: Scheduler }
export const STATUS_LABELS: Record<RunSummary['status'], string> = { queued: 'Queued', running: 'Running', waiting_approval: 'Waiting for approval', waiting_user: 'Waiting for you', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' }
const canContinue = (run?: RunSummary): boolean => run?.status === 'interrupted' || (run?.status === 'failed' && run.error?.code === 'provider')
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)
function runsResult(value: unknown): RunSummary[] {
  const runs = record(value).runs
  if (!Array.isArray(runs) || runs.length > 200) throw new Error('Invalid tasks')
  return runs.map(value => {
    const r = record(value)
    if (!validId(r.id) || typeof r.goal !== 'string' || r.goal.length > 16000 || !RUN_STATUSES.includes(r.status as RunSummary['status']) || !Number.isSafeInteger(r.updated) || Number(r.updated) < 0 || typeof r.mixed !== 'boolean' || !['web', 'local'].includes(String(r.mode))) throw new Error('Invalid task')
    return value as RunSummary
  })
}
function eventsResult(value: unknown, runId: string, afterSeq: number): AgentEvent[] {
  const events = record(value).events
  if (!Array.isArray(events) || events.length > 200) throw new Error('Invalid events')
  return events.map(value => {
    const event = parseAgentEvent(value)
    if (event.runId !== runId || event.seq <= afterSeq) throw new Error('Invalid event cursor')
    return event
  })
}
export class AgentView {
  private enabled = false
  private initialized = false
  private disposed = false
  private queued = false
  private before?: number
  private listing = false
  private selected = ''
  private selectedRun?: RunSummary
  private generation = 0
  private mode: RunMode = 'web'
  private picking = false
  private starting = false
  private pendingSelect = ''
  private attempt?: { key: string; id: string }
  private readonly grants = new Map<string, string>()
  private readonly web = button('Web research', () => this.setMode('web'))
  private readonly local = button('Local files', () => this.setMode('local'))
  private readonly addFolder = button('Add folder', () => { void this.pickFolder() })
  private readonly chips = element('div', 'agent-folder-chips')
  private readonly runs = new Map<string, RunSummary>()
  private readonly rows = new Map<string, { node: HTMLButtonElement; goal: HTMLElement; status: HTMLElement }>()
  private readonly list = element('div', 'agent-tasks')
  private readonly older = button('Load older', () => { void this.loadList() })
  private readonly newest = button('Load newest', () => {
    if (this.listing) return
    this.before = undefined; this.runs.clear(); void this.loadList()
  })
  private readonly status = element('p', 'agent-status')
  private hostState: HostState = 'idle'
  private readonly host = element('p', 'agent-host')
  private readonly acting = new Set<string>()
  private readonly deleted = new Set<string>()
  private statusKey = ''
  private readonly stop = button('Stop task', () => { void this.command('cancel') })
  private readonly resume = button('Continue', () => { void this.command('continue') })
  private readonly remove = button('Delete task', () => { void this.command('delete') }, 'danger')
  private readonly history = element('div', 'agent-timeline')
  private readonly heading = element('h2', '', 'Select a task')
  private readonly earlier = button('Show earlier', () => { void this.loadEarlier() })
  private readonly timeline: AgentTimeline
  private readonly unsubscribe: () => void
  constructor(private readonly api: AgentApi, private readonly elements: ViewElements, private readonly options: ViewOptions = {}) {
    this.status.setAttribute('aria-live', 'polite'); this.status.setAttribute('role', 'status')
    const tasks = element('section', 'agent-task-list'); tasks.setAttribute('aria-label', 'Tasks')
    tasks.append(element('h2', '', 'Tasks'), this.list, this.older, this.newest)
    this.history.setAttribute('aria-label', 'Task timeline'); this.history.tabIndex = 0
    const controls = element('div', 'agent-run-controls'); controls.append(this.stop, this.resume, this.remove)
    const detail = element('section', 'agent-detail'); detail.append(this.heading, controls, this.earlier, this.history)
    this.host.setAttribute('role', 'status'); this.host.setAttribute('aria-live', 'polite'); this.host.hidden = true
    elements.panel.append(this.host, this.status, tasks, detail)
    this.timeline = new AgentTimeline(this.history, { request: value => api.request(value), schedule: options.schedule, announce: text => { this.status.textContent = text } })
    elements.folders.append(this.web, this.local, this.addFolder, this.chips); this.renderFolders()
    elements.stopAll.onclick = () => { void api.request({ kind: 'stopAll' }).catch(() => { this.status.textContent = 'Could not stop all tasks. Try again.' }) }
    this.unsubscribe = api.onPush(push => this.push(push))
    this.setActive(false)
  }
  get active(): boolean { return this.enabled }
  async submit(goal: string): Promise<boolean> {
    if (!this.enabled || this.starting || !goal.trim() || goal.length > 16000) return false
    this.starting = true
    const grantIds = [...this.grants.keys()]
    const key = JSON.stringify([goal, this.mode, this.mode === 'local' ? grantIds : []])
    if (this.attempt?.key !== key) this.attempt = { key, id: crypto.randomUUID() }
    try {
      const request = parseAgentRequest({ kind: 'start', requestId: this.attempt.id, goal, mode: this.mode, ...(this.mode === 'local' ? { grantIds } : {}) })
      const result = record(await this.api.request(request))
      if (!validId(result.runId)) throw new Error('Invalid run')
      if (this.disposed) return false
      this.attempt = undefined; this.pendingSelect = result.runId
      if (this.runs.has(result.runId)) { this.select(result.runId); this.pendingSelect = '' }
      this.status.textContent = 'Task started'
      return true
    } catch { this.status.textContent = 'Could not start the task. Try again.'; return false }
    finally { this.starting = false }
  }
  setActive(active: boolean): void {
    this.enabled = active; this.elements.panel.hidden = this.elements.folders.hidden = this.elements.stopAll.hidden = !active
    if (active && !this.initialized) { this.initialized = true; void this.loadList() }
  }
  dispose(): void { this.disposed = true; this.generation++; this.unsubscribe(); this.timeline.dispose() }
  private push(push: AgentPush): void {
    if (this.disposed) return
    if (push.kind === 'partial') {
      if (push.runId === this.selected) this.timeline.partial(push.step, push.text)
    } else if (push.kind === 'host') {
      this.hostState = push.state; this.schedule()
    } else if (push.kind === 'events') {
      try {
        const runs = runsResult({ runs: push.runs }), events = push.events.map(parseAgentEvent).filter(event => event.runId === this.selected)
        this.upsert(runs); if (events.length) this.timeline.append(events); if (runs.length) this.schedule()
        for (const partial of push.partials ?? []) if (partial.runId === this.selected) this.timeline.partial(partial.step, partial.text)
      }
      catch { this.status.textContent = 'Could not update tasks. Try again.' }
    }
  }
  private upsert(runs: RunSummary[], older = false): void {
    for (const run of runs) {
      if (this.deleted.has(run.id)) continue
      if (!this.runs.has(run.id) || this.runs.get(run.id)!.updated <= run.updated) this.runs.set(run.id, run)
      if (this.selectedRun?.id === run.id && this.selectedRun.updated <= run.updated) this.selectedRun = run
    }
    if (this.runs.size > 1000) {
      const sorted = [...this.runs.values()].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id))
      const outside = older ? sorted.slice(0, -1000) : sorted.slice(1000)
      for (const run of outside) this.runs.delete(run.id)
    }
    if (this.pendingSelect && this.runs.has(this.pendingSelect)) { this.select(this.pendingSelect); this.pendingSelect = '' }
  }
  private setMode(mode: RunMode): void { this.mode = mode; this.renderFolders() }
  private renderFolders(): void {
    this.web.setAttribute('aria-pressed', String(this.mode === 'web')); this.local.setAttribute('aria-pressed', String(this.mode === 'local'))
    this.addFolder.disabled = this.mode === 'web' || this.picking || this.grants.size >= 8
    this.chips.replaceChildren()
    for (const [id, label] of this.grants) {
      const chip = element('div', 'agent-folder-chip'), remove = button('×', () => {
        if (this.mode !== 'local') return
        this.grants.delete(id); this.renderFolders()
      })
      remove.setAttribute('aria-label', `Remove folder ${safeAgentLabel(label)}`); remove.disabled = this.mode === 'web'
      chip.append(element('span', '', safeAgentLabel(label)), remove); this.chips.append(chip)
    }
    this.chips.setAttribute('aria-disabled', String(this.mode === 'web'))
  }
  private async pickFolder(): Promise<void> {
    if (this.mode !== 'local' || this.picking || this.grants.size >= 8) return
    this.picking = true; this.renderFolders()
    try {
      const result = record(await this.api.request({ kind: 'pickFolder' }))
      if (this.disposed || result.cancelled === true) return
      const grant = record(result.grant)
      if (!validId(grant.id) || typeof grant.label !== 'string' || grant.label.length > 1000) throw new Error('Invalid grant')
      this.grants.set(grant.id, grant.label)
    } catch { this.status.textContent = 'Could not add the folder. Try again.' }
    finally { this.picking = false; this.renderFolders() }
  }
  private async loadList(): Promise<void> {
    if (this.listing) return
    this.listing = true; this.older.disabled = true
    try {
      const runs = runsResult(await this.api.request({ kind: 'list', limit: 50, ...(this.before === undefined ? {} : { before: this.before }) }))
      if (this.disposed) return
      this.upsert(runs, this.before !== undefined); this.before = runs.length ? Math.min(...runs.map(run => run.updated)) : this.before
      const first = runs.find(run => this.runs.has(run.id))
      if (!this.selected && first) this.select(first.id)
      this.older.hidden = runs.length < 50; this.schedule()
    } catch { this.status.textContent = 'Could not load tasks. Try again.' }
    finally { this.listing = false; this.older.disabled = false }
  }
  private select(runId: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    this.selected = runId; this.selectedRun = run; const generation = ++this.generation
    this.statusKey = `${run.id}:${run.status}`; this.status.textContent = STATUS_LABELS[run.status]
    this.timeline.reset(runId, run.mixed); this.timeline.setInteractive(false)
    this.schedule(); void this.loadEvents(runId, generation)
  }
  private async loadEvents(runId: string, generation: number): Promise<void> {
    let afterSeq = 0
    try {
      for (;;) {
        const events = eventsResult(await this.api.request({ kind: 'events', runId, afterSeq, limit: 200 }), runId, afterSeq)
        if (this.disposed || generation !== this.generation) return
        this.timeline.append(events)
        if (events.length < 200) break
        afterSeq = Math.max(...events.map(event => event.seq))
      }
      this.timeline.setInteractive(true)
    } catch { if (!this.disposed && generation === this.generation) this.status.textContent = 'Could not load this task. Select it to retry.' }
  }
  private async loadEarlier(): Promise<void> {
    const first = this.timeline.firstSeq, runId = this.selected, generation = this.generation
    if (first <= 1 || this.earlier.disabled) return
    this.earlier.disabled = true
    try {
      const afterSeq = Math.max(0, first - 201)
      const events = eventsResult(await this.api.request({ kind: 'events', runId, afterSeq, limit: 200 }), runId, afterSeq)
      if (!this.disposed && generation === this.generation) this.timeline.append(events.filter(event => event.seq < first), 'earlier')
    } catch { this.status.textContent = 'Could not load earlier events. Try again.' }
    finally { this.earlier.disabled = false }
  }
  private async command(kind: 'cancel' | 'continue' | 'delete'): Promise<void> {
    const run = this.selectedRun
    if (!run || this.acting.has(run.id) || (kind === 'cancel' && isTerminal(run.status)) || (kind === 'continue' && !canContinue(run))) return
    if (kind === 'delete' && !confirm('Delete this task and its artifacts?')) return
    this.acting.add(run.id); this.schedule()
    try {
      const result = record(await this.api.request({ kind, runId: run.id }))
      if (result.ok !== true) throw new Error('Action failed')
      if (this.disposed) return
      if (kind === 'delete') {
        this.deleted.add(run.id)
        if (this.deleted.size > 1000) this.deleted.delete(this.deleted.values().next().value!)
        this.runs.delete(run.id)
        if (this.selected === run.id) { this.selected = ''; this.selectedRun = undefined; this.generation++; this.timeline.reset('', false) }
      }
    } catch { this.status.textContent = 'This action failed. Try again.' }
    finally { this.acting.delete(run.id); this.schedule() }
  }
  private schedule(): void {
    if (this.queued) return
    this.queued = true
    ;(this.options.schedule ?? requestAnimationFrame)(() => { this.queued = false; if (!this.disposed) this.render() })
  }
  private render(): void {
    this.host.textContent = this.hostState === 'crashed' ? 'The agent stopped unexpectedly. Your tasks were saved; start or continue a task to restart it.' : this.hostState === 'starting' ? 'Starting the agent…' : ''
    this.host.hidden = !this.host.textContent
    const sorted = [...this.runs.values()].sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id))
    const retained = new Set(sorted.map(run => run.id))
    for (const [id, row] of this.rows) if (!retained.has(id)) { row.node.remove(); this.rows.delete(id) }
    for (const [index, run] of sorted.entries()) {
      let row = this.rows.get(run.id)
      if (!row) {
        row = { node: button('', () => this.select(run.id)), goal: element('span'), status: element('span', 'agent-badge') }
        row.node.className = 'agent-task'; row.node.dataset.runId = run.id; row.node.append(row.goal, row.status); this.rows.set(run.id, row)
      }
      if (row.goal.textContent !== run.goal) row.goal.textContent = run.goal
      if (row.status.textContent !== STATUS_LABELS[run.status]) row.status.textContent = STATUS_LABELS[run.status]
      row.node.setAttribute('aria-current', String(run.id === this.selected))
      if (this.list.children[index] !== row.node) this.list.insertBefore(row.node, this.list.children[index] ?? null)
    }
    const selected = this.selectedRun
    this.stop.hidden = !selected || isTerminal(selected.status)
    this.resume.hidden = !canContinue(selected); this.remove.hidden = !selected
    this.stop.disabled = this.resume.disabled = this.remove.disabled = this.acting.has(this.selected)
    if (!selected) this.heading.textContent = 'Select a task'
    if (selected) {
      this.heading.textContent = selected.goal; this.timeline.setMixed(selected.mixed)
      const label = STATUS_LABELS[selected.status]
      const key = `${selected.id}:${selected.status}`
      if (this.statusKey !== key) { this.status.textContent = label; this.statusKey = key }
    }
  }
}
