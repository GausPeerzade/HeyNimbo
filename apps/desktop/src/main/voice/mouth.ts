import { openSocket, type RealtimeEvent, type SocketFactory } from '../openai/realtime'

const VOICE_INSTRUCTIONS =
  'You are a text-to-speech voice. Read the text you are given aloud exactly as written, in a warm, ' +
  'natural, conversational tone. Never add, remove, or change words, and never answer it.'
/** A sentence that has produced no terminal event by now has failed. */
const LINE_TIMEOUT_MS = 20_000

interface Line {
  id: string
  responseId?: string
  onAudio: (pcm: Uint8Array) => void
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Text to speech through a Realtime voice model. Each line is an out-of-band
 *  response with no conversation context, spoken verbatim. */
export class Mouth {
  private socket: ReturnType<SocketFactory> | undefined
  private line: Line | undefined
  private nextId = 0
  /** Lines cancelled before the server acknowledged them; cancelled server-side
   *  once their acknowledgement arrives, so they stop generating. */
  private readonly cancelledBeforeCreated = new Set<string>()

  constructor(
    private readonly key: string,
    private readonly voice = 'marin',
    private readonly connect: SocketFactory = openSocket,
  ) {}

  warm(): void {
    this.session()
  }

  /** Speaks one line, streaming its audio. Resolves when it was fully spoken or
   *  deliberately cancelled; rejects when speech failed. */
  speak(text: string, onAudio: (pcm: Uint8Array) => void): Promise<void> {
    this.cancel()
    const socket = this.session()
    return new Promise<void>((resolve, reject) => {
      const id = `line-${++this.nextId}`
      const timer = setTimeout(() => this.fail(new Error('Speech timed out.')), LINE_TIMEOUT_MS)
      this.line = { id, onAudio, resolve, reject, timer }
      socket.send({
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

  /** Interrupts the line being spoken; its promise resolves. */
  cancel(): void {
    const line = this.take()
    if (!line) return
    if (line.responseId) this.socket?.send({ type: 'response.cancel', response_id: line.responseId })
    else this.cancelledBeforeCreated.add(line.id)
    line.resolve()
  }

  close(): void {
    this.cancel()
    this.socket?.close()
    this.socket = undefined
  }

  private take(): Line | undefined {
    const line = this.line
    this.line = undefined
    if (line) clearTimeout(line.timer)
    return line
  }

  private fail(error: Error): void {
    const line = this.take()
    if (!line) return console.warn(`[mouth] ${error.message}`)
    if (line.responseId) this.socket?.send({ type: 'response.cancel', response_id: line.responseId })
    line.reject(error)
  }

  private session(): ReturnType<SocketFactory> {
    if (this.socket?.isOpen) return this.socket
    this.cancelledBeforeCreated.clear()
    this.socket = this.connect(
      'model=gpt-realtime-2.1-mini',
      this.key,
      (event) => this.onEvent(event),
      (reason) => this.fail(new Error(`Speech connection ${reason}.`)),
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
    if (event.type === 'error') {
      return this.fail(new Error((event.error as { message?: string } | undefined)?.message ?? 'Speech failed.'))
    }
    const response = event.response as { id?: string; status?: string; metadata?: { nimbo_line?: string } } | undefined
    const line = this.line
    if (event.type === 'response.created') {
      const id = response?.metadata?.nimbo_line
      if (id && this.cancelledBeforeCreated.delete(id)) {
        this.socket?.send({ type: 'response.cancel', response_id: response?.id })
      } else if (line && id === line.id) {
        line.responseId = response?.id
      }
    } else if (line && event.type === 'response.output_audio.delta' && event.response_id === line.responseId) {
      line.onAudio(Buffer.from(String(event.delta), 'base64'))
    } else if (line && event.type === 'response.done' && response?.id === line.responseId) {
      if (response?.status === 'completed') this.take()?.resolve()
      else this.fail(new Error(`Speech ended as ${response?.status ?? 'unknown'}.`))
    }
  }
}
