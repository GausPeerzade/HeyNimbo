import type { ScreenCaptures } from '@heynimbo/native'
import { BeatParser, type Beat, type Mark } from '../../shared/beats'
import type { VoiceCommand, VoiceEvent } from '../../shared/ipc'
import type { CaptureSpace } from '../overlay-geometry'
import type { DrawingScene } from '../../shared/app'
import type { ConversationController } from '../conversations'
import { AGENT_INSTRUCTIONS, INSTRUCTIONS, turnNote, type Exchange, type Screenshot } from './brain'
import type { NimboAgent } from '../agent/engine'
import type { designModel } from '../agent/designer'
import type { AnswerConnection } from '../answer-provider'
import type { Ears } from './ears'
import { OPENAI_KEY_REJECTED } from '../openai/realtime'
import { KEY_REJECTED } from '../model-catalog'
import { contains, readPointing, toPixels, type Point, type Rect } from '../../shared/focus'
import type { Mouth } from './mouth'

const MIC_STOP_TIMEOUT_MS = 1_500
const SAVE_INTERVAL_MS = 250
/** Designed parts are revealed in batches this often, each batch growing over twice as long. */
const DESIGN_BATCH_MS = 300
const FOCUS_WAIT_MS = 1_500
/** How long a polish pass waits for its card to be shown before giving up. */
const SNAPSHOT_WAIT_MS = 60_000
/** Declared beat budget while sentence PCM is still streaming. Drawing uses
 *  natural durations unless it would overrun this speech estimate. */
const WORDS_PER_SECOND = 2.6

export interface TalkDeps {
  agent: Pick<NimboAgent, 'answer'>
  /** Builds a 3D card's model in its own request while the answer speaks; absent means no 3D detail. */
  design?: typeof designModel
  answer?: () => AnswerConnection
  conversations: ConversationController
  ears?: Pick<Ears, 'begin' | 'append' | 'finish' | 'cancel' | 'close'>
  mouth?: Pick<Mouth, 'speak' | 'cancel' | 'close'>
  voiceUnavailableReason?: string
  audio: { send(command: VoiceCommand): void }
  capture: () => Promise<ScreenCaptures | undefined>
  /** OpenAI rejected the voice key; the next turn should use the Mac's own speech. */
  onVoiceKeyRejected?: () => void
  /** A label while busy, or undefined to return the notch to rest. */
  onStatus: (label: string | undefined) => void
  /** The display to draw on when no screenshot exists (Screen Recording off or capture failed). */
  canvas?: () => CaptureSpace | undefined
  /** The cursor's path during the last hold (global points), and a full-resolution close-up of a region. */
  pointing?: { trail: () => Point[]; closeUp: (region: Rect) => Promise<Buffer | undefined>; captureAt: (point: Point) => Promise<ScreenCaptures | undefined> }
  drawing: {
    /** Draws marks given in the capture's screenshot pixels. */
    draw(marks: Mark[], durationMs: number, space: CaptureSpace): void
    /** Builds 3D lines ahead of their sentence; they still draw with it. */
    prepare?(marks: Mark[], space: CaptureSpace): void
    /** A JPEG of a 3D card's model as drawn now, for the designer's polish pass. */
    snapshot?(id: string, space: CaptureSpace): Promise<Buffer | undefined>
    /** The answer is over; offer to clear the drawing. */
    answerDone(): void
  }
}

interface Turn {
  readonly id: number
  readonly abort: AbortController
  readonly connection?: AnswerConnection
  /** Replaced on release when the owner pointed at another display. */
  capture: Promise<ScreenCaptures | undefined>
  readonly marks: Map<string, number>
  releasedAt?: number
  micStopped?: () => void
  /** What the owner circled or underlined while asking, or where they moved the pointer, in screenshot pixels. */
  focus?: Promise<Pick<Screenshot, 'focus' | 'cursor'>>
  spoken: boolean
  recordId?: string
  scene: DrawingScene
  answer: string
  dirty: boolean
  saveTimer?: NodeJS.Timeout
  /** Marks waiting for their sentence's audio to start, by line number. */
  readonly lines: Map<number, { marks: Mark[]; durationMs: number }>
  space?: CaptureSpace
  /** 3D designs streaming for this turn; the turn stays open until they finish. */
  designs: Array<Promise<void>>
  /** Designed parts per 3D card, held until the card itself is on screen. */
  held: Map<string, Mark[]>
  shown: Set<string>
  /** True only when a real screenshot went to the model. */
  screenUsed?: boolean
  conversationId?: string
}

/** One push-to-talk conversation: listen while held, then transcribe, think and
 *  speak sentence by sentence. A new press interrupts whatever is in flight. */
