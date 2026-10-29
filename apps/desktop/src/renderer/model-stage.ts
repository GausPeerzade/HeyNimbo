import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { MODEL_LIMITS, type ModelMaterial, type PartMark, type ModelCommand } from '../shared/model-protocol'
import type { Point } from './ink'
import { ModelSections } from './model-sections'
import { boxCorners, illustratedDistance, ModelGraph, type ModelPart } from './model-geometry'

const INK = 0x283d40
const palette = { blue: 0x286f9d, red: 0xb54e62, orange: 0xbd742e, green: 0x38816b, purple: 0x7a60a5, grey: 0x6d797f }
const finishes: Record<ModelMaterial, { color: number; roughness: number; metalness: number; opacity?: number }> = {
  steel: { color: 0xb4c1c1, roughness: 0.28, metalness: 0.88 }, brass: { color: 0xc4a15b, roughness: 0.3, metalness: 0.78 },
  copper: { color: 0xb97e60, roughness: 0.32, metalness: 0.85 }, rubber: { color: 0x273638, roughness: 0.9, metalness: 0 },
  glass: { color: 0xb6d8d3, roughness: 0.12, metalness: 0, opacity: 0.3 }, water: { color: 0x78abb6, roughness: 0.18, metalness: 0, opacity: 0.55 },
  wood: { color: 0xb29673, roughness: 0.7, metalness: 0 }, plastic: { color: 0x749a8c, roughness: 0.38, metalness: 0.05 },
  paper: { color: 0xeee4ce, roughness: 1, metalness: 0 }, glow: { color: 0xe6c986, roughness: 1, metalness: 0 },
}

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
interface Motion { mark: Extract<ModelCommand, { kind: 'move' }>; start: number; position: THREE.Vector3; rotation: THREE.Euler }

