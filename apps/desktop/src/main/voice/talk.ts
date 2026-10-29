import type { ScreenCaptures } from '@nimboguide/native'
import type { VoiceCommand, VoiceEvent } from '../../shared/ipc'
import { SentenceSplitter } from '../../shared/sentences'
import { streamAnswer, type Exchange, type Screenshot } from './brain'
import type { Ears } from './ears'
import type { Mouth } from './mouth'

const HISTORY_LIMIT = 6
const MIC_STOP_TIMEOUT_MS = 1_500

export interface TalkDeps {
  key: string
  ears: Ears
  mouth: Mouth
  audio: { send(command: VoiceCommand): void }
  capture: () => Promise<ScreenCaptures | undefined>
  /** A label while busy, or undefined to return the notch to rest. */
  onStatus: (label: string | undefined) => void
}

interface Turn {
  readonly id: number
  readonly abort: AbortController
  readonly capture: Promise<ScreenCaptures | undefined>
  readonly marks: Map<string, number>
  releasedAt?: number
  micStopped?: () => void
  spoken: boolean
}

/** One push-to-talk conversation: listen while held, then transcribe, think and
 *  speak sentence by sentence. A new press interrupts whatever is in flight. */
export class TalkSession {
  private turn: Turn | undefined
  private nextId = 0
  private readonly history: Exchange[] = []

  constructor(private readonly deps: TalkDeps) {}

  holdStarted(): void {
    this.interrupt()
    this.deps.ears.begin()
    const id = ++this.nextId
    this.turn = { id, abort: new AbortController(), capture: this.deps.capture(), marks: new Map(), spoken: false }
    this.deps.audio.send({ kind: 'micStart', id })
    this.deps.onStatus('Listening…')
  }

  holdEnded(): void {
    const turn = this.turn
    if (!turn || turn.releasedAt !== undefined) return
    turn.releasedAt = performance.now()
    const micStopped = new Promise<void>((resolve) => {
      turn.micStopped = resolve
      setTimeout(resolve, MIC_STOP_TIMEOUT_MS)
    })
    this.deps.audio.send({ kind: 'micStop' })
    this.answer(turn, micStopped).catch((error: unknown) => this.fail(turn, error))
  }

  holdCancelled(): void {
    this.interrupt()
    this.deps.onStatus(undefined)
  }

  onAudioEvent(event: VoiceEvent): void {
    const turn = this.turn
    switch (event.kind) {
      case 'micChunk':
        if (turn?.id === event.id && !turn.abort.signal.aborted) this.deps.ears.append(event.pcm)
        return
      case 'micStopped':
        if (turn?.id === event.id) turn.micStopped?.()
        return
      case 'micError':
        console.warn(`[talk] microphone: ${event.message}`)
        this.interrupt()
        this.deps.onStatus('Microphone unavailable')
        return
      case 'playbackStarted':
        if (turn) {
          this.mark(turn, 'first audio')
          this.deps.onStatus('Speaking…')
        }
        return
      case 'playbackDrained':
        if (turn?.spoken) this.finish(turn)
        return
      case 'micStarted':
    }
  }

  private async answer(turn: Turn, micStopped: Promise<void>): Promise<void> {
    await micStopped
    const question = await this.deps.ears.finish()
    this.mark(turn, 'transcript')
    if (turn.abort.signal.aborted) return
    if (!question) return this.finish(turn)
    this.deps.onStatus('Thinking…')
    const screenshot = toScreenshot(await turn.capture)
    const splitter = new SentenceSplitter()
    let speech: Promise<void> = Promise.resolve()
    const say = (sentence: string): void => {
      if (!turn.marks.has('first line')) this.mark(turn, 'first line')
      speech = speech.then(() =>
        turn.abort.signal.aborted
          ? undefined
          : this.deps.mouth.speak(sentence, (pcm) => {
              if (!turn.abort.signal.aborted) this.deps.audio.send({ kind: 'play', pcm })
            }),
      )
    }
    let answer = ''
    for await (const delta of streamAnswer({
      key: this.deps.key,
      question,
      screenshot,
      history: this.history,
      signal: turn.abort.signal,
    })) {
      if (!answer) this.mark(turn, 'first token')
      answer += delta
      splitter.push(delta).forEach(say)
    }
    splitter.flush().forEach(say)
    await speech
    if (turn.abort.signal.aborted) return
    this.history.push({ question, answer })
    this.history.splice(0, Math.max(0, this.history.length - HISTORY_LIMIT))
    turn.spoken = true
    this.deps.audio.send({ kind: 'playEnd' })
  }

  /** Stops listening, thinking and speaking for the current turn. */
  private interrupt(): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    turn.abort.abort()
    turn.micStopped?.()
    this.deps.ears.cancel()
    this.deps.mouth.cancel()
    this.deps.audio.send({ kind: 'micStop' })
    this.deps.audio.send({ kind: 'playCancel' })
  }

  private finish(turn: Turn): void {
    if (this.turn !== turn) return
    this.turn = undefined
    if (turn.releasedAt !== undefined && turn.marks.size > 0) {
      const timings = [...turn.marks].map(([label, at]) => `${label} ${Math.round(at - turn.releasedAt!)}ms`)
      console.info(`[talk] after release: ${timings.join(', ')}`)
    }
    this.deps.onStatus(undefined)
  }

  private fail(turn: Turn, error: unknown): void {
    if (turn.abort.signal.aborted || this.turn !== turn) return
    console.warn(`[talk] ${error instanceof Error ? error.message : String(error)}`)
    this.interrupt()
    this.deps.onStatus('Something went wrong')
    setTimeout(() => {
      if (!this.turn) this.deps.onStatus(undefined)
    }, 2_500)
  }

  private mark(turn: Turn, label: string): void {
    if (!turn.marks.has(label)) turn.marks.set(label, performance.now())
  }
}

function toScreenshot(captures: ScreenCaptures | undefined): Screenshot | undefined {
  const display = captures?.displays[0]
  if (!display) return undefined
  return {
    jpeg: display.jpeg,
    width: display.pixelWidth,
    height: display.pixelHeight,
    cursor: display.cursor ?? undefined,
  }
}
