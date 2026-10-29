import type { Mark } from '../shared/beats'
import { MODEL_LIMITS } from '../shared/model-protocol'
import { ModelStage } from './model-stage'
import { labelSlots, type LabelSlot } from './model-geometry'
import { CardScene, contains, layoutFlow, markCenter, objectPoint, BADGE_RADIUS, type CardState, type SceneObject } from './card-scene'
import { sampleWriting, wrapWriting, writingDuration, type WritingLayout } from './handwriting'
import { FrameTrace } from './frame-trace'
import type { OverlayCommand, OverlayRing } from '../shared/ipc'
import { geometryFor, samplePath, strokesFor, type Point, type StrokeGeometry } from './ink'
import { buddyPath, EAR_FOLD } from './buddy-shape'
import { beatBudget, sampleFlight, scheduleBeat, strokeDuration, flightDuration, type Gesture } from './drawing-timeline'

const SVG_NS = 'http://www.w3.org/2000/svg'
const stage = document.getElementById('stage') as unknown as SVGSVGElement
const clearButton = document.getElementById('clear') as HTMLButtonElement
const scene = layer('scene')
const cardsLayer = layer('cards', scene)
const cardScene = new CardScene()
const modelStages = new Map<CardState, ModelStage>()
interface ModelLabel {
  mark: Extract<Mark, { kind: 'tag' }>
  owner: SceneObject
  writing: WritingLayout
  /** The widest written line. */
  width: number
  /** True once the tag's own beat has begun; only begun labels hold a slot. */
  started: boolean
  slot?: LabelSlot
  /** Where the words were first written, in overlay coordinates. */
  words?: Point
  /** The slot the words now belong at, and the offset they have glided so far. */
  goal?: Point
  shift: Point
  glide?: { from: Point; start: number }
  /** The stage framing and hand-turn count the slot was solved for. */
  framing: number
  turned: number
  group?: SVGGElement
  dot?: SVGCircleElement
  leader?: SVGPathElement
}
/** Labels slide to a re-solved slot rather than jumping. */
const LABEL_GLIDE_MS = 420
const modelLabels = new Map<ModelStage, ModelLabel[]>()
/** Reused for every per-frame projection. */
const projected: Point = [0, 0]
/** A warm 3D stage (context, studio light, compiled shaders) built in idle time, ready for the next @model. */
let spareStage: ModelStage | undefined
/** Stages built from streamed @model lines whose beat has not arrived yet, by model id. */
const preparedModels = new Map<string, { stage: ModelStage; host: HTMLDivElement; w: number; h: number }>()
/** Model cards fade in alongside their first part rather than ahead of it. */
const cardFades: Array<{ node: SVGGElement; start: number }> = []
const MODEL_CARD_FADE_MS = 450
const pillBoxes: Array<{ x: number; y: number; w: number; h: number; node: SVGGElement }> = []
const objectNodes = new Map<SceneObject, SVGGElement>()
const cardViews = new Map<CardState, { root: SVGGElement; surface: SVGRectElement; board: SVGRectElement; body: SVGGElement; layers: Record<'wash' | 'ink' | 'words', SVGGElement> }>()
const ringLayer = layer('rings', scene)
const washLayer = layer('wash', scene)
const inkLayer = layer('ink', scene)
const wordsLayer = layer('words', scene)
const buddyLayer = layer('buddy-layer')
const FADE_MS = 240
const regions = new Map<string, { over: boolean; captured: boolean }>()
const warnedOmissions = new Set<CardState>()
const releaseDrags = new Map<CardState, () => void>()

interface Action extends Gesture {
  owner?: SceneObject
  begin: (durationMs: number) => (progress: number) => void
}

interface Animation {
  owner?: SceneObject
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
    if (animation.owner?.removed) { animations.shift(); continue }
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
  for (let i = cardFades.length - 1; i >= 0; i--) {
    const fade = cardFades[i]!, progress = Math.min(1, (now - fade.start) / MODEL_CARD_FADE_MS)
    fade.node.setAttribute('opacity', String(progress))
    if (progress === 1) cardFades.splice(i, 1)
  }
  let modelsActive = cardFades.length > 0
  for (const model of modelStages.values()) modelsActive = model.tick(now) || modelsActive
  const followed = follow(now)
  const morphing = morph(now)
  lastFrame = now
  if (animations.length || fadeStarted !== undefined || buddyFadeStarted !== undefined || followed || morphing || modelsActive) wake()
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
  window.heynimbo.sendOverlayEvent({ kind: 'buddyIdle' })
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
          window.heynimbo.sendOverlayEvent({ kind: 'buddyIdle' })
        }
      }
    },
  })
}

