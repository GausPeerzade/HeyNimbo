import WebSocket from 'ws'

/** A server event from the Realtime API; fields depend on `type`. */
export interface RealtimeEvent {
  type: string
  [field: string]: unknown
}

/** A Realtime API WebSocket that queues events until it opens. The API key
 *  stays in the main process and is sent only to api.openai.com. */
export class RealtimeSocket {
  private readonly socket: WebSocket
  private readonly queued: string[] = []
  private closed = false

  constructor(
    query: string,
    key: string,
    private readonly onEvent: (event: RealtimeEvent) => void,
    onClose: (reason: string) => void,
  ) {
    this.socket = new WebSocket(`wss://api.openai.com/v1/realtime?${query}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    this.socket.on('open', () => this.queued.splice(0).forEach((message) => this.socket.send(message)))
    this.socket.on('message', (data) => this.receive(data.toString()))
    this.socket.on('error', (error) => onClose(error.message))
    this.socket.on('close', (code, reason) => {
      this.closed = true
      onClose(`closed ${code} ${reason.toString()}`.trim())
    })
  }

  get isOpen(): boolean {
    return !this.closed
  }

  send(event: { type: string; [field: string]: unknown }): void {
    if (this.closed) return
    const message = JSON.stringify(event)
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(message)
    else this.queued.push(message)
  }

  close(): void {
    this.closed = true
    this.socket.close()
  }

  private receive(text: string): void {
    try {
      const event = JSON.parse(text) as RealtimeEvent
      if (typeof event.type === 'string') this.onEvent(event)
    } catch {
      // Ignore frames that are not JSON events.
    }
  }
}

export function base64(pcm: Uint8Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}
