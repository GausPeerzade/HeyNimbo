import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { MODEL_LIMITS, partVertexCost, type PartMark, type Vec3 } from '../shared/model-protocol'

/** Inward-facing walls (bores, cups, the inside of tubes) are pre-darkened, so
 *  a cut-open part reads hollow under even studio light. */
export const CAVITY_SHADE = 0.42
const CREASE_DEGREES = 40

/** A helix whose last three-quarter turn at each end closes onto its neighbour, as on a real spring. */
class CoilCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private readonly r: number, private readonly h: number, private readonly coils: number, private readonly wire: number) { super() }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const turns = t * this.coils, closed = Math.min(2.2 * this.wire, this.h / this.coils), end = 0.75
    const open = Math.max(closed, (this.h - 2 * end * closed) / Math.max(0.01, this.coils - 2 * end))
    const y = turns < end ? turns * closed : turns > this.coils - end ? this.h - (this.coils - turns) * closed : end * closed + (turns - end) * open
    const angle = turns * Math.PI * 2
    return target.set(Math.cos(angle) * this.r, Math.min(this.h, y) - this.h / 2, Math.sin(angle) * this.r)
  }
}

function shade(geometry: THREE.BufferGeometry, value = 1): THREE.BufferGeometry {
  if (!geometry.getAttribute('color')) geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(value), 3))
  return geometry
}

function cappedCurve(curve: THREE.Curve<THREE.Vector3>, r: number, segments: number, radial: number, radiusAt?: (t: number) => number): THREE.BufferGeometry {
  const tube = new THREE.TubeGeometry(curve, segments, r, radial, false)
  // A taper scales each ring about its point on the curve; the caps below reuse the scaled end rings.
  if (radiusAt) {
    const position = tube.getAttribute('position'), centre = new THREE.Vector3(), vertex = new THREE.Vector3()
    for (let i = 0; i <= segments; i++) {
      curve.getPointAt(i / segments, centre)
      // Rings are spaced by arc length; radii belong to control points, which the curve parameter tracks.
      const factor = radiusAt(curve.getUtoTmapping(i / segments, 0)) / r
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j
        vertex.fromBufferAttribute(position, k).sub(centre).multiplyScalar(factor).add(centre)
        position.setXYZ(k, vertex.x, vertex.y, vertex.z)
      }
    }
    // The tube's own normals still face straight out; a taper tilts its surface.
    tube.computeVertexNormals()
  }
  const caps = [0, 1].map((end) => {
    const normal = curve.getTangent(end).multiplyScalar(end === 0 ? -1 : 1)
    const point = curve.getPoint(end), positions = [point.x, point.y, point.z], normals = normal.toArray(), uv = [0.5, 0.5], indices: number[] = []
    const ring = tube.getAttribute('position'), offset = end * segments * (radial + 1)
    // Reuse the tube's end ring exactly; an independently rotated disc can leave seams.
    for (let j = 0; j <= radial; j++) {
      positions.push(ring.getX(offset + j), ring.getY(offset + j), ring.getZ(offset + j))
      normals.push(normal.x, normal.y, normal.z)
      uv.push(0.5 + 0.5 * Math.cos(j * Math.PI * 2 / radial), 0.5 + 0.5 * Math.sin(j * Math.PI * 2 / radial))
      if (j < radial) indices.push(...(end === 0 ? [0, j + 1, j + 2] : [0, j + 2, j + 1]))
    }
    const cap = new THREE.BufferGeometry()
    cap.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); cap.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); cap.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); cap.setIndex(indices)
    return cap
  })
  const geometry = mergeGeometries([tube, ...caps])!
  tube.dispose(); for (const cap of caps) cap.dispose()
  return shade(geometry)
}

/** Replaces each corner of a closed or open (r, y) outline with a short arc, so
 *  real-world edges catch a highlight instead of meeting at a knife edge. */
