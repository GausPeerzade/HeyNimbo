import { describe, expect, it } from 'vitest'
import { readPointing, toPixels, type Point } from './focus'

// A second display to the right of a 1440×900 one: gestures are judged in global points.
const frame = { x: 1440, y: 0, width: 1512, height: 982 }
const circle = (cx: number, cy: number, r: number, turns = 1.08): Point[] => Array.from({ length: 61 }, (_, i) => {
  const t = i / 60 * turns * 2 * Math.PI - Math.PI / 2
  return { x: cx + r * 1.3 * Math.cos(t), y: cy + r * Math.sin(t) }
})
const line = (x1: number, y1: number, x2: number, y2: number, n = 20): Point[] => Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + (x2 - x1) * i / n, y: y1 + (y2 - y1) * i / n + (i % 2) }))

describe('readPointing', () => {
  it('reads a circle as the area it encloses, leaving out the way the pointer came', () => {
    // The hand comes up from the bottom of the screen, then circles something.
    const { region } = readPointing([...line(2100, 900, 1800, 300), ...circle(1800, 400, 100)], frame)
    expect(region!.x).toBeGreaterThan(1600); expect(region!.x + region!.width).toBeLessThan(2000)
    expect(region!.y).toBeGreaterThan(260); expect(region!.y + region!.height).toBeLessThan(540)
  })

  it('leaves out a short way over that ends right at the circle', () => {
    // From the right straight onto the circle's rightmost point, then once around it.
    const around = Array.from({ length: 61 }, (_, i) => ({ x: 1800 + 100 * Math.cos(i / 60 * 2 * Math.PI), y: 400 + 100 * Math.sin(i / 60 * 2 * Math.PI) }))
    const { region } = readPointing([...line(2000, 400, 1900, 400, 10), ...around], frame)
    expect(region!.x + region!.width).toBeLessThan(1930)
  })

  it('reads a long smooth scribble quickly', () => {
    // Narrow ellipses drawn over and over: many nearly closed stretches, none of them a loop.
    const scribble = Array.from({ length: 4000 }, (_, i) => ({ x: 2000 + 300 * Math.cos(i / 25), y: 400 + 4 * Math.sin(i / 25) }))
    const started = performance.now()
    readPointing(scribble, frame)
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('reads a flat last stroke as an underline, reaching up to the text above it', () => {
    const { region } = readPointing([...line(2100, 900, 1600, 500), ...line(1600, 500, 1900, 500)], frame)
    expect(region!.x).toBeGreaterThan(1590); expect(region!.x).toBeLessThan(1615); expect(region!.x + region!.width).toBeCloseTo(1900, 0)
    expect(region!.y).toBeLessThan(470); expect(region!.y + region!.height).toBeLessThan(515)
  })

  it('does not mistake the way over and an underline back along it for a loop', () => {
    // Recorded live: the pointer jumps from below to the start of a line of text, then underlines it.
    const { region } = readPointing([{ x: 2140, y: 780 }, ...line(1506, 611, 1985, 611)], frame)
    expect(region!.x).toBeGreaterThan(1495); expect(region!.y + region!.height).toBeLessThan(630)
  })

  it('reads a plain move as pointing, not marking an area', () => {
    expect(readPointing(line(2100, 900, 1700, 300), frame)).toEqual({ pointer: { x: 1700, y: 300 } })
  })

  it('keeps where the pointer ended when it jumped over from another display', () => {
    expect(readPointing([{ x: 1400, y: 400 }, { x: 1500, y: 400 }], frame)).toEqual({ pointer: { x: 1500, y: 400 } })
  })

  it('ignores a hand resting on the mouse, a path over the whole screen, and other displays', () => {
    expect(readPointing(circle(1800, 400, 8), frame)).toEqual({})
    expect(readPointing(circle(2196, 491, 600), frame).region).toBeUndefined()
    expect(readPointing(circle(700, 400, 100), frame)).toEqual({})
  })

  it('keeps a circle at the edge inside the display', () => {
    // The screen's edge stops the pointer, so a circle around a corner runs along it.
    const { region } = readPointing(circle(1460, 30, 60).map(p => ({ x: Math.max(frame.x, p.x), y: Math.max(0, p.y) })), frame)
    expect(region!.x).toBe(1440); expect(region!.y).toBe(0)
  })
})

describe('toPixels', () => {
  it('maps global points into the screenshot, clamped to its size', () => {
    expect(toPixels({ x: 1440 + 756, y: 491, width: 2000, height: 100 }, frame, 1280, 831)).toEqual({ x: 640, y: 416, width: 640, height: 85 })
  })
})
