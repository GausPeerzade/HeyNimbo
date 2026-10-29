import { describe, expect, it } from 'vitest'
import { CardScene, layoutFlow, growCard, BADGE_RADIUS, CARD_HEADER, CARD_PADDING, ROW_RHYTHM, objectPoint } from './card-scene'

const cardMark = (id = 'water', x = 50) => ({ kind: 'card' as const, id, x, y: 40, w: 420, h: 180, title: 'Water', board: 'grid' as const })
const measure = (text: string): number => text.length * 12

describe('card scene layout and lifetime', () => {
  it('reserves fixed columns/rhythm, keeps the badge inset and grows down without header intrusion or shrink', () => {
    const scene = new CardScene()
    const card = scene.open(cardMark())!
    const heading = layoutFlow(card, 'heading', 'The journey', measure, 900)!
    const first = layoutFlow(card, 'step', 'Evaporation', measure, 900)!
    const firstSnapshot = structuredClone(first)
    const second = layoutFlow(card, 'step', 'Condensation', measure, 900)!
    expect(heading.y).toBe(card.y + CARD_HEADER + CARD_PADDING)
    expect(first.badge[0] - BADGE_RADIUS).toBe(card.x + CARD_PADDING)
    expect(first.arrow[0]).toBe(card.x + CARD_PADDING + 57)
    expect(first.words[0]).toBe(card.x + CARD_PADDING + 94)
    expect(second.badge[1] - first.badge[1]).toBe(ROW_RHYTHM)
    expect(second.words[1] - first.words[1]).toBe(ROW_RHYTHM)
    expect(second.number).toBe(2)
    expect(first).toEqual(firstSnapshot)
    expect(card.h).toBe(card.cursor + CARD_PADDING)
    const grown = card.h
    expect(growCard(card, 10, 900)).toBe(grown)
    expect(growCard(card, 2000, 900)).toBe(900 - card.y - 2)
  })

  it('shortens instead of shrinking and refuses rows that would spill off the display', () => {
    const card = new CardScene().open(cardMark())!
    const row = layoutFlow(card, 'step', 'A very long explanation with many words to reserve before writing', measure, 240)!
    expect(row.writing.size).toBe(26)
    expect(row.writing.shortened).toBe(true)
    expect(row.writing.lines.at(-1)!.text).toMatch(/…$/)
    const cursor = card.cursor
    expect(layoutFlow(card, 'step', 'No room', measure, 240)).toBeUndefined()
    expect(card.cursor).toBe(cursor)
  })

  it('parents existing ink and pending work once, and closes only its own objects even after overlapping drag', () => {
    const scene = new CardScene()
    const existing = scene.retain([100, 140])
    const a = scene.open(cardMark())!
    const b = scene.open(cardMark('other', 550))!
    const pendingA = scene.retain([200, 160], a)
    const pendingB = scene.retain([600, 160], b)
    const loose = scene.retain([20, 20])
    expect(existing.card).toBe(a)
    a.offset = [500, 20]
    expect(objectPoint(pendingA, pendingA.center)).toEqual([700, 180])
    scene.close('water')
    expect([existing.removed, pendingA.removed, pendingB.removed, loose.removed]).toEqual([true, true, false, false])
    expect(layoutFlow(a, 'note', 'Late arrival', measure, 900)).toBeUndefined()
    expect(scene.open(cardMark())).toBeUndefined()
    scene.clear()
    expect(pendingB.removed).toBe(true)
    expect(scene.cards.size).toBe(0)
  })
})

it('draws the last fitting row, then omits the boundary row and every later row without skipped numbers or overflow', () => {
  const card = new CardScene().open(cardMark())!
  const first = layoutFlow(card, 'step', 'First', measure, 300)!
  const last = layoutFlow(card, 'step', 'Last fitting row', measure, 300)!
  expect(first.number).toBe(1)
  expect(last.number).toBe(2)
  expect(card.y + card.h).toBeLessThanOrEqual(298)
  expect(last.y + last.height + CARD_PADDING).toBeLessThanOrEqual(298)
  const reserved = { cursor: card.cursor, h: card.h }
  expect(layoutFlow(card, 'step', 'Omitted', measure, 300)).toBeUndefined()
  // Even if a later resize would make room, this card never resumes at a skipped row.
  expect(layoutFlow(card, 'step', 'Also omitted', measure, 900)).toBeUndefined()
  expect(card.omittedSteps).toBe(2)
  expect(card.steps).toBe(2)
  expect({ cursor: card.cursor, h: card.h }).toEqual(reserved)
})
