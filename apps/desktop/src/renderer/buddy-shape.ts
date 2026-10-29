import { measurePath, samplePath, smoothThrough, type Point } from './ink'

/** Points per outline; a multiple of three so the pen keeps its exact corners. */
const OUTLINE_POINTS = 48
const SAMPLES_PER_SEGMENT = 10

/** The pen points up with its tip at the origin, so transforms never detach it
 *  from the ink. Clockwise from the tip, like the ear. */
const PEN: readonly Point[] = [[0, 0], [7.5, 13], [-7.5, 13]]

/** An upright ear over the pen's body: rim on the right, lobe at the bottom.
 *  Clockwise from the top. */
const EAR: readonly Point[] = [
  [0, -3], [4.5, -2.4], [7.6, 0.6], [8.6, 5.6], [7.6, 11], [5.2, 16], [2.2, 20], [-1.4, 21.6],
  [-4, 19.6], [-4.4, 16], [-3.2, 12.6], [-5.4, 9], [-7, 4], [-5.6, -0.6],
]

/** The ear's inner fold, faded in on top as the outline becomes an ear. */
export const EAR_FOLD = 'M-2.4 8.6 C-3 3.4 0.4 0.8 3.4 1.8 C6.4 2.8 6.4 7.4 4.4 9.8 C2.9 11.6 1.6 12.6 1.6 15.2'

function penOutline(): Point[] {
  const side = OUTLINE_POINTS / PEN.length
  return PEN.flatMap((from, corner) => {
    const to = PEN[(corner + 1) % PEN.length]!
    return Array.from({ length: side }, (_, step): Point => [
      from[0] + ((to[0] - from[0]) * step) / side,
      from[1] + ((to[1] - from[1]) * step) / side,
    ])
  })
}

function earOutline(): Point[] {
  // Wrap the neighbors around so the closed curve has no seam, then keep one lap.
  const curve = smoothThrough([EAR.at(-1)!, ...EAR, EAR[0]!, EAR[1]!], SAMPLES_PER_SEGMENT)
  const lap = measurePath(curve.slice(SAMPLES_PER_SEGMENT, SAMPLES_PER_SEGMENT * (EAR.length + 1) + 1))
  return Array.from({ length: OUTLINE_POINTS }, (_, index) => samplePath(lap, index / OUTLINE_POINTS).point)
}

const PEN_OUTLINE = penOutline()
const EAR_OUTLINE = earOutline()

/** The buddy's outline, `ear` of the way from the pen (0) to the ear (1). */
export function buddyPath(ear: number): string {
  const points = PEN_OUTLINE.map(([x, y], index) => {
    const [earX, earY] = EAR_OUTLINE[index]!
    return `${(x + (earX - x) * ear).toFixed(2)} ${(y + (earY - y) * ear).toFixed(2)}`
  })
  return `M${points.join('L')}Z`
}
