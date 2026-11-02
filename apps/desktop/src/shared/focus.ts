/** Pointing while asking: the path the cursor traced during a hold, turned into the
 *  part of the screen the question is about (circled, underlined, or scribbled over). */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Shorter strokes are a hand resting on the mouse, not a gesture. */
const MIN_EXTENT = 36
const MIN_LENGTH = 70
/** A gesture wandering over most of the screen is not about one part of it. */
const MAX_SHARE = 0.6
/** Around a circle, so its edge doesn't cut through what it encloses. */
const PAD = 0.12
/** A stroke this flat is an underline. */
const FLAT = 0.25
/** How far an underline reaches up to the text above it, and down past it. */
const ABOVE = 44
const BELOW = 10
/** Paths are resampled to this spacing, so judging them doesn't depend on how fast the hand moved. */
const STEP = 6
/** A loop closes when its ends come within this share of its size; a hand-drawn circle rarely meets itself exactly. */
const CLOSE = 0.25
/** A turn sharper than this ends a straight stroke. */
const TURN = Math.PI / 4
/** Drawing around something never doubles back like this; the way over and a stroke back along it do. */
const REVERSAL = Math.PI * 2 / 3

/** What the pointer did while the owner asked: the area it marked, or else only where it ended up. */
export interface Pointing { region?: Rect; pointer?: Point }

/** Reads `points` (global points, in order) on the display `frame`. A loop is a circle around something,
 *  wherever the pointer came from; failing that, a flat last stroke is an underline, and anything else
 *  after the pointer's first stroke (its way over) is a scribble over an area. A plain move only points. */
export function readPointing(points: readonly Point[], frame: Rect): Pointing {
  // Where it ended counts even if it got here from another display; its shape only from what it drew here.
  const first = points[0], last = points[points.length - 1]
  const pointer = first && last && contains(frame, last) && Math.hypot(last.x - first.x, last.y - first.y) >= MIN_EXTENT ? { pointer: last } : {}
  const path = resample(points.filter(p => contains(frame, p)))
  if (path.length < 2) return pointer
  const loop = longestLoop(path)
  if (loop) return { ...pointer, ...region(loop, frame, 'outline') }
  const runs = straightRuns(path)
  const final = runs[runs.length - 1]!
  if (isFlat(final) && (final.length - 1) * STEP >= MIN_LENGTH) return { ...pointer, ...region(final, frame, 'underline') }
  if (runs.length < 3) return pointer
  return { ...pointer, ...region(runs.slice(1).flat(), frame, 'outline') }
}

function resample(points: readonly Point[]): Point[] {
  if (!points.length) return []
  const out = [points[0]!]
  let carry = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, d = Math.hypot(b.x - a.x, b.y - a.y)
    for (let t = STEP - carry; t <= d; t += STEP) out.push({ x: a.x + (b.x - a.x) * t / d, y: a.y + (b.y - a.y) * t / d })
    carry = (carry + d) % STEP
    if (out.length > 2_000) return out
  }
  // The stroke ends where the hand stopped, not at the last whole step.
  const end = points[points.length - 1]!, tail = out[out.length - 1]!
  if (end.x !== tail.x || end.y !== tail.y) out.push(end)
  return out
}

/** The longest stretch of the path whose ends nearly meet, that never doubles back and isn't flat. */
function longestLoop(path: Point[]): Point[] | undefined {
  // reversals[k]: how many points before k double back, so any stretch is checked at once.
  const reversals = [0]
  for (let k = 0; k < path.length; k++) reversals.push(reversals[k]! + (turnAt(path, k) > REVERSAL ? 1 : 0))
  const box = rangeBounds(path)
  for (let span = path.length - 1; span * STEP >= MIN_LENGTH * 2; span--) {
    for (let i = 0; i + span < path.length; i++) {
      const a = path[i]!, b = path[i + span]!
      if (reversals[i + span]! - reversals[i + 1]! > 0) continue
      const { left, top, right, bottom } = box(i, i + span)
      const width = right - left, height = bottom - top
      // Closed relative to its own size, so the way over can't make a long stretch count as closed.
      if (Math.hypot(a.x - b.x, a.y - b.y) >= CLOSE * Math.hypot(width, height) || height < width * FLAT) continue
      // Its ends may still reach a little way along the way over, or past where the circle closed: pull each in while that brings them closer.
      let start = i, end = i + span
      const gap = (p: number, q: number): number => Math.hypot(path[p]!.x - path[q]!.x, path[p]!.y - path[q]!.y)
      for (let moved = true; moved;) {
        moved = false
        if (end - start > 2 && gap(start + 1, end) < gap(start, end)) { start++; moved = true }
        if (end - start > 2 && gap(start, end - 1) < gap(start, end)) { end--; moved = true }
      }
      return path.slice(start, end + 1)
    }
  }
  return undefined
}

