import * as THREE from 'three'
import type { Axis } from '../shared/model-protocol'
import type { ModelPart } from './model-geometry'

/** Far enough that a parked plane never clips anything a model can hold. */
const PARKED = 1e9
/** Section passes and caps never reach the contact shadow or anchor ray casts. */
export const SECTION_LAYER = 2
/** Closed shapes that read as a casing when other parts sit inside them. */
const HOLLOWABLE = new Set(['box', 'cylinder', 'cone', 'capsule', 'sphere', 'blob', 'extrude', 'lathe'])
/** Natural solids stay solid, whatever is buried in them. */
const SOLID = new Set(['rock', 'soil'])
/** An opened casing's wall, as a fraction of its smallest size. */
const WALL = 0.08

function worldBox(part: ModelPart): THREE.Box3 {
  const box = new THREE.Box3(), piece = new THREE.Box3()
  for (const placement of part.placements) { placement.updateWorldMatrix(true, false); box.union(piece.copy(part.geometry.boundingBox!).applyMatrix4(placement.matrixWorld)) }
  return box
}

interface SectionCopy {
  reveal: THREE.Group
  stencil: THREE.Mesh[]
  cap: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  cut: boolean
}
interface SectionPart { part: ModelPart; surfaces: readonly THREE.Material[]; copies: SectionCopy[]; tint: THREE.Color; hollow: boolean; owned: Array<THREE.Material | THREE.BufferGeometry> }

/** Stencil winding/cap pass adapted from three.js webgl_clipping_stencil (MIT).
 *  The section hatch, per-part/repeat lifecycle and cut ordering are our own. */
