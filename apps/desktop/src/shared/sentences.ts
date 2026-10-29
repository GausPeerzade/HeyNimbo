// Splits a streamed answer into sentences, so speech can start on the first
// sentence while the rest is still being generated.

const ABBREVIATIONS = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'no.'])
/** Very long sentences are cut at a comma or space so speech never stalls. */
const MAX_PENDING = 240

export class SentenceSplitter {
  private pending = ''

  /** Adds streamed text and returns every sentence it completed. */
  push(delta: string): string[] {
    this.pending += delta
    const sentences: string[] = []
    for (let end = this.boundary(); end > 0; end = this.boundary()) {
      sentences.push(...this.take(end))
    }
    while (this.pending.length > MAX_PENDING) {
      const comma = this.pending.lastIndexOf(', ', MAX_PENDING)
      const cut = comma > 0 ? comma : this.pending.lastIndexOf(' ', MAX_PENDING)
      sentences.push(...this.take(cut > 0 ? cut + 1 : MAX_PENDING))
    }
    return sentences
  }

  /** Returns whatever is left once the stream ends. */
  flush(): string[] {
    return this.take(this.pending.length)
  }

  /** Index just past the first sentence end, or 0 if none is complete yet.
   *  An end needs whitespace after it, so "3.5" and "index.ts" never split. */
  private boundary(): number {
    const pattern = /[.!?…]+["')\]]*(?=\s)|\n+/g
    for (let match = pattern.exec(this.pending); match; match = pattern.exec(this.pending)) {
      const end = match.index + match[0].length
      const word = this.pending.slice(this.pending.lastIndexOf(' ', match.index) + 1, end).toLowerCase()
      if (!ABBREVIATIONS.has(word)) return end
    }
    return 0
  }

  private take(end: number): string[] {
    const sentence = this.pending.slice(0, end).trim()
    this.pending = this.pending.slice(end)
    return sentence ? [sentence] : []
  }
}
