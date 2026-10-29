import type { Mark } from '../shared/beats'
import { FrameTrace } from './frame-trace'
import type { OverlayCommand, OverlayRing } from '../shared/ipc'
import { geometryFor, samplePath, strokesFor, type Point, type StrokeGeometry } from './ink'
import { buddyPath, EAR_FOLD } from './buddy-shape'
import { beatBudget, sampleFlight, scheduleBeat, strokeDuration, flightDuration, type Gesture } from './drawing-timeline'

const SVG_NS = 'http://www.w3.org/2000/svg'
const stage = document.getElementById('stage') as unknown as SVGSVGElement
const clearButton = document.getElementById('clear') as HTMLButtonElement
const scene = layer('scene')
const ringLayer = layer('rings', scene)
const washLayer = layer('wash', scene)
const inkLayer = layer('ink', scene)
const wordsLayer = layer('words', scene)
const buddyLayer = layer('buddy-layer')
const FADE_MS = 240

interface Action extends Gesture {
  begin: (durationMs: number) => (progress: number) => void
}

interface Animation {
  start: number
  durationMs: number
  begin: (durationMs: number) => (progress: number) => void
  frame?: (progress: number) => void
  /** The flight back to the cursor; a new beat replaces it. */
  isReturn?: boolean
}

/** Where the idle buddy sits relative to the OS pointer's tip. */
const CURSOR_OFFSET: Point = [16, 20]
/** Idle buddies lean like a pointer. */
const IDLE_ANGLE = -35
/** Follow smoothing time constant; frame-rate independent. */
const FOLLOW_MS = 60
/** Pause after the last stroke before flying home, in case more is coming. */
const RETURN_DELAY_MS = 600
/** Time for the pen to become an ear while listening, and back. */
const MORPH_MS = 240

let buddyAt: Point | undefined
/** The angle and scale callers last gave the buddy, before the ear blend. */
let buddyPose: [angle: number, scale: number] = [IDLE_ANGLE, 1]
let listening = false
/** 0 is the pen and 1 the ear; eases toward `listening` over MORPH_MS. */
let earAmount = 0
/** The blend the buddy's outline was last drawn at. */
let drawnEar = 0
/** The OS cursor on this display, when this display owns the buddy. */
let cursorAt: Point | undefined
/** following: rides the cursor; busy: drawing or flying; parked: hidden here. */
let mode: 'following' | 'busy' | 'parked' = 'parked'
let lastFrame = 0
let epoch = 0
let plannedTip: Point | undefined
let plannedEnd = 0
let nextId = 0
let framePending = false
let fadeStarted: number | undefined
let buddyFadeStarted: number | undefined
const animations: Animation[] = []
const trace = new FrameTrace()

function layer(name: string, parent: SVGElement = stage): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g')
  group.setAttribute('class', name)
  parent.append(group)
  return group
}

function element<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

/** One monotonic clock owns every flight, reveal, label and scene fade. */
function wake(): void {
  if (framePending) return
  framePending = true
  requestAnimationFrame(tick)
}

function tick(now: number): void {
  framePending = false
  while (animations.length) {
    const animation = animations[0]!
    if (now < animation.start) break
    animation.frame ??= animation.begin(Math.max(0, animation.start + animation.durationMs - now))
    const progress = animation.durationMs > 0 ? Math.min(1, (now - animation.start) / animation.durationMs) : 1
    animation.frame(progress)
    if (progress < 1) break
    animations.shift()
  }
  if (fadeStarted !== undefined) {
    const progress = Math.min(1, (now - fadeStarted) / FADE_MS)
    scene.setAttribute('opacity', String(1 - progress))
    if (progress === 1) {
      clearScene()
      fadeStarted = undefined
    }
  }
  if (buddyFadeStarted !== undefined) {
    const progress = Math.min(1, (now - buddyFadeStarted) / 180)
    buddyLayer.setAttribute('opacity', String(1 - progress))
    if (progress === 1) {
      buddyFadeStarted = undefined
      buddyAt = undefined
    }
  }
  const followed = follow(now)
  const morphing = morph(now)
  lastFrame = now
  if (animations.length || fadeStarted !== undefined || buddyFadeStarted !== undefined || followed || morphing) wake()
}

function followTarget(): Point | undefined {
  if (!cursorAt) return undefined
  return [Math.min(innerWidth - 10, cursorAt[0] + CURSOR_OFFSET[0]), Math.min(innerHeight - 10, cursorAt[1] + CURSOR_OFFSET[1])]
}

/** Eases the idle buddy toward the cursor; once drawing is done, flies home.
 *  Returns whether another frame is needed. */