function strokeAction(geometry: StrokeGeometry, group: number, owner?: SceneObject, color?: string): Action {
  const padding = geometry.width + 8
  const left = Math.min(...geometry.points.map(([x]) => x)) - padding
  const top = Math.min(...geometry.points.map(([, y]) => y)) - padding
  const right = Math.max(...geometry.points.map(([x]) => x)) + padding
  const bottom = Math.max(...geometry.points.map(([, y]) => y)) + padding
  return {
    group, owner, from: geometry.points[0]!, to: geometry.points.at(-1)!,
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
      if (color) path.style.fill = color
      const target = owner ? objectNodes.get(owner)! : geometry.style === 'marker' ? washLayer : inkLayer
      target.append(mask, path)
      window.heynimbo.sendOverlayEvent({ kind: 'strokeStarted', durationMs, epoch })
      // Progressive reveal/pen presence adapted from Jason Kneen's MIT overlay;
      // both use our final centerline, correcting the upstream tip mismatch.
      return (progress) => {
        path.setAttribute('opacity', progress > 0 ? '1' : '0')
        reveal.setAttribute('stroke-dashoffset', String(1 - progress))
        reveal.setAttribute('stroke-linecap', progress === 1 ? 'round' : 'butt')
        const tip = samplePath(geometry, progress)
        moveBuddy(objectPoint(owner, tip.point), tip.angle)
      }
    },
  }
}

function measureWriting(size: number): (text: string) => number {
  const context = document.createElement('canvas').getContext('2d')!
  context.font = `500 ${size}px Caveat`
  return (text) => context.measureText(text).width
}

function writingAction(layout: WritingLayout, at: Point, group: number, owner: SceneObject, target = objectNodes.get(owner)!): Action {
  const end = sampleWriting(layout, at, 1).tip
  return {
    group, owner, from: sampleWriting(layout, at, 0).tip, to: end,
    seconds: writingDuration(layout.lines.map((line) => line.text).join('\n')),
    begin: (durationMs) => {
      const parts = layout.lines.map((line, i) => {
        const id = `writing-${nextId++}`
        const y = at[1] + i * layout.lineHeight
        const gradient = element('linearGradient', { id: `${id}-edge`, x1: line.rtl ? 1 : 0, x2: line.rtl ? 0 : 1, y1: 0, y2: 0 })
        gradient.append(element('stop', { offset: 0, 'stop-color': 'white' }), element('stop', { offset: 1, 'stop-color': 'white', 'stop-opacity': 0 }))
        const mask = element('mask', { id, maskUnits: 'userSpaceOnUse', x: at[0] - 4, y: y - layout.size, width: line.width + 12, height: layout.lineHeight + 8 })
        const solid = element('rect', { x: at[0] - 3, y: y - layout.size, width: 0, height: layout.lineHeight + 8, fill: 'white' })
        const edge = element('rect', { x: at[0], y: y - layout.size, width: 5, height: layout.lineHeight + 8, fill: `url(#${id}-edge)` })
        mask.append(solid, edge)
        const text = element('text', { x: at[0] + (line.rtl ? line.width : 0), y, direction: line.rtl ? 'rtl' : 'ltr', 'unicode-bidi': 'plaintext', class: 'note', mask: `url(#${id})`, opacity: 0 })
        text.style.fontSize = `${layout.size}px`
        text.textContent = line.text
        target.append(gradient, mask, text)
        return { solid, edge, text }
      })
      window.heynimbo.sendOverlayEvent({ kind: 'strokeStarted', durationMs, epoch })
      return (progress) => {
        const sample = sampleWriting(layout, at, progress)
        for (const [i, part] of parts.entries()) {
          const width = sample.widths[i]!
          const line = layout.lines[i]!
          const complete = width >= line.width
          part.text.setAttribute('opacity', width > 0 ? '1' : '0')
          part.solid.setAttribute('width', String(Math.max(0, width - 2 + (complete ? 8 : 0))))
          part.solid.setAttribute('x', String(line.rtl ? at[0] + line.width - width + (complete ? -4 : 2) : at[0] - 3))
          part.edge.setAttribute('x', String(line.rtl ? at[0] + line.width - width : at[0] + width - 5))
        }
        moveBuddy(objectPoint(owner, sample.tip), 90)
      }
    },
  }
}

function retainObject(center: Point, card?: CardState, kind: 'wash' | 'ink' | 'words' = 'words'): SceneObject {
  const owner = cardScene.retain(center, card)
  const parent = owner.card ? cardViews.get(owner.card)!.layers[kind] : kind === 'wash' ? washLayer : kind === 'ink' ? inkLayer : wordsLayer
  const node = layer('scene-object', parent)
  node.setAttribute('data-layer', kind)
  node.setAttribute('transform', `translate(${-owner.originOffset[0]} ${-owner.originOffset[1]})`)
  objectNodes.set(owner, node)
  return owner
}