/** One transparent context per paper body. The overlay's clock owns every frame. */
export class ModelStage {
  readonly graph = new ModelGraph()
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1000)
  readonly sections = new ModelSections(this.scene)
  readonly renderer: THREE.WebGLRenderer
  readonly margin: number
  afterRender?: () => void
  visit?: () => void
  private readonly disposables = new Set<THREE.BufferGeometry | THREE.Material>()
  private readonly motions = new Map<string, Motion>()
  private readonly environment: THREE.WebGLRenderTarget
  private readonly key = new THREE.DirectionalLight(0xfff5e4, 3)
  private readonly ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ color: INK, opacity: 0.13, depthWrite: false }))
  private readonly target = new THREE.Vector3()
  private readonly desiredTarget = new THREE.Vector3()
  private distance = 8
  private desiredDistance = 8
  private yaw = 0.6
  private pitch = 0.4
  private last = 0
  private released = -Infinity
  private resumeTimer?: ReturnType<typeof setTimeout>
  private drag?: { pointer: number; x: number; y: number }
  private dirty = true
  private disposed = false
  private rendering = false
  private renders = 0
  private framed = false

  constructor(readonly host: HTMLElement, readonly options: StageOptions) {
    this.margin = Math.min(120, options.width * 0.23)
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, stencil: true, powerPreference: 'low-power' })
    this.renderer.setClearColor(0, 0)
    this.renderer.setPixelRatio(Math.min(MODEL_LIMITS.dpr, globalThis.devicePixelRatio || 1))
    this.renderer.setSize(options.width, options.height)
    this.renderer.localClippingEnabled = true
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.shadowMap.autoUpdate = false
    // The official MIT RoomEnvironment provides local studio reflections, not a backdrop.
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer)
    this.environment = pmrem.fromScene(room, 0.04)
    this.scene.environment = this.environment.texture; this.scene.environmentIntensity = 0.8
    room.dispose(); pmrem.dispose()
    this.camera.aspect = options.width / options.height
    this.camera.updateProjectionMatrix()
    host.append(this.renderer.domElement)
    this.scene.add(this.graph.root, new THREE.HemisphereLight(0xfff8e7, 0x637b80, 0.7))
    this.key.castShadow = true; this.key.shadow.mapSize.set(512, 512)
    this.key.shadow.radius = 3
    this.key.shadow.normalBias = 0.015; this.key.shadow.bias = -0.0003
    const fill = new THREE.DirectionalLight(0xc5e1e5, 1.1); fill.position.set(4, 2, 3)
    const rim = new THREE.DirectionalLight(0xffe6c8, 2.4); rim.position.set(1, 4, -4)
    this.scene.add(this.key, this.key.target, fill, rim)
    this.ground.rotation.x = -Math.PI / 2; this.ground.receiveShadow = true; this.ground.renderOrder = 2000
    this.scene.add(this.ground); this.disposables.add(this.ground.geometry); this.disposables.add(this.ground.material)
    this.wireDrag()
  }

  prepare(spec: PartMark): ModelPart | undefined {
    const part = this.graph.add(spec)
    if (!part) return
    const finish = finishes[spec.mat]
    const material = new THREE.MeshPhysicalMaterial({ ...finish, color: spec.color ? palette[spec.color] : finish.color, transparent: finish.opacity !== undefined, side: THREE.DoubleSide, clipShadows: true, clearcoat: spec.mat === 'plastic' || spec.mat === 'glass' ? 0.5 : 0, ...(spec.mat === 'glow' && { emissive: 0x8c691d, emissiveIntensity: 0.2 }) })
    const edges = new THREE.EdgesGeometry(part.geometry, 32)
    const outline = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.25, depthWrite: false })
    this.disposables.add(material); this.disposables.add(edges); this.disposables.add(outline)
    for (const reveal of part.reveals) {
      const mesh = new THREE.Mesh(part.geometry, material); mesh.castShadow = true; mesh.receiveShadow = true
      reveal.add(mesh, new THREE.LineSegments(edges, outline))
    }
    this.sections.register(part, material, outline)
    return part
  }

  reveal(part: ModelPart, progress: number): void {
    if (this.disposed) return
    const first = !part.built
    this.graph.reveal(part, progress)
    if (first) this.fit()
    this.dirty = true; this.options.wake()
  }

  project(name: string): Point {
    const point = this.graph.anchor(name) ?? new THREE.Vector3()
    point.project(this.camera)
    return [(point.x + 1) * this.options.width / 2, (1 - point.y) * this.options.height / 2]
  }

  labelEdges(): [number, number] {
    const points = boxCorners(this.graph.box()).map((point) => point.project(this.camera))
    const xs = points.map((point) => (point.x + 1) * this.options.width / 2)
    return [Math.max(this.margin, Math.min(...xs)), Math.min(this.options.width - this.margin, Math.max(...xs))]
  }

  private fit(): void {
    const box = this.graph.box()
    for (const [name, motion] of this.motions) {
      const part = this.graph.parts.get(name)!, movingBox = this.graph.box(part.root)
      if (motion.mark.motion === 'slide' || motion.mark.motion === 'bob') {
        const offset = new THREE.Vector3(); offset[motion.mark.axis] = motion.mark.amount
        const matrix = part.root.parent!.matrixWorld
        offset.applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix))
        box.union(movingBox.translate(offset))
      } else {
        const sphere = movingBox.getBoundingSphere(new THREE.Sphere())
        const radius = sphere.radius + sphere.center.distanceTo(part.root.getWorldPosition(new THREE.Vector3())) + (motion.mark.motion === 'orbit' ? Math.abs(motion.mark.amount) : 0)
        box.union(new THREE.Box3().setFromCenterAndSize(part.root.getWorldPosition(new THREE.Vector3()), new THREE.Vector3().setScalar(radius * 2)))
      }
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    this.desiredTarget.copy(sphere.center)
    this.desiredDistance = illustratedDistance(box, this.camera.fov, this.options.width, this.options.height, this.margin, this.yaw, this.pitch)
    this.ground.position.set(sphere.center.x, box.min.y - 0.01, sphere.center.z); this.ground.scale.setScalar(sphere.radius * 5)
    this.key.position.copy(sphere.center).add(new THREE.Vector3(-1.5, 12, 3.5).multiplyScalar(sphere.radius))
    this.key.target.position.copy(sphere.center)
    const shadow = this.key.shadow.camera, extent = sphere.radius * 1.5
    shadow.left = -extent; shadow.right = extent; shadow.top = extent; shadow.bottom = -extent
    shadow.near = 0.1; shadow.far = sphere.radius * 18; shadow.updateProjectionMatrix()
    if (!this.framed) { this.target.copy(this.desiredTarget); this.distance = this.desiredDistance; this.framed = true }
  }

  move(mark: Extract<ModelCommand, { kind: 'move' }>, now: number): void {
    const part = this.graph.parts.get(mark.part)
    if (!part?.built || mark.amount === 0) return
    const old = this.motions.get(mark.part)
    this.motions.set(mark.part, { mark, start: now, position: old?.position.clone() ?? part.root.position.clone(), rotation: old?.rotation.clone() ?? part.root.rotation.clone() })
    // Reserve the motion envelope once; do not chase the mechanism each frame.
    this.fit()
    this.dirty = true; this.options.wake()
  }

  cut(axis: Extract<ModelCommand, { kind: 'cut' }>['axis']): void {
    this.sections.cut(axis, this.graph.bounds().center); this.dirty = true; this.options.wake()
  }

  /** Returns whether the shared clock needs another frame; idle calls do not render. */
  tick(now: number): boolean {
    if (this.disposed || !this.framed) return false
    const dt = Math.min(32, Math.max(0, now - this.last)); this.last = now
    const returning = !this.drag && now - this.released > 3000 && Math.abs(this.pitch - 0.4) > 0.0001
    const moving = this.motions.size > 0 || (this.options.turntable && this.framed && !this.drag && now - this.released > 3000)
    const fitting = this.target.distanceTo(this.desiredTarget) > 0.0001 || Math.abs(this.distance - this.desiredDistance) > 0.0001
    if (!this.dirty && !moving && !returning && !fitting) {
      if (this.rendering && this.options.debug()) console.info(`[model:${this.options.id}] idle after ${this.renders} renders`)
      this.rendering = false
      return false
    }
    const blend = 1 - Math.exp(-dt / 240)
    this.target.lerp(this.desiredTarget, blend); this.distance += (this.desiredDistance - this.distance) * blend
    if (returning) this.pitch += (0.4 - this.pitch) * (1 - Math.exp(-dt / 900))
    if (this.options.turntable && !this.drag && now - this.released > 3000) {
      const ease = Math.min(1, (now - this.released - 3000) / 1500)
      this.yaw += dt * 0.000015 * ease
    }
    for (const [name, motion] of this.motions) {
      const part = this.graph.parts.get(name)!
      const { mark } = motion, phase = (now - motion.start) / (mark.period * 1000) * Math.PI * 2
      part.root.position.copy(motion.position); part.root.rotation.copy(motion.rotation)
      if (mark.motion === 'spin') part.root.rotation[mark.axis] += THREE.MathUtils.degToRad(mark.amount) * (now - motion.start) / (mark.period * 1000)
      else if (mark.motion === 'orbit') {
        const axis = new THREE.Vector3(mark.axis === 'x' ? 1 : 0, mark.axis === 'y' ? 1 : 0, mark.axis === 'z' ? 1 : 0)
        const radial = new THREE.Vector3(mark.axis === 'x' ? 0 : 1, mark.axis === 'x' ? 1 : 0, 0).multiplyScalar(mark.amount)
        part.root.position.add(radial.applyAxisAngle(axis, phase))
      } else part.root.position[mark.axis] += mark.amount * (1 - Math.cos(phase)) / 2
    }
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)).multiplyScalar(this.distance).add(this.target)
    this.camera.lookAt(this.target); this.camera.updateMatrixWorld()
    this.sections.update(this.camera, this.graph.bounds())
    this.renderer.shadowMap.needsUpdate = this.dirty || this.motions.size > 0
    this.renderer.render(this.scene, this.camera)
    this.afterRender?.(); this.visit?.()
    this.renders++; this.rendering = true; this.dirty = false
    if (moving || fitting || returning || this.drag) this.options.trace(now + 100)
    return moving || fitting || returning || !!this.drag
  }

  private wireDrag(): void {
    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.drag || this.disposed) return
      event.preventDefault(); event.stopPropagation()
      clearTimeout(this.resumeTimer)
      this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId); this.options.capture(true, true); this.options.wake()
    })
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.drag?.pointer) return
      this.yaw -= (event.clientX - this.drag.x) * 0.008
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
    this.released = performance.now()
    clearTimeout(this.resumeTimer)
    this.resumeTimer = setTimeout(() => this.options.wake(), 3010)
  }

  private releaseDrag(): void {
    const pointer = this.drag?.pointer; this.drag = undefined
    if (pointer !== undefined && this.renderer.domElement.hasPointerCapture(pointer)) this.renderer.domElement.releasePointerCapture(pointer)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; clearTimeout(this.resumeTimer); this.releaseDrag(); this.options.capture(false, false)
    this.afterRender = undefined; this.visit = undefined
    this.motions.clear(); this.sections.dispose(); this.graph.dispose()
    for (const resource of this.disposables) resource.dispose()
    this.disposables.clear(); this.scene.clear(); this.scene.environment = null
    this.environment.dispose(); this.key.shadow.dispose()
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.host.remove()
  }
}
