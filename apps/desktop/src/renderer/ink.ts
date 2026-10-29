// Hand-drawn stroke paths for the overlay. Each shape becomes one or more pen
// strokes (lists of points) that the overlay reveals over time and outlines
// with perfect-freehand for a tapered, pressure-like line.

import { getStroke, type StrokeOptions } from 'perfect-freehand'
import type { Mark } from '../shared/beats'

export type Point = [number, number]

export interface Stroke {
  points: Point[]
  style: 'pen' | 'marker'
  /** Marker strokes are as thick as the area they highlight. */
  size?: number
}

/** Seeded randomness, so the same mark always wobbles the same way. */
function random(seed: number): () => number {
  let state = Math.floor(seed) >>> 0 || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A slightly bowed line, as a hand draws it. */
function bowed(from: Point, to: Point, rand: () => number): Point[] {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]]
  const length = Math.hypot(dx, dy) || 1
  const bow = (rand() - 0.5) * Math.min(14, length * 0.06)
  const steps = Math.max(8, Math.round(length / 12))
  return Array.from({ length: steps + 1 }, (_, i): Point => {
    const t = i / steps
    const offset = Math.sin(Math.PI * t) * bow
    return [from[0] + dx * t - (dy / length) * offset, from[1] + dy * t + (dx / length) * offset]
  })
}

/** Strokes for a mark, or none for marks that are not ink. */
export function strokesFor(mark: Mark): Stroke[] {
  switch (mark.kind) {
    case 'circle': {
      const rand = random(mark.x * 31 + mark.y * 17 + mark.r)
      const start = rand() * Math.PI * 2
      const tilt = (rand() - 0.5) * 0.4
      const [rx, ry] = [mark.r * 1.08, mark.r * 0.94]
      const sweep = Math.PI * 2 + 0.35 // overshoot past the start, like a real loop
      const steps = 56
      const points = Array.from({ length: steps + 1 }, (_, i): Point => {
        const a = start + (sweep * i) / steps
        const wobble = 1 + Math.sin(a * 3 + start) * 0.03
        const [ex, ey] = [Math.cos(a) * rx * wobble, Math.sin(a) * ry * wobble]
        return [mark.x + ex * Math.cos(tilt) - ey * Math.sin(tilt), mark.y + ex * Math.sin(tilt) + ey * Math.cos(tilt)]
      })
      return [{ points, style: 'pen' }]
    }
    case 'box': {
      const rand = random(mark.x * 13 + mark.y * 7 + mark.w)
      const pad = 4
      const corners: Point[] = [
        [mark.x - pad, mark.y - pad],
        [mark.x + mark.w + pad, mark.y - pad],
        [mark.x + mark.w + pad, mark.y + mark.h + pad],
        [mark.x - pad, mark.y + mark.h + pad],
        [mark.x - pad + 6, mark.y - pad - 2],
      ]
      const points = corners.slice(1).flatMap((corner, i) => bowed(corners[i]!, corner, rand))
      return [{ points, style: 'pen' }]
    }
    case 'line':
      return [{ points: bowed([mark.x1, mark.y1], [mark.x2, mark.y2], random(mark.x1 + mark.y2)), style: 'pen' }]
    case 'arrow': {
      const tip: Point = [mark.x2, mark.y2]
      const angle = Math.atan2(mark.y2 - mark.y1, mark.x2 - mark.x1)
      const head = (side: number): Point => [
        tip[0] - Math.cos(angle + side * 0.5) * 20,
        tip[1] - Math.sin(angle + side * 0.5) * 20,
      ]
      const rand = random(mark.x1 * 3 + mark.y2)
      return [
        { points: bowed([mark.x1, mark.y1], tip, rand), style: 'pen' },
        { points: bowed(head(1), tip, rand), style: 'pen' },
        { points: bowed(tip, head(-1), rand), style: 'pen' },
      ]
    }
    case 'highlight': {
      const y = mark.y + mark.h / 2
      return [{ points: bowed([mark.x, y], [mark.x + mark.w, y], random(mark.x + y)), style: 'marker', size: Math.min(40, mark.h * 0.95) }]
    }
    case 'point':
    case 'text':
    case 'clear':
      return []
  }
}

const PEN: StrokeOptions = {
  size: 6,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.45,
  simulatePressure: true,
  start: { taper: 14 },
  end: { taper: 22 },
}

/** The SVG path for the first `progress` (0..1) of a stroke. */
export function outline(stroke: Stroke, progress: number): string {
  const count = Math.max(2, Math.ceil(stroke.points.length * Math.min(1, progress)))
  const options: StrokeOptions =
    stroke.style === 'pen'
      ? PEN
      : { size: stroke.size ?? 24, thinning: 0, smoothing: 0.5, streamline: 0.3, simulatePressure: false, last: progress >= 1 }
  const polygon = getStroke(stroke.points.slice(0, count), { ...options, last: progress >= 1 })
  if (polygon.length < 2) return ''
  return `M${polygon.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`
}

/** Path length, used to pace drawing like a pen moving at a steady speed. */
export function lengthOf(stroke: Stroke): number {
  return stroke.points.reduce((sum, point, i) => {
    const previous = stroke.points[i - 1]
    return previous ? sum + Math.hypot(point[0] - previous[0], point[1] - previous[1]) : sum
  }, 0)
}
