import type { SemanticColor } from './beats'

/** All untrusted model resource limits, in world units unless noted. */
export const MODEL_LIMITS = {
  // Placements per model and per line: a designed model is hundreds of parts, mostly repeats.
  cards: 2, parts: 1200, repeats: 64, points: 200, labelCharacters: 40, tags: 8,
  dimension: 12, coordinate: 24, scale: 4, coils: 12, teeth: 32,
  verticesPerPart: 16_384, verticesPerModel: 1_500_000, commands: 180,
  minDimension: 0.004, minPeriod: 0.5, maxPeriod: 60, dpr: 2,
} as const
export type Vec3 = [number, number, number]
export type ModelMaterial = 'steel' | 'brass' | 'copper' | 'rubber' | 'glass' | 'water' | 'wood' | 'plastic' | 'paper' | 'glow' | 'paint' | 'tissue' | 'rock' | 'soil'
/** The 2D semantic colours plus three that only 3D surfaces need. */
export type ModelColor = SemanticColor | 'yellow' | 'brown' | 'white'
export type PartShape = 'box' | 'cylinder' | 'tube' | 'cone' | 'sphere' | 'torus' | 'capsule' | 'spring' | 'gear' | 'pipe' | 'lathe' | 'extrude' | 'blob'
  /** No geometry: a pivot that its children follow and that a spin turns. */
  | 'group'
/** A designed surface: exact colour (0xrrggbb) and physical finish instead of a named material. */
export interface PartFinish { color: number; metalness: number; roughness: number; opacity?: number; emission?: number }
export type Axis = 'x' | 'y' | 'z'
export interface PartMark {
  kind: 'part'; id: string; name: string; shape: PartShape
  dimensions: Record<string, number>
  at: Vec3; turn: Vec3; scale: number; parent?: string
  copies: number; step: Vec3; around: boolean
  mat: ModelMaterial; color?: ModelColor; half: boolean
  points?: Vec3[]; profile?: Array<[number, number]>
  /** An extrude's closed 2D outline, smoothed through its points when `smooth`. */
  outline?: Array<[number, number]>; smooth?: boolean
  /** A pipe's radius at each point, for tapering limbs, tails and stems. */
  radii?: number[]
  /** A polish pass's new version of a part: the old part (and the parts in it) come off as this one starts to grow. */
  replaces?: string
  /** Each copy's own place and turn, for repeats around any axis; overrides copies/step/around. */
  instances?: Array<{ at: Vec3; turn: Vec3 }>
  finish?: PartFinish
}
export type ModelCommand = PartMark
  | { kind: 'move'; id: string; part: string; motion: 'spin' | 'bob' | 'slide' | 'orbit'; axis: Axis; amount: number; period: number }
  | { kind: 'cut'; id: string; axis: Axis | 'view' }
  | { kind: 'tag'; id: string; part: string; text: string; side?: 'left' | 'right' }
  /** Takes a part (and the parts inside it) off the model: only the designer's polish pass sends it. */
  | { kind: 'remove'; id: string; part: string }