function follow(now: number): boolean {
  const target = followTarget()
  if (animations.length || mode === 'parked') return false
  if (!target) {
    // Drawing finished but the cursor is elsewhere: hand the buddy over.
    if (mode === 'busy') settle(now)
    return false
  }
  if (mode === 'busy') {
    flyHome(now + RETURN_DELAY_MS)
    return true
  }
  const from = buddyAt ?? target
  // Cap the step: after the mouse rested, the first frame must not snap.
  const blend = 1 - Math.exp(-Math.min(32, Math.max(0, now - lastFrame)) / FOLLOW_MS)
  const next: Point = [from[0] + (target[0] - from[0]) * blend, from[1] + (target[1] - from[1]) * blend]
  moveBuddy(next, IDLE_ANGLE)
  return Math.hypot(target[0] - next[0], target[1] - next[1]) > 0.3
}

/** Hides the buddy here and lets main give it to the cursor's display. */
function settle(now: number): void {
  mode = 'parked'
  buddyFadeStarted = now
  window.nimbo.sendOverlayEvent({ kind: 'buddyIdle' })
}

/** Flies from wherever the buddy is to the cursor, then resumes following. */
function flyHome(at: number): void {
  const target = followTarget()
  if (!buddyAt || !target) return
  const from = buddyAt
  animations.push({
    start: at,
    durationMs: flightDuration(from, target) * 1000,
    isReturn: true,
    begin: () => {
      const origin = buddyAt ?? from
      const home = followTarget() ?? target
      const fly = flight(origin, home)
      return (progress) => {
        fly(progress)
        if (progress === 1) {
          mode = 'following'
          window.nimbo.sendOverlayEvent({ kind: 'buddyIdle' })
        }
      }
    },
  })
}

function strokeAction(geometry: StrokeGeometry, group: number): Action {
  const padding = geometry.width + 8
  const left = Math.min(...geometry.points.map(([x]) => x)) - padding
  const top = Math.min(...geometry.points.map(([, y]) => y)) - padding
  const right = Math.max(...geometry.points.map(([x]) => x)) + padding
  const bottom = Math.max(...geometry.points.map(([, y]) => y)) + padding
  return {
    group, from: geometry.points[0]!, to: geometry.points.at(-1)!,
    seconds: strokeDuration(geometry.length),
    begin: (durationMs) => {
      const id = `ink-reveal-${nextId++}`
      const mask = element('mask', { id, maskUnits: 'userSpaceOnUse', x: left, y: top, width: right - left, height: bottom - top })
      const reveal = element('path', {
        d: geometry.centerline, pathLength: 1, fill: 'none', stroke: 'white',
        'stroke-width': geometry.width * 2 + 4, 'stroke-linejoin': 'round',
        'stroke-dasharray': '1 1', 'stroke-dashoffset': 1,
      })
      mask.append(reveal)
      const path = element('path', { class: geometry.style, d: geometry.outline, mask: `url(#${id})`, opacity: 0 })
      const target = geometry.style === 'marker' ? washLayer : inkLayer
      target.append(mask, path)
      window.nimbo.sendOverlayEvent({ kind: 'strokeStarted', durationMs, epoch })
      // Progressive reveal/pen presence adapted from Jason Kneen's MIT overlay;
      // both use our final centerline, correcting the upstream tip mismatch.
      return (progress) => {
        path.setAttribute('opacity', progress > 0 ? '1' : '0')
        reveal.setAttribute('stroke-dashoffset', String(1 - progress))
        reveal.setAttribute('stroke-linecap', progress === 1 ? 'round' : 'butt')
        const tip = samplePath(geometry, progress)
        moveBuddy(tip.point, tip.angle)
      }
    },
  }
}

function textAction(mark: Extract<Mark, { kind: 'text' }>, group: number): Action {
  const text = element('text', { x: mark.x, y: mark.y, class: 'note' })
  text.textContent = mark.text
  wordsLayer.append(text)
  const width = text.getComputedTextLength() + 8
  text.remove()
  return {
    group, from: [mark.x, mark.y - 6], to: [mark.x + width, mark.y - 6],
    seconds: Math.min(1.4, 0.4 + 0.015 * mark.text.length),
    begin: (durationMs) => {
      const id = `text-reveal-${nextId++}`
      const clip = element('clipPath', { id })
      const reveal = element('rect', { x: mark.x - 4, y: mark.y - 40, width: 0, height: 60 })
      clip.append(reveal)
      text.setAttribute('clip-path', `url(#${id})`)
      wordsLayer.append(clip, text)
      window.nimbo.sendOverlayEvent({ kind: 'strokeStarted', durationMs, epoch })
      return (progress) => {
        reveal.setAttribute('width', String(width * progress))
        moveBuddy([mark.x + width * progress, mark.y - 6], 90)
      }
    },
  }
}

