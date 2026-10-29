// Stable stroke geometry for screen ink. The full outline is built once;
// the renderer reveals it along the very same measured centerline.

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
  const bow = (rand() - 0.5) * Math.min(2, length * 0.03)
  const steps = Math.max(8, Math.round(length / 12))
  return Array.from({ length: steps + 1 }, (_, i): Point => {
    if (i === 0) return from
    if (i === steps) return to
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
        { points: [...bowed(head(1), tip, rand), ...bowed(tip, head(-1), rand).slice(1)], style: 'pen' },
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

export interface MeasuredPath {
  points: Point[]
  distances: number[]
  length: number
}

export interface StrokeGeometry extends MeasuredPath {
  centerline: string
  outline: string
  width: number
  style: Stroke['style']
}

export function measurePath(points: Point[]): MeasuredPath {
  const distances = [0]
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!
    const point = points[i]!
    distances.push(distances[i - 1]! + Math.hypot(point[0] - previous[0], point[1] - previous[1]))
  }
  return { points, distances, length: distances.at(-1) ?? 0 }
}

/** One arc-length lookup drives both the mask and the pen tip. */
export function samplePath(path: MeasuredPath, progress: number): { point: Point; angle: number } {
  const distance = Math.max(0, Math.min(1, progress)) * path.length
  let low = 1
  let high = path.distances.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (path.distances[middle]! < distance) low = middle + 1
    else high = middle
  }
  const from = path.points[low - 1] ?? path.points[0] ?? [0, 0]
  const to = path.points[low] ?? from
  const span = (path.distances[low] ?? 0) - (path.distances[low - 1] ?? 0)
  const t = span > 0 ? (distance - path.distances[low - 1]!) / span : 0
  return {
    point: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t],
    angle: Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI + 90,
  }
}

export function geometryFor(stroke: Stroke): StrokeGeometry {
  const width = stroke.style === 'pen' ? 3.5 : stroke.size ?? 24
  const options: StrokeOptions = {
    size: width, thinning: 0, smoothing: 0, streamline: 0,
    simulatePressure: false, last: true,
  }
  const polygon = getStroke(stroke.points, options)
  const coordinates = (points: number[][]): string => points.map(([x, y]) => `${x} ${y}`).join('L')
  return {
    ...measurePath(stroke.points), width, style: stroke.style,
    centerline: `M${coordinates(stroke.points)}`,
    outline: polygon.length > 1 ? `M${coordinates(polygon)}Z` : '',
  }
}
