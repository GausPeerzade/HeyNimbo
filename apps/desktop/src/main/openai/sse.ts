// Incremental parser for server-sent events, as streamed by the Responses API.

export interface SseEvent {
  event?: string
  data: string
}

export class SseParser {
  private buffer = ''
  private carriageReturn = false

  /** Adds raw text and returns every event it completed. */
  push(chunk: string): SseEvent[] {
    // A trailing "\r" may be the first half of a "\r\n" split across chunks.
    const text = (this.carriageReturn ? '\r' : '') + chunk
    this.carriageReturn = text.endsWith('\r')
    this.buffer += (this.carriageReturn ? text.slice(0, -1) : text).replace(/\r\n?/g, '\n')
    const events: SseEvent[] = []
    for (let end = this.buffer.indexOf('\n\n'); end >= 0; end = this.buffer.indexOf('\n\n')) {
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const event = parseBlock(block)
      if (event) events.push(event)
    }
    return events
  }
}

function parseBlock(block: string): SseEvent | undefined {
  let name: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') name = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { event: name, data: data.join('\n') } : undefined
}