// Part names describe anatomy ("pulmonary-vein-left"), so they may be longer than a card ID; a model
// ID longer than 16 still matches no @model and drops its line.
const NAME = '[a-z0-9-]{1,32}'
const defaults: Record<PartShape, Record<string, number>> = {
  box: { w: 1, h: 1, d: 1, round: 0 }, cylinder: { r: 0.5, h: 1, top: 0.5 },
  tube: { r: 0.5, inner: 0.35, h: 1 }, cone: { r: 0.5, h: 1 }, sphere: { r: 0.5 },
  torus: { r: 0.5, tube: 0.1 }, capsule: { r: 0.25, h: 1 },
  spring: { r: 0.4, h: 1, coils: 5, wire: 0.04 }, gear: { r: 0.5, teeth: 12, w: 0.15, hole: 0.1 },
  pipe: { r: 0.08 }, lathe: {}, extrude: { d: 0.2, round: 0.02 }, blob: { w: 1, h: 1, d: 1, lumps: 0.1, seed: 1, taper: 0 }, group: {},
}
/** Bounds for keys that are not plain sizes; whole-number keys are rounded first. */
const ranges: Record<string, [number, number]> = {
  round: [0, MODEL_LIMITS.dimension], top: [0, MODEL_LIMITS.dimension], hole: [0, MODEL_LIMITS.dimension],
  teeth: [3, MODEL_LIMITS.teeth], coils: [3, MODEL_LIMITS.coils], lumps: [0, 0.4], taper: [-0.9, 0.9], seed: [1, 999],
}
const counted = new Set(['teeth', 'coils', 'seed'])
/** Near-misses an author is likely to write. Anything else still drops only its own line. */
const shapeAliases: Record<string, PartShape> = {
  cube: 'box', block: 'box', plate: 'box', slab: 'box', rod: 'cylinder', disc: 'cylinder', disk: 'cylinder', shaft: 'cylinder',
  ring: 'torus', ball: 'sphere', dome: 'sphere', pill: 'capsule', coil: 'spring', cog: 'gear', hose: 'pipe', wire: 'pipe',
  prism: 'extrude', outline: 'extrude', silhouette: 'extrude', ellipsoid: 'blob', egg: 'blob', lump: 'blob', organic: 'blob',
}
const keyAliases: Record<string, string> = {
  pos: 'at', position: 'at', rot: 'turn', rotate: 'turn', rotation: 'turn', parent: 'in', material: 'mat', colour: 'color',
  radius: 'r', height: 'h', length: 'h', width: 'w', depth: 'd', count: 'copies', ring: 'around',
}
const materialAliases: Record<string, ModelMaterial> = {
  metal: 'steel', iron: 'steel', chrome: 'steel', silver: 'steel', aluminum: 'steel', aluminium: 'steel', gold: 'brass', bronze: 'brass',
  light: 'glow', fire: 'glow', flame: 'glow', lava: 'glow', magma: 'glow', painted: 'paint', ceramic: 'paint', fabric: 'paint',
  skin: 'tissue', flesh: 'tissue', organic: 'tissue', leaf: 'tissue', stone: 'rock', concrete: 'rock', dirt: 'soil', earth: 'soil', sand: 'soil', ice: 'glass',
}
const colorAliases: Record<string, ModelColor> = {
  gray: 'grey', pink: 'red', teal: 'green', cyan: 'blue', violet: 'purple', gold: 'yellow', tan: 'brown', beige: 'brown', cream: 'white', silver: 'grey', black: 'grey',
}
const materials = new Set('steel brass copper rubber glass water wood plastic paper glow paint tissue rock soil'.split(' '))
const colors = new Set('blue red orange green purple grey yellow brown white'.split(' '))
const number = (text: string | undefined): number => text !== undefined && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n))
function vector(text: string | undefined): Vec3 | undefined {
  const n = text?.split(',').map(number)
  return n?.length === 3 && n.every(Number.isFinite) ? n.map((v) => clamp(v, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)) as Vec3 : undefined
}
/** Degrees, wrapped into one turn either way. */
function angles(text: string | undefined): Vec3 {
  const n = text?.split(',').map(number)
  return n?.length === 3 && n.every(Number.isFinite) ? n.map((v) => v - 360 * Math.trunc(v / 360)) as Vec3 : [0, 0, 0]
}
/** key=value pairs; malformed tokens are skipped and the last duplicate wins. */
function keys(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  for (const token of text.trim().split(/\s+/)) {
    const match = /^([A-Za-z]+)=([^\s=]+)$/.exec(token)
    if (match) result[keyAliases[match[1]!.toLowerCase()] ?? match[1]!.toLowerCase()] = match[2]!
  }
  return result
}

/** Conservative vertex reservations include outlines; actual geometry is checked again. */
export function partVertexCost(part: PartMark): number {
  const perCopy = part.shape === 'group' ? 0 : part.shape === 'box' ? 1200
    : part.shape === 'spring' ? 500 + part.dimensions.coils! * 400
    : part.shape === 'pipe' ? 500 + (part.points?.length ?? 0) * 300
    : part.shape === 'gear' ? 900 + part.dimensions.teeth! * 220
    : part.shape === 'lathe' ? 600 + (part.profile?.length ?? 0) * 250
    : part.shape === 'extrude' ? 700 + (part.outline?.length ?? 0) * 350 : 2500
  return perCopy * part.copies
}