function cardAction(mark: Extract<Mark, { kind: 'card' | 'model' }>, group: number): Action[] {
  if (mark.kind === 'model' && modelStages.size >= MODEL_LIMITS.cards) return []
  const card = cardScene.open(mark)
  if (!card) return []
  const root = layer('paper-card', cardsLayer)
  root.setAttribute('opacity', '0')
  root.setAttribute('data-interactive', 'false')
  const surface = element('rect', { class: 'card-surface', x: card.x, y: card.y, width: card.w, height: card.h, rx: 10 })
  const header = element('path', { class: 'card-header', d: `M${card.x + 10} ${card.y}H${card.x + card.w - 10}Q${card.x + card.w} ${card.y} ${card.x + card.w} ${card.y + 10}V${card.y + 28}H${card.x}V${card.y + 10}Q${card.x} ${card.y} ${card.x + 10} ${card.y}` })
  const patternId = `board-${nextId++}`
  const pattern = element('pattern', { id: patternId, width: 20, height: 20, patternUnits: 'userSpaceOnUse', x: card.x, y: card.y + 28 })
  if (mark.kind === 'card' && mark.board === 'grid') pattern.append(element('path', { class: 'grid-line', d: 'M20 0H0V20', fill: 'none' }))
  if (mark.kind === 'card' && mark.board === 'dots') pattern.append(element('circle', { class: 'grid-dot', cx: 1, cy: 1, r: 1 }))
  const board = element('rect', { x: card.x + 1, y: card.y + 28, width: card.w - 2, height: card.h - 29, rx: 8, fill: `url(#${patternId})` })
  const title = element('text', { class: 'card-title', x: card.x + 14, y: card.y + 19 })
  title.textContent = mark.title
  root.append(pattern, surface, board, header, title)
  const body = layer('card-body', root)
  if (mark.kind === 'model') {
    const viewport = element('foreignObject', { x: card.x + 1, y: card.y + 29, width: card.w - 2, height: card.h - 30, class: 'model-viewport' })
    const { stage, host } = modelStage(mark)
    viewport.append(host); body.append(viewport)
    modelStages.set(card, stage)
  }
  const layers = { wash: layer('wash', body), ink: layer('ink', body), words: layer('words', body) }
  cardViews.set(card, { root, surface, board, body, layers })
  while (title.getComputedTextLength() > card.w - 56 && title.textContent!.length > 1) title.textContent = title.textContent!.slice(0, -2) + '…'
  // Marks already on the paper acquire the same explicit parent once.
  for (const [object, node] of objectNodes) if (object.card === card) layers[node.getAttribute('data-layer') as 'wash' | 'ink' | 'words'].append(node)
  const owner = retainObject([card.x + card.w / 2, card.y + 14], card)
  // A model card fades in while its first part already grows; a paper card is drawn first.
  return [{ group, owner, from: owner.center, to: owner.center, seconds: mark.kind === 'model' ? 0 : 0.45, glides: mark.kind === 'model',
    begin: () => {
      root.setAttribute('data-interactive', 'true')
      wireCard(card, root)
      if (mark.kind === 'model') { cardFades.push({ node: root, start: performance.now() }); return () => {} }
      return (progress) => root.setAttribute('opacity', String(progress))
    },
  }]
}

/** The stage for a model card: one prepared from its streamed line, the warm
 *  spare, or (only if neither exists) a new one built now. */
function modelStage(mark: Extract<Mark, { kind: 'model' }>): { stage: ModelStage; host: HTMLDivElement } {
  const ready = preparedModels.get(mark.id)
  preparedModels.delete(mark.id)
  if (ready && ready.w === mark.w && ready.h === mark.h) return ready
  ready?.stage.dispose()
  const host = document.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLDivElement
  host.setAttribute('class', 'model-host')
  const stage = (spareStage ?? new ModelStage()).mount(host, {
    id: mark.id, width: mark.w - 2, height: mark.h - 30, turntable: mark.turntable, wake,
    capture: (over, captured) => reportRegion(`card:${mark.id}`, over, captured),
    overCard: (x, y) => { const card = cardScene.cards.get(mark.id); return !!card && contains(card, [x, y]) },
    trace: (until) => trace.activeUntil(until), debug: () => trace.enabled,
  })
  spareStage = undefined
  return { stage, host }
}

/** Keeps a spare stage warm so no @model waits for a context: built when the
 *  overlay loads, long before any answer, and again once a drawing is cleared.
 *  Never mid-answer: building one is a long task that would stall the pen. */
function warmSpareStage(): void {
  if (!('requestIdleCallback' in globalThis) || spareStage || modelStages.size || preparedModels.size) return
  spareStage = new ModelStage()
}

/** Streamed 3D lines: a stage per @model and each @part's geometry, ahead of their beats. */
function prepareModels(marks: Mark[]): void {
  for (const mark of marks) {
    if (mark.kind === 'model') {
      const live = cardScene.cards.get(mark.id)
      if (live || preparedModels.has(mark.id) || modelStages.size + preparedModels.size >= MODEL_LIMITS.cards) continue
      preparedModels.set(mark.id, { ...modelStage(mark), w: mark.w, h: mark.h })
    } else if (mark.kind === 'part') {
      const card = cardScene.cards.get(mark.id)
      ;(preparedModels.get(mark.id)?.stage ?? (card && modelStages.get(card)))?.prepare(mark)
    }
  }
  dressWhenIdle()
}

