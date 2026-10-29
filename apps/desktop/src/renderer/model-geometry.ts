import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MODEL_LIMITS, partVertexCost, type PartMark, type Vec3 } from '../shared/model-protocol'

class CoilCurve extends THREE.Curve<THREE.Vector3> {
  constructor(private readonly r: number, private readonly h: number, private readonly coils: number) { super() }
  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    const angle = t * this.coils * Math.PI * 2
    return target.set(Math.cos(angle) * this.r, (t - 0.5) * this.h, Math.sin(angle) * this.r)
  }
}

function cappedCurve(curve: THREE.Curve<THREE.Vector3>, r: number, segments: number, radial: number): THREE.BufferGeometry {
  const tube = new THREE.TubeGeometry(curve, segments, r, radial, false)
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
  return geometry
}

export function partGeometry(part: PartMark): THREE.BufferGeometry {
  const d = part.dimensions
  switch (part.shape) {
    case 'box': return d.round! > 0 ? new RoundedBoxGeometry(d.w!, d.h!, d.d!, 4, d.round!) : new THREE.BoxGeometry(d.w, d.h, d.d)
    case 'cylinder': {
      if (d.top === 0) return new THREE.ConeGeometry(d.r, d.h, 64)
      const bevel = Math.min(d.r!, d.top!, d.h!) * 0.035
      return new THREE.LatheGeometry([[0, -d.h! / 2], [d.r! - bevel, -d.h! / 2], [d.r!, -d.h! / 2 + bevel], [d.top!, d.h! / 2 - bevel], [d.top! - bevel, d.h! / 2], [0, d.h! / 2]].map(([r, y]) => new THREE.Vector2(r, y)), 64)
    }
    case 'cone': return new THREE.ConeGeometry(d.r, d.h, 64)
    case 'tube': {
      const bevel = Math.min((d.r! - d.inner!) * 0.22, d.h! * 0.035)
      return new THREE.LatheGeometry([[d.r!, -d.h! / 2 + bevel], [d.r!, d.h! / 2 - bevel], [d.r! - bevel, d.h! / 2], [d.inner! + bevel, d.h! / 2], [d.inner!, d.h! / 2 - bevel], [d.inner!, -d.h! / 2 + bevel], [d.inner! + bevel, -d.h! / 2], [d.r! - bevel, -d.h! / 2], [d.r!, -d.h! / 2 + bevel]].map(([r, y]) => new THREE.Vector2(r, y)), 64)
    }
    case 'sphere': {
      if (!part.half) return new THREE.SphereGeometry(d.r, 48, 24)
      const profile = [new THREE.Vector2(0, 0), new THREE.Vector2(d.r, 0)]
      for (let i = 1; i <= 16; i++) profile.push(new THREE.Vector2(d.r! * Math.cos(i * Math.PI / 32), d.r! * Math.sin(i * Math.PI / 32)))
      return new THREE.LatheGeometry(profile, 48)
    }
    case 'torus': return new THREE.TorusGeometry(d.r, d.tube, 16, 64).rotateX(Math.PI / 2)
    case 'capsule': return new THREE.CapsuleGeometry(d.r, Math.max(0, d.h! - 2 * d.r!), 8, 32)
    case 'spring': return cappedCurve(new CoilCurve(d.r!, d.h!, d.coils!), d.wire!, d.coils! * 24, 12)
    case 'pipe': return cappedCurve(new THREE.CatmullRomCurve3(part.points!.map((p) => new THREE.Vector3(...p))), d.r!, (part.points!.length - 1) * 18, 12)
    case 'lathe': return new THREE.LatheGeometry([new THREE.Vector2(0, part.profile![0]![1]), ...part.profile!.map(([r, y]) => new THREE.Vector2(r, y)), new THREE.Vector2(0, part.profile!.at(-1)![1])], 48)
    case 'gear': {
      const shape = new THREE.Shape()
      for (let i = 0; i < d.teeth! * 4; i++) {
        const angle = i / (d.teeth! * 4) * Math.PI * 2
        const r = d.r! * (i % 4 === 0 || i % 4 === 3 ? 0.82 : 1)
        const x = Math.cos(angle) * r, y = Math.sin(angle) * r
        if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y)
      }
      shape.closePath()
      if (d.hole! > 0) { const hole = new THREE.Path(); hole.absarc(0, 0, d.hole!, 0, Math.PI * 2, true); shape.holes.push(hole) }
      return new THREE.ExtrudeGeometry(shape, { depth: d.w, bevelEnabled: true, bevelThickness: Math.min(d.w! * 0.12, 0.015), bevelSize: Math.min(d.r! * 0.025, 0.015), bevelSegments: 2, steps: 1, curveSegments: 16 }).rotateX(Math.PI / 2).translate(0, d.w! / 2, 0)
    }
  }
}

export interface ModelPart {
  spec: PartMark
  root: THREE.Group
  placements: THREE.Group[]
  reveals: THREE.Group[]
  geometry: THREE.BufferGeometry
  built: boolean
}