function buddy(): SVGGElement {
  const existing = buddyLayer.querySelector<SVGGElement>('g.buddy')
  if (existing) return existing
  const group = element('g', { class: 'buddy' })
  group.append(element('path', { class: 'buddy-body', d: buddyPath(0) }), element('path', { class: 'buddy-fold', d: EAR_FOLD, opacity: 0 }))
  buddyLayer.append(group)
  return group
}

function moveBuddy(point: Point, angle: number, scale = 1, glow = 8): void {
  buddyFadeStarted = undefined
  buddyAt = point
  buddyPose = [angle, scale]
  buddy().style.setProperty('--glow', `${glow}px`)
  placeBuddy(performance.now())
  buddyLayer.setAttribute('opacity', '1')
}

/** Draws the buddy at its pose; as it becomes an ear it stands upright and breathes. */
function placeBuddy(now: number): void {
  if (!buddyAt) return
  const group = buddy()
  const ear = earAmount * earAmount * (3 - 2 * earAmount)
  if (ear !== drawnEar) {
    drawnEar = ear
    group.querySelector('.buddy-body')!.setAttribute('d', buddyPath(ear))
    group.querySelector('.buddy-fold')!.setAttribute('opacity', String(Math.max(0, ear * 2 - 1)))
  }
  const [angle, scale] = buddyPose
  const breath = 1 + 0.05 * ear * Math.sin(now / 170)
  group.setAttribute('transform', `translate(${buddyAt[0]} ${buddyAt[1]}) rotate(${angle * (1 - ear)}) scale(${scale * breath})`)
}

/** Eases between pen and ear; returns whether another frame is needed. */
function morph(now: number): boolean {
  const target = listening ? 1 : 0
  if (!buddyAt) {
    // Nothing to animate here; show the right shape whenever the buddy appears.
    earAmount = target
    return false
  }
  if (earAmount === target && !listening) return false
  const step = Math.min(32, Math.max(0, now - lastFrame)) / MORPH_MS
  earAmount = target > earAmount ? Math.min(target, earAmount + step) : Math.max(target, earAmount - step)
  placeBuddy(now)
  // A listening ear keeps breathing.
  return listening || earAmount !== target
}

function flight(from: Point, to: Point): (progress: number) => void {
  return (progress) => {
    const pose = sampleFlight(from, to, progress)
    moveBuddy(pose.point, pose.angle, pose.scale, pose.glow)
  }
}

function showLabel(x: number, y: number, label: string): SVGGElement {
  const group = element('g', { class: 'label', opacity: 0 })
  const text = element('text', { x: 7, y: 17 })
  text.textContent = label
  const background = element('rect', { rx: 5, height: 24, width: 0 })
  group.append(background, text)
  wordsLayer.append(group)
  const measured = text.getComputedTextLength()
  const width = Math.min(innerWidth - 16, measured + 14)
  background.setAttribute('width', String(width))
  if (width < measured + 14) {
    text.setAttribute('textLength', String(width - 14))
    text.setAttribute('lengthAdjust', 'spacingAndGlyphs')
  }
  // Jason Kneen's MIT right-edge flip/clamp, using measured SVG text instead
  // of a character estimate; also flip above at the bottom edge.
  const left = x + 12 + width > innerWidth - 8 ? x - width - 12 : x + 12
  const top = y + 12 + 24 > innerHeight - 8 ? y - 24 - 12 : y + 12
  group.setAttribute('transform', `translate(${Math.max(8, Math.min(innerWidth - width - 8, left))} ${Math.max(8, Math.min(innerHeight - 32, top))})`)
  return group
}

