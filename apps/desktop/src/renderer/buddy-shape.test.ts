import { describe, expect, it } from 'vitest'
import { buddyPath } from './buddy-shape'

const points = (path: string): number[][] =>
  path.slice(1, -1).split('L').map((pair) => pair.split(' ').map((value) => Number(value) + 0))

const signedArea = (shape: number[][]): number =>
  shape.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = shape[(index + 1) % shape.length]!
    return sum + x! * nextY! - nextX! * y!
  }, 0) / 2

describe('buddyPath', () => {
  it('is the exact pen at rest and moves every point straight to its ear partner', () => {
    const pen = points(buddyPath(0))
    const half = points(buddyPath(0.5))
    const ear = points(buddyPath(1))
    for (const shape of [pen, half, ear]) expect(shape).toHaveLength(48)

    // The tip stays on the ink and the corners stay sharp.
    expect(pen[0]).toEqual([0, 0])
    expect(pen).toContainEqual([7.5, 13])
    expect(pen).toContainEqual([-7.5, 13])

    for (const [index, [x, y]] of half.entries()) {
      expect(x).toBeCloseTo((pen[index]![0]! + ear[index]![0]!) / 2, 1)
      expect(y).toBeCloseTo((pen[index]![1]! + ear[index]![1]!) / 2, 1)
    }

    // Both lap the same way from the top, so the morph doesn't turn inside out.
    expect(ear[0]).toEqual([0, -3])
    expect(Math.sign(signedArea(ear))).toBe(Math.sign(signedArea(pen)))
  })
})