export function roundCorners(points: ReadonlyArray<readonly [number, number]>, radius: number, closed = false, steps = 3): Array<[number, number]> {
  const result: Array<[number, number]> = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, before = points[(i - 1 + points.length) % points.length]!, after = points[(i + 1) % points.length]!
    const isEnd = !closed && (i === 0 || i === points.length - 1)
    const a = new THREE.Vector2(before[0] - p[0], before[1] - p[1]), b = new THREE.Vector2(after[0] - p[0], after[1] - p[1])
    const cut = Math.min(radius, a.length() / 2.01, b.length() / 2.01)
    a.normalize(); b.normalize()
    if (isEnd || cut <= 1e-6 || p[0] <= 0 || a.dot(b) < -0.9) { result.push([p[0], p[1]]); continue }
    const start = new THREE.Vector2(p[0] + a.x * cut, p[1] + a.y * cut), end = new THREE.Vector2(p[0] + b.x * cut, p[1] + b.y * cut)
    // A quadratic arc through the corner keeps the ends tangent to both edges.
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t
      result.push([u * u * start.x + 2 * u * t * p[0] + t * t * end.x, u * u * start.y + 2 * u * t * p[1] + t * t * end.y])
    }
  }
  return result
}

/** Revolves an (r, y) outline about y. Unlike a plain lathe, normals are split
 *  at creases sharper than 40°, so flat ends stay flat and walls stay straight.
 *  Counter-clockwise outlines (up the outside, down the inside) face outward. */
