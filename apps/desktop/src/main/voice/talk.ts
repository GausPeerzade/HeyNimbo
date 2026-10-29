import type { ScreenCaptures } from '@nimboguide/native'
import { BeatParser, type Beat, type Mark } from '../../shared/beats'
import type { VoiceCommand, VoiceEvent } from '../../shared/ipc'
import type { CaptureSpace } from '../overlay-geometry'
import type { DrawingScene } from '../../shared/app'
import type { ConversationController } from '../conversations'
import { streamAnswer, type Exchange, type Screenshot } from './brain'
import type { AnswerConnection } from '../answer-provider'
import type { Ears } from './ears'
import type { Mouth } from './mouth'

const MIC_STOP_TIMEOUT_MS = 1_500
const SAVE_INTERVAL_MS = 250
/** Declared beat budget while sentence PCM is still streaming. Drawing uses
 *  natural durations unless it would overrun this speech estimate. */
const WORDS_PER_SECOND = 2.6

export interface TalkDeps {
  key?: string
  answer?: () => AnswerConnection
  conversations: ConversationController
  ears?: Ears
  mouth?: Mouth
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
  readonly connection?: AnswerConnection
  readonly capture: Promise<ScreenCaptures | undefined>
  readonly marks: Map<string, number>
  releasedAt?: number
  micStopped?: () => void
  spoken: boolean
  recordId?: string
  scene: DrawingScene
  answer: string
  dirty: boolean
  saveTimer?: NodeJS.Timeout
  /** Marks waiting for their sentence's audio to start, by line number. */
  readonly lines: Map<number, { marks: Mark[]; durationMs: number }>
  space?: CaptureSpace
}

/** One push-to-talk conversation: listen while held, then transcribe, think and
 *  speak sentence by sentence. A new press interrupts whatever is in flight. */
