import type { DrawingScene } from '../shared/app'
import { geometryFor, strokesFor } from './ink'

const THUMBNAIL_PADDING = 32
const THUMBNAIL_TEXT_SIZE = 22
const ROW = THUMBNAIL_TEXT_SIZE * 2

type Shape = { kind: 'text'; x: number; y: number; text: string } | { kind: 'frame'; x: number; y: number; w: number; h: number }

/** What a scene leaves on paper besides ink: labels, card and 3D frames, and card rows laid out
 *  top to bottom. A 3D model is shown as its titled frame; the thumbnail never renders geometry. */
function shapesFor(scene: DrawingScene): Shape[] {
  let shapes: Shape[] = []
  const rows = new Map<string, { x: number; y: number; step: number }>()
  for (const beat of scene.beats) for (const mark of beat.marks) {
    if (mark.kind === 'clear') { shapes = []; rows.clear(); continue }
    if (mark.kind === 'text' || mark.kind === 'point') shapes.push({ kind: 'text', x: mark.x, y: mark.y, text: mark.kind === 'text' ? mark.text : mark.label ?? '↗' })
    else if (mark.kind === 'label') shapes.push({ kind: 'text', x: mark.lx, y: mark.ly, text: mark.text })
    else if (mark.kind === 'card' || mark.kind === 'model') {
      shapes.push({ kind: 'frame', x: mark.x, y: mark.y, w: mark.w, h: mark.h }, { kind: 'text', x: mark.x + 16, y: mark.y + 32, text: mark.kind === 'model' ? `3D · ${mark.title}` : mark.title })
      rows.set(mark.id, { x: mark.x + 16, y: mark.y + 32 + ROW, step: 0 })
    } else if (mark.kind === 'heading' || mark.kind === 'note' || mark.kind === 'step') {
      const row = rows.get(mark.id)
      if (!row) continue
      shapes.push({ kind: 'text', x: row.x, y: row.y, text: mark.kind === 'step' ? `${++row.step}. ${mark.text}` : mark.text })
      row.y += ROW
    }
  }
  return shapes
}

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
  }
  for (const shape of shapesFor(scene)) {
    if (shape.kind === 'frame') points.push([shape.x, shape.y], [shape.x + shape.w, shape.y + shape.h])
    else points.push([shape.x, shape.y - THUMBNAIL_TEXT_SIZE], [shape.x + [...shape.text].length * THUMBNAIL_TEXT_SIZE, shape.y + THUMBNAIL_TEXT_SIZE / 2])
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
  }
  for (const shape of shapesFor(scene)) {
    const node = document.createElementNS(ns, shape.kind === 'frame' ? 'rect' : 'text')
    if (shape.kind === 'frame') {
      for (const [name, value] of [['x', shape.x], ['y', shape.y], ['width', shape.w], ['height', shape.h], ['rx', 12]] as const) node.setAttribute(name, String(value))
      node.setAttribute('fill', 'none'); node.setAttribute('stroke', 'currentColor'); node.setAttribute('stroke-width', '2'); node.setAttribute('opacity', '.5')
    } else {
      node.setAttribute('x', String(shape.x)); node.setAttribute('y', String(shape.y)); node.setAttribute('fill', 'currentColor'); node.setAttribute('font-size', String(THUMBNAIL_TEXT_SIZE))
      node.textContent = shape.text
    }
    svg.append(node)
  }
  return svg
}
