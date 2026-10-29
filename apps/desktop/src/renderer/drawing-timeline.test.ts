import { describe, expect, it } from 'vitest'
import { flightDuration, sampleFlight, scheduleBeat, strokeDuration, type Gesture } from './drawing-timeline'

const line = (group: number, from: [number, number], to: [number, number]): Gesture => ({
  group, from, to, seconds: strokeDuration(Math.hypot(to[0] - from[0], to[1] - from[1])),
})

describe('strokeDuration', () => {
  it('uses the base plus distance, with readable minimum and maximum', () => {
    expect(strokeDuration(0)).toBe(0.3)
    expect(strokeDuration(70)).toBe(0.3)
    expect(strokeDuration(350)).toBe(0.5)
    expect(strokeDuration(700)).toBe(0.75)
    expect(strokeDuration(1610)).toBe(1.4)
    expect(strokeDuration(10000)).toBe(1.4)
  })
})

describe('scheduleBeat', () => {
  it('front-loads rather than stretching one gesture across a long sentence', () => {
    const gesture = line(0, [0, 0], [350, 0])
    expect(scheduleBeat([gesture], [0, 0], 3000)).toEqual(scheduleBeat([gesture], [0, 0], 8000))
    expect(scheduleBeat([gesture], [0, 0], 8000)).toEqual([
      { kind: 'gesture', index: 0, startMs: 0, durationMs: 500 },
    ])
  })

  it('serializes gestures with 30ms gaps and budgets travel before ink', () => {
    const timeline = scheduleBeat([line(0, [0, 0], [350, 0]), line(1, [630, 0], [980, 0])], [0, 0], 3000)
    expect(timeline).toEqual([
      { kind: 'gesture', index: 0, startMs: 0, durationMs: 500 },
      { kind: 'flight', from: [350, 0], to: [630, 0], startMs: 530, durationMs: 350 },
      { kind: 'gesture', index: 1, startMs: 880, durationMs: 500 },
    ])
  })

  it('starts a gliding gesture at once, without a flight, because it moves the pen itself', () => {
    const far: Gesture = { group: 0, from: [900, 600], to: [900, 600], seconds: 0.6, glides: true }
    expect(scheduleBeat([far], [0, 0], 3000)).toEqual([{ kind: 'gesture', index: 0, startMs: 0, durationMs: 600 }])
    expect(scheduleBeat([{ ...far, glides: false }], [0, 0], 3000)[0]).toMatchObject({ kind: 'flight' })
  })

  it('keeps composite parts contiguous, then waits for the whole group', () => {
    const parts = [line(0, [0, 0], [350, 0]), line(0, [350, 0], [700, 0]), line(1, [700, 0], [1050, 0])]
    expect(scheduleBeat(parts, [0, 0], 5000)).toEqual([
      { kind: 'gesture', index: 0, startMs: 0, durationMs: 500 },
      { kind: 'gesture', index: 1, startMs: 500, durationMs: 500 },
      { kind: 'gesture', index: 2, startMs: 1030, durationMs: 500 },
    ])
  })

  it('compresses flights, real sub-stroke durations and gaps only on overrun', () => {
    const gestures = [line(0, [800, 0], [1150, 0]), line(1, [1150, 0], [1500, 0])]
    const natural = scheduleBeat(gestures, [0, 0], 10000)
    const end = natural.at(-1)!.startMs + natural.at(-1)!.durationMs
    expect(scheduleBeat(gestures, [0, 0], end)).toEqual(natural)
    const compressed = scheduleBeat(gestures, [0, 0], end / 2)
    compressed.forEach((entry, index) => {
      expect(entry.startMs).toBeCloseTo(natural[index]!.startMs / 2)
      expect(entry.durationMs).toBeCloseTo(natural[index]!.durationMs / 2)
    })
    expect(compressed.at(-1)!.startMs + compressed.at(-1)!.durationMs).toBeCloseTo(end / 2)
  })

  it.each([1, 10, 50])('fits %i crowded gestures in a 1s budget without hidden floors or overlaps', (count) => {
    const gestures = Array.from({ length: count }, (_, i) => line(i, [i * 70, 0], [(i + 1) * 70, 0]))
    const timeline = scheduleBeat(gestures, [-1000, 0], 1000)
    timeline.forEach((entry, i) => {
      expect(entry.durationMs).toBeGreaterThan(0)
      if (i) expect(entry.startMs).toBeGreaterThanOrEqual(timeline[i - 1]!.startMs + timeline[i - 1]!.durationMs - 1e-8)
    })
    expect(timeline.at(-1)!.startMs + timeline.at(-1)!.durationMs).toBeCloseTo(1000)
  })
})

describe('sampleFlight', () => {
  it('lands at exact endpoints with tangent rotation and a symmetric shallow bow', () => {
    expect(sampleFlight([20, 30], [420, 30], 0).point).toEqual([20, 30])
    expect(sampleFlight([20, 30], [420, 30], 1).point).toEqual([420, 30])
    const middle = sampleFlight([20, 30], [420, 30], 0.5)
    expect(middle.point).toEqual([220, -10])
    expect(middle.angle).toBe(90)
    expect(middle.scale).toBeCloseTo(1.3)
    expect(middle.glow).toBeCloseTo(14)
    expect(sampleFlight([0, 0], [2000, 0], 0.5).point).toEqual([1000, -48])
    expect(sampleFlight([0, 0], [400, 0], 0).angle).toBeLessThan(90)
    expect(sampleFlight([0, 0], [400, 0], 1).angle).toBeGreaterThan(90)
  })

  it('eases from elapsed progress rather than advancing by frames', () => {
    const quarter = sampleFlight([0, 0], [400, 0], 0.25)
    expect(quarter.point[0]).toBeCloseTo(62.5)
    expect(sampleFlight([0, 0], [400, 0], 0).scale).toBe(1)
    expect(sampleFlight([0, 0], [400, 0], 1).glow).toBeCloseTo(8)
  })

  it('clamps travel time by distance, including the short and remote cases', () => {
    expect(flightDuration([0, 0], [10, 0])).toBe(0.35)
    expect(flightDuration([0, 0], [480, 0])).toBe(0.6)
    expect(flightDuration([0, 0], [800, 0])).toBe(0.9)
    expect(flightDuration([0, 0], [5000, 0])).toBe(0.9)
  })
})
