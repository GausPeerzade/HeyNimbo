import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { parseModelCommand, type PartMark, type ModelCommand } from '../shared/model-protocol'
import { ModelStage } from './model-stage'

class Canvas {
  listeners = new Map<string, Array<(event: any) => void>>()
  capture?: number
  addEventListener(name: string, callback: (event: any) => void): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]) }
  setPointerCapture(id: number): void { this.capture = id }
  hasPointerCapture(id: number): boolean { return this.capture === id }
  releasePointerCapture(): void { this.capture = undefined; this.dispatch('lostpointercapture') }
  dispatch(name: string, values: Record<string, unknown> = {}): void { for (const callback of this.listeners.get(name) ?? []) callback({ pointerId: 1, button: 0, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {}, ...values }) }
}
const environments = vi.hoisted(() => ({ built: 0 }))
vi.mock('three', async (load) => {
  const original = await load<typeof import('three')>()
  return { ...original, PMREMGenerator: class { fromScene = () => { environments.built++; return new original.WebGLRenderTarget(16, 16) }; dispose = vi.fn() }, WebGLRenderer: class {
    domElement = new Canvas()
    localClippingEnabled = false
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false }
    setClearColor = vi.fn(); setPixelRatio = vi.fn(); setSize = vi.fn(); render = vi.fn(); clear = vi.fn()
    getRenderTarget = vi.fn(() => null); setRenderTarget = vi.fn(); getClearAlpha = vi.fn(() => 0); setClearAlpha = vi.fn()
    dispose = vi.fn(); forceContextLoss = vi.fn()
  } }
})
const part = (name = 'body', args = '', shape = 'box') => parseModelCommand(`@part p ${name} ${shape} ${args}`) as PartMark
const move = (line: string) => parseModelCommand(line) as Extract<ModelCommand, { kind: 'move' }>
function setup(turntable = false) {
  const options = { id: 'p', width: 600, height: 500, turntable, wake: vi.fn(), capture: vi.fn(), overCard: (x: number, y: number) => x >= 0 && x < 600 && y >= 0 && y < 500, trace: vi.fn(), debug: () => false }
  const host = { append: vi.fn(), remove: vi.fn() }
  const stage = new ModelStage(host as unknown as HTMLElement, options)
  const canvas = stage.renderer.domElement as unknown as Canvas
  return { stage, options, host, canvas }
}
const world = (object: THREE.Object3D) => { object.updateWorldMatrix(true, false); return object.getWorldPosition(new THREE.Vector3()) }
/** Renders of the card's view, not the contact-shadow passes. */
const views = (stage: ModelStage) => vi.mocked(stage.renderer.render).mock.calls.filter(([, camera]) => camera === stage.camera).length
afterEach(() => vi.unstubAllGlobals())