export function parseModelCommand(line: string): ModelCommand | undefined {
  const tag = new RegExp(`^@tag (${NAME}) (${NAME}) "([^"\\n]+)"(?: (left|right))?$`).exec(line)
  if (tag) {
    const text = Array.from(tag[3]!.trim())
    if (!text.length) return
    const words = text.length <= MODEL_LIMITS.labelCharacters ? text.join('') : `${text.slice(0, MODEL_LIMITS.labelCharacters - 1).join('').trimEnd()}…`
    return { kind: 'tag', id: tag[1]!, part: tag[2]!, text: words, ...(tag[4] && { side: tag[4] as 'left' | 'right' }) }
  }
  const cut = new RegExp(`^@cut (${NAME})(?: (x|y|z|view|side|top|front))?$`).exec(line)
  if (cut) return { kind: 'cut', id: cut[1]!, axis: ({ side: 'x', top: 'y', front: 'z' } as Record<string, Axis>)[cut[2]!] ?? (cut[2] as Axis | 'view' | undefined) ?? 'view' }
  const move = new RegExp(`^@move (${NAME}) (${NAME}) (spin|bob|slide|orbit)(.*)$`).exec(line)
  if (move) {
    const p = keys(move[4]!), spin = move[3] === 'spin'
    const amount = number(p.amount), period = number(p.period)
    const reach = spin ? 360 : MODEL_LIMITS.dimension
    return {
      kind: 'move', id: move[1]!, part: move[2]!, motion: move[3] as 'spin' | 'bob' | 'slide' | 'orbit',
      axis: (['x', 'y', 'z'].includes(p.axis ?? '') ? p.axis : 'y') as Axis,
      amount: Number.isFinite(amount) ? clamp(amount, -reach, reach) : spin ? 360 : 0.5,
      period: Number.isFinite(period) ? clamp(period, MODEL_LIMITS.minPeriod, MODEL_LIMITS.maxPeriod) : 4,
    }
  }
  return parsePart(line)
}

/** Out-of-range values are clamped and unknown keys ignored, so a near-miss
 *  keeps its part, and the children and tags that refer to it. */
