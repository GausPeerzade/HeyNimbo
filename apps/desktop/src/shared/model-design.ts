import { MODEL_LIMITS, partVertexCost, type ModelCommand, type PartFinish, type PartMark, type Vec3 } from './model-protocol'

/** One line of the 3D designer's JSON Lines output, the format D-Shift's model tool uses
 *  (github.com/Kylejeong2/d-shift, MIT). Lines are data, never code: unknown keys are ignored
 *  and a malformed line drops alone. */
type Line = Record<string, unknown>
type Quat = [number, number, number, number]

const DEG = Math.PI / 180
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n))
const num = (value: unknown, fallback: number, low: number = MODEL_LIMITS.minDimension, high: number = MODEL_LIMITS.dimension): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, low, high) : fallback
function vec(value: unknown): Vec3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v))
    ? value.map(v => clamp(v, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)) as Vec3 : undefined
}
/** Degrees are angles, not positions: wrapped into one turn, never clamped to the coordinate range. */
function degrees(value: unknown): Vec3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v)) ? value.map(v => v % 360) as Vec3 : undefined
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
const round = (a: Vec3): Vec3 => a.map(v => Math.round(v * 1e4) / 1e4) as Vec3

function axisAngle(axis: Vec3, angle: number): Quat {
  const n = length(axis) || 1, s = Math.sin(angle / 2)
  return [axis[0] / n * s, axis[1] / n * s, axis[2] / n * s, Math.cos(angle / 2)]
}
function multiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}
function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q, [vx, vy, vz] = v
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]
}
/** Euler XYZ degrees (the renderer's order) to a quaternion, and back. */
function fromEuler([x, y, z]: Vec3): Quat { return multiply(multiply(axisAngle([1, 0, 0], x * DEG), axisAngle([0, 1, 0], y * DEG)), axisAngle([0, 0, 1], z * DEG)) }
function toEuler([x, y, z, w]: Quat): Vec3 {
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w)
  const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w), m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y)
  const ey = Math.asin(clamp(m13, -1, 1))
  const [ex, ez] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0]
  return round([ex / DEG, ey / DEG, ez / DEG])
}
/** The rotation that turns the y axis onto `direction`. */
function alongY(direction: Vec3): Quat {
  const d = scale(direction, 1 / length(direction)), dot = d[1]
  if (dot > 0.999999) return [0, 0, 0, 1]
  if (dot < -0.999999) return [1, 0, 0, 0]
  return axisAngle([d[2], 0, -d[0]], Math.acos(dot))
}
function hex(value: unknown): number | undefined {
  return typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value) ? parseInt(value.replace('#', ''), 16) : undefined
}
const NAME = /[^a-z0-9-]+/g
const nameOf = (value: unknown): string | undefined => {
  const name = typeof value === 'string' ? value.toLowerCase().replace(/_/g, '-').replace(NAME, '').slice(0, 32) : ''
  return name || undefined
}

/** Turns designer lines into model commands for one model card. Holds the materials, groups and
 *  part names declared so far, because later lines refer to them. */
export class ModelDesign {
  title = ''
  concept = ''
  private readonly materials = new Map<string, Line>()
  private readonly groups = new Map<string, Vec3>()
  /** Every name ever placed, including removed ones. */
  private readonly used = new Set<string>()
  /** The part each designer id currently stands for: a polish pass that reuses an id replaces the part. */
  private readonly current = new Map<string, string>()
  private readonly placed = new Map<string, { copies: number; cost: number; parent?: string }>()
  /** Labelled parts and their words. */
  private readonly tagged = new Map<string, string>()
  private readonly texts = new Set<string>()
  private revision = 0
  private readonly centres = new Map<string, Vec3>()
  private placements = 0
  private vertices = 0
  private labels = 0
  private unnamed = 0

  constructor(private readonly id: string) {}

  /** Parts and groups on the model now. */
  get size(): number { return this.placed.size }

