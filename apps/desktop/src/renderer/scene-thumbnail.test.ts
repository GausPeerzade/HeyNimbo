import { expect, it } from 'vitest'
import type { DrawingScene } from '../shared/app'
import type { Mark } from '../shared/beats'
import { thumbnailViewBox } from './scene-thumbnail'
const scene = (marks: Mark[]): DrawingScene => ({ version: 1, beats: [{ marks, space: { frame: { x: 0, y: 0, width: 960, height: 600 }, pixelWidth: 1920, pixelHeight: 1200 } }] })
it('crops a sparse drawing around its ink instead of the full display', () => {
  const [x,y,width,height] = thumbnailViewBox(scene([{ kind: 'line', x1: 700, y1: 90, x2: 860, y2: 140 }])).split(' ').map(Number)
  expect(x).toBeLessThan(700); expect(y).toBeLessThan(90)
  expect(x! + width!).toBeGreaterThan(860); expect(y! + height!).toBeGreaterThan(140)
  expect(width).toBeLessThan(300); expect(height).toBeLessThan(200)
})
it('reserves fallback text bounds and removes cleared ink from the crop', () => {
  const marks: Mark[] = [{ kind: 'line', x1: 0, y1: 0, x2: 5000, y2: 5000 }, { kind: 'clear' }, { kind: 'text', x: 500, y: 200, text: '出口🙂' }]
  expect(thumbnailViewBox(scene(marks))).toBe('468 146 130 97')
  expect(thumbnailViewBox(scene([{ kind: 'clear' }]))).toBe('0 0 1920 1200')
  expect(thumbnailViewBox({ version: 1, beats: [] })).toBe('0 0 1 1')
})