/** Bounds of any stretch path[i..j] at once, from sparse tables of running minima and maxima. */
function rangeBounds(path: Point[]): (i: number, j: number) => { left: number; top: number; right: number; bottom: number } {
  const levels = [[path.map(p => p.x), path.map(p => p.y), path.map(p => p.x), path.map(p => p.y)]]
  for (let size = 2; size <= path.length; size *= 2) {
    const [minX, minY, maxX, maxY] = levels[levels.length - 1]!, half = size / 2, next: number[][] = [[], [], [], []]
    for (let k = 0; k + size <= path.length; k++) {
      next[0]!.push(Math.min(minX![k]!, minX![k + half]!)); next[1]!.push(Math.min(minY![k]!, minY![k + half]!))
      next[2]!.push(Math.max(maxX![k]!, maxX![k + half]!)); next[3]!.push(Math.max(maxY![k]!, maxY![k + half]!))
    }
    levels.push(next)
  }
  return (i, j) => {
    const level = Math.floor(Math.log2(j - i + 1)), [minX, minY, maxX, maxY] = levels[level]!, other = j - (1 << level) + 1
    return { left: Math.min(minX![i]!, minX![other]!), top: Math.min(minY![i]!, minY![other]!), right: Math.max(maxX![i]!, maxX![other]!), bottom: Math.max(maxY![i]!, maxY![other]!) }
  }
}

/** How sharply the path turns at `k`, judged over a few steps either side so tremor doesn't count. */
function turnAt(path: Point[], k: number): number {
  const before = path[Math.max(0, k - 3)]!, at = path[k]!, after = path[Math.min(path.length - 1, k + 3)]!
  if (before === at || at === after) return 0
  const angle = Math.atan2(after.y - at.y, after.x - at.x) - Math.atan2(at.y - before.y, at.x - before.x)
  return Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)))
}

/** The path split wherever it turns sharply, each piece sharing its end with the next. */
function straightRuns(path: Point[]): Point[][] {
  const runs: Point[][] = [[path[0]!]]
  let heading: number | undefined
  for (let i = 1; i < path.length; i++) {
    // Each heading spans a few steps, so the hand's tremor doesn't break a stroke.
    const from = path[Math.max(0, i - 3)]!, to = path[i]!, angle = Math.atan2(to.y - from.y, to.x - from.x)
    const turn = heading === undefined ? 0 : Math.abs(Math.atan2(Math.sin(angle - heading), Math.cos(angle - heading)))
    if (turn > TURN && i >= 3) { runs.push([path[i - 1]!]); heading = angle }
    heading ??= angle
    runs[runs.length - 1]!.push(to)
  }
  return runs
}

function bounds(points: readonly Point[]): { left: number; top: number; right: number; bottom: number } {
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

function isFlat(points: readonly Point[]): boolean {
  const b = bounds(points)
  return b.bottom - b.top < (b.right - b.left) * FLAT
}

function region(points: readonly Point[], frame: Rect, kind: 'outline' | 'underline'): { region?: Rect } {
  let { left, top, right, bottom } = bounds(points)
  const width = right - left, height = bottom - top
  if (Math.max(width, height) < MIN_EXTENT) return {}
  if (kind === 'underline') { top -= ABOVE; bottom += BELOW }
  else { left -= width * PAD; right += width * PAD; top -= height * PAD; bottom += height * PAD }
  left = Math.max(frame.x, left); top = Math.max(frame.y, top)
  right = Math.min(frame.x + frame.width, right); bottom = Math.min(frame.y + frame.height, bottom)
  const area = { x: left, y: top, width: right - left, height: bottom - top }
  return area.width * area.height > MAX_SHARE * frame.width * frame.height ? {} : { region: area }
}

/** Half-open, like display frames: the right and bottom edges belong to the neighbouring display. */
export function contains(frame: Rect, p: Point): boolean {
  return p.x >= frame.x && p.x < frame.x + frame.width && p.y >= frame.y && p.y < frame.y + frame.height
}

/** `region` (global points) in the pixels of an image of `frame` that is `pixelWidth` × `pixelHeight`. */
export function toPixels(region: Rect, frame: Rect, pixelWidth: number, pixelHeight: number): Rect {
  const sx = pixelWidth / frame.width, sy = pixelHeight / frame.height
  const x = Math.max(0, Math.round((region.x - frame.x) * sx)), y = Math.max(0, Math.round((region.y - frame.y) * sy))
  return { x, y, width: Math.min(pixelWidth - x, Math.round(region.width * sx)), height: Math.min(pixelHeight - y, Math.round(region.height * sy)) }
}
