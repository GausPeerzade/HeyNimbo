import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GlowPass } from './model-glow'
import { MODEL_LIMITS, type ModelColor, type ModelMaterial, type PartMark, type PartFinish, type ModelCommand } from '../shared/model-protocol'
import type { Point } from './ink'
import { ContactShadow } from './model-contact-shadow'
import { ModelSections, SECTION_LAYER } from './model-sections'
import { illustratedFraming, ModelGraph, partGeometry, smoothNormals, type ModelPart } from './model-geometry'

const INK = 0x283d40
/** Semantic colours, pulled a quarter of the way to a warm grey so painted
 *  parts read as objects on paper rather than flat interface fills. */
const palette: Record<ModelColor, number> = { blue: 0x3d6f8f, red: 0xa65a66, orange: 0xb27b45, green: 0x4a7f6d, purple: 0x76668f, grey: 0x5f6b70, yellow: 0xd4ae4c, brown: 0x8a6446, white: 0xece7dc }
/** Glow is light, so its colours run hot and saturated: lava, flame, stars, screens. */
const glowPalette: Record<ModelColor, number> = { blue: 0x4aa3e8, red: 0xe0472f, orange: 0xf28b2e, green: 0x5fc46f, purple: 0xa775e0, grey: 0xd8d2c4, yellow: 0xf6c54a, brown: 0xd18a4a, white: 0xfff3d6 }
/** Soft colours given in turn to painted parts left uncoloured, so neighbours stay distinct. */
const paintCycle = [0xe6dfd1, 0x86a2b6, 0x9db394, 0xd3b48d, 0xc2826d, 0xa99dbf, 0x84aba7]
const finishes: Record<ModelMaterial, { color: number; roughness: number; metalness: number; opacity?: number }> = {
  steel: { color: 0xa3acaf, roughness: 0.3, metalness: 0.92 }, brass: { color: 0xc9a25a, roughness: 0.32, metalness: 0.9 },
  copper: { color: 0xc27e5c, roughness: 0.34, metalness: 0.9 }, rubber: { color: 0x323a3c, roughness: 0.82, metalness: 0 },
  glass: { color: 0xd3e6e8, roughness: 0.06, metalness: 0, opacity: 0.26 }, water: { color: 0x83b5c2, roughness: 0.12, metalness: 0, opacity: 0.5 },
  wood: { color: 0xb3916b, roughness: 0.7, metalness: 0 }, plastic: { color: 0x8b9a9b, roughness: 0.48, metalness: 0 },
  paper: { color: 0xf1ead9, roughness: 0.92, metalness: 0 }, glow: { color: 0xf0b850, roughness: 0.7, metalness: 0 },
  paint: { color: 0xe6dfd1, roughness: 0.42, metalness: 0 }, tissue: { color: 0xd39a92, roughness: 0.55, metalness: 0 },
  rock: { color: 0x8e857b, roughness: 0.95, metalness: 0 }, soil: { color: 0x8c6c4d, roughness: 1, metalness: 0 },
}
/** An elevated three-quarter view through a long lens; the turntable sways about it. */
export const VIEW = { fov: 20, yaw: 0.55, pitch: 0.36, sway: 0.3, swayPeriodMs: 14_000 }
/** Where the view settles to face a fixed cut: its section turned toward the viewer. */
const CUT_VIEW: Record<'x' | 'y' | 'z', { yaw?: number; pitch?: number }> = { x: { yaw: 0.95 }, y: { pitch: 0.72 }, z: { yaw: 0.4 } }
/** Silhouette bands for placing labels beside the model at their own height, in pixels. */
const BAND = 8
/** Ink outlines, edges and the shadow catcher: drawn, but never part of contact shadows or anchor ray casts. */
const INK_LAYER = 1
/** Motions begun this close together share one clock, so meshing gears stay in phase. */
const MOTION_SYNC_MS = 400

export interface StageOptions {
  id: string
  width: number
  height: number
  turntable: boolean
  wake: () => void
  capture: (over: boolean, captured: boolean) => void
  overCard: (x: number, y: number) => boolean
  trace: (until: number) => void
  debug: () => boolean
}
/** A motion and the rest pose it is measured from, so nothing drifts or accumulates. */
interface Motion { mark: Extract<ModelCommand, { kind: 'move' }>; start: number; position: THREE.Vector3; rotation: THREE.Euler; turns: THREE.Quaternion[] }

const unitAxis = (axis: 'x' | 'y' | 'z', target: THREE.Vector3): THREE.Vector3 => target.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)

/** Critically damped approach (no overshoot, no velocity jump when the goal moves). */
function damp(current: number, goal: number, velocity: { v: number }, smoothMs: number, dt: number): number {
  const omega = 2 / smoothMs, x = omega * dt, decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = current - goal, temp = (velocity.v + omega * change) * dt
  velocity.v = (velocity.v - omega * temp) * decay
  return goal + (change + temp) * decay
}

/** A back-face shell pushed out along smoothed normals by a constant screen
 *  width: the silhouette ink line, clipped like its part. */