describe('model stage lifecycle and interaction', () => {
  it('warms a bounded, transparent context before any card exists, then mounts it in a moment', () => {
    vi.stubGlobal('devicePixelRatio', 4)
    const stage = new ModelStage()
    expect(stage.renderer.setPixelRatio).toHaveBeenCalledWith(2)
    expect(stage.renderer.setClearColor).toHaveBeenCalledWith(0, 0)
    expect(stage.renderer.outputColorSpace).toBe(THREE.SRGBColorSpace)
    expect(stage.renderer.toneMapping).toBe(THREE.NeutralToneMapping)
    expect(stage.renderer.shadowMap).toMatchObject({ enabled: true, type: THREE.PCFShadowMap, autoUpdate: false })
    expect(stage.scene.environment).toBeInstanceOf(THREE.Texture)
    // One throwaway frame compiles every shader and allocates shadow and contact targets now.
    expect(views(stage)).toBe(1)
    expect(stage.renderer.setRenderTarget).toHaveBeenCalled()
    expect(stage.tick(16)).toBe(false)
    const prepared = stage.prepare(part())!
    expect(stage.waiting).toBe(1)
    const host = { append: vi.fn(), remove: vi.fn() }, wake = vi.fn()
    stage.mount(host as unknown as HTMLElement, { id: 'p', width: 600, height: 500, turntable: false, wake, capture: vi.fn(), overCard: () => false, trace: vi.fn(), debug: () => false })
    expect(stage.renderer.setSize).toHaveBeenCalledWith(600, 500)
    expect(host.append).toHaveBeenCalledWith(stage.renderer.domElement)
    expect(wake).toHaveBeenCalled()
    // A part prepared from its streamed line is the same part on its beat, dressed one per frame.
    expect(stage.prepare(part())).toBe(prepared)
    stage.tick(32); expect(stage.waiting).toBe(0)
    expect(prepared.reveals[0]!.children.some((node) => (node as THREE.Mesh).isMesh)).toBe(true)
    stage.dispose()
  })
  it('glides to new framing without a jump and stops rendering when idle', () => {
    const { stage } = setup()
    expect(stage.tick(0)).toBe(false)
    const first = stage.prepare(part())!; stage.reveal(first, 1); stage.tick(16)
    const before = stage.camera.position.clone()
    const second = stage.prepare(part('second', 'at=12,0,0'))!; stage.reveal(second, 0.1); stage.tick(32)
    const firstStep = before.distanceTo(stage.camera.position)
    for (let t = 48; t <= 5000; t += 16) stage.tick(t)
    expect(firstStep).toBeGreaterThan(0)
    expect(firstStep).toBeLessThan(before.distanceTo(stage.camera.position) / 8)
    const calls = vi.mocked(stage.renderer.render).mock.calls.length
    expect(stage.tick(6000)).toBe(false); expect(stage.tick(9000)).toBe(false)
    expect(stage.renderer.render).toHaveBeenCalledTimes(calls)
    stage.move(move('@move p body spin amount=0'), 9000)
    expect(stage.tick(10_000)).toBe(false)
    expect(stage.renderer.render).toHaveBeenCalledTimes(calls)
    stage.dispose()
  })
  it('starts motion only after entry, propagates it to children, and projects attached anchors on each pose', () => {
    const { stage } = setup()
    const parent = stage.prepare(part())!, child = stage.prepare(part('child', 'in=body at=0,1,0'))!
    const slide = move('@move p body slide amount=1 period=2')
    stage.move(slide, 0); stage.tick(1000)
    expect(parent.root.position.y).toBe(0)
    stage.reveal(parent, 1); stage.reveal(child, 1); stage.tick(1000)
    const before = [...stage.project('child')]
    stage.move(slide, 1000); expect(stage.tick(2000)).toBe(true)
    expect(parent.root.position.y).toBeCloseTo(1)
    expect(stage.graph.anchor('child')!.y).toBeCloseTo(2)
    expect(stage.project('child')).not.toEqual(before)
    stage.dispose()
  })
  it('spins each copy in place and orbits about the parent origin, starting from rest with no jump', () => {
    const { stage } = setup()
    const wheels = stage.prepare(part('wheels', 'copies=2 step=2,0,0', 'cylinder'))!
    const planet = stage.prepare(part('planet', 'r=0.2 at=2,0,0', 'sphere'))!
    stage.reveal(wheels, 1); stage.reveal(planet, 1); stage.tick(0)
    const rest = wheels.placements.map(world)
    stage.move(move('@move p wheels spin axis=x period=2'), 0); stage.move(move('@move p planet orbit axis=y period=4'), 0)
    stage.tick(1)
    expect(world(planet.root).distanceTo(new THREE.Vector3(2, 0, 0))).toBeLessThan(0.01)
    stage.tick(500)
    // Copies keep their places while turning; the planet keeps its distance from the centre.
    wheels.placements.forEach((placement, i) => expect(world(placement).distanceTo(rest[i]!)).toBeLessThan(1e-6))
    expect(wheels.placements[1]!.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(1)
    stage.tick(1000)
    expect(world(planet.root).length()).toBeCloseTo(2)
    expect(Math.abs(world(planet.root).z)).toBeCloseTo(2)
    stage.dispose()
  })
  it('runs motions begun together on one clock, so meshing gears stay in phase', () => {
    const { stage } = setup()
    const a = stage.prepare(part('a', 'r=0.3 teeth=12', 'gear'))!, b = stage.prepare(part('b', 'r=0.6 teeth=24 at=0.9,0,0', 'gear'))!
    stage.reveal(a, 1); stage.reveal(b, 1); stage.tick(0)
    stage.move(move('@move p a spin axis=y period=4'), 0)
    stage.move(move('@move p b spin axis=y amount=-360 period=8'), 120)
    stage.tick(1000)
    const angle = (target: THREE.Object3D) => new THREE.Euler().setFromQuaternion(target.quaternion, 'YXZ').y
    expect(angle(b.placements[0]!)).toBeCloseTo(-angle(a.placements[0]!) / 2)
    stage.dispose()
  })
  it('never recomputes the model bounds per frame while a mechanism runs', () => {
    const { stage } = setup()
    const body = stage.prepare(part())!, arm = stage.prepare(part('arm', 'in=body at=1,0,0'))!
    stage.reveal(body, 1); stage.reveal(arm, 1); stage.move(move('@move p arm spin period=2'), 0)
    for (let t = 0; t < 3000; t += 16) stage.tick(t)
    const corners = vi.spyOn(stage.graph, 'corners'), box = vi.spyOn(stage.graph, 'box'), samples = vi.spyOn(stage.graph, 'samples')
    for (let t = 3000; t < 4000; t += 16) expect(stage.tick(t)).toBe(true)
    expect(corners).not.toHaveBeenCalled(); expect(box).not.toHaveBeenCalled(); expect(samples).not.toHaveBeenCalled()
    stage.dispose()
  })
  it('gates orbit drag to the viewport and primary button, preserves capture outside, and releases on cancel/dispose', () => {
    const { stage, options, canvas } = setup(true)
    const body = stage.prepare(part())!; stage.reveal(body, 1); stage.tick(16)
    canvas.dispatch('pointermove', { clientX: 900 }); canvas.dispatch('pointerdown', { button: 2 })
    expect(options.capture).not.toHaveBeenCalled()
    const before = stage.camera.position.clone()
    canvas.dispatch('pointerdown'); expect(canvas.capture).toBe(1)
    canvas.dispatch('pointermove', { pointerId: 2, clientX: 400 }); stage.tick(32)
    expect(stage.camera.position.distanceTo(before)).toBeLessThan(0.1)
    canvas.dispatch('pointermove', { clientX: 750 }); stage.tick(48)
    expect(stage.camera.position.distanceTo(before)).toBeGreaterThan(1)
    const turned = stage.turned
    canvas.dispatch('pointerup', { pointerId: 2 }); expect(canvas.capture).toBe(1)
    canvas.dispatch('pointercancel', { clientX: 900 }); expect(canvas.capture).toBeUndefined()
    expect(options.capture).toHaveBeenLastCalledWith(false, false)
    expect(stage.turned).toBe(turned + 1)
    canvas.dispatch('pointerdown'); stage.dispose()
    expect(canvas.capture).toBeUndefined(); expect(options.capture).toHaveBeenLastCalledWith(false, false)
  })
  it('stops drawing while the context is lost and rebuilds its studio light when it comes back', () => {
    const { stage, canvas } = setup()
    const body = stage.prepare(part())!; stage.reveal(body, 1); stage.tick(16)
    const renders = views(stage), built = environments.built
    canvas.dispatch('webglcontextlost')
    expect(stage.tick(32)).toBe(false); expect(views(stage)).toBe(renders)
    canvas.dispatch('webglcontextrestored')
    expect(environments.built).toBe(built + 1)
    stage.tick(48); expect(views(stage)).toBe(renders + 1)
    stage.dispose()
  })
  it('follows a move to a display with another scale', () => {
    vi.stubGlobal('devicePixelRatio', 1)
    const { stage } = setup()
    const body = stage.prepare(part())!; stage.reveal(body, 1); stage.tick(16)
    vi.stubGlobal('devicePixelRatio', 2)
    stage.tick(32)
    expect(stage.renderer.setPixelRatio).toHaveBeenLastCalledWith(2)
    expect(stage.renderer.setSize).toHaveBeenLastCalledWith(600, 500)
    stage.dispose()
  })
  it('anchors labels on a surface the camera can see, and rides along with the part', () => {
    const { stage } = setup()
    const casing = stage.prepare(part('casing', 'r=1 inner=0.9 h=2', 'tube'))!
    stage.reveal(casing, 1); stage.cut('z')
    const piston = stage.prepare(part('piston', 'r=0.5 h=0.3', 'cylinder'))!, hidden = stage.prepare(part('hidden', 'r=0.1 at=0,0,-0.6', 'sphere'))!
    stage.reveal(piston, 1); stage.reveal(hidden, 1); stage.tick(16)
    stage.locate('piston')
    expect(piston.anchor).toBeDefined()
    const point = stage.graph.anchor('piston')!
    // On the piston's own surface, not its hollow-looking centre.
    expect(Math.hypot(point.x, point.z) > 0.45 || Math.abs(point.y) > 0.14).toBe(true)
    stage.locate('hidden')
    expect(hidden.anchor).toBeUndefined()
    stage.move(move('@move p piston slide amount=0.5 period=2'), 16); stage.tick(1016)
    expect(stage.graph.anchor('piston')!.y).toBeCloseTo(point.y + 0.5)
    stage.dispose()
  })
  it('widens a label column only when words would touch the model, and re-frames once', () => {
    const { stage } = setup()
    const body = stage.prepare(part('body', 'w=4'))!; stage.reveal(body, 1); stage.tick(16)
    const framing = stage.framing, [left] = stage.labelEdges()
    stage.widenReserve(0, 0); expect(stage.framing).toBe(framing)
    stage.widenReserve(80, 0)
    expect(stage.framing).toBe(framing + 1)
    expect(stage.labelEdges()[0]).toBeGreaterThan(left)
    stage.dispose()
  })
  it('disposes each shared geometry/material and loses the context exactly once, even during motion', () => {
    const environmentDisposal = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
    const { stage, host } = setup()
    const body = stage.prepare(part('body', 'copies=3 step=1,0,0'))!; stage.reveal(body, 1)
    const resources = new Set<THREE.BufferGeometry | THREE.Material>()
    stage.scene.traverse((node) => { const mesh = node as THREE.Mesh; if (mesh.geometry) resources.add(mesh.geometry); if (mesh.material && !Array.isArray(mesh.material)) resources.add(mesh.material) })
    const disposals = [...resources].map((r) => vi.spyOn(r, 'dispose'))
    stage.move(move('@move p body spin'), 0)
    stage.dispose(); stage.dispose()
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(stage.renderer.dispose).toHaveBeenCalledOnce(); expect(stage.renderer.forceContextLoss).toHaveBeenCalledOnce()
    expect(host.remove).toHaveBeenCalledOnce(); expect(stage.graph.parts.size).toBe(0)
    // The studio environment and both contact-shadow targets.
    expect(environmentDisposal).toHaveBeenCalledTimes(3); expect(stage.scene.environment).toBeNull()
    environmentDisposal.mockRestore()
    expect(stage.tick(1000)).toBe(false)
  })
})
