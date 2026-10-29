import type { Mark } from '../shared/beats'
import type { OverlayCommand, OverlayRing } from '../shared/ipc'
import { lengthOf, outline, strokesFor, type Stroke } from './ink'

const SVG_NS = 'http://www.w3.org/2000/svg'
const stage = document.getElementById('stage') as unknown as SVGSVGElement
const ringLayer = layer('rings')
const inkLayer = layer('ink')
const buddyLayer = layer('buddy')

/** Pen speed in CSS pixels per second; strokes take 0.3-1.4 s each. */
const PEN_SPEED = 1100
/** Drawing finishes within this share of its sentence, leaving room to look. */
const SHARE_OF_SENTENCE = 0.85

let buddyAt: OverlayRing | undefined
let generation = 0

function layer(name: string): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g')
  group.setAttribute('class', name)
  stage.append(group)
  return group
}

function element<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Runs `frame(progress)` from 0 to 1 over `seconds`, after `delay` seconds,
 *  unless the overlay is cleared first. */
function animate(seconds: number, delay: number, frame: (progress: number) => void): void {
  const owner = generation
  const start = performance.now() + delay * 1000
  const tick = (now: number): void => {
    if (owner !== generation) return
    const progress = Math.min(1, Math.max(0, (now - start) / (seconds * 1000)))
    if (now >= start) frame(progress)
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function drawStroke(stroke: Stroke, seconds: number, delay: number): void {
  const path = element('path', { class: stroke.style, d: '' })
  inkLayer.append(path)
  animate(seconds, delay, (progress) => path.setAttribute('d', outline(stroke, easeInOut(progress))))
}

function handwrite(mark: Extract<Mark, { kind: 'text' }>, seconds: number, delay: number): void {
  const id = `reveal-${generation}-${inkLayer.childElementCount}`
  const clip = element('clipPath', { id })
  const reveal = element('rect', { x: mark.x - 4, y: mark.y - 40, width: 0, height: 60 })
  clip.append(reveal)
  const text = element('text', { x: mark.x, y: mark.y, class: 'note', 'clip-path': `url(#${id})` })
  text.textContent = mark.text
  inkLayer.append(clip, text)
  const width = text.getComputedTextLength() + 12
  animate(seconds, delay, (progress) => reveal.setAttribute('width', String(width * progress)))
}

function buddy(): SVGGElement {
  const existing = buddyLayer.querySelector<SVGGElement>('g.buddy')
  if (existing) return existing
  const group = element('g', { class: 'buddy' })
  group.append(element('path', { class: 'buddy-body', d: 'M0 0 L18 7 L9 10 L6 19 Z' }))
  buddyLayer.append(group)
  return group
}

function point(mark: Extract<Mark, { kind: 'point' }>, from: OverlayRing | undefined, delay: number): void {
  const start = buddyAt ?? from ?? { x: mark.x, y: mark.y }
  buddyAt = { x: mark.x, y: mark.y }
  const body = buddy()
  buddyLayer.querySelector('.label')?.remove()
  // Fly along an arc that bulges upward, like a thrown paper plane.
  const control = { x: (start.x + mark.x) / 2, y: Math.min(start.y, mark.y) - 80 }
  animate(0.65, delay, (progress) => {
    const t = easeInOut(progress)
    const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t * t * mark.x
    const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t * t * mark.y
    body.setAttribute('transform', `translate(${x} ${y})`)
    if (progress === 1 && mark.label) showLabel(mark.x, mark.y, mark.label)
  })
}

function showLabel(x: number, y: number, label: string): void {
  const group = element('g', { class: 'label', transform: `translate(${x + 22} ${y + 18})` })
  const text = element('text', { x: 10, y: 19 })
  text.textContent = label
  const background = element('rect', { rx: 10, height: 28, width: 0 })
  group.append(background, text)
  buddyLayer.append(group)
  background.setAttribute('width', String(text.getComputedTextLength() + 20))
}

/** Schedules every mark in order, compressed to fit inside the sentence. */
function drawBeat(marks: Mark[], durationMs: number, from: OverlayRing | undefined): void {
  const steps: Array<{ seconds: number; run: (seconds: number, delay: number) => void }> = []
  for (const mark of marks) {
    if (mark.kind === 'clear') steps.push({ seconds: 0, run: () => inkLayer.replaceChildren() })
    else if (mark.kind === 'point') steps.push({ seconds: 0.65, run: (_s, delay) => point(mark, from, delay) })
    else if (mark.kind === 'text')
      steps.push({ seconds: Math.min(1.6, Math.max(0.5, mark.text.length * 0.05)), run: (s, d) => handwrite(mark, s, d) })
    else
      for (const stroke of strokesFor(mark)) {
        const seconds = Math.min(1.4, Math.max(0.3, lengthOf(stroke) / PEN_SPEED + 0.15))
        steps.push({ seconds, run: (s, d) => drawStroke(stroke, s, d) })
      }
  }
  const total = steps.reduce((sum, step) => sum + step.seconds, 0)
  const scale = total > 0 ? Math.min(1, (SHARE_OF_SENTENCE * durationMs) / 1000 / total) : 1
  let delay = 0
  for (const step of steps) {
    step.run(step.seconds * scale, delay)
    delay += step.seconds * scale
  }
}

function clearAll(): void {
  generation++
  buddyAt = undefined
  stage.classList.remove('fading')
  for (const group of [ringLayer, inkLayer, buddyLayer]) group.replaceChildren()
}

function apply(command: OverlayCommand): void {
  switch (command.kind) {
    case 'clear':
      return clearAll()
    case 'ring': {
      ringLayer.replaceChildren(element('circle', { class: 'ring', cx: command.ring.x, cy: command.ring.y, r: 28 }))
      return
    }
    case 'beat':
      stage.classList.remove('fading')
      return drawBeat(command.marks, command.durationMs, command.from)
    case 'fade': {
      stage.classList.add('fading')
      const owner = generation
      setTimeout(() => owner === generation && clearAll(), 700)
    }
  }
}

window.nimbo.onOverlayCommand(apply)
