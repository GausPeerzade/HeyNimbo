import type { ScreenCaptures } from '@nimboguide/native'
import { BeatParser, type Beat, type Mark } from '../../shared/beats'
import type { VoiceCommand, VoiceEvent } from '../../shared/ipc'
import type { CaptureSpace } from '../overlay-geometry'
import type { DrawingScene } from '../../shared/app'
import type { ConversationController } from '../conversations'
import { streamAnswer, type Screenshot } from './brain'
import type { Ears } from './ears'
import type { Mouth } from './mouth'

const MIC_STOP_TIMEOUT_MS = 1_500
/** Declared beat budget while sentence PCM is still streaming. Drawing uses
 *  natural durations unless it would overrun this speech estimate. */
const WORDS_PER_SECOND = 2.6

export interface TalkDeps {
  key: string
  conversations: ConversationController
  ears: Ears
  mouth: Mouth
  audio: { send(command: VoiceCommand): void }
  capture: () => Promise<ScreenCaptures | undefined>
  /** A label while busy, or undefined to return the notch to rest. */
  onStatus: (label: string | undefined) => void
  drawing: {
    /** Draws marks given in the capture's screenshot pixels. */
    draw(marks: Mark[], durationMs: number, space: CaptureSpace): void
    /** The answer is over; offer to clear the drawing. */
    answerDone(): void
  }
}

interface Turn {
  readonly id: number
  readonly abort: AbortController
  readonly capture: Promise<ScreenCaptures | undefined>
  readonly marks: Map<string, number>
  releasedAt?: number
  micStopped?: () => void
  spoken: boolean
  recordId?: string
  scene: DrawingScene
  /** Marks waiting for their sentence's audio to start, by line number. */
  readonly lines: Map<number, { marks: Mark[]; durationMs: number }>
  space?: CaptureSpace
}

/** One push-to-talk conversation: listen while held, then transcribe, think and
 *  speak sentence by sentence. A new press interrupts whatever is in flight. */
export class TalkSession {
  private turn: Turn | undefined
  private nextId = 0

  constructor(private readonly deps: TalkDeps) {}

  holdStarted(): void {
    this.interrupt()
    this.deps.ears.begin()
    const id = ++this.nextId
    this.turn = {
      id,
      abort: new AbortController(),
      capture: this.deps.capture(),
      marks: new Map(),
      spoken: false,
      scene: { version: 1, beats: [] },
      lines: new Map(),
    }
    this.deps.audio.send({ kind: 'micStart', id })
    this.deps.onStatus('Listening…')
  }

  askText(question: string): void {
    if (!question.trim()) return
    this.interrupt()
    const turn: Turn = {
      id: ++this.nextId, abort: new AbortController(), capture: this.deps.capture(), marks: new Map(),
      spoken: false, lines: new Map(), scene: { version: 1, beats: [] }, releasedAt: performance.now(),
    }
    this.turn = turn
    this.respond(turn, question.trim(), 'text').catch((error: unknown) => this.fail(turn, error))
  }

  close(): void {
    this.interrupt()
    this.deps.ears.close()
    this.deps.mouth.close()
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
      case 'lineScheduled': {
        const line = turn?.lines.get(event.line)
        if (!turn || !line) return
        turn.lines.delete(event.line)
        setTimeout(() => this.draw(turn, line.marks, line.durationMs), event.startsInMs)
        return
      }
      case 'playbackDrained':
        if (turn?.spoken) {
          this.finish(turn)
          this.deps.drawing.answerDone()
        }
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
    await this.respond(turn, question, 'voice')
  }

