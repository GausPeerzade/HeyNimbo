import type { AppSettings, DrawingScene, HistoryTurn, TurnTask } from '../shared/app'
import type { Exchange } from './voice/brain'
import { HistoryRepository } from './history'

/** The current conversation is shared by voice, Home and peek. */
export class ConversationController {
  private current: string | null = null
  private readonly temporary = new HistoryRepository()
  private active: { id: string; repository: HistoryRepository } | undefined
  constructor(readonly history: HistoryRepository, private readonly settings: () => AppSettings, private readonly changed: () => void = () => {}) {}
  get saved(): boolean { const s = this.settings(); return s.saveHistory && s.retention !== 0 }
  private get repository(): HistoryRepository { return this.saved ? this.history : this.temporary }
  get currentId(): string | null { return this.current }
  get activeTurnId(): string | null { return this.active?.id ?? null }
  list() {
    const conversations = this.repository.list()
    if (this.current && !conversations.some(c => c.id === this.current)) {
      const current = this.repository.conversation(this.current)
      if (current) conversations.push(current)
    }
    return conversations
  }
  get(id: string) { return this.repository.conversation(id) }
  turns(): HistoryTurn[] { return this.current ? this.repository.turns(this.current) : [] }
  newConversation(): string {
    this.current = this.repository.create()
    this.changed()
    return this.current
  }
  open(id: string): void {
    if (!this.repository.exists(id)) throw new Error('This conversation is no longer available.')
    this.current = id
    this.changed()
  }
  context(): Exchange[] {
    return this.current ? this.repository.context(this.current, this.active?.id) : []
  }
  begin(question: string, mode: HistoryTurn['mode'], connection?: { provider: string; model: string }): string {
    const previous = this.current
    const conversationId = previous && this.repository.exists(previous) ? previous : this.repository.create()
    let id: string
    try { id = this.repository.begin(conversationId, question, mode, Date.now(), connection) }
    catch (error) {
      if (conversationId !== previous) {
        try { this.repository.delete(conversationId) } catch { console.warn('[history] Could not remove an empty conversation.') }
      }
      throw error
    }
    this.current = conversationId
    this.active = { id, repository: this.repository }
    this.changed()
    return id
  }
  update(id: string, answer: string, scene: DrawingScene, screenUsed: boolean): void {
    if (this.active?.id !== id) return
    this.active.repository.update(id, answer, scene, screenUsed)
    this.changed()
  }
  finish(id: string, state: HistoryTurn['state'], error: string | null = null): void {
    if (this.active?.id !== id) return
    try { this.active.repository.finish(id, state, error) }
    finally { this.active = undefined; this.changed() }
  }
  /** Task outcomes can arrive after the turn finished and after history settings changed, so the
   *  writer binds the repository that owns the turn now. A deleted turn makes it a no-op. */
  taskRecorder(turnId: string): (tasks: TurnTask[]) => void {
    const repository = this.active?.id === turnId ? this.active.repository : this.repository
    return tasks => { repository.setTasks(turnId, tasks); this.changed() }
  }
  reset(): void { this.current = null; this.changed() }
  search(query: string) { return this.repository.search(query) }
  rename(id: string, title: string): void { this.repository.rename(id, title); this.changed() }
  pin(id: string, pinned: boolean): void { this.repository.pin(id, pinned); this.changed() }
  delete(id: string): void { this.repository.delete(id); if (this.current === id) this.current = null; this.changed() }
  deleteAll(): void { this.history.deleteAll(); this.temporary.deleteAll(); this.reset() }
  close(): void { this.temporary.close(); this.history.close() }
}