function parsePart(line: string): PartMark | undefined {
  const match = new RegExp(`^@part (${NAME}) (${NAME}) ([A-Za-z]+)(.*)$`).exec(line)
  const written = match?.[3]!.toLowerCase() ?? ''
  const shape = Object.hasOwn(defaults, written) ? written as PartShape : shapeAliases[written]
  if (!match || !shape) return
  const p = keys(match[4]!)
  const dimensions = { ...defaults[shape] }
  if (shape === 'cylinder' && !p.top) dimensions.top = Number.isFinite(number(p.r)) ? number(p.r) : dimensions.r!
  for (const key of Object.keys(dimensions)) {
    const n = number(p[key])
    if (!Number.isFinite(n)) continue
    const [low, high] = ranges[key] ?? [MODEL_LIMITS.minDimension, MODEL_LIMITS.dimension]
    dimensions[key] = clamp(counted.has(key) ? Math.round(n) : n, low, high)
  }
  const d = dimensions
  if (shape === 'tube') d.inner = Math.min(d.inner!, d.r! * 0.92)
  if (shape === 'gear') d.hole = Math.min(d.hole!, d.r! * 0.6)
  if (shape === 'torus') d.tube = Math.min(d.tube!, d.r! * 0.9)
  if (shape === 'spring') d.wire = Math.min(d.wire!, d.r! * 0.5)
  if (shape === 'box') d.round = Math.min(d.round!, Math.min(d.w!, d.h!, d.d!) / 2)
  if (shape === 'extrude') d.round = Math.min(d.round!, d.d! / 2)
  const around = p.around !== undefined
  const copies = clamp(Math.round(number(p.around ?? p.copies) || 1), 1, MODEL_LIMITS.repeats)
  const at = vector(p.at) ?? [0, 0, 0], step = around ? [0, 0, 0] as Vec3 : vector(p.step) ?? [0, 0, 0]
  // Repetition may not escape the same bounded local coordinate box.
  if (copies > 1) for (let i = 0; i < 3; i++) step[i] = clamp(step[i]!, (-MODEL_LIMITS.coordinate - at[i]!) / (copies - 1), (MODEL_LIMITS.coordinate - at[i]!) / (copies - 1))
  const scale = Number.isFinite(number(p.scale)) ? clamp(number(p.scale), MODEL_LIMITS.minDimension, MODEL_LIMITS.scale) : 1
  // Without a material, organic forms default to tissue and everything else to
  // paint, which the renderer gives a soft colour of its own per part.
  const mat = p.mat?.toLowerCase() ?? (shape === 'blob' ? 'tissue' : 'paint'), color = p.color?.toLowerCase() ?? ''
  const tint = colors.has(color) ? color as ModelColor : colorAliases[color]
  const parent = p.in && new RegExp(`^${NAME}$`).test(p.in) ? p.in : undefined
  const part: PartMark = {
    kind: 'part', id: match[1]!, name: match[2]!, shape, dimensions, at, turn: angles(p.turn), scale, copies, step, around,
    mat: materials.has(mat) ? mat as ModelMaterial : materialAliases[mat] ?? 'paint',
    half: written === 'dome' || ['true', 'yes', '1'].includes(p.half ?? ''),
    ...(parent && { parent }), ...(tint && { color: tint }),
  }
  const pairs = (text: string | undefined, size: number): number[][] =>
    (text?.split(';') ?? []).map((row) => row.split(',').map(number)).filter((row) => row.length === size && row.every(Number.isFinite))
      .filter((row, i, rows) => i === 0 || row.some((v, j) => v !== rows[i - 1]![j])).slice(0, MODEL_LIMITS.points)
  if (shape === 'pipe') {
    const points = pairs(p.points, 3).map((row) => row.map((v) => clamp(v, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)) as Vec3)
    if (points.length < 2) return
    part.points = points
  }
  if (shape === 'extrude') {
    const outline = pairs(p.points, 2).map(([x, y]) => [clamp(x!, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate), clamp(y!, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)] as [number, number])
    // An outline needs some area; a line or a point would extrude to nothing.
    let area = 0
    for (let i = 0; i < outline.length; i++) { const [x0, y0] = outline[i]!, [x1, y1] = outline[(i + 1) % outline.length]!; area += x0 * y1 - x1 * y0 }
    if (outline.length < 3 || Math.abs(area) < 1e-6) return
    part.outline = outline; part.smooth = ['true', 'yes', '1'].includes(p.smooth ?? '')
  }
  if (shape === 'lathe') {
    const profile = pairs(p.profile, 2).map(([r, y]) => [clamp(r!, 0, MODEL_LIMITS.dimension), clamp(y!, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)] as [number, number])
    if (profile.length < 2 || !profile.some(([r]) => r > 0)) return
    part.profile = profile
  }
  return partVertexCost(part) / copies <= MODEL_LIMITS.verticesPerPart ? part : undefined
}

/** Answer-local references are checked before marks reach the renderer. */
export class ModelRegistry {
  readonly models = new Map<string, { names: Set<string>; count: number; vertices: number; tags: Set<string> }>()
  private opened = 0
  open(id: string): boolean {
    if (this.opened >= MODEL_LIMITS.cards || this.models.has(id)) return false
    this.models.set(id, { names: new Set(), count: 0, vertices: 0, tags: new Set() }); this.opened++
    return true
  }
  accept(mark: ModelCommand): boolean {
    const model = this.models.get(mark.id)
    if (!model) return false
    if (mark.kind === 'part') {
      const cost = partVertexCost(mark)
      if (model.names.has(mark.name) || (mark.parent && !model.names.has(mark.parent)) || model.count + mark.copies > MODEL_LIMITS.parts || model.vertices + cost > MODEL_LIMITS.verticesPerModel) return false
      model.names.add(mark.name); model.count += mark.copies; model.vertices += cost
    } else if (mark.kind === 'tag') {
      if (!model.names.has(mark.part) || model.tags.has(mark.part) || model.tags.size >= MODEL_LIMITS.tags) return false
      model.tags.add(mark.part)
    } else if (mark.kind === 'move' && !model.names.has(mark.part)) return false
    return true
  }
  clear(): void { this.models.clear() }
}
