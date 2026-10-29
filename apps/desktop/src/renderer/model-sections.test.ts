import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { parseModelCommand, type PartMark } from '../shared/model-protocol'
import { ModelGraph } from './model-geometry'
import { ModelSections } from './model-sections'

function setup() {
  const scene = new THREE.Scene(), graph = new ModelGraph(); scene.add(graph.root)
  const sections = new ModelSections(scene)
  const part = graph.add(parseModelCommand('@part p barrel tube copies=2 step=2,0,0') as PartMark)!
  const surface = new THREE.MeshStandardMaterial(), outline = new THREE.LineBasicMaterial()
  for (const reveal of part.reveals) reveal.add(new THREE.Mesh(part.geometry, surface))
  sections.register(part, surface, outline)
  const camera = new THREE.PerspectiveCamera(); camera.position.set(3, 2, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  return { scene, graph, sections, part, surface, outline, camera }
}

describe('hatched model sections', () => {
  it('uses opposite stencil winding for hollow parts, isolated cap clears, and the same clipping plane for ink and solids', () => {
    const { scene, graph, sections, part, surface, outline, camera } = setup()
    const caps = scene.children.filter((node) => node instanceof THREE.Mesh) as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[]
    expect(caps).toHaveLength(2); expect(caps.every((cap) => !cap.visible)).toBe(true)
    graph.reveal(part, 0.5); sections.cut('z'); sections.update(camera, graph.bounds())
    expect(surface.clippingPlanes?.[0]).toBe(sections.plane); expect(outline.clippingPlanes?.[0]).toBe(sections.plane)
    expect(caps.every((cap) => cap.visible && cap.material.stencilFunc === THREE.NotEqualStencilFunc)).toBe(true)
    expect(caps[0]!.material.fragmentShader).toContain('fwidth(diagonal)')
    const passes = part.reveals[0]!.children.filter((node) => (node as THREE.Mesh).material instanceof THREE.MeshBasicMaterial) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]
    expect(passes.map((pass) => pass.material.stencilZPass)).toEqual([THREE.IncrementWrapStencilOp, THREE.DecrementWrapStencilOp])
    expect(passes.every((pass) => !pass.material.colorWrite && !pass.material.depthWrite && !pass.material.depthTest)).toBe(true)
    expect(caps[0]!.renderOrder).toBeGreaterThan(passes[0]!.renderOrder)
    const renderer = { clearStencil: vi.fn() }
    caps[0]!.onAfterRender(renderer as unknown as THREE.WebGLRenderer, scene, camera, caps[0]!.geometry, caps[0]!.material, new THREE.Group())
    expect(renderer.clearStencil).toHaveBeenCalledOnce()
    const dispose = vi.spyOn(caps[0]!.material, 'dispose'); sections.dispose(); expect(dispose).toHaveBeenCalledOnce()
    expect(scene.children.filter((node) => node instanceof THREE.Mesh)).toHaveLength(0)
    graph.dispose(); surface.dispose(); outline.dispose()
  })
  it('keeps axis cuts at the origin, while the view cut follows the camera-facing half through the model center', () => {
    const { graph, sections, part, surface, outline, camera } = setup()
    graph.reveal(part, 1)
    const bounds = graph.bounds()
    sections.cut('x'); sections.update(camera, bounds)
    expect(sections.plane.normal.toArray()).toEqual([-1, 0, 0]); expect(sections.plane.constant).toBeCloseTo(0)
    sections.cut('view', bounds.center); sections.update(camera, bounds)
    expect(sections.plane.distanceToPoint(bounds.center)).toBeCloseTo(0)
    expect(sections.plane.distanceToPoint(camera.position)).toBeLessThan(0)
    const before = sections.plane.normal.clone()
    camera.position.set(-4, 1, 2); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(); sections.update(camera, bounds)
    expect(sections.plane.normal.distanceTo(before)).toBeGreaterThan(0.5)
    expect(sections.plane.normal.dot(camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(1)
    sections.dispose(); graph.dispose(); surface.dispose(); outline.dispose()
  })
})
