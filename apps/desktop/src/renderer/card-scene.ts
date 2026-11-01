import type { Mark } from '../shared/beats'
import type { Point } from './ink'
import { wrapWriting, type MeasureText, type WritingLayout } from './handwriting'

export const CARD_HEADER = 28
export const CARD_PADDING = 24
export const ROW_RHYTHM = 80
export const BADGE_RADIUS = 10

export interface CardState {
  id: string
  x: number
  y: number
  w: number
  h: number
  offset: Point
  cursor: number
  steps: number
  omittedSteps: number
  closed: boolean
}
export interface SceneObject {
  center: Point
  originOffset: Point
  card?: CardState
  removed: boolean
}
export interface FlowLayout {
  y: number
  badge: Point
  arrow: Point
  words: Point
  writing: WritingLayout
  number: number
  height: number
}

/** Retained parentage is assigned once, not recomputed when cards overlap on drag. */
export class CardScene {
  readonly cards = new Map<string, CardState>()
  readonly objects = new Set<SceneObject>()

  open(mark: Extract<Mark, { kind: 'card' | 'model' }>): CardState | undefined {
    if (this.cards.size >= 3 || this.cards.has(mark.id)) return undefined
    const card: CardState = { ...mark, offset: [0, 0], cursor: CARD_HEADER + CARD_PADDING, steps: 0, omittedSteps: 0, closed: false }
    this.cards.set(card.id, card)
    for (const object of this.objects) if (!object.card && !object.removed && contains(card, object.center)) object.card = card
    return card
  }

  retain(center: Point, card?: CardState): SceneObject {
    const explicitParent = card !== undefined
    card ??= [...this.cards.values()].filter((card) => !card.closed && contains(card, center)).sort((a, b) => a.w * a.h - b.w * b.h)[0]
    const object: SceneObject = { center, card, originOffset: card && !explicitParent ? [...card.offset] : [0, 0], removed: false }
    this.objects.add(object)
    return object
  }

  close(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    card.closed = true
    for (const object of this.objects) if (object.card === card) object.removed = true
  }

  clear(): void {
    for (const object of this.objects) object.removed = true
    for (const card of this.cards.values()) card.closed = true
    this.cards.clear()
    this.objects.clear()
  }
}

export function contains(card: CardState, [x, y]: Point): boolean {
  return x >= card.x + card.offset[0] && x <= card.x + card.offset[0] + card.w && y >= card.y + card.offset[1] && y <= card.y + card.offset[1] + card.h
}

export function growCard(card: CardState, bottom: number, displayHeight: number): number {
  card.h = Math.max(card.h, Math.min(displayHeight - card.y - card.offset[1] - 2, bottom + CARD_PADDING))
  return card.h
}

/** Reserve a complete slot before any part reveals. Prior slots never move. */
export function layoutFlow(card: CardState, kind: 'heading' | 'step' | 'note', text: string, measure: MeasureText, displayHeight: number): FlowLayout | undefined {
  if (card.closed || (kind === 'step' && card.steps >= 8)) return undefined
  if (kind === 'step' && card.omittedSteps > 0) { card.omittedSteps++; return undefined }
  const size = kind === 'heading' ? 30 : 26
  const x = card.x + CARD_PADDING
  const wordsX = x + (kind === 'step' ? 94 : 0)
  const available = displayHeight - card.y - card.offset[1] - CARD_PADDING - 2 - card.cursor
  const maxLines = Math.min(kind === 'note' ? 3 : 2, Math.floor((available - (kind === 'step' ? 0 : 20)) / (size * 1.3)))
  if (maxLines < 1 || (kind === 'step' && available < ROW_RHYTHM)) {
    if (kind === 'step') card.omittedSteps++
    return undefined
  }
  const writing = wrapWriting(text, card.x + card.w - CARD_PADDING - wordsX, size, measure, maxLines)
  const height = kind === 'step' ? ROW_RHYTHM : writing.lines.length * writing.lineHeight + 20
  if (height > available) return undefined
  const y = card.y + card.cursor
  card.cursor += height
  if (kind === 'step') card.steps++
  growCard(card, card.cursor, displayHeight)
  return { y, badge: [x + BADGE_RADIUS, y + 20], arrow: [x + 57, y + 20], words: [wordsX, y + size], writing, number: card.steps, height }
}

export function objectPoint(object: SceneObject | undefined, point: Point): Point {
  const offset = object?.card?.offset ?? [0, 0]
  return [point[0] + offset[0]! - (object?.originOffset[0] ?? 0), point[1] + offset[1]! - (object?.originOffset[1] ?? 0)]
}

export function markCenter(mark: Mark): Point | undefined {
  if (['part', 'move', 'cut', 'tag', 'remove'].includes(mark.kind) || mark.kind === 'clear' || mark.kind === 'heading' || mark.kind === 'note' || mark.kind === 'step') return undefined
  if (mark.kind === 'line' || mark.kind === 'arrow') return [(mark.x1 + mark.x2) / 2, (mark.y1 + mark.y2) / 2]
  if (mark.kind === 'curve') return [mark.points.reduce((sum, p) => sum + p[0], 0) / mark.points.length, mark.points.reduce((sum, p) => sum + p[1], 0) / mark.points.length]
  if (mark.kind === 'part' || mark.kind === 'move' || mark.kind === 'cut' || mark.kind === 'tag' || mark.kind === 'remove') return undefined
  if (mark.kind === 'box' || mark.kind === 'highlight' || mark.kind === 'card' || mark.kind === 'model') return [mark.x + mark.w / 2, mark.y + mark.h / 2]
  return [mark.x, mark.y]
}