export class TalkSession {
  private turn: Turn | undefined
  private nextId = 0
  /** The last finished turn, while its 3D models may still be polishing; the next question stops it. */
  private polishing: Turn | undefined
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
      lines: new Map(), designs: [], held: new Map(), shown: new Set(),
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
      spoken: false, lines: new Map(), scene: { version: 1, beats: [] }, answer: '', dirty: false, releasedAt: performance.now(), designs: [], held: new Map(), shown: new Set(),
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
    const trail = this.deps.pointing?.trail() ?? [], end = trail[trail.length - 1]
    // Pointing on another display than the one captured at the start: that display is the one asked about.
    if (end) turn.capture = turn.capture.then(async captures => {
      const frame = captures?.displays[0]?.frame
      return frame && !contains(frame, end) && !turn.abort.signal.aborted ? (await this.deps.pointing!.captureAt(end)) ?? captures : captures
    })
    turn.focus = this.pointedAt(turn, trail)
    const micStopped = new Promise<void>((resolve) => {
      turn.micStopped = resolve
      setTimeout(resolve, MIC_STOP_TIMEOUT_MS)
    })
    this.deps.audio.send({ kind: 'micStop' })
    this.answer(turn, micStopped).catch((error: unknown) => this.fail(turn, error))
  }

  /** What the pointer did during the hold: an area it marked, with a close-up taken while speech is
   *  still being transcribed, or else where it ended up, which is where the owner is pointing now. */
  private async pointedAt(turn: Turn, trail: Point[]): Promise<Pick<Screenshot, 'focus' | 'cursor'>> {
    const display = (await turn.capture)?.displays[0]
    if (!display || turn.abort.signal.aborted) return {}
    const { region, pointer } = readPointing(trail, display.frame)
    if (region || pointer) console.info(`[pointing] ${region ? `area ${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.width)}x${Math.round(region.height)}` : `pointer ${Math.round(pointer!.x)},${Math.round(pointer!.y)}`}`)
    const pixels = (area: Rect): Rect => toPixels(area, display.frame, display.pixelWidth, display.pixelHeight)
    const cursor = pointer && pixels({ ...pointer, width: 0, height: 0 })
    const moved = cursor ? { cursor: { x: cursor.x, y: cursor.y } } : {}
    if (!region) return moved
    // The area is known now; only its optional close-up is waited for, and not for long.
    const jpeg = await Promise.race([this.deps.pointing!.closeUp(region), new Promise<undefined>(resolve => setTimeout(resolve, FOCUS_WAIT_MS))])
    if (jpeg) this.mark(turn, 'close-up')
    return { ...moved, focus: { ...pixels(region), ...(jpeg && { jpeg }) } }
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
    // Ready by now as a rule: the close-up is taken while the words are transcribed, and its wait is bounded.
    const pointed = screenshot && await turn.focus
    if (turn.abort.signal.aborted) return
    if (screenshot && pointed) Object.assign(screenshot, pointed)
    // Without a screenshot a vision model can still draw cards, sketches and 3D on the
    // cursor's display; it just cannot see or point at what is there.
    if (display) turn.space = { frame: display.frame, pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight }
    else if (turn.connection?.vision !== false) turn.space = this.deps.canvas?.()
    turn.screenUsed = Boolean(display)
    const canvas = !display && turn.space ? { width: turn.space.pixelWidth, height: turn.space.pixelHeight } : undefined
    // 3D lines go to the overlay as they arrive, so their geometry is ready when speech reaches them.
    const beats = new BeatParser({ width: turn.space?.pixelWidth ?? 0, height: turn.space?.pixelHeight ?? 0 }, (mark) => {
      if (turn.space && (mark.kind === 'model' || mark.kind === 'part') && !turn.abort.signal.aborted) {
        if (mark.kind === 'part') this.mark(turn, 'first 3D preparation')
        this.deps.drawing.prepare?.([mark], turn.space)
        if (mark.kind === 'model') this.design(turn, mark, question)
      }
    })
    let speech: Promise<void> = Promise.resolve()
    let lineNumber = 0
    let answer = ''
    const save = (): void => {
      turn.answer = answer.replace(/^@[^\n]*(?:\n|$)/gm, '').replace(/\n{2,}/g, '\n').trim()
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
    if (!turn.connection) throw new Error('Add a key for the selected answer provider in Settings → Connection.')
    const vision = turn.connection.vision !== false
    for await (const delta of this.deps.agent.answer({
      conversationId: turn.conversationId ?? `turn-${turn.id}`,
      connection: turn.connection,
      instructions: INSTRUCTIONS + AGENT_INSTRUCTIONS,
      question,
      note: turnNote(screenshot, canvas, vision),
      screenshot,
      history,
      signal: turn.abort.signal,
      onStep: steps => {
        if (turn.abort.signal.aborted) return
        turn.scene.steps = steps
        save()
        const running = steps.findLast(step => step.state === 'running')
        this.deps.onStatus(running ? `${running.label.slice(0, 60)}…` : 'Thinking…')
      },
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
    // A model still building keeps the answer open, so Stop still ends it and the drawing isn't offered to clear.
    await Promise.allSettled(turn.designs)
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
    for (const step of turn.scene.steps ?? []) if (step.state === 'running') { step.state = 'stopped'; turn.dirty = true }
    try { this.flush(turn) }
    catch { console.warn('[talk] Could not save the latest answer.') }
    try { if (turn.recordId) this.deps.conversations.finish(turn.recordId, state, error) }
    catch { console.warn('[talk] Could not save the turn state.') }
  }

  /** Persistence must never prevent microphone, network or speech cleanup. */
  /** Stops a finished answer's 3D polish, as when its drawing is cleared. */
  stopPolish(): void {
    this.polishing?.abort.abort(); this.polishing = undefined
  }

  private interrupt(state: 'interrupted' | 'error' = 'interrupted', error: string | null = null): void {
    this.stopPolish()
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
    this.polishing = turn
    this.saveOutcome(turn, 'complete')
    if (turn.releasedAt !== undefined && turn.marks.size > 0) {
      const timings = [...turn.marks].map(([label, at]) => `${label} ${Math.round(at - turn.releasedAt!)}ms`)
      console.info(`[talk] after release: ${timings.join(', ')}`)
    }
    this.deps.onStatus(undefined)
  }

  private fail(turn: Turn, error: unknown): void {
    if (turn.abort.signal.aborted || this.turn !== turn) return
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[talk] ${message}`)
    if (message === OPENAI_KEY_REJECTED) this.deps.onVoiceKeyRejected?.()
    this.interrupt('error', message)
    // Say it in the notch when Home has nothing to show (failed while listening) or the owner must fix a key.
    const direct = !turn.recordId || message === KEY_REJECTED || message === OPENAI_KEY_REJECTED
    this.deps.onStatus(direct ? message : 'Something went wrong; see Home')
    clearTimeout(this.errorTimer)
    this.errorTimer = setTimeout(() => {
      if (!this.turn) this.deps.onStatus(undefined)
    }, direct ? 6_000 : 2_500)
  }

  private draw(turn: Turn, marks: Mark[], durationMs: number): void {
    // A finished turn still draws its polish, until the next question stops it.
    const live = this.turn === turn || (this.polishing === turn && !turn.abort.signal.aborted)
    if (live && turn.space && marks.length) {
      if (marks.some(mark => mark.kind === 'part')) this.mark(turn, 'first 3D draw queued')
      this.deps.drawing.draw(marks, durationMs, turn.space)
      // Parts designed before their card appeared follow it on.
      for (const mark of marks) if (mark.kind === 'model') { turn.shown.add(mark.id); this.release(turn, mark.id) }
    }
  }

  /** Streams a 3D card's model from the designer: each part is prepared on arrival and revealed in
   *  short batches once the card is on screen, so the model assembles while the answer speaks. */
  private design(turn: Turn, card: Extract<Mark, { kind: 'model' }>, question: string): void {
    const connection = turn.connection
    if (!this.deps.design || !connection || !turn.space) return
    const space = turn.space
    let timer: NodeJS.Timeout | undefined, built!: () => void
    // The answer waits for the first build only; the polish pass carries on after it.
    turn.designs.push(new Promise<void>(resolve => { built = resolve }))
    const flush = (): void => { clearTimeout(timer); timer = undefined; this.release(turn, card.id) }
    // The card appears when speech reaches it, which may be after the first build is done; the overlay then waits for the parts to grow.
    const snapshot = this.deps.drawing.snapshot && (async () => {
      for (const deadline = Date.now() + SNAPSHOT_WAIT_MS; !turn.shown.has(card.id) || turn.held.get(card.id)?.length;) {
        if (turn.abort.signal.aborted || Date.now() > deadline) return undefined
        await new Promise(resolve => setTimeout(resolve, DESIGN_BATCH_MS))
      }
      return this.deps.drawing.snapshot!(card.id, space)
    })
    void (async () => {
      for await (const batch of this.deps.design!({ connection, id: card.id, title: card.brief ?? card.title, question, signal: turn.abort.signal, ...(snapshot && { snapshot }), onBuilt: () => { flush(); built() } })) {
        if (turn.abort.signal.aborted) return
        if (batch.some(mark => mark.kind === 'part')) this.mark(turn, 'first designed part')
        this.deps.drawing.prepare?.(batch, space)
        turn.held.set(card.id, [...turn.held.get(card.id) ?? [], ...batch])
        timer ??= setTimeout(() => { timer = undefined; this.release(turn, card.id) }, DESIGN_BATCH_MS)
      }
    })().catch((error: unknown) => console.warn(`[design] ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        flush(); built()
        // Polish drawn after the answer ended hides its Clear button and stops the fade: offer them again.
        if (this.polishing === turn && !turn.abort.signal.aborted) this.deps.drawing.answerDone()
      })
  }

  private release(turn: Turn, id: string): void {
    const held = turn.held.get(id)
    if (!held?.length || !turn.shown.has(id)) return
    turn.held.delete(id)
    this.draw(turn, held, DESIGN_BATCH_MS * 2)
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