export function revolve(outline: ReadonlyArray<readonly [number, number]>, segments = 64, closed = false): THREE.BufferGeometry {
  const points = outline.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y))
  if (closed && points[0]!.distanceTo(points.at(-1)!) > 1e-9) points.push(points[0]!.clone())
  const count = points.length - 1
  const lengths = Array.from({ length: count }, (_, i) => points[i + 1]!.distanceTo(points[i]!))
  const normals = Array.from({ length: count }, (_, i) => {
    const d = points[i + 1]!.clone().sub(points[i]!)
    return new THREE.Vector2(d.y, -d.x).normalize()
  })
  // Each segment end gets its own ring unless the joint is smooth enough to share one.
  interface Ring { r: number; y: number; n: THREE.Vector2 }
  const rings: Ring[] = [], starts: number[] = [], ends: number[] = []
  const smooth = (a: THREE.Vector2, b: THREE.Vector2): boolean => a.dot(b) > Math.cos(THREE.MathUtils.degToRad(CREASE_DEGREES))
  for (let i = 0; i <= count; i++) {
    const p = points[i]!, before = i > 0 ? normals[i - 1] : closed ? normals[count - 1] : undefined, after = i < count ? normals[i] : closed ? normals[0] : undefined
    if (before && after && smooth(before, after)) {
      // Weighted by length: a long wall stays straight where it meets a short bevel step.
      const lengthBefore = lengths[i > 0 ? i - 1 : count - 1]!, lengthAfter = lengths[i < count ? i : 0]!
      const index = rings.push({ r: p.x, y: p.y, n: before.clone().multiplyScalar(lengthBefore).addScaledVector(after, lengthAfter).normalize() }) - 1
      starts[i] = index; ends[i] = index
    } else {
      if (before) ends[i] = rings.push({ r: p.x, y: p.y, n: before.clone() }) - 1
      if (after) starts[i] = rings.push({ r: p.x, y: p.y, n: after.clone() }) - 1
    }
  }
  const positions: number[] = [], vertexNormals: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = []
  for (const [k, ring] of rings.entries()) for (let j = 0; j <= segments; j++) {
    const phi = j / segments * Math.PI * 2, sin = Math.sin(phi), cos = Math.cos(phi)
    positions.push(ring.r * sin, ring.y, ring.r * cos)
    vertexNormals.push(ring.n.x * sin, ring.n.y, ring.n.x * cos)
    uvs.push(j / segments, k / Math.max(1, rings.length - 1))
    const cavity = ring.n.x < -0.35 ? CAVITY_SHADE : 1
    colors.push(cavity, cavity, cavity)
  }
  for (let i = 0; i < count; i++) {
    const a = starts[i]! * (segments + 1), b = ends[i + 1]! * (segments + 1)
    const degenerateA = points[i]!.x === 0, degenerateB = points[i + 1]!.x === 0
    for (let j = 0; j < segments; j++) {
      if (!degenerateA) indices.push(a + j, a + j + 1, b + j)
      if (!degenerateB) indices.push(b + j, a + j + 1, b + j + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(vertexNormals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  return geometry
}

/** A user outline closed onto the axis where it ends off-axis, wound outward. */
function latheOutline(profile: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const points = profile.map(([r, y]) => [r, y] as [number, number])
  if (points[0]![0] > 0) points.unshift([0, points[0]![1]])
  if (points.at(-1)![0] > 0) points.push([0, points.at(-1)![1]])
  // The shoelace area is positive when the outline runs up the outside.
  let area = 0
  for (let i = 0; i < points.length; i++) { const [r0, y0] = points[i]!, [r1, y1] = points[(i + 1) % points.length]!; area += r0 * y1 - r1 * y0 }
  return area < 0 ? points.reverse() : points
}

/** Involute spur gear outline: `r` is the pitch radius, so gears with the same
 *  teeth-per-radius mesh when their centres are r1 + r2 apart. Tooth 0 is centred on +x. */
export function gearOutline(r: number, teeth: number): THREE.Vector2[] {
  const module = 2 * r / teeth, pressure = THREE.MathUtils.degToRad(20)
  const tip = r + module, root = Math.max(r - 1.25 * module, r * 0.5), base = r * Math.cos(pressure)
  const involute = (radius: number): number => { const alpha = Math.acos(Math.min(1, base / Math.max(radius, base))); return Math.tan(alpha) - alpha }
  // Half the tooth's angular width at a radius, less a little backlash; flanks below the base circle run radially.
  const half = (radius: number): number => Math.max(0.15 * Math.PI / teeth, 0.96 * Math.PI / (2 * teeth) + involute(r) - involute(radius))
  const samples = teeth <= 16 ? 4 : teeth <= 24 ? 3 : 2
  const flank = Array.from({ length: samples + 1 }, (_, i) => Math.max(root, base) + (tip - Math.max(root, base)) * i / samples)
  if (root < base) flank.unshift(root)
  const points: THREE.Vector2[] = []
  const at = (radius: number, angle: number): THREE.Vector2 => new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius)
  for (let k = 0; k < teeth; k++) {
    const centre = k / teeth * Math.PI * 2
    for (const radius of flank) points.push(at(radius, centre - half(Math.max(radius, base))))
    for (const radius of [...flank].reverse()) points.push(at(radius, centre + half(Math.max(radius, base))))
    points.push(at(root, centre + Math.PI / teeth))
  }
  return points
}

/** A flat-ended prism of an outline with an optional round bore, extruded
 *  along y. Side normals follow the same crease rule as `revolve`. */
function prism(outline: THREE.Vector2[], hole: number, depth: number): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = []
  const vertex = (x: number, y: number, z: number, n: THREE.Vector3, shadeValue = 1): number => {
    positions.push(x, y, z); normals.push(n.x, n.y, n.z); colors.push(shadeValue, shadeValue, shadeValue)
    return positions.length / 3 - 1
  }
  const bore = hole > 0 ? Array.from({ length: 32 }, (_, i) => new THREE.Vector2(Math.cos(-i / 32 * Math.PI * 2) * hole, Math.sin(-i / 32 * Math.PI * 2) * hole)) : []
  const faces = THREE.ShapeUtils.triangulateShape(outline, bore.length ? [bore] : [])
  const all = [...outline, ...bore]
  for (const [y, normal] of [[depth / 2, new THREE.Vector3(0, 1, 0)], [-depth / 2, new THREE.Vector3(0, -1, 0)]] as const) {
    const first = positions.length / 3
    // Outline x/y map to world x/z, with z = -y so the outline's counter-clockwise turn faces +y.
    for (const p of all) vertex(p.x, y, -p.y, normal)
    for (const [a, b, c] of faces) indices.push(...(y > 0 ? [first + a!, first + b!, first + c!] : [first + a!, first + c!, first + b!]))
  }
  const walls = (loop: THREE.Vector2[], inward: boolean): void => {
    const n = loop.length
    const edgeNormal = (i: number): THREE.Vector2 => { const d = loop[(i + 1) % n]!.clone().sub(loop[i]!); return new THREE.Vector2(d.y, -d.x).normalize() }
    for (let i = 0; i < n; i++) {
      const p = loop[i]!, q = loop[(i + 1) % n]!, en = edgeNormal(i)
      const cornerNormal = (index: number, own: THREE.Vector2): THREE.Vector3 => {
        const other = edgeNormal(index === i ? (i - 1 + n) % n : (i + 1) % n)
        const shared = own.dot(other) > Math.cos(THREE.MathUtils.degToRad(CREASE_DEGREES)) ? own.clone().add(other).normalize() : own
        return new THREE.Vector3(shared.x, 0, -shared.y)
      }
      const value = inward ? CAVITY_SHADE : 1
      const a = vertex(p.x, depth / 2, -p.y, cornerNormal(i, en), value), b = vertex(p.x, -depth / 2, -p.y, cornerNormal(i, en), value)
      const c = vertex(q.x, depth / 2, -q.y, cornerNormal(i + 1, en), value), d = vertex(q.x, -depth / 2, -q.y, cornerNormal(i + 1, en), value)
      indices.push(a, b, c, b, d, c)
    }
  }
  walls(outline, false)
  if (bore.length) walls(bore, true)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  return geometry
}

/** A closed 2D outline (in x/y) extruded along z, centred, `depth` thick
 *  overall with a rounded `round` bevel inside the outline, so the solid's
 *  edge stays on the points. A smooth outline runs a closed curve through them. */
function extrusion(outline: ReadonlyArray<readonly [number, number]>, depth: number, round: number, smooth: boolean): THREE.BufferGeometry {
  const points = outline.map(([x, y]) => new THREE.Vector2(x, y))
  const loop = smooth
    ? new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x, p.y, 0)), true, 'centripetal').getPoints(points.length * 6).slice(0, -1).map((p) => new THREE.Vector2(p.x, p.y))
    : points
  const bevel = Math.min(round, depth * 0.4)
  const extruded = new THREE.ExtrudeGeometry(new THREE.Shape(loop), {
    depth: depth - 2 * bevel, steps: 1, curveSegments: 4,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 3,
  }).translate(0, 0, -depth / 2 + bevel)
  // Smooth across the bevel's small steps, crisp at real corners.
  const geometry = toCreasedNormals(extruded, THREE.MathUtils.degToRad(CREASE_DEGREES))
  extruded.dispose()
  return shade(geometry)
}

