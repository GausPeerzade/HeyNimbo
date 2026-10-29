import { describe, expect, it } from 'vitest'
import { displayFor, toOverlaySpace, type CaptureSpace } from './overlay-geometry'

// A 1440x900-point display left of the primary, captured at 1280x800 pixels.
const left = { id: 2, bounds: { x: -1440, y: 0, width: 1440, height: 900 } }
const primary = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1080 } }
const capture: CaptureSpace = { frame: left.bounds, pixelWidth: 1280, pixelHeight: 800 }

describe('displayFor', () => {
  it('matches the captured display by frame, falling back to the one containing its center', () => {
    expect(displayFor(capture, [primary, left])?.id).toBe(2)
    const moved = { ...capture, frame: { ...capture.frame, x: -1400 } }
    expect(displayFor(moved, [primary, left])?.id).toBe(2)
    expect(displayFor({ ...capture, frame: { x: 9000, y: 0, width: 10, height: 10 } }, [primary, left])).toBeUndefined()
  })
})

describe('toOverlaySpace', () => {
  it('scales screenshot pixels to the display and makes them overlay-local', () => {
    const marks = toOverlaySpace(
      [
        { kind: 'point', x: 640, y: 400, label: 'center' },
        { kind: 'circle', x: 0, y: 0, r: 64 },
        { kind: 'box', x: 1280, y: 800, w: 128, h: 80 },
        { kind: 'arrow', x1: 0, y1: 800, x2: 1280, y2: 0 },
        { kind: 'clear' },
      ],
      capture,
      left.bounds,
    )
    expect(marks).toEqual([
      { kind: 'point', x: 720, y: 450, label: 'center' },
      { kind: 'circle', x: 0, y: 0, r: 72 },
      { kind: 'box', x: 1440, y: 900, w: 144, h: 90 },
      { kind: 'arrow', x1: 0, y1: 900, x2: 1440, y2: 0 },
      { kind: 'clear' },
    ])
  })
})
