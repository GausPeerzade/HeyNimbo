import { base64, RealtimeSocket, type RealtimeEvent } from '../openai/realtime'

/** The API rejects commits under 100 ms of audio; such taps are not questions. */
const MIN_TURN_BYTES = 24_000 * 2 * 0.1
const TRANSCRIPT_TIMEOUT_MS = 10_000

interface PendingTurn {
  resolve: (transcript: string) => void
  reject: (error: Error) => void
  itemId?: string
  timer: NodeJS.Timeout
}

/** Streaming speech-to-text over one warm transcription session, reused across
 *  turns and reopened if it drops. */
export class Ears {
  private socket: RealtimeSocket | undefined
  private bytes = 0
  private pending: PendingTurn | undefined

  constructor(private readonly key: string) {}

  /** Opens the session ahead of the first question. */
  warm(): void {
    this.session()
  }

  begin(): void {
    this.cancel()
    this.session().send({ type: 'input_audio_buffer.clear' })
    this.bytes = 0
  }

  append(pcm: Uint8Array): void {
    this.bytes += pcm.byteLength
    this.session().send({ type: 'input_audio_buffer.append', audio: base64(pcm) })
  }

  /** Ends the turn and resolves with its transcript, or '' for a tap. */
  finish(): Promise<string> {
    if (this.bytes < MIN_TURN_BYTES) return Promise.resolve('')
    this.cancel()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(new Error('Transcription timed out.')), TRANSCRIPT_TIMEOUT_MS)
      this.pending = { resolve, reject, timer }
      this.session().send({ type: 'input_audio_buffer.commit' })
    })
  }

  /** Drops the turn in progress; a pending transcript resolves as ''. */
  cancel(): void {
    this.settle('')
  }

  close(): void {
    this.cancel()
    this.socket?.close()
    this.socket = undefined
  }

  private session(): RealtimeSocket {
    if (this.socket?.isOpen) return this.socket
    this.socket = new RealtimeSocket(
      'intent=transcription',
      this.key,
      (event) => this.onEvent(event),
      (reason) => this.settle(new Error(`Transcription connection ${reason}.`)),
    )
    this.socket.send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: { model: 'gpt-live-transcribe', delay: 'low' },
            turn_detection: null,
          },
        },
      },
    })
    return this.socket
  }

  private onEvent(event: RealtimeEvent): void {
    const pending = this.pending
    if (event.type === 'error') {
      const message = (event.error as { message?: string } | undefined)?.message ?? 'Transcription failed.'
      if (pending) this.settle(new Error(message))
      else console.warn(`[ears] ${message}`)
    } else if (pending && event.type === 'input_audio_buffer.committed') {
      pending.itemId = String(event.item_id)
    } else if (
      pending &&
      event.type === 'conversation.item.input_audio_transcription.completed' &&
      (!pending.itemId || event.item_id === pending.itemId)
    ) {
      this.settle(String(event.transcript ?? '').trim())
    }
  }

  private settle(outcome: string | Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    clearTimeout(pending.timer)
    if (outcome instanceof Error) pending.reject(outcome)
    else pending.resolve(outcome)
  }
}