/** A seeded pseudo-random sequence, so a blob looks the same every time it is drawn. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A soft organic form: an ellipsoid of w × h × d with a few broad, seeded
 *  swellings (`lumps` of its size) and an optional narrowing toward the
 *  bottom (`taper` > 0) or top (< 0), for cells, organs, rocks and clouds. */
function blob(w: number, h: number, d: number, lumps: number, seed: number, taper: number): THREE.BufferGeometry {
  const random = seeded(seed * 7919)
  const waves = Array.from({ length: 5 }, () => ({
    axis: new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize(),
    frequency: 1.5 + random() * 2, phase: random() * Math.PI * 2, weight: 0.5 + random(),
  }))
  const total = waves.reduce((sum, wave) => sum + wave.weight, 0)
  const sphere = new THREE.SphereGeometry(1, 48, 32)
  sphere.deleteAttribute('normal'); sphere.deleteAttribute('uv')
  // Weld the seam and poles first, so the swelling and the normals stay continuous.
  const geometry = mergeVertices(sphere)
  sphere.dispose()
  const position = geometry.getAttribute('position'), direction = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    direction.fromBufferAttribute(position, i).normalize()
    let swell = 0
    for (const wave of waves) swell += wave.weight * Math.sin(wave.frequency * direction.dot(wave.axis) * Math.PI + wave.phase)
    const radius = 1 + lumps * swell / total
    const narrowing = 1 - taper * (1 - direction.y) / 2
    position.setXYZ(i, direction.x * radius * narrowing * w / 2, direction.y * radius * h / 2, direction.z * radius * narrowing * d / 2)
  }
  geometry.computeVertexNormals()
  return shade(geometry)
}