export class ModelSections {
  /** Every surface carries one clipping plane from the start, so a cut only
   *  moves a plane and never recompiles a shader. */
  readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), PARKED)
  /** Held by parts added after the cut: they stay whole inside the opened casing. */
  readonly whole = new THREE.Plane(new THREE.Vector3(0, 0, -1), PARKED)
  private axis?: Axis | 'view'
  private readonly center = new THREE.Vector3()
  private readonly copies: SectionCopy[] = []
  /** Stencil and cap passes take turns in this order; it only grows, so a copy added after a removal never shares one. */
  private order = 0
  private readonly parts: SectionPart[] = []
  private readonly materials = new Set<THREE.Material>()
  private readonly geometries = new Set<THREE.BufferGeometry>()
  private readonly geometry = new THREE.PlaneGeometry(1, 1)
  private readonly normal = new THREE.Vector3()
  private readonly capCenter = new THREE.Vector3()
  private readonly basis = new THREE.Matrix4()
  private readonly u = new THREE.Vector3()
  private readonly v = new THREE.Vector3()
  private readonly w = new THREE.Vector3()
  /** Parts opened by the cut, for judging which later parts span the section. */
  private cutBox?: THREE.Box3
  /** Set when a cut or a new part may have buried something inside a solid. */
  private review = false
  constructor(private readonly scene: THREE.Scene) {}

  /** Forgets a removed part, its section caps and their GPU resources; returns the materials it freed. */
  unregister(part: ModelPart): THREE.Material[] {
    const index = this.parts.findIndex((entry) => entry.part === part)
    if (index < 0) return []
    const [entry] = this.parts.splice(index, 1)
    for (const copy of entry!.copies) {
      copy.cap.removeFromParent()
      const at = this.copies.indexOf(copy); if (at >= 0) this.copies.splice(at, 1)
    }
    for (const resource of entry!.owned) {
      resource.dispose()
      if (resource instanceof THREE.BufferGeometry) this.geometries.delete(resource); else this.materials.delete(resource)
    }
    return entry!.owned.filter((resource): resource is THREE.Material => resource instanceof THREE.Material)
  }

  /** `surfaces` are the part's own materials (solid, outline, edges). Transparent parts are clipped but never capped. */
  register(part: ModelPart, surfaces: readonly THREE.Material[], tint: THREE.Color, capped: boolean): void {
    // After a cut, a part stays whole unless it spans the section like a floor or a slab.
    const opened = this.axis !== undefined && this.spans(part)
    for (const surface of surfaces) surface.clippingPlanes = [this.axis && !opened ? this.whole : this.plane]
    const entry: SectionPart = { part, surfaces, copies: [], tint: tint.clone(), hollow: false, owned: [] }
    this.parts.push(entry)
    this.review = this.axis !== undefined
    if (!capped) return
    for (const reveal of part.reveals) {
      const order = this.order++ * 3
      const stencil = [THREE.BackSide, THREE.FrontSide].map((side) => {
        const mesh = new THREE.Mesh(part.geometry, this.stencilMaterial(side))
        mesh.renderOrder = order; mesh.visible = false; mesh.layers.set(SECTION_LAYER); reveal.add(mesh)
        return mesh
      })
      const cap = new THREE.Mesh(this.geometry, this.capMaterial(tint))
      cap.renderOrder = order + 1; cap.visible = false; cap.layers.set(SECTION_LAYER)
      cap.onAfterRender = (renderer) => renderer.clearStencil()
      entry.owned.push(...stencil.map((mesh) => mesh.material as THREE.Material), cap.material)
      const copy = { reveal, stencil, cap, cut: opened }
      for (const mesh of stencil) mesh.visible = opened
      this.scene.add(cap); this.copies.push(copy); entry.copies.push(copy)
    }
  }

  /** One of each section material, so their shaders can compile before the first cut. */
  warmUpMaterials(): THREE.Material[] {
    return [this.stencilMaterial(THREE.BackSide), this.capMaterial(new THREE.Color()), this.cavityMaterial(new THREE.Color())]
  }

  /** Back faces count up and front faces down: the stencil stays nonzero inside
   *  an opened solid. A cavity's surface counts the other way. */
  private stencilMaterial(side: THREE.Side, cavity = false): THREE.MeshBasicMaterial {
    const operation = (side === THREE.BackSide) !== cavity ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp
    const material = new THREE.MeshBasicMaterial({
      side, depthWrite: false, depthTest: false, colorWrite: false, clippingPlanes: [this.plane],
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: operation, stencilZFail: operation, stencilZPass: operation,
    })
    this.materials.add(material)
    return material
  }

  private capMaterial(tint: THREE.Color): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide, uniforms: {
        span: { value: 1 }, spacing: { value: 0.05 },
        paper: { value: new THREE.Color(0xebe6da).lerp(tint, 0.18) }, ink: { value: new THREE.Color(0x283d40).lerp(tint, 0.2) },
      },
      vertexShader: 'varying vec2 sectionUv; void main() { sectionUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // Antialiased 45° hatch in plane units, a fixed number of lines per model radius.
      fragmentShader: `varying vec2 sectionUv; uniform float span; uniform float spacing; uniform vec3 paper; uniform vec3 ink;
        void main() {
          vec2 p = (sectionUv - 0.5) * span;
          float d = (p.x + p.y) / spacing;
          float f = abs(fract(d + 0.5) - 0.5);
          float aa = fwidth(d);
          float line = 1.0 - smoothstep(0.07, 0.07 + aa, f);
          gl_FragColor = vec4(mix(paper, ink, line * 0.9), 1.0);
          #include <colorspace_fragment>
        }`,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    })
    this.materials.add(material)
    return material
  }

  /** Opens every part already built, through `center`. Parts still waiting
   *  for their sentence (even ones queued in the same beat) stay whole, as do
   *  parts added later; a second cut opens whatever is built by then. */
  cut(axis: Axis | 'view', center: THREE.Vector3): void {
    this.axis = axis; this.center.copy(center)
    if (axis !== 'view') this.plane.setFromNormalAndCoplanarPoint(this.normal.set(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, axis === 'z' ? -1 : 0), center)
    this.cutBox = new THREE.Box3()
    for (const { part } of this.parts) if (part.built) this.cutBox.union(worldBox(part))
    for (const { part, surfaces, copies } of this.parts) {
      const opened = part.built || this.spans(part)
      for (const surface of surfaces) surface.clippingPlanes![0] = opened ? this.plane : this.whole
      for (const copy of copies) { copy.cut = opened; for (const mesh of copy.stencil) mesh.visible = opened }
    }
    this.review = true
  }

  /** Whether a part added after the cut is structure inside the opened casing
   *  that crosses its section (a floor, a slab), which would otherwise jut out. */
  private spans(part: ModelPart): boolean {
    if (!this.cutBox || this.cutBox.isEmpty() || this.axis === 'view') return false
    const n = this.plane.normal, corner = new THREE.Vector3()
    const reach = (box: THREE.Box3): number => {
      let most = -Infinity
      for (let i = 0; i < 8; i++) most = Math.max(most, -this.plane.distanceToPoint(corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)))
      return most
    }
    // How far it runs across the section, along its longer in-plane direction.
    const across = (box: THREE.Box3): number => { const size = box.getSize(corner); return n.x ? Math.max(size.y, size.z) : n.y ? Math.max(size.x, size.z) : Math.max(size.x, size.y) }
    const box = worldBox(part)
    return this.cutBox.containsPoint(box.getCenter(new THREE.Vector3())) && reach(box) >= 0.85 * reach(this.cutBox) && across(box) >= 0.6 * across(this.cutBox)
  }

  /** A solid that was cut open with parts buried behind its section would hide
   *  them under hatching: it becomes a shell with a real wall instead. */
  private reviewHollows(): void {
    const n = this.plane.normal
    for (const entry of this.parts) {
      if (entry.hollow || !entry.copies.some((copy) => copy.cut) || !HOLLOWABLE.has(entry.part.spec.shape) || SOLID.has(entry.part.spec.mat)) continue
      const box = worldBox(entry.part), size = box.getSize(new THREE.Vector3())
      const inside = box.clone().expandByScalar(-0.05 * Math.min(size.x, size.y, size.z)), volume = size.x * size.y * size.z
      for (const other of this.parts) {
        if (other === entry) continue
        const otherBox = worldBox(other.part), otherSize = otherBox.getSize(new THREE.Vector3()), centre = otherBox.getCenter(new THREE.Vector3())
        if (!inside.containsPoint(centre) || otherSize.x * otherSize.y * otherSize.z >= volume) continue
        // A quarter or more of it on the kept side would sit hidden inside a solid section.
        const depth = Math.abs(otherSize.x * n.x) + Math.abs(otherSize.y * n.y) + Math.abs(otherSize.z * n.z)
        if (this.plane.distanceToPoint(centre) + depth / 2 > 0.25 * depth) { this.hollow(entry); break }
      }
    }
  }

  /** Adds an inner surface one wall inside the outer, facing the cavity. Its
   *  stencil passes count the other way, so only the wall is capped. */
  private hollow(entry: SectionPart): void {
    entry.hollow = true
    const { geometry } = entry.part, size = geometry.boundingBox!.getSize(new THREE.Vector3()), centre = geometry.boundingBox!.getCenter(new THREE.Vector3())
    const wall = WALL * Math.max(1e-6, Math.min(size.x, size.y, size.z))
    const inner = geometry.clone().translate(-centre.x, -centre.y, -centre.z)
      .scale(Math.max(0.2, 1 - 2 * wall / size.x), Math.max(0.2, 1 - 2 * wall / size.y), Math.max(0.2, 1 - 2 * wall / size.z)).translate(centre.x, centre.y, centre.z)
    this.geometries.add(inner)
    const cavity = this.cavityMaterial(entry.tint)
    entry.owned.push(inner, cavity)
    for (const copy of entry.copies) {
      const surface = new THREE.Mesh(inner, cavity)
      surface.renderOrder = 1000; surface.receiveShadow = true; surface.userData.part = entry.part.spec.name
      const passes = [THREE.BackSide, THREE.FrontSide].map((side) => {
        const mesh = new THREE.Mesh(inner, this.stencilMaterial(side, true))
        mesh.renderOrder = copy.stencil[0]!.renderOrder; mesh.visible = copy.cut; mesh.layers.set(SECTION_LAYER)
        entry.owned.push(mesh.material)
        return mesh
      })
      copy.reveal.add(surface, ...passes); copy.stencil.push(...passes)
    }
  }

  private cavityMaterial(tint: THREE.Color): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({ color: tint.clone().multiplyScalar(0.5), roughness: 0.85, side: THREE.BackSide, clippingPlanes: [this.plane] })
    this.materials.add(material)
    return material
  }

  /** Allocation-free; `bounds` is the settled framing sphere, which covers every motion pose. */
  update(camera: THREE.Camera, bounds: THREE.Sphere): void {
    if (!this.axis) return
    const n = this.normal
    if (this.axis === 'view') camera.getWorldDirection(n)
    else n.set(this.axis === 'x' ? -1 : 0, this.axis === 'y' ? -1 : 0, this.axis === 'z' ? -1 : 0)
    this.plane.setFromNormalAndCoplanarPoint(n, this.center)
    if (this.review) { this.review = false; this.reviewHollows() }
    // A stable in-plane basis keeps the hatch angle still: camera axes for a view cut, world up otherwise.
    if (this.axis === 'view') { this.u.setFromMatrixColumn(camera.matrixWorld, 0); this.v.setFromMatrixColumn(camera.matrixWorld, 1) }
    else { this.v.set(0, this.axis === 'y' ? 0 : 1, this.axis === 'y' ? -1 : 0); this.u.crossVectors(this.v, n).normalize() }
    // u × v keeps the basis right-handed: a mirrored basis would tilt the cap out of the cut plane.
    this.basis.makeBasis(this.u, this.v, this.w.crossVectors(this.u, this.v))
    this.plane.projectPoint(bounds.center, this.capCenter)
    const span = Math.max(0.1, bounds.radius * 2.4)
    for (const { cap, reveal, cut } of this.copies) {
      cap.visible = cut && reveal.visible
      cap.position.copy(this.capCenter); cap.quaternion.setFromRotationMatrix(this.basis)
      cap.scale.setScalar(span); cap.material.uniforms.span!.value = span
      cap.material.uniforms.spacing!.value = Math.max(0.002, bounds.radius / 24)
    }
  }

  dispose(): void {
    for (const copy of this.copies) { copy.cap.removeFromParent(); for (const stencil of copy.stencil) stencil.removeFromParent() }
    for (const material of this.materials) material.dispose()
    for (const geometry of this.geometries) geometry.dispose()
    this.geometry.dispose(); this.copies.length = 0; this.parts.length = 0; this.materials.clear(); this.geometries.clear()
  }
}
