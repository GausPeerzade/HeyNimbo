// The scene protocol (v1). The model writes plain sentences, and drawing
// commands on their own lines starting with "@", placed just before the
// sentence they illustrate:
//
//   @circle 812 344 40
//   That blue Save button saves your work.
//
// Coordinates are screenshot pixels. Commands are parsed and validated, never
// executed, and never spoken.

import { SentenceSplitter } from './sentences'
import { MODEL_LIMITS, ModelRegistry, parseModelCommand, type ModelCommand } from './model-protocol'

export type SemanticColor = 'blue' | 'red' | 'orange' | 'green' | 'purple' | 'grey'
export type StepDirection = 'up' | 'down' | 'left' | 'right'

export type Mark = ModelCommand
  | { kind: 'model'; id: string; x: number; y: number; w: number; h: number; title: string; turntable: boolean }
  | { kind: 'point'; x: number; y: number; label?: string }
  | { kind: 'circle'; x: number; y: number; r: number }
  | { kind: 'box'; x: number; y: number; w: number; h: number }
  | { kind: 'highlight'; x: number; y: number; w: number; h: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'text'; x: number; y: number; text: string }
  /** Part of a circle; angles in degrees, 0 at three o'clock, positive clockwise. */
  | { kind: 'arc'; x: number; y: number; r: number; start: number; sweep: number }
  /** A smooth freehand line through its points, for sketches and icons. */
  | { kind: 'curve'; points: Array<[number, number]> }
  | { kind: 'dot'; x: number; y: number; r: number }
  | { kind: 'card'; id: string; x: number; y: number; w: number; h: number; title: string; board: 'grid' | 'dots' | 'plain' }
  | { kind: 'heading'; id: string; text: string }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'step'; id: string; text: string; direction: StepDirection; color: SemanticColor }
  | { kind: 'label'; x: number; y: number; lx: number; ly: number; text: string }
  | { kind: 'clear' }

/** A sentence to speak, with the marks to draw as it starts. A final beat may
 *  carry marks with no sentence. */
export interface Beat {
  marks: Mark[]
  sentence?: string
}

export interface ImageSize {
  width: number
  height: number
}

const MAX_TEXT = 80
const MAX_CURVE_POINTS = 24
const MAX_DOT_RADIUS = 30

/** Parses one "@command args" line, clamped to the image; undefined if invalid. */
export function parseMark(line: string, image: ImageSize): Mark | undefined {
  const modelCommand = parseModelCommand(line.trim())
  if (modelCommand) return modelCommand
  const cardMark = parseCardMark(line.trim(), image)
  if (cardMark) return cardMark
  const match = /^@(\w+)((?:\s+-?\d+(?:\.\d+)?)*)\s*(?:"([^"]*)")?\s*$/.exec(line.trim())
  if (!match) return undefined
  const [, command = '', numbers = '', quoted] = match
  const n = numbers.trim() ? numbers.trim().split(/\s+/).map(Number) : []
  if (n.some((value) => !Number.isFinite(value))) return undefined
  const x = (value: number): number => clamp(value, 0, image.width)
  const y = (value: number): number => clamp(value, 0, image.height)
  const label = quoted?.trim().slice(0, MAX_TEXT) || undefined
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = n
  const name = command.toLowerCase()
  if (name === 'curve') {
    const count = n.length / 2
    if (!Number.isInteger(count) || count < 2 || count > MAX_CURVE_POINTS || quoted !== undefined) return undefined
    return { kind: 'curve', points: Array.from({ length: count }, (_, i): [number, number] => [x(n[2 * i]!), y(n[2 * i + 1]!)]) }
  }
  const radius = (value: number): number => Math.min(value, Math.max(image.width, image.height))
  switch (`${name}/${n.length}`) {
    case 'point/2':
      return { kind: 'point', x: x(a), y: y(b), ...(label && { label }) }
    case 'circle/3':
      return c > 0 ? { kind: 'circle', x: x(a), y: y(b), r: radius(c) } : undefined
    case 'box/4':
    case 'highlight/4': {
      const left = x(a)
      const top = y(b)
      const w = x(a + c) - left
      const h = y(b + d) - top
      const kind = command.toLowerCase() as 'box' | 'highlight'
      return w > 0 && h > 0 ? { kind, x: left, y: top, w, h } : undefined
    }
    case 'arrow/4':
    case 'line/4':
      return { kind: command.toLowerCase() as 'arrow' | 'line', x1: x(a), y1: y(b), x2: x(c), y2: y(d) }
    case 'text/2':
      return label ? { kind: 'text', x: x(a), y: y(b), text: label } : undefined
    case 'arc/5':
      return c > 0 && e !== 0
        ? { kind: 'arc', x: x(a), y: y(b), r: radius(c), start: d, sweep: clamp(e, -360, 360) }
        : undefined
    case 'dot/3':
      return c > 0 ? { kind: 'dot', x: x(a), y: y(b), r: Math.min(c, MAX_DOT_RADIUS) } : undefined
    case 'clear/0':
      return quoted === undefined ? { kind: 'clear' } : undefined
    default:
      return undefined
  }
}

export const CARD_ID_PATTERN = '[a-z0-9-]{1,16}'
/** CSS-pixel floor after screenshot scaling: room for columns and readable words. */
export const CARD_MIN_OVERLAY_WIDTH = 320
const NUMBER = '-?\\d+(?:\\.\\d+)?'