export function partGeometry(part: PartMark): THREE.BufferGeometry {
  const d = part.dimensions
  switch (part.shape) {
    case 'box': {
      // Real boxes are never knife-edged: at least a 2.5% round.
      const round = Math.min(Math.max(d.round!, Math.min(d.w!, d.h!, d.d!) * 0.025), Math.min(d.w!, d.h!, d.d!) / 2)
      return shade(new RoundedBoxGeometry(d.w!, d.h!, d.d!, 2, round))
    }
    case 'cylinder': {
      const bevel = Math.min(d.r!, Math.max(d.top!, 0.0001), d.h!) * 0.08
      return revolve(roundCorners([[0, -d.h! / 2], [d.r!, -d.h! / 2], [d.top!, d.h! / 2], [0, d.h! / 2]], bevel))
    }
    case 'cone': return revolve(roundCorners([[0, -d.h! / 2], [d.r!, -d.h! / 2], [0, d.h! / 2]], Math.min(d.r!, d.h!) * 0.06))
    case 'tube': {
      const bevel = Math.min((d.r! - d.inner!) * 0.25, d.h! * 0.06)
      // Start mid-wall so the loop's closing joint is smooth.
      return revolve(roundCorners([[d.r!, 0], [d.r!, d.h! / 2], [d.inner!, d.h! / 2], [d.inner!, -d.h! / 2], [d.r!, -d.h! / 2]], bevel, true), 64, true)
    }
    case 'sphere': {
      if (!part.half) return shade(new THREE.SphereGeometry(d.r, 48, 24))
      const dome: Array<[number, number]> = [[0, 0]]
      for (let i = 0; i <= 16; i++) dome.push([d.r! * Math.cos(i * Math.PI / 32), d.r! * Math.sin(i * Math.PI / 32)])
      dome[dome.length - 1]![0] = 0
      return revolve(roundCorners(dome, d.r! * 0.03), 48)
    }
    case 'torus': return shade(new THREE.TorusGeometry(d.r, d.tube, 16, 64).rotateX(Math.PI / 2))
    case 'capsule': return shade(new THREE.CapsuleGeometry(d.r, Math.max(0, d.h! - 2 * d.r!), 8, 32))
    case 'spring': return cappedCurve(new CoilCurve(d.r!, d.h!, d.coils!, d.wire!), d.wire!, d.coils! * 24, 12)
    case 'pipe': {
      const radii = part.radii, last = (part.points!.length - 1)
      // Long strands get fewer segments per point, so a 200-point curve stays light.
      const segments = Math.min(last * 18, 600)
      const radiusAt = radii && ((t: number): number => { const u = t * last, i = Math.min(Math.floor(u), last - 1); return Math.max(radii[i]! + (radii[i + 1]! - radii[i]!) * (u - i), MODEL_LIMITS.minDimension) })
      return cappedCurve(new THREE.CatmullRomCurve3(part.points!.map((p) => new THREE.Vector3(...p))), d.r!, segments, 12, radiusAt)
    }
    case 'group': { const empty = new THREE.BufferGeometry(); empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3)); return empty }
    case 'lathe': return revolve(latheOutline(part.profile!), 48)
    case 'gear': return prism(gearOutline(d.r!, d.teeth!), Math.min(d.hole!, Math.max(d.r! - 1.25 * 2 * d.r! / d.teeth!, d.r! * 0.5) * 0.85), d.w!)
    case 'extrude': return extrusion(part.outline!, d.d!, d.round!, part.smooth ?? false)
    case 'blob': return blob(d.w!, d.h!, d.d!, d.lumps!, d.seed!, d.taper!)
  }
}

/** One averaged normal per position, so an outline shell pushed along it
 *  stays closed across creases. */
export function smoothNormals(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
  geometry.computeBoundingSphere()
  // Positions quantised to 1/10000 of the part's radius give exact integer keys, no strings.
  const scale = 1e4 / Math.max(1e-9, geometry.boundingSphere!.radius), span = 2e4 + 1, centre = geometry.boundingSphere!.center
  const groups = new Map<number, number>(), group = new Int32Array(position.count), sums = new Float64Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const q = (value: number, origin: number): number => Math.round((value - origin) * scale) + 1e4
    const key = (q(position.getX(i), centre.x) * span + q(position.getY(i), centre.y)) * span + q(position.getZ(i), centre.z)
    let index = groups.get(key)
    if (index === undefined) { index = groups.size; groups.set(key, index) }
    group[i] = index
    const at = index * 3
    sums[at] = sums[at]! + normal.getX(i); sums[at + 1] = sums[at + 1]! + normal.getY(i); sums[at + 2] = sums[at + 2]! + normal.getZ(i)
  }
  const values = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const g = group[i]! * 3, x = sums[g]!, y = sums[g + 1]!, z = sums[g + 2]!, length = Math.hypot(x, y, z) || 1
    values[i * 3] = x / length; values[i * 3 + 1] = y / length; values[i * 3 + 2] = z / length
  }
  return new THREE.BufferAttribute(values, 3)
}