/** Logical parents retain their first copy as the child/label anchor. Copies reveal together. */
export class ModelGraph {
  readonly root = new THREE.Group()
  readonly parts = new Map<string, ModelPart>()
  private count = 0
  private vertices = 0
  private reserved = 0

  add(spec: PartMark): ModelPart | undefined {
    const parent = spec.parent ? this.parts.get(spec.parent) : undefined
    const cost = partVertexCost(spec)
    if (this.parts.has(spec.name) || (spec.parent && !parent) || this.count + spec.copies > MODEL_LIMITS.parts || this.reserved + cost > MODEL_LIMITS.verticesPerModel) return
    const geometry = partGeometry(spec)
    const vertices = geometry.getAttribute('position').count
    if (vertices > MODEL_LIMITS.verticesPerPart || (this.vertices + vertices * spec.copies) > MODEL_LIMITS.verticesPerModel) { geometry.dispose(); return }
    geometry.computeBoundingBox()
    const root = new THREE.Group()
    root.position.fromArray(spec.at)
    ;(parent?.placements[0] ?? this.root).add(root)
    const placements: THREE.Group[] = [], reveals: THREE.Group[] = []
    for (let i = 0; i < spec.copies; i++) {
      const placement = new THREE.Group(), reveal = new THREE.Group()
      placement.rotation.set(...spec.turn.map(THREE.MathUtils.degToRad) as Vec3)
      placement.scale.setScalar(spec.scale)
      if (spec.around) {
        const angle = i * Math.PI * 2 / spec.copies
        const position = new THREE.Vector3(...spec.at).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle)
        placement.position.copy(position).sub(new THREE.Vector3(...spec.at))
        placement.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle))
      } else placement.position.fromArray(spec.step.map((v) => v * i))
      root.add(placement); placement.add(reveal); reveal.scale.setScalar(0); reveal.visible = false
      placements.push(placement); reveals.push(reveal)
    }
    const part: ModelPart = { spec, root, placements, reveals, geometry, built: false }
    this.parts.set(spec.name, part); this.count += spec.copies; this.vertices += vertices * spec.copies; this.reserved += cost
    return part
  }

  reveal(part: ModelPart, progress: number): void {
    part.built = true
    const t = THREE.MathUtils.smoothstep(progress, 0, 1)
    for (const reveal of part.reveals) { reveal.visible = progress > 0; reveal.scale.setScalar(Math.max(0.0001, t)) }
  }

  /** Full-size built geometry only: neither growing scales nor section planes bias framing. */
  box(ancestor?: THREE.Object3D): THREE.Box3 {
    this.root.updateWorldMatrix(true, true)
    const box = new THREE.Box3()
    for (const part of this.parts.values()) if (part.built) for (const placement of part.placements) {
      let node: THREE.Object3D | null = placement
      while (ancestor && node && node !== ancestor) node = node.parent
      if (!ancestor || node) box.union(part.geometry.boundingBox!.clone().applyMatrix4(placement.matrixWorld))
    }
    return box
  }

  bounds(): THREE.Sphere {
    const box = this.box()
    return box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere())
  }

  anchor(name: string): THREE.Vector3 | undefined {
    const part = this.parts.get(name)
    if (!part) return
    part.root.updateWorldMatrix(true, true)
    return part.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(part.placements[0]!.matrixWorld)
  }

  dispose(): void {
    for (const part of this.parts.values()) part.geometry.dispose()
    this.parts.clear(); this.root.clear(); this.count = 0; this.vertices = 0; this.reserved = 0
  }
}

/** Fit a sphere to the tighter vertical or label-reserved horizontal field of view. */
export function cameraDistance(radius: number, fovDegrees: number, width: number, height: number, margin: number): number {
  const vertical = THREE.MathUtils.degToRad(fovDegrees) / 2
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(1, width - 2 * margin) / Math.max(1, height))
  return Math.max(0.1, radius) / Math.sin(Math.min(vertical, horizontal)) * 1.08
}

export interface LabelIntent { id: string; y: number; side: 'left' | 'right'; height: number }
export interface LabelSlot extends LabelIntent { baseline: number }
/** Solve once at entry; subsequent projection updates endpoints, never these word slots. */
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

export function boxCorners(box: THREE.Box3): THREE.Vector3[] {
  return [box.min.x, box.max.x].flatMap((x) => [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new THREE.Vector3(x, y, z))))
}

/** Fit actual projected extents, not an enclosing sphere's empty side space.
 *  Depth is included so the nearest corners also stay inside the paper margins. */
export function illustratedDistance(box: THREE.Box3, fov: number, width: number, height: number, margin: number, yaw: number, pitch: number): number {
  const center = box.getCenter(new THREE.Vector3())
  const toward = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  const up = new THREE.Vector3().crossVectors(toward, right)
  const tanY = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 0.78
  const tanX = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * Math.max(1, width - 2 * margin) / height
  return Math.max(0.1, ...boxCorners(box).map((corner) => {
    corner.sub(center)
    return corner.dot(toward) + Math.max(Math.abs(corner.dot(right)) / tanX, Math.abs(corner.dot(up)) / tanY)
  }))
}