export class TalkSession {
  private turn: Turn | undefined
  private nextId = 0
  private errorTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: TalkDeps) {}

  get voiceAvailable(): boolean { return Boolean(this.deps.ears && this.deps.mouth) }

  holdStarted(): void {
    if (!this.voiceAvailable) { this.deps.onStatus('Voice unavailable: add an OpenAI key in Settings → Connection. ChatGPT plans support answers only.'); return }
    this.interrupt()
    this.deps.ears!.begin()
    const connection = this.deps.answer?.()
    const id = ++this.nextId
    this.turn = {
      id,
      abort: new AbortController(),
      connection, capture: connection?.vision === false ? Promise.resolve(undefined) : this.deps.capture(),
      marks: new Map(),
      spoken: false,
      scene: { version: 1, beats: [] }, answer: '', dirty: false,
      lines: new Map(),
    }
    this.deps.audio.send({ kind: 'micStart', id })
    this.deps.onStatus('Listening…')
  }

  askText(question: string): { accepted: true } {
    if (!question.trim()) throw new Error('Enter a question.')
    this.holdCancelled()
    const connection = this.deps.answer?.()
    const turn: Turn = {
      id: ++this.nextId, abort: new AbortController(), connection, capture: connection?.vision === false ? Promise.resolve(undefined) : this.deps.capture(), marks: new Map(),
      spoken: false, lines: new Map(), scene: { version: 1, beats: [] }, answer: '', dirty: false, releasedAt: performance.now(),
    }
    this.turn = turn
    try {
      const history = this.begin(turn, question.trim(), 'text')
      void this.respond(turn, question.trim(), history).catch((error: unknown) => this.fail(turn, error))
      return { accepted: true }
    } catch (error) {
      this.fail(turn, error)
      throw error
    }
  }

  close(): void {
    clearTimeout(this.errorTimer)
    try { this.holdCancelled() }
    finally {
      try { this.deps.ears?.close() }
      finally { this.deps.mouth?.close() }
    }
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
    try { this.interrupt() }
    finally { this.deps.onStatus(undefined) }
  }

  onAudioEvent(event: VoiceEvent): void {
    const turn = this.turn
    switch (event.kind) {
      case 'micChunk':
        if (turn?.id === event.id && !turn.abort.signal.aborted) this.deps.ears?.append(event.pcm)
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
    const question = await this.deps.ears!.finish()
    this.mark(turn, 'transcript')
    if (turn.abort.signal.aborted) return
    if (!question) return this.finish(turn)
    const history = this.begin(turn, question, 'voice')
    await this.respond(turn, question, history)
  }

  private begin(turn: Turn, question: string, mode: 'voice' | 'text'): Exchange[] {
    const history = this.deps.conversations.context()
    turn.recordId = this.deps.conversations.begin(question, mode, turn.connection ? { provider: turn.connection.provider, model: turn.connection.model } : undefined)
    this.deps.onStatus('Thinking…')
    return history
  }

  private async respond(turn: Turn, question: string, history: Exchange[]): Promise<void> {
    const display = (await turn.capture)?.displays[0]
    if (turn.abort.signal.aborted) return
    const screenshot = toScreenshot(display)
    if (display) turn.space = { frame: display.frame, pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight }
    const beats = new BeatParser({ width: display?.pixelWidth ?? 0, height: display?.pixelHeight ?? 0 })
    let speech: Promise<void> = Promise.resolve()
    let lineNumber = 0
    let answer = ''
    const save = (): void => {
      turn.answer = answer.replace(/^@[^\n]*(?:\n|$)/gm, '').trim()
      turn.dirty = true
      turn.saveTimer ??= setTimeout(() => {
        try { this.flush(turn) } catch (error) { this.fail(turn, error) }
      }, SAVE_INTERVAL_MS)
    }
    const say = ({ sentence, marks }: Beat): void => {
      if (turn.space && marks.length) turn.scene.beats.push({ sentence, marks, space: turn.space })
      save()
      if (!this.deps.mouth) { this.draw(turn, marks, 800); return }
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
          : this.deps.mouth!.speak(sentence, (pcm) => {
              if (!turn.abort.signal.aborted) this.deps.audio.send({ kind: 'play', line, pcm })
            }),
      )
      // A failed sentence stops the whole turn now, not after the answer streams.
      speech.catch((error: unknown) => this.fail(turn, error))
    }
    for await (const delta of streamAnswer({
      key: this.deps.key,
      connection: turn.connection,
      question,
      screenshot,
      history,
      signal: turn.abort.signal,
    })) {
      if (turn.abort.signal.aborted) break
      if (!answer) this.mark(turn, 'first token')
      answer += delta
      save()
      beats.push(delta).forEach(say)
    }
    if (turn.abort.signal.aborted) return
    beats.flush().forEach(say)
    this.flush(turn)
    await speech
    if (turn.abort.signal.aborted) return
    if (!this.deps.mouth) { this.finish(turn); this.deps.drawing.answerDone(); return }
    turn.spoken = true
    this.deps.audio.send({ kind: 'playEnd' })
  }

  private flush(turn: Turn): void {
    clearTimeout(turn.saveTimer); turn.saveTimer = undefined
    if (!turn.dirty || !turn.recordId) return
    this.deps.conversations.update(turn.recordId, turn.answer, turn.scene, Boolean(turn.space))
    turn.dirty = false
  }

  private saveOutcome(turn: Turn, state: 'complete' | 'interrupted' | 'error', error: string | null = null): void {
    try { this.flush(turn) }
    catch { console.warn('[talk] Could not save the latest answer.') }
    try { if (turn.recordId) this.deps.conversations.finish(turn.recordId, state, error) }
    catch { console.warn('[talk] Could not save the turn state.') }
  }

  /** Persistence must never prevent microphone, network or speech cleanup. */
  private interrupt(state: 'interrupted' | 'error' = 'interrupted', error: string | null = null): void {
    const turn = this.turn
    if (!turn) return
    this.turn = undefined
    try { this.saveOutcome(turn, state, error) }
    finally {
      turn.abort.abort()
      turn.micStopped?.()
      try { this.deps.ears?.cancel() }
      finally {
        try { this.deps.mouth?.cancel() }
        finally {
          try { this.deps.audio.send({ kind: 'micStop' }) }
          finally { this.deps.audio.send({ kind: 'playCancel' }) }
        }
      }
    }
  }

  private finish(turn: Turn): void {
    if (this.turn !== turn) return
    this.turn = undefined
    this.saveOutcome(turn, 'complete')
    if (turn.releasedAt !== undefined && turn.marks.size > 0) {
      const timings = [...turn.marks].map(([label, at]) => `${label} ${Math.round(at - turn.releasedAt!)}ms`)
      console.info(`[talk] after release: ${timings.join(', ')}`)
    }
    this.deps.onStatus(undefined)
  }

  private fail(turn: Turn, error: unknown): void {
    if (turn.abort.signal.aborted || this.turn !== turn) return
    console.warn(`[talk] ${error instanceof Error ? error.message : String(error)}`)
    this.interrupt('error', error instanceof Error ? error.message : String(error))
    this.deps.onStatus('Something went wrong; see Home')
    clearTimeout(this.errorTimer)
    this.errorTimer = setTimeout(() => {
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