function parseCardMark(line: string, image: ImageSize): Mark | undefined {
  const textOK = (text: string): boolean => text.trim().length > 0 && Array.from(text).length <= 60
  const card = new RegExp(`^@(card|model) (${CARD_ID_PATTERN}) (${NUMBER}) (${NUMBER}) (${NUMBER}) (${NUMBER}) "([^"\\n]*)"(?: (grid|dots|plain|turntable=true|turntable=false))?$`).exec(line)
  if (card) {
    const [, kind, id, ax, ay, aw, ah, title, board] = card
    if (board && (kind === 'model' ? !board.startsWith('turntable=') : board.startsWith('turntable='))) return undefined
    const [x, y, w, h] = [ax, ay, aw, ah].map(Number) as [number, number, number, number]
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || !textOK(title!)) return undefined
    const width = clamp(w, Math.min(240, image.width), image.width)
    const height = clamp(h, Math.min(180, image.height), image.height)
    const box = { id: id!, x: clamp(x, 0, image.width - width), y: clamp(y, 0, image.height - height), w: width, h: height, title: title!.trim() }
    return kind === 'model' ? { ...box, kind: 'model', turntable: board === 'turntable=true' }
      : { ...box, kind: 'card', board: (board ?? 'grid') as 'grid' | 'dots' | 'plain' }
  }
  const flow = new RegExp(`^@(heading|note|step) (${CARD_ID_PATTERN}) "([^"\\n]*)"(?: (up|down|left|right))?(?: (blue|red|orange|green|purple|grey))?$`).exec(line)
  if (flow) {
    const [, kind, id, text, direction, color] = flow
    if (!textOK(text!) || (kind !== 'step' && (direction || color))) return undefined
    return kind === 'step'
      ? { kind, id: id!, text: text!.trim(), direction: (direction ?? 'down') as StepDirection, color: (color ?? 'blue') as SemanticColor }
      : { kind: kind as 'heading' | 'note', id: id!, text: text!.trim() }
  }
  const label = new RegExp(`^@label (${NUMBER}) (${NUMBER}) (${NUMBER}) (${NUMBER}) "([^"\\n]*)"$`).exec(line)
  if (!label || !textOK(label[5]!)) return undefined
  const [x, y, lx, ly] = label.slice(1, 5).map(Number) as [number, number, number, number]
  if (![x, y, lx, ly].every(Number.isFinite)) return undefined
  return { kind: 'label', x: clamp(x, 0, image.width), y: clamp(y, 0, image.height), lx: clamp(lx, 0, image.width), ly: clamp(ly, 0, image.height), text: label[5]!.trim() }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** Turns a streamed answer into beats. Sentences stream as soon as they end;
 *  a command line waits for its newline and attaches to the next sentence. */
export class BeatParser {
  private readonly splitter = new SentenceSplitter()
  private pendingMarks: Mark[] = []
  private readonly cards = new Map<string, number>()
  private cardCount = 0
  private commandCount = 0
  private modelCommandCount = 0
  private readonly models = new ModelRegistry()
  private atLineStart = true
  private markLine: string | undefined

  constructor(private readonly image: ImageSize) {}

  push(delta: string): Beat[] {
    const beats: Beat[] = []
    let text = ''
    for (const char of delta) {
      if (this.markLine !== undefined) {
        if (char !== '\n') {
          this.markLine += char
          continue
        }
        this.endMarkLine()
        this.atLineStart = true
        continue
      }
      if (this.atLineStart && char === '@') {
        beats.push(...this.sentences(text))
        text = ''
        this.markLine = char
        continue
      }
      if (this.atLineStart && /\S/.test(char)) this.atLineStart = false
      if (char === '\n') this.atLineStart = true
      text += char
    }
    beats.push(...this.sentences(text))
    return beats
  }

  flush(): Beat[] {
    if (this.markLine !== undefined) this.endMarkLine()
    const beats = this.splitter.flush().map((sentence) => this.beat(sentence))
    if (this.pendingMarks.length) beats.push(this.beat())
    return beats
  }

  private sentences(text: string): Beat[] {
    return text ? this.splitter.push(text).map((sentence) => this.beat(sentence)) : []
  }

  private endMarkLine(): void {
    const mark = parseMark(this.markLine ?? '', this.image)
    const modelCommand = mark && ['model', 'part', 'move', 'cut', 'tag'].includes(mark.kind)
    if (mark && (modelCommand ? this.modelCommandCount < MODEL_LIMITS.commands : this.commandCount < 20)) {
      let valid = true
      if (mark.kind === 'card' || mark.kind === 'model') {
        valid = this.cardCount < 3 && !this.cards.has(mark.id)
        if (valid && mark.kind === 'model') valid = this.models.open(mark.id)
        if (valid) { this.cards.set(mark.id, 0); this.cardCount++ }
      } else if (mark.kind === 'part' || mark.kind === 'move' || mark.kind === 'cut' || mark.kind === 'tag') valid = this.models.accept(mark)
      else if (mark.kind === 'step' || mark.kind === 'heading' || mark.kind === 'note') {
        const steps = this.cards.get(mark.id)
        valid = steps !== undefined && !this.models.models.has(mark.id) && (mark.kind !== 'step' || steps < 8)
        if (valid && mark.kind === 'step') this.cards.set(mark.id, steps! + 1)
      } else if (mark.kind === 'clear') { this.cards.clear(); this.models.clear() }
      if (valid) { this.pendingMarks.push(mark); if (modelCommand) this.modelCommandCount++; else this.commandCount++ }
    }
    this.markLine = undefined
  }

  private beat(sentence?: string): Beat {
    const beat: Beat = { marks: this.pendingMarks, ...(sentence !== undefined && { sentence }) }
    this.pendingMarks = []
    return beat
  }
}
