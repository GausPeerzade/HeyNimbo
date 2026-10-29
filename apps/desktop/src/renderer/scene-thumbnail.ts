import type { DrawingScene } from '../shared/app'
import { geometryFor, strokesFor } from './ink'

const THUMBNAIL_PADDING = 32
const THUMBNAIL_TEXT_SIZE = 22

/** Conservative ink bounds keep sparse drawings legible without desktop pixels.
 * Text reserves a full em per code point so fallback scripts aren't cropped. */
export function thumbnailViewBox(scene: DrawingScene): string {
  let points: Array<[number, number]> = []
  for (const beat of scene.beats) for (const mark of beat.marks) {
    if (mark.kind === 'clear') { points = []; continue }
    for (const stroke of strokesFor(mark)) {
      const half = (stroke.size ?? THUMBNAIL_TEXT_SIZE) / 2
      for (const [x, y] of stroke.points) points.push([x - half, y - half], [x + half, y + half])
    }
    if (mark.kind === 'text' || mark.kind === 'point') {
      const label = mark.kind === 'text' ? mark.text : mark.label ?? '↗'
      points.push([mark.x, mark.y - THUMBNAIL_TEXT_SIZE], [mark.x + [...label].length * THUMBNAIL_TEXT_SIZE, mark.y + THUMBNAIL_TEXT_SIZE / 2])
    }
  }
  if (!points.length) return `0 0 ${scene.beats[0]?.space.pixelWidth ?? 1} ${scene.beats[0]?.space.pixelHeight ?? 1}`
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity
  for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y) }
  return `${left - THUMBNAIL_PADDING} ${top - THUMBNAIL_PADDING} ${right - left + THUMBNAIL_PADDING * 2} ${bottom - top + THUMBNAIL_PADDING * 2}`
}

/** A safe static scene preview; no desktop pixels or external image references. */
export function sceneThumbnail(scene: DrawingScene): SVGSVGElement | undefined {
  const first = scene.beats[0]
  if (!first) return
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', thumbnailViewBox(scene))
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Generated drawing on blank paper; screen not saved')
  const title = document.createElementNS(ns, 'title'); title.textContent = scene.beats.map(b => b.sentence ?? '').join(' '); svg.append(title)
  for (const beat of scene.beats) for (const mark of beat.marks) {
    if (mark.kind === 'clear') { while (svg.lastChild && svg.lastChild !== title) svg.lastChild.remove(); continue }
    for (const stroke of strokesFor(mark)) {
      const path = document.createElementNS(ns, 'path'); const geometry = geometryFor(stroke)
      path.setAttribute('d', geometry.outline); path.setAttribute('fill', 'currentColor')
      if (stroke.style === 'marker') path.setAttribute('opacity', '.28')
      svg.append(path)
    }
    if (mark.kind === 'text' || mark.kind === 'point') {
      const text = document.createElementNS(ns, 'text')
      text.setAttribute('x', String(mark.x)); text.setAttribute('y', String(mark.y)); text.setAttribute('fill', 'currentColor'); text.setAttribute('font-size', String(THUMBNAIL_TEXT_SIZE))
      text.textContent = mark.kind === 'text' ? mark.text : mark.label ?? '↗'; svg.append(text)
    }
  }
  return svg
}
