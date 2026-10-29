import type { Mark } from '../shared/beats'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where a screenshot came from: the display frame in global points and the
 *  image size in pixels. */
export interface CaptureSpace {
  frame: Rect
  pixelWidth: number
  pixelHeight: number
}

/** Picks the display a capture was taken from: the one with the same frame,
 *  else the one containing the frame's center. */
export function displayFor<T extends { bounds: Rect }>(capture: CaptureSpace, displays: readonly T[]): T | undefined {
  const { frame } = capture
  const same = displays.find(({ bounds }) => Math.abs(bounds.x - frame.x) < 2 && Math.abs(bounds.y - frame.y) < 2)
  if (same) return same
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  return displays.find(({ bounds: b }) => cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height)
}

/** Converts marks from screenshot pixels to the overlay window's CSS pixels
 *  (the overlay covers `displayBounds`, in global points). */
export function toOverlaySpace(marks: readonly Mark[], capture: CaptureSpace, displayBounds: Rect): Mark[] {
  const sx = capture.frame.width / capture.pixelWidth
  const sy = capture.frame.height / capture.pixelHeight
  const x = (px: number): number => capture.frame.x + px * sx - displayBounds.x
  const y = (py: number): number => capture.frame.y + py * sy - displayBounds.y
  return marks.map((mark) => {
    switch (mark.kind) {
      case 'point':
      case 'text':
        return { ...mark, x: x(mark.x), y: y(mark.y) }
      case 'circle':
        return { ...mark, x: x(mark.x), y: y(mark.y), r: mark.r * sx }
      case 'box':
      case 'highlight':
        return { ...mark, x: x(mark.x), y: y(mark.y), w: mark.w * sx, h: mark.h * sy }
      case 'arrow':
      case 'line':
        return { ...mark, x1: x(mark.x1), y1: y(mark.y1), x2: x(mark.x2), y2: y(mark.y2) }
      case 'clear':
        return mark
    }
  })
}