/** Builds waiting parts' materials and outlines between frames. */
function dressWhenIdle(): void {
  globalThis.requestIdleCallback?.((deadline) => {
    const stages = [...[...preparedModels.values()].map(({ stage }) => stage), ...modelStages.values()]
    for (const stage of stages) while (stage.waiting && deadline.timeRemaining() > 4) stage.dressNext()
    if (stages.some((stage) => stage.waiting)) dressWhenIdle()
  }, { timeout: 1000 })
}

function modelActions(mark: Extract<Mark, { kind: 'part' | 'move' | 'cut' | 'tag' }>, group: number, beat: { start: number }): Action[] {
  const card = cardScene.cards.get(mark.id)
  const model = card && modelStages.get(card)
  if (!card || card.closed || !model) return []
  const at: Point = [card.x + card.w / 2, card.y + card.h / 2]
  const owner = retainObject(at, card)
  if (mark.kind === 'part') {
    const prepared = model.graph.parts.has(mark.name)
    const part = model.prepare(mark)
    if (!part) return []
    // Grows from the moment its turn comes; the pen glides over to it while it grows.
    return [{ group, owner, from: at, to: at, seconds: 0.6, glides: true, begin: () => {
      const start = buddyAt ?? at
      if (trace.enabled && ![...model.graph.parts.values()].some((other) => other.built)) {
        console.info(`[model-timing] ${JSON.stringify({ id: card.id, part: mark.name, prepared, beatToFirstPartMs: Math.round(performance.now() - beat.start), modelLineToFirstPartMs: Math.round(performance.now() - model.mountedAt) })}`)
      }
      return (progress) => {
        const visit = (): void => {
          const point = model.project(mark.name, projected), glide = Math.min(1, progress / 0.4), eased = glide * glide * (3 - 2 * glide)
          const target = objectPoint(owner, [card.x + 1 + point[0], card.y + 29 + point[1]])
          moveBuddy([start[0] + (target[0] - start[0]) * eased, start[1] + (target[1] - start[1]) * eased], IDLE_ANGLE)
        }
        model.visit = progress < 1 ? visit : undefined
        model.reveal(part, progress); visit()
      }
    } }]
  }
  if (mark.kind === 'move') return [{ group, owner, from: at, to: at, seconds: 0, glides: true, begin: () => {
    model.move(mark, performance.now())
    return () => {}
  } }]
  if (mark.kind === 'cut') return [{ group, owner, from: at, to: at, seconds: 0.15, glides: true, begin: () => {
    model.cut(mark.axis)
    return () => {}
  } }]
  return modelTagActions(mark, group, card, model, owner)
}

/** Solves every begun label's slot against the camera the framing settles
 *  to, never the gliding one, so a slot is right once the view comes to rest.
 *  Called again only when that framing or the cut changes, not while turning. */
function layoutModelLabels(model: ModelStage, card: CardState): void {
  const labels = (modelLabels.get(model) ?? []).filter((label) => label.started && model.graph.parts.get(label.mark.part)?.built)
  if (!labels.length) return
  const [left, right] = model.labelEdges()
  const middle = (left + right) / 2, hysteresis = model.options.width * 0.12, size = labels[0]!.writing.size
  const intents = labels.map((label) => {
    // After a hand turn the view is new, so sides are chosen afresh.
    const previous = label.turned === model.turned ? label.slot?.side : undefined
    model.locate(label.mark.part, label.mark.side ?? previous)
    const [x, y] = model.projectSettled(label.mark.part, projected)
    // A side, once chosen, flips only when its anchor has moved well past the model's middle.
    // A side the answer asked for is a preference: it gives way rather than cross the whole model.
    const asked = label.mark.side && Math.abs(x - middle) > model.options.width * 0.3 && (x > middle) !== (label.mark.side === 'right') ? undefined : label.mark.side
    const side = asked ?? (previous === 'left' ? (x > middle + hysteresis ? 'right' : 'left')
      : previous === 'right' ? (x < middle - hysteresis ? 'left' : 'right') : x < middle ? 'left' : 'right')
    return { id: label.mark.part, y, side, height: label.writing.lines.length * label.writing.lineHeight }
  })
  const slots = labelSlots(intents, 14, model.options.height - 14)
  const now = performance.now(), overflow = { left: 0, right: 0 }
  for (const label of labels) {
    label.framing = model.framing; label.turned = model.turned
    const slot = slots.find((slot) => slot.id === label.mark.part)
    if (!slot) continue
    label.slot = slot
    // Sit beside the model at the words' own height, so leaders stay short.
    const first = slot.baseline - (label.writing.lines.length - 1) * label.writing.lineHeight
    const [near, far] = model.labelEdges(first - size - 6, slot.baseline + 8)
    const ideal = slot.side === 'left' ? card.x + 1 + near - label.width - 14 : card.x + 1 + far + 14
    const x = Math.max(card.x + 12, Math.min(card.x + card.w - label.width - 12, ideal))
    overflow[slot.side] = Math.max(overflow[slot.side], Math.abs(x - ideal))
    const goal: Point = [x, card.y + 29 + first]
    if (!label.words) { label.words = goal; label.goal = goal; continue }
    if (label.goal?.[0] === goal[0] && label.goal[1] === goal[1]) continue
    label.goal = goal; label.glide = { from: [...label.shift], start: now }
    model.hold(now + LABEL_GLIDE_MS)
  }
  // Words pushed against the card edge would cover the model: make the column wider and re-frame.
  model.widenReserve(overflow.left, overflow.right)
}

