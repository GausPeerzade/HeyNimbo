import { RealtimeSocket, type RealtimeEvent } from '../openai/realtime'

const VOICE_INSTRUCTIONS =
  'You are a text-to-speech voice. Read the text you are given aloud exactly as written, in a warm, ' +
  'natural, conversational tone. Never add, remove, or change words, and never answer it.'

interface Line {
  id: string
  responseId?: string
  onAudio: (pcm: Uint8Array) => void
  done: () => void
}

/** Text to speech through a Realtime voice model. Each line is an out-of-band
 *  response with no conversation context, spoken verbatim. */
export class Mouth {
  private socket: RealtimeSocket | undefined
  private line: Line | undefined
  private nextId = 0

  constructor(
    private readonly key: string,
    private readonly voice = 'marin',
  ) {}

  warm(): void {
    this.session()
  }

  /** Speaks one line, streaming its audio; resolves when generation ends. */
  speak(text: string, onAudio: (pcm: Uint8Array) => void): Promise<void> {
    this.cancel()
    return new Promise<void>((done) => {
      const id = `line-${++this.nextId}`
      this.line = { id, onAudio, done }
      this.session().send({
        type: 'response.create',
        response: {
          conversation: 'none',
          metadata: { nimbo_line: id },
          output_modalities: ['audio'],
          input: [],
          instructions: `Say exactly the following, word for word, and nothing else:\n\n${text}`,
        },
      })
    })
  }

  /** Stops the line being generated; its promise resolves. */
  cancel(): void {
    const line = this.line
    if (!line) return
    this.line = undefined
    if (line.responseId) this.socket?.send({ type: 'response.cancel', response_id: line.responseId })
    line.done()
  }

  close(): void {
    this.cancel()
    this.socket?.close()
    this.socket = undefined
  }

  private session(): RealtimeSocket {
    if (this.socket?.isOpen) return this.socket
    this.socket = new RealtimeSocket(
      'model=gpt-realtime-2.1-mini',
      this.key,
      (event) => this.onEvent(event),
      (reason) => {
        console.warn(`[mouth] connection ${reason}`)
        this.cancel()
      },
    )
    this.socket.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: VOICE_INSTRUCTIONS,
        audio: { output: { format: { type: 'audio/pcm', rate: 24_000 }, voice: this.voice } },
      },
    })
    return this.socket
  }

  private onEvent(event: RealtimeEvent): void {
    const line = this.line
    if (event.type === 'error') {
      console.warn(`[mouth] ${(event.error as { message?: string } | undefined)?.message ?? 'speech failed'}`)
      return this.cancel()
    }
    if (!line) return
    const response = event.response as { id?: string; metadata?: { nimbo_line?: string } } | undefined
    if (event.type === 'response.created' && response?.metadata?.nimbo_line === line.id) {
      line.responseId = response.id
    } else if (event.type === 'response.output_audio.delta' && event.response_id === line.responseId) {
      line.onAudio(Buffer.from(String(event.delta), 'base64'))
    } else if (event.type === 'response.done' && response?.id === line.responseId) {
      this.line = undefined
      line.done()
    }
  }
}
