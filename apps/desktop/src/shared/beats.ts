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

export type Mark =
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
  const match = /^@(\w+)((?:\s+-?\d+(?:\.\d+)?)*)\s*(?:"([^"]*)")?\s*$/.exec(line.trim())
  if (!match) return undefined
  const [, command = '', numbers = '', quoted] = match
  const n = numbers.trim() ? numbers.trim().split(/\s+/).map(Number) : []
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

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** Turns a streamed answer into beats. Sentences stream as soon as they end;
 *  a command line waits for its newline and attaches to the next sentence. */
export class BeatParser {
  private readonly splitter = new SentenceSplitter()
  private pendingMarks: Mark[] = []
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
    if (mark) this.pendingMarks.push(mark)
    this.markLine = undefined
  }

  private beat(sentence?: string): Beat {
    const beat: Beat = { marks: this.pendingMarks, ...(sentence !== undefined && { sentence }) }
    this.pendingMarks = []
    return beat
  }
}