function inkShell(ink: { resolution: THREE.Vector2; width: { value: number } }): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(INK).lerp(new THREE.Color(0xfaf7ef), 0.3), side: THREE.BackSide })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.inkResolution = { value: ink.resolution }
    shader.uniforms.inkWidth = ink.width
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 outlineNormal;\nuniform vec2 inkResolution;\nuniform float inkWidth;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec2 inkDirection = (normalMatrix * outlineNormal).xy;
        gl_Position.xy += normalize(inkDirection + vec2(1e-6)) * inkWidth * gl_Position.w * 2.0 / inkResolution;`)
  }
  material.customProgramCacheKey = () => 'heynimbo-ink-shell'
  return material
}

function isWithinCopy(object: THREE.Object3D, placement: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (node === placement) return true
  return false
}

/** One transparent context per paper body. The overlay's clock owns every frame. */
export class ModelStage {
  readonly graph = new ModelGraph()
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.01, 1000)
  readonly sections = new ModelSections(this.scene)
  readonly renderer: THREE.WebGLRenderer
  /** Widest handwriting a margin label may use; set by `mount`. */
  labelWidth = 0
  /** The card body this stage draws into, and its callbacks; set by `mount`. */
  host?: HTMLElement
  options!: StageOptions
  /** When a card took this stage (its streamed @model line, or its beat), for latency traces. */
  mountedAt = 0
  /** Bumped whenever the settled framing or the cut changes, so margin labels re-anchor and re-slot. */
  framing = 0
  /** Bumped when someone finishes turning the model by hand: labels may then change sides freely. */
  turned = 0
  afterRender?: () => void
  visit?: () => void
  private readonly disposables = new Set<{ dispose: () => void }>()
  /** Each dressed part's own materials and edges, freed when a polish pass removes the part. */
  private readonly owned = new Map<ModelPart, Array<{ dispose: () => void }>>()
  private readonly motions = new Map<string, Motion>()
  private readonly undressed: ModelPart[] = []
  private environment?: THREE.WebGLRenderTarget
  private readonly key = new THREE.DirectionalLight(0xfff2df, 2.6)
  private readonly ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ color: INK, opacity: 0.09, depthWrite: false }))
  private readonly contact = new ContactShadow()
  private readonly glow = new GlowPass()
  /** Silhouette width in device pixels: about 1.2 CSS pixels at any scale. */
  private readonly ink = { resolution: new THREE.Vector2(1, 1), width: { value: 1.2 } }
  /** The camera the framing settles to, ignoring sway and glide; labels are laid out against it. */
  private readonly settled = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.01, 1000)
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1)
  private readonly target = new THREE.Vector3()
  private readonly desiredTarget = new THREE.Vector3()
  private readonly targetVelocity = [{ v: 0 }, { v: 0 }, { v: 0 }]
  private readonly distanceVelocity = { v: 0 }
  private readonly scratch = new THREE.Vector3()
  private readonly axis = new THREE.Vector3()
  private readonly turn = new THREE.Quaternion()
  private readonly raycaster = new THREE.Raycaster()
  private silhouette: [number, number] = [0, 0]
  /** Per BAND-pixel row of the settled view: the model's left and right edges. */
  private bands: Array<[number, number] | undefined> = []
  private distance = 8
  private desiredDistance = 8
  private readonly yawVelocity = { v: 0 }
  private readonly shiftVelocity = { v: 0 }
  private yawGoal = VIEW.yaw
  private pitchGoal = VIEW.pitch
  private baseYaw = VIEW.yaw
  private yaw = VIEW.yaw
  private pitch = VIEW.pitch
  /** Label column widths; the lens shifts so the model sits centred between them. */
  private readonly reserve = { left: 0, right: 0 }
  private shift = 0
  private desiredShift = 0
  private pixelRatio: number
  private last = 0
  private released = -Infinity
  private swayFrom = 0
  private heldUntil = 0
  private motionClock = -Infinity
  private resumeTimer?: ReturnType<typeof setTimeout>
  private drag?: { pointer: number; x: number; y: number }
  private dirty = true
  private disposed = false
  private lost = false
  private rendering = false
  private renders = 0
  private framed = false

  /** Builds the context, studio environment and every shader up front, so a
   *  card can adopt a warm stage the moment its @model line arrives. */
  constructor(host?: HTMLElement, options?: StageOptions) {
    this.pixelRatio = Math.min(MODEL_LIMITS.dpr, globalThis.devicePixelRatio || 1)
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, stencil: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0, 0)
    this.renderer.setPixelRatio(this.pixelRatio)
    this.renderer.localClippingEnabled = true
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Neutral keeps base colours true on paper; filmic curves desaturate brass and copper.
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.buildEnvironment()
    this.scene.environmentIntensity = 0.5
    for (const camera of [this.camera, this.settled]) { camera.layers.enable(INK_LAYER); camera.layers.enable(SECTION_LAYER) }
    this.scene.add(this.graph.root, new THREE.HemisphereLight(0xfff6e8, 0x56666a, 0.55))
    this.key.castShadow = true; this.key.shadow.mapSize.set(1024, 1024); this.key.shadow.radius = 3; this.key.shadow.bias = -0.0004
    const fill = new THREE.DirectionalLight(0xd6e8ec, 0.55); fill.position.set(4, 1.2, 2.5)
    const rim = new THREE.DirectionalLight(0xffffff, 1.5); rim.position.set(1.5, 3.5, -4)
    this.scene.add(this.key, this.key.target, fill, rim, this.contact.group)
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true; this.ground.renderOrder = 2000; this.ground.layers.set(INK_LAYER)
    this.scene.add(this.ground)
    for (const resource of [this.ground.geometry, this.ground.material, this.contact]) this.disposables.add(resource)
    this.warmUp()
    this.wireCanvas()
    if (host && options) this.mount(host, options)
  }

  /** Attaches the stage to a card body of the given size; cheap, unlike construction. */
  mount(host: HTMLElement, options: StageOptions): this {
    this.host = host; this.options = options; this.mountedAt = performance.now()
    this.labelWidth = Math.min(190, options.width * 0.3 - 28)
    this.reserve.left = this.reserve.right = options.width * 0.1
    this.renderer.setSize(options.width, options.height)
    this.ink.resolution.set(options.width * this.pixelRatio, options.height * this.pixelRatio); this.ink.width.value = 1.2 * this.pixelRatio
    this.glow.setSize(options.width * this.pixelRatio, options.height * this.pixelRatio)
    for (const camera of [this.camera, this.settled]) { camera.aspect = options.width / options.height; camera.updateProjectionMatrix() }
    host.append(this.renderer.domElement)
    if (this.undressed.length) options.wake()
    return this
  }

  /** Parts registered but not yet given materials and outlines. */
  get waiting(): number { return this.disposed ? 0 : this.undressed.length }

  /** Builds one waiting part's materials and outlines. */
  dressNext(): void {
    const part = this.undressed[0]
    if (part && !this.disposed) this.dress(part)
  }

  /** Registers the part at once (names, parents, budgets); its materials and
   *  outlines are built a part per frame before its sentence, or on first reveal. */
  prepare(spec: PartMark): ModelPart | undefined {
    // A part prepared from its streamed line comes back as the same part on its beat.
    const existing = this.graph.parts.get(spec.name)
    if (existing) return existing
    const part = this.graph.add(spec)
    if (!part || this.disposed) return part
    this.undressed.push(part); this.options?.wake()
    return part
  }

  /** `order` is the part's place in the model: it picks an unpainted part's
   *  colour and nudges its depth, so a later part flush against an earlier
   *  one (a door on a wall, a dial on a face) wins instead of flickering. */
  private surface(mat: ModelMaterial, color: ModelColor | undefined, order: number, designed?: PartFinish): THREE.MeshStandardMaterial {
    if (designed) {
      // A designed finish is exact: its colour, metal and roughness, glowing where it emits.
      const transparent = designed.opacity !== undefined
      return new THREE.MeshStandardMaterial({
        color: designed.color, roughness: designed.roughness, metalness: designed.metalness, vertexColors: true, clipShadows: true,
        transparent, opacity: designed.opacity ?? 1, depthWrite: !transparent, side: transparent ? THREE.DoubleSide : THREE.FrontSide,
        polygonOffset: !transparent, polygonOffsetUnits: -4 * Math.min(order, 30),
        ...(designed.emission !== undefined && { emissive: designed.emission, emissiveIntensity: 0.9 }),
      })
    }
    const finish = finishes[mat], transparent = finish.opacity !== undefined
    // A colour tints metal rather than replacing it, so a grey or blue steel still reads as metal.
    const tint = new THREE.Color(mat === 'paint' && !color ? paintCycle[order % paintCycle.length]! : finish.color)
    if (color) tint.lerp(new THREE.Color((mat === 'glow' ? glowPalette : palette)[color]), finish.metalness > 0.5 ? 0.5 : 1)
    return new THREE.MeshStandardMaterial({
      color: tint, roughness: finish.roughness, metalness: finish.metalness, vertexColors: true, clipShadows: true,
      transparent, opacity: finish.opacity ?? 1, depthWrite: !transparent, side: transparent ? THREE.DoubleSide : THREE.FrontSide,
      polygonOffset: !transparent, polygonOffsetUnits: -4 * Math.min(order, 30),
      // Glow lights itself in its own colour; tissue glows faintly, as if lit from within.
      ...(mat === 'glow' && { emissive: tint, emissiveIntensity: 0.85 }),
      ...(mat === 'tissue' && { emissive: tint, emissiveIntensity: 0.16 }),
    })
  }

  private dress(part: ModelPart): void {
    const index = this.undressed.indexOf(part)
    if (index < 0) return
    this.undressed.splice(index, 1)
    const { spec } = part
    if (spec.shape === 'group') return
    const material = this.surface(spec.mat, spec.color, [...this.graph.parts.keys()].indexOf(spec.name), spec.finish)
    part.geometry.setAttribute('outlineNormal', smoothNormals(part.geometry))
    const shell = inkShell(this.ink)
    const edges = new THREE.EdgesGeometry(part.geometry, 40)
    const edgeInk = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.32, depthWrite: false })
    for (const resource of [material, shell, edges, edgeInk]) this.disposables.add(resource)
    this.owned.set(part, [material, shell, edges, edgeInk])
    for (const reveal of part.reveals) {
      const mesh = new THREE.Mesh(part.geometry, material)
      mesh.castShadow = !material.transparent; mesh.receiveShadow = true; mesh.userData.part = spec.name; mesh.renderOrder = 1000
      const outline = new THREE.Mesh(part.geometry, shell), lines = new THREE.LineSegments(edges, edgeInk)
      outline.layers.set(INK_LAYER); outline.renderOrder = 1000; lines.layers.set(INK_LAYER); lines.renderOrder = 1001
      reveal.add(mesh, outline, lines)
    }
    this.sections.register(part, [material, shell, edgeInk], material.color, !material.transparent)
  }

  /** Renders one throwaway frame of stand-ins for every material, shadow pass
   *  and render target the stage will use, so shaders compile and buffers are
   *  allocated now, while nothing is on screen, not on a part's first frame.
   *  The stand-ins then stay hidden in the scene, so the programs stay cached. */
  private warmUp(): void {
    const geometry = partGeometry({ kind: 'part', id: '', name: '', shape: 'box', dimensions: { w: 1, h: 1, d: 1, round: 0 }, at: [0, 0, 0], turn: [0, 0, 0], scale: 1, copies: 1, step: [0, 0, 0], around: false, mat: 'steel', half: false })
    const group = new THREE.Group()
    const materials: THREE.Material[] = [this.surface('steel', undefined, 0), this.surface('glass', undefined, 0), this.surface('glow', undefined, 0), inkShell(this.ink), new THREE.LineBasicMaterial({ transparent: true, depthWrite: false })]
    for (const material of materials) material.clippingPlanes = [this.sections.plane]
    for (const material of [...materials, ...this.sections.warmUpMaterials(), ...this.contact.materials]) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true; mesh.receiveShadow = true
      group.add(mesh)
    }
    group.scale.setScalar(1e-6)
    this.scene.add(group)
    for (const resource of [geometry, ...materials]) this.disposables.add(resource)
    this.camera.position.set(0, 0, 1); this.camera.lookAt(0, 0, 0); this.camera.updateMatrixWorld()
    this.renderer.shadowMap.needsUpdate = true
    this.contact.render(this.renderer, this.scene)
    this.renderer.render(this.scene, this.camera)
    group.visible = false
  }

  /** The model as drawn right now, on white, as a JPEG data URL: what the designer's polish pass looks at. */
  snapshot(): string | undefined {
    if (this.disposed || !this.options || !this.framed) return undefined
    this.dirty = true; this.tick(performance.now())
    // Read in the same task as the render, before the browser presents and clears the buffer.
    const source = this.renderer.domElement, canvas = document.createElement('canvas')
    canvas.width = source.width; canvas.height = source.height
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.85)
  }

  /** Removes a part (and the parts inside it), as a polish pass replacing or dropping it. Returns the removed names. */
  remove(name: string): string[] {
    if (this.disposed) return []
    const removed = this.graph.remove(name)
    for (const part of removed) {
      for (const material of this.sections.unregister(part)) this.glow.forget(material)
      this.motions.delete(part.spec.name)
      for (const resource of this.owned.get(part) ?? []) { resource.dispose(); this.disposables.delete(resource); if (resource instanceof THREE.Material) this.glow.forget(resource) }
      this.owned.delete(part)
      const waiting = this.undressed.indexOf(part); if (waiting >= 0) this.undressed.splice(waiting, 1)
    }
    if (removed.length) { this.renderer.shadowMap.needsUpdate = true; this.fit(); this.dirty = true; this.options?.wake() }
    return removed.map((part) => part.spec.name)
  }

  reveal(part: ModelPart, progress: number): void {
    if (this.disposed) return
    this.dress(part)
    const first = !part.built
    this.graph.reveal(part, progress)
    if (first) this.fit()
    this.dirty = true; this.options.wake()
  }

  /** The part's anchor in viewport pixels, under the camera as last rendered. */
  project(name: string, out: Point = [0, 0]): Point {
    return this.toViewport(this.camera, name, out)
  }

  /** As `project`, under the camera the framing is settling to. */
  projectSettled(name: string, out: Point = [0, 0]): Point {
    return this.toViewport(this.settled, name, out)
  }

  /** The settled model's left and right edges in viewport pixels between `top`
   *  and `bottom`, or overall when it has nothing at those heights. */
  labelEdges(top = -Infinity, bottom = Infinity): [number, number] {
    let left = Infinity, right = -Infinity
    for (let band = Math.max(0, Math.floor(top / BAND)); band <= Math.min(this.bands.length - 1, Math.floor(bottom / BAND)); band++) {
      const edges = this.bands[band]
      if (edges) { left = Math.min(left, edges[0]); right = Math.max(right, edges[1]) }
    }
    if (left > right) [left, right] = this.silhouette
    return [Math.max(12, left), Math.min(this.options.width - 12, right)]
  }

  /** Widens a label column by `left`/`right` pixels when its words would otherwise touch the model. */
  widenReserve(left: number, right: number): void {
    const max = this.options.width * 0.3
    const next = { left: Math.min(max, this.reserve.left + Math.max(0, left)), right: Math.min(max, this.reserve.right + Math.max(0, right)) }
    if ((next.left <= this.reserve.left + 1 && next.right <= this.reserve.right + 1) || this.disposed) return
    Object.assign(this.reserve, next)
    if (this.framed) this.fit()
    this.dirty = true; this.options.wake()
  }

  /** Keeps rendering until `until`, for overlay work drawn against this stage. */
  hold(until: number): void {
    this.heldUntil = Math.max(this.heldUntil, until); this.options.wake()
  }

  /** Moves the part's label anchor onto a surface the settled camera can see:
   *  not cut away, not behind another part. Among visible points it prefers
   *  those toward the label's column, so leaders stay short and steady. The
   *  anchor is kept in its copy's own frame, so it rides along with motion. */
  locate(name: string, side?: 'left' | 'right'): void {
    const part = this.graph.parts.get(name)
    if (!part?.built || this.disposed) return
    this.scene.updateMatrixWorld()
    const meshes: THREE.Object3D[] = []
    for (const other of this.graph.parts.values()) if (other.built) for (const reveal of other.reveals) for (const child of reveal.children) if ((child as THREE.Mesh).isMesh && child.layers.isEnabled(0)) meshes.push(child)
    const origin = this.settled.position, position = part.geometry.getAttribute('position')
    const stride = Math.max(1, Math.floor(position.count / 24))
    const candidates: Array<{ copy: number; world: THREE.Vector3; score: number }> = []
    const centre = part.geometry.boundingBox!.getCenter(new THREE.Vector3())
    const goal = centre.clone().applyMatrix4(part.placements[0]!.matrixWorld).project(this.settled)
    if (side) goal.x += ((side === 'left' ? -1 : 1) - goal.x) * 0.35
    for (const [copy, placement] of part.placements.entries()) {
      const local = [centre.clone()]
      for (let i = 0; i < position.count; i += stride) local.push(new THREE.Vector3().fromBufferAttribute(position, i))
      for (const point of local) {
        const world = point.applyMatrix4(placement.matrixWorld), screen = world.clone().project(this.settled)
        candidates.push({ copy, world, score: Math.hypot(screen.x - goal.x, (screen.y - goal.y) * this.options.height / this.options.width) })
      }
    }
    candidates.sort((a, b) => a.score - b.score)
    part.anchor = undefined
    for (const { copy, world } of candidates.slice(0, 48)) {
      this.raycaster.set(origin, world.clone().sub(origin).normalize())
      this.raycaster.far = origin.distanceTo(world) + this.sphere.radius
      const hit = this.raycaster.intersectObjects(meshes, false).find((intersection) => {
        const material = (intersection.object as THREE.Mesh).material as THREE.Material
        const clipped = material.clippingPlanes?.some((plane) => plane.distanceToPoint(intersection.point) < 0)
        return !clipped && (!material.transparent || intersection.object.userData.part === name)
      })
      const placement = part.placements[copy]!
      if (hit?.object.userData.part === name && isWithinCopy(hit.object, placement)) {
        part.anchor = placement.worldToLocal(hit.point.clone()); part.anchorCopy = copy
        return
      }
    }
  }

  private toViewport(camera: THREE.Camera, name: string, out: Point): Point {
    const point = this.graph.anchor(name, this.scratch) ?? this.scratch.set(0, 0, 0)
    point.project(camera)
    out[0] = (point.x + 1) * this.options.width / 2; out[1] = (1 - point.y) * this.options.height / 2
    return out
  }

  private fit(): void {
    // Measure the rest pose, then each motion's far reach, so the frame never chases the mechanism.
    for (const [name, motion] of this.motions) this.restPose(this.graph.parts.get(name)!, motion)
    const points = this.graph.corners()
    if (!points.length) return
    const reach = this.motionReach()
    points.push(...reach)
    const yaws = this.options.turntable ? [this.yawGoal - VIEW.sway, this.yawGoal, this.yawGoal + VIEW.sway] : [this.yawGoal]
    const { width, height } = this.options
    const { distance, target } = illustratedFraming(points, VIEW.fov, width, height, this.reserve, yaws, this.pitchGoal)
    const box = new THREE.Box3().setFromPoints(points)
    box.getBoundingSphere(this.sphere)
    const shift = (this.reserve.left - this.reserve.right) / 2
    const changed = Math.abs(distance - this.desiredDistance) > this.desiredDistance * 0.005 || target.distanceTo(this.desiredTarget) > this.sphere.radius * 0.005 || Math.abs(shift - this.desiredShift) > 0.5
    this.desiredTarget.copy(target); this.desiredDistance = distance; this.desiredShift = shift
    this.settled.setViewOffset(width, height, -shift, 0, width, height)
    this.pose(this.settled, this.desiredTarget, this.desiredDistance, this.yawGoal, this.pitchGoal)
    // Silhouette bands come from real surface points, so a label can sit right beside the part it names.
    this.bands = []
    let left = Infinity, right = -Infinity
    for (const point of [...this.graph.samples(), ...reach]) {
      point.project(this.settled)
      const x = (point.x + 1) * width / 2, band = Math.floor((1 - point.y) * height / 2 / BAND)
      left = Math.min(left, x); right = Math.max(right, x)
      if (band < 0 || band > height / BAND) continue
      const edges = this.bands[band] ??= [x, x]
      edges[0] = Math.min(edges[0], x); edges[1] = Math.max(edges[1], x)
    }
    this.silhouette = [left, right]
    // Lights, shadows and the contact catcher all scale with the model, whatever its units.
    const { center, radius } = this.sphere, size = box.getSize(new THREE.Vector3())
    this.ground.position.set(center.x, box.min.y - radius * 0.002, center.z); this.ground.scale.setScalar(radius * 6)
    const footprint = Math.max(size.x, size.z) * 1.5 + radius * 0.3
    this.contact.place(center.x, box.min.y, center.z, footprint, footprint, Math.max(radius * 0.5, size.y * 0.35))
    this.key.position.copy(center).add(new THREE.Vector3(-1.6, 3.4, 2.2).multiplyScalar(radius * 3))
    this.key.target.position.copy(center)
    this.key.shadow.normalBias = radius * 0.006
    const shadow = this.key.shadow.camera, extent = radius * 1.3
    shadow.left = -extent; shadow.right = extent; shadow.top = extent; shadow.bottom = -extent
    shadow.near = radius * 0.5; shadow.far = radius * 24; shadow.updateProjectionMatrix()
    for (const camera of [this.camera, this.settled]) { camera.near = Math.max(1e-3, distance - radius * 4) * 0.5; camera.far = distance + radius * 8; camera.updateProjectionMatrix() }
    if (!this.framed) {
      // Pose the camera now: the pen projects the first part before the first frame renders.
      this.target.copy(this.desiredTarget); this.distance = this.desiredDistance; this.shift = shift
      this.swayFrom = performance.now(); this.framed = true
      this.camera.setViewOffset(width, height, -shift, 0, width, height)
      this.pose(this.camera, this.target, this.distance, this.yaw, this.pitch)
    }
    if (changed) this.framing++
  }

  /** Points bounding where each moving part can go: a slide's far end, or
   *  the circles a spin (each copy in place) or an orbit (about the parent's
   *  origin) sweeps its corners through. */
  private motionReach(): THREE.Vector3[] {
    const points: THREE.Vector3[] = [], turn = new THREE.Quaternion()
    const sweep = (corners: THREE.Vector3[], centre: THREE.Vector3, axis: THREE.Vector3): void => {
      for (let i = 1; i < 12; i++) {
        turn.setFromAxisAngle(axis, i / 12 * Math.PI * 2)
        for (const corner of corners) points.push(corner.clone().sub(centre).applyQuaternion(turn).add(centre))
      }
    }
    for (const [name, motion] of this.motions) {
      const part = this.graph.parts.get(name)!, { mark } = motion, parent = part.root.parent!
      const axis = unitAxis(mark.axis, new THREE.Vector3()).transformDirection(parent.matrixWorld)
      if (mark.motion === 'slide' || mark.motion === 'bob') {
        const offset = unitAxis(mark.axis, new THREE.Vector3()).multiplyScalar(mark.amount).applyMatrix3(new THREE.Matrix3().setFromMatrix4(parent.matrixWorld))
        for (const corner of this.graph.corners(part.root)) points.push(corner.add(offset))
      } else if (mark.motion === 'spin') {
        for (const placement of part.placements) sweep(this.graph.corners(placement), placement.getWorldPosition(new THREE.Vector3()), axis)
      } else {
        const centre = this.orbitCentre(part, motion, new THREE.Vector3()).applyMatrix4(parent.matrixWorld)
        sweep(this.graph.corners(part.root), centre, axis)
      }
    }
    return points
  }

  /** The point an orbit circles, in the parent's frame: the parent's origin,
   *  or, for a part resting on that origin, a point `amount` to one side. */
  private orbitCentre(part: ModelPart, motion: Motion, target: THREE.Vector3): THREE.Vector3 {
    const axis = unitAxis(motion.mark.axis, this.axis)
    const radial = target.copy(motion.position).addScaledVector(axis, -motion.position.dot(axis))
    if (part.spec.around || radial.lengthSq() > 1e-12) return target.set(0, 0, 0)
    return target.set(axis.x ? 0 : 1, axis.x ? 1 : 0, 0).multiplyScalar(-Math.abs(motion.mark.amount)).add(motion.position)
  }

  private restPose(part: ModelPart, motion: Motion): void {
    part.root.position.copy(motion.position); part.root.rotation.copy(motion.rotation)
    for (const [i, placement] of part.placements.entries()) placement.quaternion.copy(motion.turns[i]!)
  }

  move(mark: Extract<ModelCommand, { kind: 'move' }>, now: number): void {
    const part = this.graph.parts.get(mark.part)
    if (!part?.built || mark.amount === 0 || this.disposed) return
    const old = this.motions.get(mark.part)
    const start = now - this.motionClock < MOTION_SYNC_MS ? this.motionClock : now
    this.motionClock = start
    this.motions.set(mark.part, {
      mark, start, position: old?.position.clone() ?? part.root.position.clone(), rotation: old?.rotation.clone() ?? part.root.rotation.clone(),
      turns: old?.turns ?? part.placements.map((placement) => placement.quaternion.clone()),
    })
    // Reserve the motion envelope once; do not chase the mechanism each frame.
    this.fit()
    this.dirty = true; this.options.wake()
  }

  cut(axis: Extract<ModelCommand, { kind: 'cut' }>['axis']): void {
    if (this.disposed) return
    this.sections.cut(axis, this.graph.box().getCenter(new THREE.Vector3()))
    // Turn the new section toward the viewer, unless someone has already chosen a view.
    const facing = axis === 'view' ? undefined : CUT_VIEW[axis]
    if (facing && this.released === -Infinity) { this.yawGoal = facing.yaw ?? this.yawGoal; this.pitchGoal = facing.pitch ?? this.pitchGoal; this.fit() }
    this.framing++; this.dirty = true; this.options.wake()
  }

  /** Returns whether the shared clock needs another frame; idle calls do not render. */
  tick(now: number): boolean {
    if (this.disposed || this.lost || !this.options) return false
    // One part's materials per frame, ahead of its sentence.
    const dressing = this.undressed.length > 0
    if (dressing) this.dress(this.undressed[0]!)
    if (!this.framed) return this.undressed.length > 0
    this.matchPixelRatio()
    const dt = Math.min(32, Math.max(0, now - this.last)); this.last = now
    const settledAfterDrag = !this.drag && now - this.released > 3000
    const swaying = this.options.turntable && settledAfterDrag
    const returning = settledAfterDrag && Math.abs(this.pitch - this.pitchGoal) > 1e-4
    const fitting = Math.abs(this.distance - this.desiredDistance) > this.desiredDistance * 1e-4 || this.target.distanceTo(this.desiredTarget) > this.sphere.radius * 1e-4
      || Math.abs(this.distanceVelocity.v) > 1e-7 || Math.abs(this.shift - this.desiredShift) > 0.05 || (!this.drag && Math.abs(this.baseYaw - this.yawGoal) > 1e-4)
    const moving = this.motions.size > 0, held = now < this.heldUntil
    if (!this.dirty && !moving && !swaying && !returning && !fitting && !held && !this.drag && !dressing) {
      if (this.rendering && this.options.debug()) console.info(`[model:${this.options.id}] idle after ${this.renders} renders`)
      this.rendering = false
      return false
    }
    this.distance = damp(this.distance, this.desiredDistance, this.distanceVelocity, 260, dt)
    for (const [i, key] of (['x', 'y', 'z'] as const).entries()) this.target[key] = damp(this.target[key], this.desiredTarget[key], this.targetVelocity[i]!, 260, dt)
    if (Math.abs(this.shift - this.desiredShift) > 0.05) {
      this.shift = damp(this.shift, this.desiredShift, this.shiftVelocity, 260, dt)
      this.camera.setViewOffset(this.options.width, this.options.height, -this.shift, 0, this.options.width, this.options.height)
    }
    if (!this.drag) { const before = this.baseYaw; this.baseYaw = damp(this.baseYaw, this.yawGoal, this.yawVelocity, 420, dt); if (!swaying) this.yaw += this.baseYaw - before }
    if (returning) this.pitch += (this.pitchGoal - this.pitch) * (1 - Math.exp(-dt / 600))
    if (swaying) {
      // Phase zero at resume keeps the yaw continuous; the sway eases in over a second and a half.
      const since = Math.max(0, now - Math.max(this.released + 3000, this.swayFrom))
      this.yaw = this.baseYaw + VIEW.sway * Math.min(1, since / 1500) * Math.sin(since / VIEW.swayPeriodMs * Math.PI * 2)
    }
    for (const [name, motion] of this.motions) {
      const part = this.graph.parts.get(name)!, root = part.root
      const { mark } = motion, cycle = (now - motion.start) / (mark.period * 1000), phase = cycle * Math.PI * 2
      this.restPose(part, motion)
      if (mark.motion === 'spin') {
        // Each copy turns in place, about the axis as seen in the parent's frame.
        this.turn.setFromAxisAngle(unitAxis(mark.axis, this.axis), THREE.MathUtils.degToRad(mark.amount) * (cycle % 1))
        for (const placement of part.placements) placement.quaternion.premultiply(this.turn)
      } else if (mark.motion === 'orbit') {
        // Circles the orbit centre once per period, keeping its own orientation; a ring revolves whole.
        this.turn.setFromAxisAngle(unitAxis(mark.axis, this.axis), Math.sign(mark.amount || 1) * (cycle % 1) * Math.PI * 2)
        const centre = this.orbitCentre(part, motion, this.scratch)
        root.position.sub(centre).applyQuaternion(this.turn).add(centre)
        if (part.spec.around) root.quaternion.premultiply(this.turn)
      } else root.position[mark.axis] += mark.amount * (1 - Math.cos(phase)) / 2
    }
    this.pose(this.camera, this.target, this.distance, this.yaw, this.pitch)
    this.sections.update(this.camera, this.sphere)
    if (this.dirty || moving) {
      this.renderer.shadowMap.needsUpdate = true
      this.contact.render(this.renderer, this.scene)
    }
    this.renderer.render(this.scene, this.camera)
    this.glow.render(this.renderer, this.scene, this.camera)
    this.afterRender?.(); this.visit?.()
    this.renders++; this.rendering = true; this.dirty = false
    const active = moving || swaying || fitting || returning || held || !!this.drag || this.undressed.length > 0
    if (active) this.options.trace(now + 100)
    return active
  }

  private pose(camera: THREE.PerspectiveCamera, target: THREE.Vector3, distance: number, yaw: number, pitch: number): void {
    camera.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(distance).add(target)
    camera.lookAt(target); camera.updateMatrixWorld()
  }

  private buildEnvironment(): void {
    this.environment?.dispose()
    // The official MIT RoomEnvironment provides local studio reflections, not a backdrop.
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer)
    this.environment = pmrem.fromScene(room, 0.04)
    this.scene.environment = this.environment.texture
    room.dispose(); pmrem.dispose()
  }

  /** A window moved to a display with another scale keeps a sharp, correctly sized canvas. */
  private matchPixelRatio(): void {
    const ratio = Math.min(MODEL_LIMITS.dpr, globalThis.devicePixelRatio || 1)
    if (ratio === this.pixelRatio) return
    this.pixelRatio = ratio
    this.renderer.setPixelRatio(ratio); this.renderer.setSize(this.options.width, this.options.height)
    this.ink.resolution.set(this.options.width * ratio, this.options.height * ratio); this.ink.width.value = 1.2 * ratio
    this.glow.setSize(this.options.width * ratio, this.options.height * ratio)
    this.dirty = true
  }

  private wireCanvas(): void {
    const canvas = this.renderer.domElement
    // three.js restores its own GL state; the environment map and shadows must be rebuilt.
    canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.lost = true })
    canvas.addEventListener('webglcontextrestored', () => {
      if (this.disposed) return
      this.lost = false; this.buildEnvironment(); this.dirty = true; this.options.wake()
    })
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.drag || this.disposed) return
      event.preventDefault(); event.stopPropagation()
      clearTimeout(this.resumeTimer)
      this.baseYaw = this.yawGoal = this.yaw; this.yawVelocity.v = 0
      this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId); this.options.capture(true, true); this.options.wake()
    })
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.drag?.pointer) return
      this.yaw -= (event.clientX - this.drag.x) * 0.008; this.baseYaw = this.yawGoal = this.yaw
      this.pitch = THREE.MathUtils.clamp(this.pitch + (event.clientY - this.drag.y) * 0.006, -1.1, 1.1)
      this.drag.x = event.clientX; this.drag.y = event.clientY
      this.dirty = true; this.options.wake()
    })
    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== this.drag?.pointer) return
      this.releaseDrag(); this.resumeTurntable()
      this.options.capture(this.options.overCard(event.clientX, event.clientY), false); this.options.wake()
    }
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', finish)
    canvas.addEventListener('lostpointercapture', () => { if (this.drag) { this.drag = undefined; this.resumeTurntable(); this.options.capture(false, false); this.options.wake() } })
  }

  private resumeTurntable(): void {
    this.released = performance.now(); this.turned++
    // Re-frame for the new angle; labels re-slot once, rather than chasing the drag.
    if (this.framed) this.fit()
    clearTimeout(this.resumeTimer)
    this.resumeTimer = setTimeout(() => this.options.wake(), 3010)
  }

  private releaseDrag(): void {
    const pointer = this.drag?.pointer; this.drag = undefined
    if (pointer !== undefined && this.renderer.domElement.hasPointerCapture(pointer)) this.renderer.domElement.releasePointerCapture(pointer)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; clearTimeout(this.resumeTimer); this.releaseDrag(); this.options?.capture(false, false)
    this.afterRender = undefined; this.visit = undefined
    this.motions.clear(); this.sections.dispose(); this.graph.dispose()
    for (const resource of this.disposables) resource.dispose()
    this.disposables.clear(); this.scene.clear(); this.scene.environment = null
    this.environment?.dispose(); this.key.shadow.dispose(); this.glow.dispose()
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.host?.remove()
  }
}