  /** Commands for one streamed line; none when the line is malformed, over budget or declares only state. */
  push(text: string): ModelCommand[] {
    let line: Line
    try { line = JSON.parse(text.trim()) as Line } catch { return [] }
    if (!line || typeof line !== 'object' || Array.isArray(line)) return []
    if (typeof line.title === 'string') { this.title = line.title.slice(0, 60); this.concept = typeof line.concept === 'string' ? line.concept.slice(0, 300) : ''; return [] }
    if (typeof line.mat === 'string' && line.shape === undefined) { this.materials.set(line.mat, line); return [] }
    if (typeof line.group === 'string' && line.shape === undefined) return this.group(line)
    if (typeof line.label === 'string') return this.label(line)
    if (typeof line.remove === 'string') return this.remove(line.remove)
    return this.part(line)
  }

  private group(line: Line): ModelCommand[] {
    const id = nameOf(line.group)
    if (!id || this.current.has(id)) return []
    let name = id
    while (this.used.has(name)) name = `${id.slice(0, 26)}-v${++this.revision}`
    const pivot = vec(line.pivot) ?? [0, 0, 0]
    this.groups.set(name, pivot); this.used.add(name); this.current.set(id, name); this.placed.set(name, { copies: 0, cost: 0 })
    // An empty part at the pivot: its children follow it, and a spin turns them all about it.
    const commands: ModelCommand[] = [{ ...this.base(name, 'group', {}), at: pivot }]
    const spin = vec(line.spin), rps = num(line.rps, 0, 0, 2)
    if (spin && length(spin) > 0 && rps > 0) {
      const axis = (['x', 'y', 'z'] as const)[spin.map(Math.abs).indexOf(Math.max(...spin.map(Math.abs)))]!
      const sign = spin[['x', 'y', 'z'].indexOf(axis)]! < 0 ? -1 : 1
      commands.push({ kind: 'move', id: this.id, part: name, motion: 'spin', axis, amount: 360 * sign, period: clamp(1 / rps, MODEL_LIMITS.minPeriod, MODEL_LIMITS.maxPeriod) })
    }
    return commands
  }

  /** A label names the part nearest its position; at most the renderer's tag budget. */
  private label(line: Line): ModelCommand[] {
    const position = vec(line.position), text = (line.label as string).trim().slice(0, MODEL_LIMITS.labelCharacters)
    // The same words twice say nothing new, as when a polish pass repeats a label it already gave.
    if (!position || !text || this.labels >= MODEL_LIMITS.tags || this.texts.has(text.toLowerCase())) return []
    let nearest: string | undefined, best = Infinity
    for (const [name, centre] of this.centres) { if (this.tagged.has(name)) continue; const distance = length(sub(centre, position)); if (distance < best) { best = distance; nearest = name } }
    if (!nearest) return []
    this.tagged.set(nearest, text.toLowerCase()); this.texts.add(text.toLowerCase()); this.labels++
    return [{ kind: 'tag', id: this.id, part: nearest, text }]
  }

  private base(name: string, shape: PartMark['shape'], dimensions: Record<string, number>): PartMark {
    return { kind: 'part', id: this.id, name, shape, dimensions, at: [0, 0, 0], turn: [0, 0, 0], scale: 1, copies: 1, step: [0, 0, 0], around: false, mat: 'paint', half: false }
  }