export interface ModelPart {
  spec: PartMark
  root: THREE.Group
  placements: THREE.Group[]
  reveals: THREE.Group[]
  geometry: THREE.BufferGeometry
  built: boolean
  /** A point on a visible surface, in the frame of copy `anchorCopy`; the first copy's box centre until one is found. */
  anchor?: THREE.Vector3
  anchorCopy?: number
}

function isWithin(node: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = node; current; current = current.parent) if (current === ancestor) return true
  return false
}

/** Logical parents retain their first copy as the child/label anchor. Copies reveal together. */
export class ModelGraph {
  readonly root = new THREE.Group()
  readonly parts = new Map<string, ModelPart>()
  private count = 0
  private vertices = 0
  private reserved = 0
  /** Parts already due to come off, and their budget: parts prepared before the removal runs may use it. */
  private readonly retiring = new Set<string>()
  private owed = { count: 0, vertices: 0, reserved: 0 }

  add(spec: PartMark): ModelPart | undefined {
    const parent = spec.parent ? this.parts.get(spec.parent) : undefined
    const cost = partVertexCost(spec)
    // A replacement may use the budget of the parts it replaces, which come off when it starts to grow;
    // they are only marked as going once it is accepted, as a rejected one leaves them in place.
    const owed = { ...this.owed }
    for (const key of spec.replaces ? this.subtree(spec.replaces) : []) if (!this.retiring.has(key)) {
      const freed = this.cost(this.parts.get(key)!)
      owed.count += freed.count; owed.vertices += freed.vertices; owed.reserved += freed.reserved
    }
    if (this.parts.has(spec.name) || (spec.parent && !parent) || this.count - owed.count + spec.copies > MODEL_LIMITS.parts || this.reserved - owed.reserved + cost > MODEL_LIMITS.verticesPerModel) return
    const geometry = partGeometry(spec)
    const vertices = geometry.getAttribute('position').count
    if (vertices > MODEL_LIMITS.verticesPerPart || (this.vertices - owed.vertices + vertices * spec.copies) > MODEL_LIMITS.verticesPerModel) { geometry.dispose(); return }
    if (spec.replaces) this.retire(spec.replaces)
    geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    const root = new THREE.Group()
    // A ring of copies hangs from the parent's origin, so spinning it turns the whole ring about that axis.
    if (!spec.around && !spec.instances) root.position.fromArray(spec.at)
    ;(parent?.placements[0] ?? this.root).add(root)
    const placements: THREE.Group[] = [], reveals: THREE.Group[] = []
    const yAxis = new THREE.Vector3(0, 1, 0)
    for (let i = 0; i < spec.copies; i++) {
      const placement = new THREE.Group(), reveal = new THREE.Group()
      placement.rotation.set(...spec.turn.map(THREE.MathUtils.degToRad) as Vec3)
      placement.scale.setScalar(spec.scale)
      const instance = spec.instances?.[i]
      if (instance) {
        placement.position.fromArray(instance.at)
        placement.rotation.set(...instance.turn.map(THREE.MathUtils.degToRad) as Vec3)
      } else if (spec.around) {
        const angle = i * Math.PI * 2 / spec.copies
        placement.position.fromArray(spec.at).applyAxisAngle(yAxis, angle)
        placement.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(yAxis, angle))
      } else placement.position.fromArray(spec.step.map((v) => v * i))
      root.add(placement); placement.add(reveal); reveal.scale.setScalar(0); reveal.visible = false
      placements.push(placement); reveals.push(reveal)
    }
    const part: ModelPart = { spec, root, placements, reveals, geometry, built: false }
    this.parts.set(spec.name, part); this.count += spec.copies; this.vertices += vertices * spec.copies; this.reserved += cost
    return part
  }

  isRetiring(name: string): boolean { return this.retiring.has(name) }

  /** Marks a part and the parts inside it as due to come off, so their budget is free from now on. */
  retire(name: string): void {
    for (const key of this.subtree(name)) {
      if (this.retiring.has(key)) continue
      this.retiring.add(key)
      const cost = this.cost(this.parts.get(key)!)
      this.owed.count += cost.count; this.owed.vertices += cost.vertices; this.owed.reserved += cost.reserved
    }
  }

  /** Removes a part and every part placed inside it, returning budget for their replacements. */
  remove(name: string): ModelPart[] {
    const removed: ModelPart[] = []
    for (const key of this.subtree(name)) {
      const part = this.parts.get(key)!, cost = this.cost(part)
      part.root.removeFromParent(); this.parts.delete(key)
      this.count -= cost.count; this.vertices -= cost.vertices; this.reserved -= cost.reserved
      if (this.retiring.delete(key)) { this.owed.count -= cost.count; this.owed.vertices -= cost.vertices; this.owed.reserved -= cost.reserved }
      part.geometry.dispose(); removed.push(part)
    }
    return removed
  }

  private cost(part: ModelPart): { count: number; vertices: number; reserved: number } {
    return { count: part.spec.copies, vertices: part.geometry.getAttribute('position').count * part.spec.copies, reserved: partVertexCost(part.spec) }
  }

  /** A part and every part placed inside it: children follow their parent's first copy, so they go with it. */
  private subtree(name: string): string[] {
    if (!this.parts.has(name)) return []
    const found = [name]
    for (let i = 0; i < found.length; i++) for (const part of this.parts.values()) if (part.spec.parent === found[i] && !found.includes(part.spec.name)) found.push(part.spec.name)
    return found
  }

  reveal(part: ModelPart, progress: number): void {
    part.built = true
    const t = THREE.MathUtils.smoothstep(progress, 0, 1)
    for (const reveal of part.reveals) { reveal.visible = progress > 0; reveal.scale.setScalar(Math.max(0.0001, t)) }
  }

  /** Full-size built geometry only: neither growing scales nor section planes bias framing. */
  box(ancestor?: THREE.Object3D): THREE.Box3 {
    this.root.updateWorldMatrix(true, true)
    const box = new THREE.Box3(), piece = new THREE.Box3()
    for (const part of this.parts.values()) if (part.built && !part.geometry.boundingBox!.isEmpty()) for (const placement of part.placements) {
      if (!ancestor || isWithin(placement, ancestor)) box.union(piece.copy(part.geometry.boundingBox!).applyMatrix4(placement.matrixWorld))
    }
    return box
  }

  /** The eight corners of every built copy's own box: a tight, cheap stand-in
   *  for its silhouette. Limited to `ancestor`'s subtree when given. */
  corners(ancestor?: THREE.Object3D): THREE.Vector3[] {
    this.root.updateWorldMatrix(true, true)
    const points: THREE.Vector3[] = []
    for (const part of this.parts.values()) if (part.built && !part.geometry.boundingBox!.isEmpty()) for (const placement of part.placements) {
      if (ancestor && !isWithin(placement, ancestor)) continue
      const { min, max } = part.geometry.boundingBox!
      for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) points.push(new THREE.Vector3(x, y, z).applyMatrix4(placement.matrixWorld))
    }
    return points
  }

  /** Up to about `budget` surface points of the built model, for silhouette bands. */
  samples(budget = 3000): THREE.Vector3[] {
    this.root.updateWorldMatrix(true, true)
    let total = 0
    for (const part of this.parts.values()) if (part.built) total += part.geometry.getAttribute('position').count * part.placements.length
    const stride = Math.max(1, Math.ceil(total / budget)), points: THREE.Vector3[] = []
    for (const part of this.parts.values()) if (part.built) for (const placement of part.placements) {
      const position = part.geometry.getAttribute('position')
      for (let i = 0; i < position.count; i += stride) points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(placement.matrixWorld))
    }
    return points
  }

  bounds(): THREE.Sphere {
    const box = this.box()
    return box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere())
  }

  /** Writes the part's anchor in world space into `target`; world matrices must be current. */
  anchor(name: string, target = new THREE.Vector3()): THREE.Vector3 | undefined {
    const part = this.parts.get(name)
    if (!part) return
    const placement = part.placements[part.anchor ? part.anchorCopy ?? 0 : 0]!
    placement.updateWorldMatrix(true, false)
    if (part.anchor) return target.copy(part.anchor).applyMatrix4(placement.matrixWorld)
    return part.geometry.boundingBox!.getCenter(target).applyMatrix4(placement.matrixWorld)
  }

  dispose(): void {
    for (const part of this.parts.values()) part.geometry.dispose()
    this.parts.clear(); this.root.clear(); this.count = 0; this.vertices = 0; this.reserved = 0; this.retiring.clear(); this.owed = { count: 0, vertices: 0, reserved: 0 }
  }
}

