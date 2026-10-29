import type { SearchHit } from '../shared/app'

/** Every edit invalidates in-flight work, including edits within the debounce window. */
export class ConversationSearch {
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly query: () => string,
    private readonly fetch: (query: string) => Promise<SearchHit[] | undefined>,
    private readonly show: (hits: SearchHit[] | undefined) => void,
  ) {}
  changed(): void {
    const sequence = ++this.sequence, query = this.query().trim()
    clearTimeout(this.timer)
    if (!query) { this.show(undefined); return }
    this.timer = setTimeout(() => { void this.search(sequence, query) }, 120)
  }
  private async search(sequence: number, query: string): Promise<void> {
    const hits = await this.fetch(query)
    if (sequence !== this.sequence || query !== this.query().trim() || !hits) return
    this.show(hits)
  }
}
