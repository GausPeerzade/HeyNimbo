import type { ScreenCaptures } from '@heynimbo/native'
import { BeatParser, type Beat, type Mark, type TaskProposal } from '../../shared/beats'
import type { VoiceCommand, VoiceEvent } from '../../shared/ipc'
import type { CaptureSpace } from '../overlay-geometry'
import type { DrawingScene, TurnTask } from '../../shared/app'
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
  ears?: Pick<Ears, 'begin' | 'append' | 'finish' | 'cancel' | 'close'>
  mouth?: Pick<Mouth, 'speak' | 'cancel' | 'close'>
  voiceUnavailableReason?: string
  audio: { send(command: VoiceCommand): void }
  capture: () => Promise<ScreenCaptures | undefined>
  /** A label while busy, or undefined to return the notch to rest. */
  onStatus: (label: string | undefined) => void
  /** The display to draw on when no screenshot exists (Screen Recording off or capture failed). */
  canvas?: () => CaptureSpace | undefined
  /** Starts a model-proposed background task in trusted code; absent when tasks are unavailable. */
  startTask?: (task: TaskProposal & { conversationId?: string; signal: AbortSignal }) => Promise<{ runId: string } | { cancelled: true }>
  /** Whether the current connection can run tasks (default: yes when `startTask` exists). */
  tasksAvailable?: () => boolean
  drawing: {
    /** Draws marks given in the capture's screenshot pixels. */
    draw(marks: Mark[], durationMs: number, space: CaptureSpace): void
    /** Builds 3D lines ahead of their sentence; they still draw with it. */
    prepare?(marks: Mark[], space: CaptureSpace): void
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
  /** True only when a real screenshot went to the model. */
  screenUsed?: boolean
  conversationId?: string
}

/** One push-to-talk conversation: listen while held, then transcribe, think and
 *  speak sentence by sentence. A new press interrupts whatever is in flight. */
export class TalkSession {
  private turn: Turn | undefined
  private nextId = 0
  /** Proposals still waiting for the owner's decision; they outlive their answer but not Stop or the next question. */
  private readonly proposals = new Set<AbortController>()
  private errorTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: TalkDeps) {}

  get voiceAvailable(): boolean { return Boolean(this.deps.ears && this.deps.mouth) }
  get voiceUnavailableReason(): string { return this.deps.voiceUnavailableReason ?? 'Voice unavailable. Open Settings → Connection to allow speech recognition or add an OpenAI key.' }

  holdStarted(): void {
    if (!this.voiceAvailable) { this.deps.onStatus(this.voiceUnavailableReason); return }
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
      case 'playbackError':
        if (turn) this.fail(turn, new Error(event.message))
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
    if (!question) { this.finish(turn); this.deps.onStatus("Didn't catch that. Hold Control + Option and try again."); return }
    const history = this.begin(turn, question, 'voice')
    await this.respond(turn, question, history)
  }

  private begin(turn: Turn, question: string, mode: 'voice' | 'text'): Exchange[] {
    const history = this.deps.conversations.context()
    turn.recordId = this.deps.conversations.begin(question, mode, turn.connection ? { provider: turn.connection.provider, model: turn.connection.model } : undefined)
    turn.conversationId = this.deps.conversations.currentId ?? undefined
    this.deps.onStatus('Thinking…')
    return history
  }

  private async respond(turn: Turn, question: string, history: Exchange[]): Promise<void> {
    const display = (await turn.capture)?.displays[0]
    if (turn.abort.signal.aborted) return
    const screenshot = toScreenshot(display)
    // Without a screenshot a vision model can still draw cards, sketches and 3D on the
    // cursor's display; it just cannot see or point at what is there.
    if (display) turn.space = { frame: display.frame, pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight }
    else if (turn.connection?.vision !== false) turn.space = this.deps.canvas?.()
    turn.screenUsed = Boolean(display)
    const canvas = !display && turn.space ? { width: turn.space.pixelWidth, height: turn.space.pixelHeight } : undefined
    const tasks = Boolean(this.deps.startTask) && (this.deps.tasksAvailable?.() ?? true)
    // 3D lines go to the overlay as they arrive, so their geometry is ready when speech reaches them.
    const beats = new BeatParser({ width: turn.space?.pixelWidth ?? 0, height: turn.space?.pixelHeight ?? 0 }, (mark) => {
      if (turn.space && (mark.kind === 'model' || mark.kind === 'part') && !turn.abort.signal.aborted) {
        if (mark.kind === 'part') this.mark(turn, 'first 3D preparation')
        this.deps.drawing.prepare?.([mark], turn.space)
      }
    }, undefined, tasks ? task => this.proposeTask(turn, task) : undefined)
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
            }, line),
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
      ...(canvas ? { canvas } : {}),
      ...(tasks ? { tasks } : {}),
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
    this.deps.conversations.update(turn.recordId, turn.answer, turn.scene, Boolean(turn.screenUsed))
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
    for (const proposal of this.proposals) proposal.abort()
    this.proposals.clear()
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

  /** The model only proposes; main decides (and asks for a folder) before anything runs.
   *  The outcome can arrive after the turn ends, so it is written by turn ID. */
  private proposeTask(turn: Turn, proposal: TaskProposal): void {
    // Parsing (and so proposals) stops at abort and at finish, so only wiring is checked here.
    if (!this.deps.startTask) return
    const task: TurnTask = { goal: proposal.goal, mode: proposal.mode, state: 'starting' }
    turn.scene.tasks = [task]
    turn.dirty = true
    // Bound now, while this turn owns its repository: the outcome may arrive after history settings change.
    const record = turn.recordId ? this.deps.conversations.taskRecorder(turn.recordId) : undefined
    const withdraw = new AbortController()
    this.proposals.add(withdraw)
    const settle = (outcome: Partial<TurnTask>): void => {
      this.proposals.delete(withdraw)
      Object.assign(task, outcome)
      try { record?.([task]) } catch { console.warn('[talk] Could not save the task outcome.') }
    }
    this.deps.startTask({ ...proposal, ...(turn.conversationId ? { conversationId: turn.conversationId } : {}), signal: withdraw.signal }).then(
      result => settle('runId' in result ? { state: 'started', runId: result.runId } : { state: 'failed', error: proposal.mode === 'local' ? 'No folder was chosen.' : 'You cancelled this task.' }),
      (error: unknown) => settle({ state: 'failed', error: error instanceof Error ? error.message.slice(0, 200) : 'The task could not start.' }),
    )
  }

  private draw(turn: Turn, marks: Mark[], durationMs: number): void {
    if (this.turn === turn && turn.space && marks.length) {
      if (marks.some(mark => mark.kind === 'part')) this.mark(turn, 'first 3D draw queued')
      this.deps.drawing.draw(marks, durationMs, turn.space)
    }
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
