import { describe, expect, it } from 'vitest'
import { geometryFor, measurePath, samplePath, strokesFor, type Point } from './ink'

// Uneven samples along a bent curve: point-count reveal would almost finish
// the first leg at 50%, instead of traveling half the actual 200px length.
const uneven: Point[] = [[0, 0], [1, 0], [2, 0], [100, 0], [100, 1], [100, 100]]

describe('arc-length reveal', () => {
  it('maps unequal sample spacing to traveled distance, including corners', () => {
    const path = measurePath(uneven)
    expect(path.length).toBe(200)
    expect(samplePath(path, 0.25).point).toEqual([50, 0])
    expect(samplePath(path, 0.5).point).toEqual([100, 0])
    expect(samplePath(path, 0.75).point).toEqual([100, 50])
    expect(samplePath(path, 0.75).angle).toBe(180)
    expect(samplePath(path, -1).point).toEqual([0, 0])
    expect(samplePath(path, 2).point).toEqual([100, 100])
  })

  it('gives equal traveled distances on a nonuniformly sampled curved centerline', () => {
    const points: Point[] = [0, 0.01, 0.03, 0.1, 0.4, 0.45, 0.8, 1].map((t) => [100 * Math.cos(t), 100 * Math.sin(t)])
    const path = measurePath(points)
    for (const progress of [0.25, 0.5, 0.75]) {
      const { point } = samplePath(path, progress)
      const end = path.distances.findIndex((distance) => distance >= path.length * progress)
      const previous = points[end - 1]!
      const traveled = path.distances[end - 1]! + Math.hypot(point[0] - previous[0], point[1] - previous[1])
      expect(traveled).toBeCloseTo(path.length * progress, 8)
    }
  })

  it('never rebuilds or mutates final ink while sampling its reveal', () => {
    const geometry = geometryFor({ points: uneven, style: 'pen' })
    const before = JSON.stringify(geometry)
    for (let i = 0; i <= 60; i++) samplePath(geometry, i / 60)
    expect(JSON.stringify(geometry)).toBe(before)
    expect(geometry.width).toBe(3.5)
    expect(geometry.centerline).toBe('M0 0L1 0L2 0L100 0L100 1L100 100')
    expect(geometry.outline.startsWith('M')).toBe(true)
    expect(geometry.outline.endsWith('Z')).toBe(true)
  })

  it('keeps connected box edges in one stroke and arrowhead wings in one chevron', () => {
    const box = strokesFor({ kind: 'box', x: 10, y: 20, w: 100, h: 60 })
    expect(box).toHaveLength(1)
    const geometry = geometryFor(box[0]!)
    expect(geometry.length).toBeGreaterThan(320)
    const arrow = strokesFor({ kind: 'arrow', x1: 0, y1: 0, x2: 200, y2: 0 })
    expect(arrow).toHaveLength(2)
    expect(arrow[0]!.points.at(-1)).toEqual([200, 0])
    expect(arrow[1]!.points).toContainEqual([200, 0])
  })

  it('handles repeated and zero-length points without a nonfinite tip', () => {
    const path = measurePath([[4, 6], [4, 6], [4, 6]])
    expect(samplePath(path, 0.5)).toEqual({ point: [4, 6], angle: 90 })
  })
})