export interface LabelIntent { id: string; y: number; side: 'left' | 'right'; height: number }
export interface LabelSlot extends LabelIntent { baseline: number }
/** Sorted by anchor height and never overlapping on a side. Earlier slots are
 *  blockers; a re-solve passes none and keeps each label's side. */
export function labelSlots(intents: readonly LabelIntent[], top: number, bottom: number, occupied: readonly LabelSlot[] = []): LabelSlot[] {
  const slots: LabelSlot[] = []
  for (const side of ['left', 'right'] as const) {
    const sorted = intents.filter((label) => label.side === side).sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))
    if (!sorted.length) continue
    const height = Math.max(...sorted.map((label) => label.height))
    const blockers = occupied.filter((slot) => slot.side === side).sort((a, b) => a.baseline - b.baseline)
    const available: number[] = []
    let start = top
    for (const blocker of [...blockers, { baseline: bottom + 8, height: 0 }]) {
      for (let baseline = start + height; baseline <= blocker.baseline - blocker.height - 8; baseline += height + 8) available.push(baseline)
      start = blocker.baseline + 8
    }
    let previous = -1
    const count = Math.min(sorted.length, available.length)
    for (let i = 0; i < count; i++) {
      const label = sorted[i]!
      let chosen = previous + 1
      for (let j = chosen + 1; j <= available.length - (count - i); j++) if (Math.abs(available[j]! - label.y) < Math.abs(available[chosen]! - label.y)) chosen = j
      slots.push({ ...label, baseline: available[chosen]! }); previous = chosen
    }
  }
  return slots
}

