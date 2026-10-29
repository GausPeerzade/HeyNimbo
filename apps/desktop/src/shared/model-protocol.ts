import type { SemanticColor } from './beats'

/** All untrusted model resource limits, in world units unless noted. */
export const MODEL_LIMITS = {
  cards: 2, parts: 40, repeats: 12, points: 16, labelCharacters: 40, tags: 8,
  dimension: 12, coordinate: 24, scale: 4, coils: 12, teeth: 32,
  verticesPerPart: 8192, verticesPerModel: 100_000, commands: 180,
  minDimension: 0.01, minPeriod: 0.5, maxPeriod: 60, dpr: 2,
} as const
export type Vec3 = [number, number, number]
export type ModelMaterial = 'steel' | 'brass' | 'copper' | 'rubber' | 'glass' | 'water' | 'wood' | 'plastic' | 'paper' | 'glow'
export type PartShape = 'box' | 'cylinder' | 'tube' | 'cone' | 'sphere' | 'torus' | 'capsule' | 'spring' | 'gear' | 'pipe' | 'lathe'
export type Axis = 'x' | 'y' | 'z'
export interface PartMark {
  kind: 'part'; id: string; name: string; shape: PartShape
  dimensions: Record<string, number>
  at: Vec3; turn: Vec3; scale: number; parent?: string
  copies: number; step: Vec3; around: boolean
  mat: ModelMaterial; color?: SemanticColor; half: boolean
  points?: Vec3[]; profile?: Array<[number, number]>
}
export type ModelCommand = PartMark
  | { kind: 'move'; id: string; part: string; motion: 'spin' | 'bob' | 'slide' | 'orbit'; axis: Axis; amount: number; period: number }
  | { kind: 'cut'; id: string; axis: Axis | 'view' }
  | { kind: 'tag'; id: string; part: string; text: string; side?: 'left' | 'right' }

const NAME = '[a-z0-9-]{1,16}'
const defaults: Record<PartShape, Record<string, number>> = {
  box: { w: 1, h: 1, d: 1, round: 0 }, cylinder: { r: 0.5, h: 1, top: 0.5 },
  tube: { r: 0.5, inner: 0.35, h: 1 }, cone: { r: 0.5, h: 1 }, sphere: { r: 0.5 },
  torus: { r: 0.5, tube: 0.1 }, capsule: { r: 0.25, h: 1 },
  spring: { r: 0.4, h: 1, coils: 5, wire: 0.04 }, gear: { r: 0.5, teeth: 12, w: 0.15, hole: 0.1 },
  pipe: { r: 0.08 }, lathe: {},
}
const materials = new Set('steel brass copper rubber glass water wood plastic paper glow'.split(' '))
const colors = new Set('blue red orange green purple grey'.split(' '))
const number = (text: string): number => /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN
const bounded = (n: number, low: number, high: number): boolean => Number.isFinite(n) && n >= low && n <= high
function vector(text: string): Vec3 | undefined {
  const n = text.split(',').map(number)
  return n.length === 3 && n.every((v) => bounded(v, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)) ? n as Vec3 : undefined
}
function keys(text: string): Record<string, string> | undefined {
  const result: Record<string, string> = Object.create(null)
  for (const token of text.trim().split(/\s+/).filter(Boolean)) {
    const match = /^([a-z]+)=([^\s=]+)$/.exec(token)
    if (!match || match[1]! in result) return
    result[match[1]!] = match[2]!
  }
  return result
}

/** Conservative vertex reservations include outlines; actual geometry is checked again. */
export function partVertexCost(part: PartMark): number {
  const perCopy = part.shape === 'box' ? (part.dimensions.round! > 0 ? 5000 : 500)
    : part.shape === 'spring' ? 500 + part.dimensions.coils! * 400
    : part.shape === 'pipe' ? 500 + (part.points?.length ?? 0) * 300
    : part.shape === 'gear' ? 500 + part.dimensions.teeth! * 220
    : part.shape === 'lathe' ? 500 + (part.profile?.length ?? 0) * 160 : 2500
  return perCopy * part.copies
}

