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
vi.mock('three', async (load) => {
  const original = await load<typeof import('three')>()
  return { ...original, PMREMGenerator: class { fromScene = () => new original.WebGLRenderTarget(16, 16); dispose = vi.fn() }, WebGLRenderer: class {
    domElement = new Canvas()
    localClippingEnabled = false
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false }
    setClearColor = vi.fn(); setPixelRatio = vi.fn(); setSize = vi.fn(); render = vi.fn()
    dispose = vi.fn(); forceContextLoss = vi.fn()
  } }
})
const part = (name = 'body', args = '') => parseModelCommand(`@part p ${name} box ${args}`) as PartMark
function setup(turntable = false) {
  const options = { id: 'p', width: 600, height: 500, turntable, wake: vi.fn(), capture: vi.fn(), overCard: (x: number, y: number) => x >= 0 && x < 600 && y >= 0 && y < 500, trace: vi.fn(), debug: () => false }
  const host = { append: vi.fn(), remove: vi.fn() }
  const stage = new ModelStage(host as unknown as HTMLElement, options)
  const canvas = stage.renderer.domElement as unknown as Canvas
  return { stage, options, host, canvas }
}
afterEach(() => vi.unstubAllGlobals())

describe('model stage lifecycle and interaction', () => {
  it('uses a bounded transparent local context, glides to new framing, and stops rendering when idle', () => {
    vi.stubGlobal('devicePixelRatio', 4)
    const { stage } = setup()
    expect(stage.renderer.setPixelRatio).toHaveBeenCalledWith(2)
    expect(stage.renderer.setClearColor).toHaveBeenCalledWith(0, 0)
    expect(stage.renderer.outputColorSpace).toBe(THREE.SRGBColorSpace)
    expect(stage.renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping)
    expect(stage.renderer.shadowMap).toMatchObject({ enabled: true, type: THREE.PCFSoftShadowMap, autoUpdate: false })
    expect(stage.scene.environment).toBeInstanceOf(THREE.Texture)
    expect(stage.tick(0)).toBe(false)
    const first = stage.prepare(part())!; stage.reveal(first, 1); stage.tick(16)
    const before = stage.camera.position.clone()
    const second = stage.prepare(part('second', 'at=12,0,0'))!; stage.reveal(second, 0.1); stage.tick(32)
    const firstStep = before.distanceTo(stage.camera.position)
    for (let t = 48; t <= 5000; t += 16) stage.tick(t)
    expect(firstStep).toBeGreaterThan(0)
    expect(firstStep).toBeLessThan(before.distanceTo(stage.camera.position) / 3)
    const calls = vi.mocked(stage.renderer.render).mock.calls.length
    expect(stage.tick(6000)).toBe(false); expect(stage.tick(9000)).toBe(false)
    expect(stage.renderer.render).toHaveBeenCalledTimes(calls)
    stage.move(parseModelCommand('@move p body spin amount=0') as Extract<ModelCommand, { kind: 'move' }>, 9000)
    expect(stage.tick(10_000)).toBe(false)
    expect(stage.renderer.render).toHaveBeenCalledTimes(calls)
    stage.dispose()
  })
  it('starts motion only after entry, propagates it to children, and projects attached anchors on each pose', () => {
    const { stage } = setup()
    const parent = stage.prepare(part())!, child = stage.prepare(part('child', 'in=body at=0,1,0'))!
    const move = parseModelCommand('@move p body slide amount=1 period=2') as Extract<ModelCommand, { kind: 'move' }>
    stage.move(move, 0); stage.tick(1000)
    expect(parent.root.position.y).toBe(0)
    stage.reveal(parent, 1); stage.reveal(child, 1); stage.tick(1000)
    const before = stage.project('child')
    stage.move(move, 1000); expect(stage.tick(2000)).toBe(true)
    expect(parent.root.position.y).toBeCloseTo(1)
    expect(stage.graph.anchor('child')!.y).toBeCloseTo(2)
    expect(stage.project('child')).not.toEqual(before)
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
    canvas.dispatch('pointerup', { pointerId: 2 }); expect(canvas.capture).toBe(1)
    canvas.dispatch('pointercancel', { clientX: 900 }); expect(canvas.capture).toBeUndefined()
    expect(options.capture).toHaveBeenLastCalledWith(false, false)
    canvas.dispatch('pointerdown'); stage.dispose()
    expect(canvas.capture).toBeUndefined(); expect(options.capture).toHaveBeenLastCalledWith(false, false)
  })
  it('disposes each shared geometry/material and loses the context exactly once, even during motion', () => {
    const environmentDisposal = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
    const { stage, host } = setup()
    const body = stage.prepare(part('body', 'copies=3 step=1,0,0'))!; stage.reveal(body, 1)
    const resources = new Set<THREE.BufferGeometry | THREE.Material>()
    stage.scene.traverse((node) => { const mesh = node as THREE.Mesh; if (mesh.geometry) resources.add(mesh.geometry); if (mesh.material && !Array.isArray(mesh.material)) resources.add(mesh.material) })
    const disposals = [...resources].map((r) => vi.spyOn(r, 'dispose'))
    stage.move(parseModelCommand('@move p body spin') as Extract<ModelCommand, { kind: 'move' }>, 0)
    stage.dispose(); stage.dispose()
    expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(stage.renderer.dispose).toHaveBeenCalledOnce(); expect(stage.renderer.forceContextLoss).toHaveBeenCalledOnce()
    expect(host.remove).toHaveBeenCalledOnce(); expect(stage.graph.parts.size).toBe(0)
    expect(environmentDisposal).toHaveBeenCalledOnce(); expect(stage.scene.environment).toBeNull()
    environmentDisposal.mockRestore()
    expect(stage.tick(1000)).toBe(false)
  })
})