/** Composite parts stay together, with travel included in the speech budget. */
function drawBeat(marks: Mark[], durationMs: number, from: OverlayRing | undefined): void {
  fadeStarted = undefined
  scene.setAttribute('opacity', '1')
  mode = 'busy'
  // A pending or running flight home gives way to the new work.
  const home = animations.findIndex((animation) => animation.isReturn)
  if (home >= 0) animations.splice(home)
  const last = animations.at(-1)
  plannedEnd = last ? last.start + last.durationMs : 0
  const origin: Point = animations.length && plannedTip ? plannedTip : buddyAt ?? [from?.x ?? 20, from?.y ?? 20]
  const actions: Action[] = []
  for (const [group, mark] of marks.entries()) {
    if (mark.kind === 'clear') {
      const at = actions.at(-1)?.to ?? origin
      actions.push({ group, from: at, to: at, seconds: 0, begin: () => () => clearScene() })
    } else if (mark.kind === 'point') {
      actions.push({
        group, from: [mark.x, mark.y], to: [mark.x, mark.y], seconds: 0.14,
        begin: () => {
          const label = mark.label ? showLabel(mark.x, mark.y, mark.label) : undefined
          return (progress) => {
            moveBuddy([mark.x, mark.y], IDLE_ANGLE)
            label?.setAttribute('opacity', String(progress))
          }
        },
      })
    } else if (mark.kind === 'text') actions.push(textAction(mark, group))
    else for (const stroke of strokesFor(mark)) actions.push(strokeAction(geometryFor(stroke), group))
  }
  const now = performance.now()
  const start = Math.max(now, animations.length ? plannedEnd : 0)
  // Time spent queued behind earlier beats comes out of this beat's budget.
  const timeline = scheduleBeat(actions, origin, beatBudget(durationMs, start - now))
  for (const entry of timeline) {
    if (entry.kind === 'gesture') {
      animations.push({ start: start + entry.startMs, durationMs: entry.durationMs, begin: actions[entry.index]!.begin })
    } else {
      animations.push({ start: start + entry.startMs, durationMs: entry.durationMs, begin: () => flight(entry.from, entry.to) })
    }
  }
  const end = timeline.at(-1)
  plannedEnd = start + (end ? end.startMs + end.durationMs : 0)
  plannedTip = actions.at(-1)?.to ?? origin
  trace.activeUntil(plannedEnd)
  wake()
}

function clearScene(): void {
  for (const group of [ringLayer, washLayer, inkLayer, wordsLayer]) group.replaceChildren()
}

/** Shows the Clear button at the drawing's top-right corner, kept on screen. */
function offerClear(): void {
  const box = [washLayer, inkLayer, wordsLayer]
    .map((group) => group.getBBox())
    .filter((rect) => rect.width > 0 || rect.height > 0)
  if (!box.length) return
  const right = Math.max(...box.map((rect) => rect.x + rect.width))
  const top = Math.min(...box.map((rect) => rect.y))
  clearButton.hidden = false
  const { width, height } = clearButton.getBoundingClientRect()
  clearButton.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, right - width / 2))}px`
  clearButton.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top - height - 10))}px`
}

function hideClear(): void {
  if (clearButton.hidden) return
  clearButton.hidden = true
  window.nimbo.sendOverlayEvent({ kind: 'clearHover', over: false })
}

clearButton.addEventListener('mouseenter', () => window.nimbo.sendOverlayEvent({ kind: 'clearHover', over: true }))
clearButton.addEventListener('mouseleave', () => window.nimbo.sendOverlayEvent({ kind: 'clearHover', over: false }))
clearButton.addEventListener('click', () => {
  hideClear()
  window.nimbo.sendOverlayEvent({ kind: 'clearClicked' })
})

/** After clear or fade: fly home if the cursor is here, else hand the buddy over. */
function returnToCursor(from: OverlayRing | undefined): void {
  animations.length = 0
  plannedTip = undefined
  plannedEnd = 0
  if (mode !== 'busy') return
  if (from) {
    cursorAt = [from.x, from.y]
    flyHome(performance.now())
  } else settle(performance.now())
  wake()
}

function apply(command: OverlayCommand): void {
  switch (command.kind) {
    case 'debug':
      trace.enabled = command.frameTrace
      return
    case 'offerClear':
      return offerClear()
    case 'listening':
      listening = command.on
      return wake()
    case 'clear':
      hideClear()
      fadeStarted = undefined
      scene.setAttribute('opacity', '1')
      clearScene()
      return returnToCursor(command.from)
    case 'park':
      animations.length = 0
      buddyFadeStarted = undefined
      buddyLayer.setAttribute('opacity', '0')
      buddyAt = undefined
      cursorAt = undefined
      mode = 'parked'
      return
    case 'cursor':
      cursorAt = [command.at.x, command.at.y]
      if (mode === 'parked') {
        // Appear right at the pointer instead of flying in from a stale spot.
        mode = 'following'
        buddyAt = followTarget()
      }
      return wake()
    case 'ring': {
      ringLayer.replaceChildren(element('circle', { class: 'ring', cx: command.ring.x, cy: command.ring.y, r: 28 }))
      return
    }
    case 'beat':
      hideClear()
      epoch = command.epoch
      return drawBeat(command.marks, command.durationMs, command.from)
    case 'fade':
      hideClear()
      fadeStarted = performance.now()
      returnToCursor(command.from)
      wake()
  }
}

window.nimbo.onOverlayCommand(apply)
