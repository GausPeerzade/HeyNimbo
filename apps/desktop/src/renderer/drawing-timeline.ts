import type { Point } from './ink'

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
export const distanceBetween = (from: Point, to: Point): number => Math.hypot(to[0] - from[0], to[1] - from[1])

export function strokeDuration(length: number): number {
  return clamp(0.25 + length / 1400, 0.3, 1.4)
}

/** A beat's drawing budget once it has waited behind earlier beats. A short
 *  floor keeps late marks readable rather than instant. */
export function beatBudget(durationMs: number, waitedMs: number, floorMs = 400): number {
  return Math.max(floorMs, durationMs - Math.max(0, waitedMs))
}

export function flightDuration(from: Point, to: Point): number {
  return clamp(distanceBetween(from, to) / 800, 0.35, 0.9)
}

/** Farza's MIT flight math, adapted to elapsed time and a shallow, capped bow.
 *  See THIRD_PARTY_NOTICES.md. The control offset is twice the visible bow. */
export function sampleFlight(from: Point, to: Point, progress: number): { point: Point; angle: number; scale: number; glow: number } {
  const u = clamp(progress, 0, 1)
  const t = u * u * (3 - 2 * u)
  const offset = Math.min(distanceBetween(from, to) * 0.1, 48) * 2
  const control: Point = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - offset]
  const dx = 2 * (1 - t) * (control[0] - from[0]) + 2 * t * (to[0] - control[0])
  const dy = 2 * (1 - t) * (control[1] - from[1]) + 2 * t * (to[1] - control[1])
  const scale = 1 + 0.3 * Math.sin(Math.PI * u)
  return {
    point: [
      (1 - t) ** 2 * from[0] + 2 * (1 - t) * t * control[0] + t * t * to[0],
      (1 - t) ** 2 * from[1] + 2 * (1 - t) * t * control[1] + t * t * to[1],
    ],
    angle: Math.atan2(dy, dx) * 180 / Math.PI + 90,
    scale, glow: 8 + 20 * (scale - 1),
  }
}

export interface Gesture {
  /** Composite parts have the same group and no artificial gap between them. */
  group: number
  from: Point
  to: Point
  seconds: number
}

export type TimelineEntry =
  | { kind: 'flight'; from: Point; to: Point; startMs: number; durationMs: number }
  | { kind: 'gesture'; index: number; startMs: number; durationMs: number }

/** Front-load natural gestures. Scale travel, ink and gaps together only on
 *  overrun; there is no separate painter floor that can spill beyond the beat. */
export function scheduleBeat(gestures: readonly Gesture[], from: Point, durationMs: number): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let at = 0
  let previousGroup: number | undefined
  for (const [index, gesture] of gestures.entries()) {
    if (previousGroup !== undefined && gesture.group !== previousGroup) at += 30
    if (distanceBetween(from, gesture.from) > 0.01) {
      const travel = flightDuration(from, gesture.from) * 1000
      entries.push({ kind: 'flight', from, to: gesture.from, startMs: at, durationMs: travel })
      at += travel
    }
    const duration = Math.max(0, gesture.seconds * 1000)
    entries.push({ kind: 'gesture', index, startMs: at, durationMs: duration })
    at += duration
    from = gesture.to
    previousGroup = gesture.group
  }
  const scale = at > 0 ? Math.min(1, Math.max(0, durationMs) / at) : 1
  return entries.map((entry) => ({ ...entry, startMs: entry.startMs * scale, durationMs: entry.durationMs * scale }))
}