/** Runs after every render: moves only dots, leader endpoints and gliding word groups. */
function updateModelLeaders(model: ModelStage, card: CardState): void {
  const labels = modelLabels.get(model) ?? []
  if (labels.some((label) => label.words && (label.framing !== model.framing || label.turned !== model.turned))) layoutModelLabels(model, card)
  const now = performance.now()
  for (const label of labels) {
    if (!label.words || !label.dot) continue
    if (label.glide && label.goal) {
      const t = Math.min(1, (now - label.glide.start) / LABEL_GLIDE_MS), eased = t * t * (3 - 2 * t)
      label.shift[0] = label.glide.from[0] + (label.goal[0] - label.words[0] - label.glide.from[0]) * eased
      label.shift[1] = label.glide.from[1] + (label.goal[1] - label.words[1] - label.glide.from[1]) * eased
      label.group?.setAttribute('transform', `translate(${label.shift[0]} ${label.shift[1]})`)
      if (t === 1) label.glide = undefined
    }
    const point = model.project(label.mark.part, projected)
    const dot: Point = [card.x + 1 + point[0], card.y + 29 + point[1]]
    label.dot.setAttribute('cx', String(dot[0])); label.dot.setAttribute('cy', String(dot[1]))
    if (label.leader) {
      const end = leaderEnd(label, label.words[0] + label.shift[0], label.words[1] + label.shift[1])
      label.leader.setAttribute('d', `M${dot[0]} ${dot[1]}L${end[0]} ${end[1]}`)
    }
  }
}

/** The leader meets the words at their inner edge, just above the first baseline. */
function leaderEnd(label: ModelLabel, x: number, y: number): Point {
  return [x + (label.slot!.side === 'left' ? label.width + 4 : -4), y - 7]
}

