import type { DrawingScene } from '../shared/app'
import { geometryFor, strokesFor } from './ink'

/** A safe static scene preview; no desktop pixels or external image references. */
export function sceneThumbnail(scene: DrawingScene): SVGSVGElement | undefined {
  const first = scene.beats[0]
  if (!first) return
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${first.space.pixelWidth} ${first.space.pixelHeight}`)
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
      text.setAttribute('x', String(mark.x)); text.setAttribute('y', String(mark.y)); text.setAttribute('fill', 'currentColor'); text.setAttribute('font-size', '22')
      text.textContent = mark.kind === 'text' ? mark.text : mark.label ?? '↗'; svg.append(text)
    }
  }
  return svg
}