export function parseModelCommand(line: string): ModelCommand | undefined {
  const tag = new RegExp(`^@tag (${NAME}) (${NAME}) "([^"\\n]+)"(?: (left|right))?$`).exec(line)
  if (tag) return Array.from(tag[3]!.trim()).length <= MODEL_LIMITS.labelCharacters && tag[3]!.trim()
    ? { kind: 'tag', id: tag[1]!, part: tag[2]!, text: tag[3]!.trim(), ...(tag[4] && { side: tag[4] as 'left' | 'right' }) } : undefined
  const cut = new RegExp(`^@cut (${NAME}) (x|y|z|view)$`).exec(line)
  if (cut) return { kind: 'cut', id: cut[1]!, axis: cut[2] as Axis | 'view' }
  const move = new RegExp(`^@move (${NAME}) (${NAME}) (spin|bob|slide|orbit)(.*)$`).exec(line)
  if (move) {
    const p = keys(move[4]!)
    if (!p || Object.keys(p).some((k) => !['axis', 'amount', 'period'].includes(k))) return
    const axis = p.axis ?? 'y', amount = number(p.amount ?? (move[3] === 'spin' ? '360' : '0.5')), period = number(p.period ?? '4')
    if (!['x', 'y', 'z'].includes(axis) || !bounded(amount, -360, 360) || !bounded(period, MODEL_LIMITS.minPeriod, MODEL_LIMITS.maxPeriod)) return
    if (move[3] !== 'spin' && Math.abs(amount) > MODEL_LIMITS.dimension) return
    return { kind: 'move', id: move[1]!, part: move[2]!, motion: move[3] as 'spin' | 'bob' | 'slide' | 'orbit', axis: axis as Axis, amount, period }
  }
  const match = new RegExp(`^@part (${NAME}) (${NAME}) ([a-z]+)(.*)$`).exec(line)
  if (!match || !Object.hasOwn(defaults, match[3]!)) return
  const shape = match[3] as PartShape, p = keys(match[4]!)
  if (!p) return
  const common = ['at', 'turn', 'scale', 'in', 'copies', 'step', 'around', 'mat', 'color']
  const extra = shape === 'pipe' ? ['points'] : shape === 'lathe' ? ['profile'] : shape === 'sphere' ? ['half'] : []
  if (Object.keys(p).some((k) => ![...common, ...extra, ...Object.keys(defaults[shape])].includes(k))) return
  const dimensions = { ...defaults[shape] }
  if (shape === 'cylinder' && p.r && !p.top) dimensions.top = number(p.r)
  for (const key of Object.keys(dimensions)) {
    const n = p[key] === undefined ? dimensions[key]! : number(p[key]!)
    const zeroOK = ['round', 'top', 'hole'].includes(key)
    const max = key === 'teeth' ? MODEL_LIMITS.teeth : key === 'coils' ? MODEL_LIMITS.coils : MODEL_LIMITS.dimension
    if (!bounded(n, zeroOK ? 0 : MODEL_LIMITS.minDimension, max) || (['teeth', 'coils'].includes(key) && (!Number.isInteger(n) || n < 3))) return
    dimensions[key] = n
  }
  if ((shape === 'tube' && dimensions.inner! >= dimensions.r!) || (shape === 'gear' && dimensions.hole! >= dimensions.r! * 0.7)
    || (shape === 'torus' && dimensions.tube! >= dimensions.r!) || (shape === 'spring' && dimensions.wire! >= dimensions.r!)
    || (shape === 'box' && dimensions.round! > Math.min(dimensions.w!, dimensions.h!, dimensions.d!) / 2)) return
  const at = vector(p.at ?? '0,0,0'), step = vector(p.step ?? '0,0,0')
  const turnValues = (p.turn ?? '0,0,0').split(',').map(number)
  const scale = number(p.scale ?? '1'), copies = number(p.copies ?? p.around ?? '1')
  if (!at || !step || turnValues.length !== 3 || !turnValues.every((v) => bounded(v, -360, 360)) || !bounded(scale, MODEL_LIMITS.minDimension, MODEL_LIMITS.scale)
    || !Number.isInteger(copies) || !bounded(copies, 1, MODEL_LIMITS.repeats) || (p.copies && p.around) || (p.around && p.step)
    || (p.in && !new RegExp(`^${NAME}$`).test(p.in)) || (p.mat && !materials.has(p.mat)) || (p.color && !colors.has(p.color))
    || (p.half !== undefined && !['true', 'false'].includes(p.half))) return
  // Repetition may not escape the same bounded local coordinate box.
  if (!p.around && at.some((v, i) => Math.abs(v + step[i]! * (copies - 1)) > MODEL_LIMITS.coordinate)) return
  const part: PartMark = { kind: 'part', id: match[1]!, name: match[2]!, shape, dimensions, at, turn: turnValues as Vec3, scale, copies, step, around: p.around !== undefined, mat: (p.mat ?? 'steel') as ModelMaterial, half: p.half === 'true', ...(p.in && { parent: p.in }), ...(p.color && { color: p.color as SemanticColor }) }
  if (shape === 'pipe') {
    const points = p.points?.split(';').map(vector)
    if (!points || points.length < 2 || points.length > MODEL_LIMITS.points || points.some((v) => !v)
      || points.some((v, i) => i > 0 && v!.every((n, j) => n === points[i - 1]![j]))) return
    part.points = points as Vec3[]
  }
  if (shape === 'lathe') {
    const profile = p.profile?.split(';').map((row) => row.split(',').map(number))
    if (!profile || profile.length < 2 || profile.length > MODEL_LIMITS.points || profile.some((row) => row.length !== 2 || !bounded(row[0]!, 0, MODEL_LIMITS.dimension) || !bounded(row[1]!, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate))
      || !profile.some((row) => row[0]! > 0) || profile.some((row, i) => i > 0 && row[1]! <= profile[i - 1]![1]!)) return
    part.profile = profile as Array<[number, number]>
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