function modelTagActions(mark: Extract<Mark, { kind: 'tag' }>, group: number, card: CardState, model: ModelStage, owner: SceneObject): Action[] {
  const labels = modelLabels.get(model) ?? []
  if (labels.length >= MODEL_LIMITS.tags || labels.some((label) => label.mark.part === mark.part) || !model.graph.parts.has(mark.part)) return []
  const writing = wrapWriting(mark.text, model.labelWidth, 20, measureWriting(20), 2)
  const label: ModelLabel = { mark, owner, writing, width: Math.max(...writing.lines.map((line) => line.width)), started: false, shift: [0, 0], framing: -1, turned: model.turned }
  labels.push(label); modelLabels.set(model, labels)
  model.afterRender = () => updateModelLeaders(model, card)
  const at = owner.center
  return [
    { group, owner, from: at, to: at, seconds: 0.15, begin: () => {
      label.started = true
      layoutModelLabels(model, card)
      if (!label.words) { console.warn(`[drawing] model ${card.id}: no readable label slot for ${mark.part}`); return () => {} }
      label.group = layer('model-label', objectNodes.get(owner)!)
      label.dot = element('circle', { class: 'leader-dot', r: 0 })
      objectNodes.get(owner)!.append(label.dot)
      updateModelLeaders(model, card)
      return (progress) => {
        label.dot!.setAttribute('r', String(2.8 * progress))
        const point = model.project(mark.part, projected)
        moveBuddy(objectPoint(owner, [card.x + 1 + point[0], card.y + 29 + point[1]]), IDLE_ANGLE)
      }
    } },
    { group, owner, from: at, to: at, seconds: 0.28, begin: () => {
      if (!label.words) return () => {}
      label.leader = element('path', { class: 'model-leader', pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-dashoffset': 1 })
      objectNodes.get(owner)!.append(label.leader)
      updateModelLeaders(model, card)
      return (progress) => {
        label.leader!.setAttribute('stroke-dashoffset', String(1 - progress))
        const point = model.project(mark.part, projected)
        const near = leaderEnd(label, label.goal![0], label.goal![1])
        const dot: Point = [card.x + 1 + point[0], card.y + 29 + point[1]]
        moveBuddy(objectPoint(owner, [dot[0] + (near[0] - dot[0]) * progress, dot[1] + (near[1] - dot[1]) * progress]), IDLE_ANGLE)
      }
    } },
    { group, owner, from: at, to: at, seconds: writingDuration(mark.text), begin: (duration) => label.words && label.group ? writingAction(writing, label.words, group, owner, label.group).begin(duration) : () => {} },
  ]
}

function flowActions(mark: Extract<Mark, { kind: 'step' | 'heading' | 'note' }>, group: number): Action[] {
  const card = cardScene.cards.get(mark.id)
  if (!card || card.closed) return []
  const layout = layoutFlow(card, mark.kind, mark.text, measureWriting(mark.kind === 'heading' ? 30 : 26), innerHeight)
  if (!layout) return []
  const view = cardViews.get(card)!
  const owner = retainObject(layout.words, card)
  const writing = writingAction(layout.writing, layout.words, group, owner)
  // Resize on the owning beat, not when a later beat is merely queued.
  const height = card.h
  const grow = (action: Action): Action => ({ ...action, begin: (duration) => {
    view.surface.setAttribute('height', String(Math.max(Number(view.surface.getAttribute('height')), height)))
    view.board.setAttribute('height', String(Math.max(Number(view.board.getAttribute('height')), height - 29)))
    return action.begin(duration)
  } })
  if (mark.kind !== 'step') return [grow(writing)]
  const badge = badgeAction(layout.badge, layout.number, group, owner)
  const [cx, cy] = layout.arrow
  const delta: Point = mark.direction === 'up' ? [0, -15] : mark.direction === 'down' ? [0, 15] : mark.direction === 'left' ? [-15, 0] : [15, 0]
  const arrow: Mark = { kind: 'arrow', x1: cx - delta[0], y1: cy - delta[1], x2: cx + delta[0], y2: cy + delta[1] }
  const strokes = strokesFor(arrow, true).map((stroke) => strokeAction(geometryFor({ ...stroke, style: 'paper', size: 2.2 }), group, owner, `var(--${mark.color})`))
  return [grow(badge), ...strokes, writing]
}

function badgeAction(at: Point, number: number, group: number, owner: SceneObject): Action {
  return { group, owner, from: at, to: at, seconds: 0.22, begin: () => {
    const disc = layer('badge', objectNodes.get(owner)!)
    disc.append(element('circle', { class: 'badge-disc', r: BADGE_RADIUS }), element('ellipse', { class: 'gel-gloss', cy: -4, rx: 7, ry: 3 }))
    const digit = element('text', { y: 4, 'text-anchor': 'middle' })
    digit.textContent = String(number)
    disc.append(digit)
    return (progress) => {
      disc.setAttribute('opacity', String(Math.min(1, progress * 3)))
      disc.setAttribute('transform', `translate(${at[0]} ${at[1]}) scale(${progress === 1 ? 1 : 0.65 + 0.35 * progress + 0.12 * Math.sin(Math.PI * progress)})`)
      moveBuddy(objectPoint(owner, at), IDLE_ANGLE)
    }
  } }
}

function leaderActions(mark: Extract<Mark, { kind: 'label' }>, group: number, owner: SceneObject): Action[] {
  const writing = wrapWriting(mark.text, Math.min(250, innerWidth - 16), 26, measureWriting(26), 2)
  const width = Math.max(...writing.lines.map((line) => line.width))
  const left = Math.max(8, Math.min(innerWidth - width - 8, mark.lx))
  const baseline = Math.max(32, Math.min(innerHeight - writing.lines.length * writing.lineHeight, mark.ly))
  const dot: Point = [mark.x, mark.y]
  const near: Point = [mark.x < left + width / 2 ? left - 5 : left + width + 5, baseline - 8]
  // Dot first establishes the feature; drawing back to the words leaves the pen
  // beside its next writing start, without an arrowhead or a second label pill.
  return [
    { group, owner, from: dot, to: dot, seconds: 0.18, begin: () => {
      const circle = element('circle', { class: 'leader-dot', cx: dot[0], cy: dot[1], r: 0 })
      objectNodes.get(owner)!.append(circle)
      return (progress) => { circle.setAttribute('r', String(3 * progress)); moveBuddy(objectPoint(owner, dot), IDLE_ANGLE) }
    } },
    strokeAction(geometryFor({ points: [dot, near], style: 'paper', size: 1.4 }), group, owner, 'var(--ink)'),
    writingAction(writing, [left, baseline], group, owner),
  ]
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

function showLabel(x: number, y: number, label: string, parent: SVGGElement): SVGGElement {
  const group = element('g', { class: 'label', opacity: 0 })
  const text = element('text', { x: 11, y: 19 })
  text.textContent = label
  const id = `gel-${nextId++}`
  const gradient = element('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 })
  gradient.append(element('stop', { class: 'gel-top', offset: 0 }), element('stop', { class: 'gel-middle', offset: 0.52 }), element('stop', { class: 'gel-bottom', offset: 1 }))
  const background = element('rect', { class: 'gel-rim', rx: 14, height: 28, width: 0, fill: `url(#${id})` })
  const gloss = element('rect', { class: 'gel-gloss', x: 3, y: 2, rx: 10, height: 10, width: 0 })
  group.append(gradient, background, gloss, text)
  parent.append(group)
  // Measure the system face in place, shortening only if wider than the display.
  while (text.getComputedTextLength() > innerWidth - 38 && label.length > 1) {
    label = Array.from(label).slice(0, -1).join('')
    text.textContent = label + '…'
  }
  const width = text.getComputedTextLength() + 22
  background.setAttribute('width', String(width))
  gloss.setAttribute('width', String(Math.max(0, width - 6)))
  const height = 28
  const candidates = [[x - width / 2, y - height - 12], [x - width / 2, y + 14], [x + 14, y - height / 2], [x - width - 14, y - height / 2]]
    .map(([left, top]) => ({ x: Math.max(8, Math.min(innerWidth - width - 8, left!)), y: Math.max(8, Math.min(innerHeight - height - 8, top!)), w: width, h: height }))
  const chosen = candidates.find((box) => !pillBoxes.some((other) => other.node.isConnected && box.x < other.x + other.w + 4 && box.x + box.w + 4 > other.x && box.y < other.y + other.h + 4 && box.y + box.h + 4 > other.y)) ?? candidates[0]!
  group.setAttribute('transform', `translate(${chosen.x} ${chosen.y})`)
  pillBoxes.push({ ...chosen, node: group })
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
  const beat = { start: 0 }
  for (const [group, mark] of marks.entries()) {
    if (mark.kind === 'clear') {
      clearScene()
      animations.length = 0
      actions.length = 0
    } else if (mark.kind === 'card' || mark.kind === 'model') actions.push(...cardAction(mark, group))
    else if (mark.kind === 'part' || mark.kind === 'move' || mark.kind === 'cut' || mark.kind === 'tag') actions.push(...modelActions(mark, group, beat))
    else if (mark.kind === 'heading' || mark.kind === 'note' || mark.kind === 'step') actions.push(...flowActions(mark, group))
    else {
      const owner = retainObject(markCenter(mark)!, undefined, mark.kind === 'highlight' ? 'wash' : ['text', 'label', 'point'].includes(mark.kind) ? 'words' : 'ink')
      if (mark.kind === 'point') {
        actions.push({
          group, owner, from: [mark.x, mark.y], to: [mark.x, mark.y], seconds: 0.18,
          begin: () => {
            const label = mark.label ? showLabel(mark.x, mark.y, mark.label, objectNodes.get(owner)!) : undefined
            return (progress) => { moveBuddy(objectPoint(owner, [mark.x, mark.y]), IDLE_ANGLE); label?.setAttribute('opacity', String(progress)) }
          },
        })
      } else if (mark.kind === 'text') {
        const size = 26
        const left = Math.max(8, Math.min(innerWidth - 80, mark.x))
        const writing = wrapWriting(mark.text, Math.max(60, Math.min(360, innerWidth - left - 8)), size, measureWriting(size), Math.max(1, Math.floor((innerHeight - mark.y) / (size * 1.3)) + 1))
        actions.push(writingAction(writing, [left, Math.max(size, mark.y)], group, owner))
      } else if (mark.kind === 'label') actions.push(...leaderActions(mark, group, owner))
      else for (const stroke of strokesFor(mark, !!owner.card)) actions.push(strokeAction(geometryFor(owner.card && stroke.style === 'pen' ? { ...stroke, style: 'paper' } : stroke), group, owner))
    }
  }
  const now = performance.now()
  const start = Math.max(now, animations.length ? plannedEnd : 0)
  beat.start = start
  // Time spent queued behind earlier beats comes out of this beat's budget.
  const timeline = scheduleBeat(actions, origin, beatBudget(durationMs, start - now))
  for (const entry of timeline) {
    if (entry.kind === 'gesture') {
      const action = actions[entry.index]!
      animations.push({ owner: action.owner, start: start + entry.startMs, durationMs: entry.durationMs, begin: action.begin })
    } else {
      const next = timeline[timeline.indexOf(entry) + 1]
      const owner = next?.kind === 'gesture' ? actions[next.index]!.owner : undefined
      animations.push({ owner, start: start + entry.startMs, durationMs: entry.durationMs, begin: () => {
        const from = buddyAt ?? entry.from
        return (progress) => flight(from, objectPoint(owner, entry.to))(progress)
      } })
    }
  }
  const end = timeline.at(-1)
  plannedEnd = start + (end ? end.startMs + end.durationMs : 0)
  plannedTip = actions.at(-1)?.to ?? origin
  trace.activeUntil(plannedEnd)
  wake()
}

function warnOmissions(card: CardState): void {
  if (!card.omittedSteps || warnedOmissions.has(card)) return
  warnedOmissions.add(card)
  console.warn(`[drawing] card ${card.id}: omitted ${card.omittedSteps} step(s); no readable slot fits the display.`)
}

function clearScene(): void {
  for (const model of modelStages.values()) model.dispose()
  modelStages.clear()
  for (const { stage } of preparedModels.values()) stage.dispose()
  preparedModels.clear()
  cardFades.length = 0
  // The next answer's stage warms once this one's teardown has settled.
  setTimeout(() => globalThis.requestIdleCallback?.(warmSpareStage, { timeout: 4000 }), 1500)
  modelLabels.clear()
  for (const card of cardScene.cards.values()) warnOmissions(card)
  warnedOmissions.clear()
  for (const release of releaseDrags.values()) release()
  releaseDrags.clear()
  for (const id of [...regions.keys()]) reportRegion(id, false, false)
  cardScene.clear()
  pillBoxes.length = 0
  objectNodes.clear()
  cardViews.clear()
  for (const group of [cardsLayer, ringLayer, washLayer, inkLayer, wordsLayer]) group.replaceChildren()
}

/** Shows the Clear button at the drawing's top-right corner, kept on screen. */
function offerClear(): void {
  for (const card of cardScene.cards.values()) warnOmissions(card)
  const box = [cardsLayer, washLayer, inkLayer, wordsLayer]
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

function reportRegion(id: string, over: boolean, captured: boolean): void {
  if (over || captured) regions.set(id, { over, captured })
  else regions.delete(id)
  window.heynimbo.sendOverlayEvent({ kind: 'interactiveRegion', id, over, captured })
}

function wireRegion(node: Element, id: string): void {
  node.addEventListener('pointerenter', () => reportRegion(id, true, regions.get(id)?.captured ?? false))
  node.addEventListener('pointerleave', () => reportRegion(id, false, regions.get(id)?.captured ?? false))
}

function wireCard(card: CardState, root: SVGGElement): void {
  const id = `card:${card.id}`
  wireRegion(root, id)
  const handle = element('rect', { class: 'card-drag', x: card.x, y: card.y, width: card.w - 32, height: 28, rx: 10 })
  const close = element('g', { class: 'card-close' })
  const closeHit = element('rect', { x: card.x + card.w - 29, y: card.y + 3, width: 24, height: 22, rx: 7 })
  const cross = element('text', { x: card.x + card.w - 17, y: card.y + 19, 'text-anchor': 'middle' })
  cross.textContent = '×'
  close.append(closeHit, cross)
  root.append(handle, close)
  let drag: { pointer: number; x: number; y: number; offset: Point } | undefined
  const release = (): void => {
    const pointer = drag?.pointer
    drag = undefined
    if (pointer !== undefined && handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
  }
  releaseDrags.set(card, release)
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, offset: [...card.offset] }
    handle.setPointerCapture(event.pointerId)
    reportRegion(id, true, true)
  })
  handle.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return
    card.offset = [
      Math.max(2 - card.x, Math.min(innerWidth - card.x - card.w - 2, drag.offset[0] + event.clientX - drag.x)),
      Math.max(2 - card.y, Math.min(innerHeight - card.y - card.h - 2, drag.offset[1] + event.clientY - drag.y)),
    ]
    root.setAttribute('transform', `translate(${card.offset[0]} ${card.offset[1]})`)
  })
  const finish = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointer) return
    release()
    const over = event.clientX >= card.x + card.offset[0] && event.clientX <= card.x + card.offset[0] + card.w && event.clientY >= card.y + card.offset[1] && event.clientY <= card.y + card.offset[1] + card.h
    reportRegion(id, over, false)
  }
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', () => { release(); reportRegion(id, false, false) })
  handle.addEventListener('lostpointercapture', () => { if (drag) { drag = undefined; reportRegion(id, false, false) } })
  close.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation() })
  close.addEventListener('click', () => {
    release()
    releaseDrags.delete(card)
    warnOmissions(card)
    cardScene.close(card.id)
    const model = modelStages.get(card)
    if (model) { model.dispose(); modelLabels.delete(model) }
    modelStages.delete(card)
    root.remove()
    cardViews.delete(card)
    for (const [object, node] of objectNodes) if (object.removed) { node.remove(); objectNodes.delete(object) }
    for (let i = animations.length - 1; i >= 0; i--) if (animations[i]!.owner?.removed) animations.splice(i, 1)
    plannedTip = undefined
    reportRegion(id, false, false)
    hideClear()
    offerClear()
    wake()
  })
}

function hideClear(): void {
  if (clearButton.hidden) return
  clearButton.hidden = true
  reportRegion('clear', false, false)
}

wireRegion(clearButton, 'clear')
clearButton.addEventListener('click', () => {
  hideClear()
  window.heynimbo.sendOverlayEvent({ kind: 'clearClicked' })
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
    case 'prepare':
      return prepareModels(command.marks)
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

let fontsReady = false
const waitingCommands: OverlayCommand[] = []
window.heynimbo.onOverlayCommand((command) => fontsReady ? apply(command) : waitingCommands.push(command))
void document.fonts.load('500 26px Caveat').then(() => document.fonts.ready).then(() => {
  fontsReady = true
  warmSpareStage()
  for (const command of waitingCommands) apply(command)
  waitingCommands.length = 0
})