  private async respond(turn: Turn, question: string, mode: 'voice' | 'text'): Promise<void> {
    if (!question) return
    const history = this.deps.conversations.context()
    turn.recordId = this.deps.conversations.begin(question, mode)
    this.deps.onStatus('Thinking…')
    const display = (await turn.capture)?.displays[0]
    if (turn.abort.signal.aborted) return
    const screenshot = toScreenshot(display)
    if (display) turn.space = { frame: display.frame, pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight }
    const beats = new BeatParser({ width: display?.pixelWidth ?? 0, height: display?.pixelHeight ?? 0 })
    let speech: Promise<void> = Promise.resolve()
    let lineNumber = 0
    let answer = ''
    const save = (): void => this.deps.conversations.update(turn.recordId!, answer.replace(/^@[^\n]*(?:\n|$)/gm, '').trim(), turn.scene, Boolean(display))
    const say = ({ sentence, marks }: Beat): void => {
      if (turn.space && marks.length) turn.scene.beats.push({ sentence, marks, space: turn.space })
      save()
      if (sentence === undefined) {
        // Trailing marks with no sentence of their own draw once speech reaches them.
        speech = speech.then(() => this.draw(turn, marks, 800))
        return
      }
      if (!turn.marks.has('first line')) this.mark(turn, 'first line')
      const line = ++lineNumber
      const words = sentence.split(/\s+/).length
      if (marks.length) turn.lines.set(line, { marks, durationMs: Math.max(800, (words / WORDS_PER_SECOND) * 1000) })
      speech = speech.then(() =>
        turn.abort.signal.aborted
          ? undefined
          : this.deps.mouth.speak(sentence, (pcm) => {
              if (!turn.abort.signal.aborted) this.deps.audio.send({ kind: 'play', line, pcm })
            }),
      )
      // A failed sentence stops the whole turn now, not after the answer streams.
      speech.catch((error: unknown) => this.fail(turn, error))
    }
    for await (const delta of streamAnswer({
      key: this.deps.key,
      question,
      screenshot,
      history,
      signal: turn.abort.signal,
    })) {
      if (!answer) this.mark(turn, 'first token')
      answer += delta
      save()
      beats.push(delta).forEach(say)
    }
    beats.flush().forEach(say)
    await speech
    if (turn.abort.signal.aborted) return
    turn.spoken = true
    this.deps.audio.send({ kind: 'playEnd' })
  }

  /** Stops listening, thinking and speaking for the current turn. */
  private interrupt(): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    if (turn.recordId) this.deps.conversations.finish(turn.recordId, 'interrupted')
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
    if (turn.recordId) this.deps.conversations.finish(turn.recordId, 'complete')
    if (turn.releasedAt !== undefined && turn.marks.size > 0) {
      const timings = [...turn.marks].map(([label, at]) => `${label} ${Math.round(at - turn.releasedAt!)}ms`)
      console.info(`[talk] after release: ${timings.join(', ')}`)
    }
    this.deps.onStatus(undefined)
  }

  private fail(turn: Turn, error: unknown): void {
    if (turn.abort.signal.aborted || this.turn !== turn) return
    console.warn(`[talk] ${error instanceof Error ? error.message : String(error)}`)
    if (turn.recordId) this.deps.conversations.finish(turn.recordId, 'error', error instanceof Error ? error.message : String(error))
    this.interrupt()
    this.deps.onStatus('Something went wrong; see Home')
    setTimeout(() => {
      if (!this.turn) this.deps.onStatus(undefined)
    }, 2_500)
  }

  private draw(turn: Turn, marks: Mark[], durationMs: number): void {
    if (this.turn === turn && turn.space && marks.length) this.deps.drawing.draw(marks, durationMs, turn.space)
  }

  private mark(turn: Turn, label: string): void {
    if (!turn.marks.has(label)) turn.marks.set(label, performance.now())
  }
}

function toScreenshot(display: ScreenCaptures['displays'][number] | undefined): Screenshot | undefined {
  if (!display) return undefined
  return {
    jpeg: display.jpeg,
    width: display.pixelWidth,
    height: display.pixelHeight,
    cursor: display.cursor ?? undefined,
  }
}