  private part(raw: Line): ModelCommand[] {
    const line = typeof raw.m === 'string' && this.materials.has(raw.m) ? { ...this.materials.get(raw.m), ...raw } : raw
    const shape = line.shape
    let part: PartMark | undefined, at: Vec3 | undefined, rotation: Quat = [0, 0, 0, 1]
    const id = nameOf(line.id), previous = id ? this.current.get(id) : undefined
    // A reused id is a new version of that part under a fresh name, so the old one can be taken off.
    let name = id ?? `p${++this.unnamed}`
    // A renderer may still hold a removed part under its old name until its removal runs, so a name is never used twice.
    if (previous || this.used.has(name)) do name = `${(id ?? name).slice(0, 26)}-v${++this.revision}`; while (this.used.has(name))
    if (shape === 'cylinder' || shape === 'capsule' || shape === 'cone') {
      const from = vec(line.from), to = vec(line.to)
      if (!from || !to || length(sub(to, from)) < MODEL_LIMITS.minDimension) return []
      const r = num(line.radius, shape === 'cone' ? 0.2 : 0.1), span = length(sub(to, from))
      // Both ends are given, so no rotation is ever guessed: the y axis is laid from `from` to `to`.
      at = scale(add(from, to), 0.5); rotation = alongY(sub(to, from))
      part = shape === 'cylinder' ? this.base(name, 'cylinder', { r, h: span, top: r })
        : shape === 'cone' ? this.base(name, 'cone', { r, h: span })
        // A capsule's ends are the centres of its caps.
        : this.base(name, 'capsule', { r, h: Math.min(span + 2 * r, MODEL_LIMITS.dimension) })
    } else if (shape === 'sphere') {
      at = vec(line.position); part = this.base(name, 'sphere', { r: num(line.radius, 0.2) })
    } else if (shape === 'box') {
      const size = vec(line.size)
      at = vec(line.position); part = this.base(name, 'box', { w: num(size?.[0], 1), h: num(size?.[1], 1), d: num(size?.[2], 1), round: 0 })
    } else if (shape === 'torus') {
      const r = num(line.ringRadius, 1)
      at = vec(line.position); part = this.base(name, 'torus', { r, tube: Math.min(num(line.pipeRadius, 0.1), r * 0.9) })
    } else if (shape === 'tube') {
      const points = (Array.isArray(line.points) ? line.points : []).map(vec).filter((p): p is Vec3 => Boolean(p)).slice(0, MODEL_LIMITS.points)
      if (points.length < 2) return []
      const r = num(line.radius, 0.08), radii = Array.isArray(line.radii) && line.radii.length === points.length ? line.radii.map(v => num(v, r)) : undefined
      at = [0, 0, 0]; part = { ...this.base(name, 'pipe', { r }), points, ...(radii && { radii }) }
    } else if (shape === 'lathe') {
      const profile = (Array.isArray(line.profile) ? line.profile : []).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v)))
        .slice(0, MODEL_LIMITS.points).map(([r, y]) => [clamp(r, 0, MODEL_LIMITS.dimension), clamp(y, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)] as [number, number])
      if (profile.length < 2 || !profile.some(([r]) => r > 0)) return []
      at = vec(line.position); part = { ...this.base(name, 'lathe', {}), profile }
    } else if (shape === 'extrude') {
      const outline = (Array.isArray(line.points) ? line.points : []).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v)))
        .slice(0, MODEL_LIMITS.points).map(([x, y]) => [clamp(x, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate), clamp(y, -MODEL_LIMITS.coordinate, MODEL_LIMITS.coordinate)] as [number, number])
      let area = 0
      for (let i = 0; i < outline.length; i++) { const [x0, y0] = outline[i]!, [x1, y1] = outline[(i + 1) % outline.length]!; area += x0 * y1 - x1 * y0 }
      if (outline.length < 3 || Math.abs(area) < 1e-6) return []
      const d = num(line.depth, 0.1)
      at = vec(line.position); part = { ...this.base(name, 'extrude', { d, round: Math.min(d * 0.15, 0.03) }), outline }
    }
    if (!part || !at) return []
    if (shape !== 'cylinder' && shape !== 'capsule' && shape !== 'cone' && shape !== 'tube') rotation = fromEuler(degrees(line.rotation) ?? [0, 0, 0])
    const instances = this.repeat(line.repeat, at, rotation)
    const groupName = typeof line.group === 'string' ? this.current.get(nameOf(line.group) ?? '') : undefined
    const pivot = groupName ? this.groups.get(groupName) : undefined
    const group = pivot ? groupName : undefined
    // Parts in a group are placed relative to its pivot, so they turn with it.
    const local = instances.map(({ at, turn }) => ({ at: round(pivot ? sub(at, pivot) : at), turn }))
    Object.assign(part, { at: local[0]!.at, turn: local[0]!.turn, copies: local.length, ...(local.length > 1 && { instances: local }), ...(group && { parent: group }) })
    const finish = this.finish(line)
    if (finish) part.finish = finish
    const cost = partVertexCost(part)
    const replaced = previous ? this.subtree(previous) : []
    // A part can't move into a group it is replacing.
    if (group && replaced.includes(group)) return []
    const freed = replaced.reduce((sum, key) => ({ copies: sum.copies + this.placed.get(key)!.copies, cost: sum.cost + this.placed.get(key)!.cost }), { copies: 0, cost: 0 })
    if (this.placements - freed.copies + part.copies > MODEL_LIMITS.parts || this.vertices - freed.cost + cost > MODEL_LIMITS.verticesPerModel) return []
    this.release(replaced)
    this.placements += part.copies; this.vertices += cost; this.used.add(name)
    this.placed.set(name, { copies: part.copies, cost, ...(group && { parent: group }) })
    if (id) this.current.set(id, name)
    this.centres.set(name, part.points ? part.points[Math.floor(part.points.length / 2)]! : at)
    if (previous) part.replaces = previous
    return [part]
  }

  private remove(value: string): ModelCommand[] {
    const name = this.current.get(nameOf(value) ?? '')
    if (!name) return []
    this.release(this.subtree(name))
    return [{ kind: 'remove', id: this.id, part: name }]
  }

  /** A part and every part placed inside it, as the renderer removes them together. */
  private subtree(name: string): string[] {
    const found = [name]
    for (let i = 0; i < found.length; i++) for (const [key, entry] of this.placed) if (entry.parent === found[i] && !found.includes(key)) found.push(key)
    return found
  }

  private release(names: string[]): void {
    for (const name of names) {
      const entry = this.placed.get(name)
      if (!entry) continue
      this.placements -= entry.copies; this.vertices -= entry.cost
      this.placed.delete(name); this.centres.delete(name); this.groups.delete(name)
      const text = this.tagged.get(name)
      if (text !== undefined) { this.tagged.delete(name); this.texts.delete(text); this.labels-- }
    }
    for (const [id, name] of this.current) if (names.includes(name)) this.current.delete(id)
  }

  /** `count` copies around `axis` through `pivot` (all the way round, or across `angle` degrees), or offset by `step`. */
  private repeat(spec: unknown, at: Vec3, rotation: Quat): Array<{ at: Vec3; turn: Vec3 }> {
    const first = { at, turn: toEuler(rotation) }
    if (!spec || typeof spec !== 'object') return [first]
    const r = spec as Line, count = Math.round(num(r.count, 1, 1, MODEL_LIMITS.repeats))
    const axis = vec(r.axis)
    if (axis && length(axis) > 0) {
      const pivot = vec(r.pivot) ?? [0, 0, 0], total = num(r.angle, 360, 1, 360) * DEG
      const stepAngle = total >= 2 * Math.PI - 1e-6 ? total / count : total / Math.max(count - 1, 1)
      return Array.from({ length: count }, (_, i) => {
        const q = axisAngle(axis, stepAngle * i)
        return { at: round(add(pivot, rotate(q, sub(at, pivot)))), turn: toEuler(multiply(q, rotation)) }
      })
    }
    const step = vec(r.step) ?? [0, 0, 0]
    return Array.from({ length: count }, (_, i) => ({ at: round(add(at, scale(step, i))), turn: first.turn }))
  }

  private finish(line: Line): PartFinish | undefined {
    const color = hex(line.color)
    if (color === undefined) return undefined
    const emission = hex(line.emission), opacity = num(line.opacity, 1, 0.05, 1)
    return {
      color, metalness: num(line.metalness, 0.1, 0, 1), roughness: num(line.roughness, 0.5, 0, 1),
      ...(opacity < 1 && { opacity }), ...(emission !== undefined && { emission }),
    }
  }
}