/** The camera distance and look-at point that make `points` fill `fill.y` of
 *  the viewport height, or `fill.x` of the width left between the two label
 *  columns, from every yaw in `yaws`. Projected extents, not an enclosing
 *  sphere, decide it. The caller shifts the lens to centre the model between
 *  unequal columns. */
export function illustratedFraming(points: readonly THREE.Vector3[], fov: number, width: number, height: number, reserve: { left: number; right: number }, yaws: readonly number[], pitch: number, fill = { x: 0.94, y: 0.76 }): { distance: number; target: THREE.Vector3 } {
  const tanY = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const tanX = tanY * Math.max(1, width - reserve.left - reserve.right) / height
  const target = new THREE.Vector3(), relative = new THREE.Vector3()
  if (!points.length) return { distance: 8, target }
  // Centre on the extents' midpoint at the middle yaw so the margins balance.
  const box = new THREE.Box3().setFromPoints(points as THREE.Vector3[])
  box.getCenter(target)
  const middle = yaws[Math.floor(yaws.length / 2)]!
  const basis = (yaw: number) => {
    const toward = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
    return { toward, right, up: new THREE.Vector3().crossVectors(toward, right) }
  }
  const { right, up } = basis(middle)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const point of points) {
    relative.subVectors(point, target)
    const x = relative.dot(right), y = relative.dot(up)
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  target.addScaledVector(right, (minX + maxX) / 2).addScaledVector(up, (minY + maxY) / 2)
  let distance = 0.1
  for (const yaw of yaws) {
    const view = basis(yaw)
    for (const point of points) {
      relative.subVectors(point, target)
      const depth = relative.dot(view.toward)
      distance = Math.max(distance, depth + Math.abs(relative.dot(view.right)) / (tanX * fill.x), depth + Math.abs(relative.dot(view.up)) / (tanY * fill.y))
    }
  }
  return { distance, target }
}
