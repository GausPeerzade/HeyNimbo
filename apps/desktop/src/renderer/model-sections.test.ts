import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { parseModelCommand, type PartMark } from '../shared/model-protocol'
import { ModelGraph, type ModelPart } from './model-geometry'
import { ModelSections } from './model-sections'

function setup() {
  const scene = new THREE.Scene(), graph = new ModelGraph(); scene.add(graph.root)
  const sections = new ModelSections(scene)
  const surfaces = new Map<string, THREE.Material[]>()
  const add = (line: string, capped = true): ModelPart => {
    const part = graph.add(parseModelCommand(line) as PartMark)!
    const surface = new THREE.MeshStandardMaterial(), outline = new THREE.LineBasicMaterial()
    for (const reveal of part.reveals) reveal.add(new THREE.Mesh(part.geometry, surface))
    sections.register(part, [surface, outline], new THREE.Color(0x808080), capped)
    surfaces.set(part.spec.name, [surface, outline])
    return part
  }
  const camera = new THREE.PerspectiveCamera(); camera.position.set(3, 2, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  const caps = () => scene.children.filter((node) => node instanceof THREE.Mesh) as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[]
  const clipped = (name: string) => surfaces.get(name)!.every((material) => material.clippingPlanes?.[0] === sections.plane)
  return { scene, graph, sections, add, camera, caps, clipped }
}
const stencilPasses = (part: ModelPart) => part.reveals[0]!.children.filter((node) => (node as THREE.Mesh).material instanceof THREE.MeshBasicMaterial) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]

describe('hatched model sections', () => {
  it('uses opposite stencil winding, isolated cap clears, and one shared plane for ink and solids', () => {
    const { scene, graph, sections, add, camera, caps } = setup()
    const part = add('@part p barrel tube copies=2 step=2,0,0')
    expect(caps()).toHaveLength(2); expect(caps().every((cap) => !cap.visible)).toBe(true)
    graph.reveal(part, 0.5); sections.cut('z', new THREE.Vector3()); sections.update(camera, graph.bounds())
    expect(caps().every((cap) => cap.visible && cap.material.stencilFunc === THREE.NotEqualStencilFunc)).toBe(true)
    expect(caps()[0]!.material.fragmentShader).toContain('fwidth(d)')
    const passes = stencilPasses(part)
    expect(passes.map((pass) => pass.material.stencilZPass)).toEqual([THREE.IncrementWrapStencilOp, THREE.DecrementWrapStencilOp])
    expect(passes.every((pass) => !pass.material.colorWrite && !pass.material.depthWrite && !pass.material.depthTest)).toBe(true)
    expect(caps()[0]!.renderOrder).toBeGreaterThan(passes[0]!.renderOrder)
    const renderer = { clearStencil: vi.fn() }
    caps()[0]!.onAfterRender(renderer as unknown as THREE.WebGLRenderer, scene, camera, caps()[0]!.geometry, caps()[0]!.material, new THREE.Group())
    expect(renderer.clearStencil).toHaveBeenCalledOnce()
    const dispose = vi.spyOn(caps()[0]!.material, 'dispose'); sections.dispose(); expect(dispose).toHaveBeenCalledOnce()
    expect(caps()).toHaveLength(0)
    graph.dispose()
  })
  it('carries a parked plane from the start, so a cut moves it instead of recompiling any shader', () => {
    const { graph, sections, add, camera, clipped } = setup()
    const part = add('@part p body box')
    expect(clipped('body')).toBe(true)
    // Parked: nothing anywhere the model can reach is on the clipped side.
    expect(sections.plane.distanceToPoint(new THREE.Vector3(30, 30, 30))).toBeGreaterThan(0)
    const versions = [part.reveals[0]!.children[0]].map((mesh) => ((mesh as THREE.Mesh).material as THREE.Material).version)
    graph.reveal(part, 1); sections.cut('x', new THREE.Vector3()); sections.update(camera, graph.bounds())
    expect([part.reveals[0]!.children[0]].map((mesh) => ((mesh as THREE.Mesh).material as THREE.Material).version)).toEqual(versions)
    expect(sections.plane.distanceToPoint(new THREE.Vector3(1, 0, 0))).toBeLessThan(0)
    graph.dispose(); sections.dispose()
  })
  it('opens only parts already built when the cut runs; queued and later parts stay whole', () => {
    const { graph, sections, add, clipped, camera } = setup()
    const casing = add('@part p casing tube r=1 inner=0.9 h=2')
    const queued = add('@part p queued cylinder r=0.3 h=0.5')
    graph.reveal(casing, 1)
    sections.cut('z', new THREE.Vector3()); sections.update(camera, graph.bounds())
    const later = add('@part p later sphere r=0.2')
    expect(clipped('casing')).toBe(true)
    expect(clipped('queued')).toBe(false); expect(clipped('later')).toBe(false)
    expect(stencilPasses(queued).every((pass) => !pass.visible)).toBe(true)
    expect(stencilPasses(later).every((pass) => !pass.visible)).toBe(true)
    graph.dispose(); sections.dispose()
  })
  it('cuts a later part too when it spans the section, like a floor across a cut-away house', () => {
    const { graph, sections, add, clipped, camera } = setup()
    const walls = add('@part p walls box w=3 h=2 d=2 at=0,1,0 mat=paint')
    graph.reveal(walls, 1); sections.cut('z', new THREE.Vector3(0, 1, 0)); sections.update(camera, graph.bounds())
    add('@part p floor box w=2.8 h=0.1 d=1.9 at=0,1,0 mat=wood')
    add('@part p stairs box w=0.4 h=0.1 d=0.3 at=-1,0.2,-0.4 mat=wood')
    // As big and as far forward, but outside the casing: a fan's guard, a lamp's base.
    add('@part p porch box w=3 h=0.1 d=1.5 at=0,-0.2,1.8 mat=wood')
    expect(clipped('floor')).toBe(true)
    expect(clipped('stairs')).toBe(false)
    expect(clipped('porch')).toBe(false)
    graph.dispose(); sections.dispose()
  })
  it('opens a solid casing into a shell when parts sit inside it, but leaves rock solid', () => {
    const inner = (part: ModelPart) => part.reveals[0]!.children.filter((node) => ((node as THREE.Mesh).material as THREE.Material).side === THREE.BackSide && !(node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.stencilWrite)
    const opened = (casing: string, content: string) => {
      const { graph, sections, add, camera } = setup()
      const outer = add(casing)
      graph.reveal(outer, 1); sections.cut('x', new THREE.Vector3())
      add(content); sections.update(camera, graph.bounds())
      return { outer, graph, sections }
    }
    const steel = opened('@part p case box w=2 h=2 d=2 mat=steel', '@part p tank box w=0.4 h=0.6 d=0.4 at=-0.5,0,0')
    expect(inner(steel.outer)).toHaveLength(1)
    // The cavity counts the other way, so only the wall between the surfaces is capped.
    const passes = stencilPasses(steel.outer)
    expect(passes).toHaveLength(4)
    expect(passes.slice(2).map((pass) => pass.material.stencilZPass)).toEqual([THREE.DecrementWrapStencilOp, THREE.IncrementWrapStencilOp])
    const wall = inner(steel.outer)[0] as THREE.Mesh
    wall.geometry.computeBoundingBox()
    expect(wall.geometry.boundingBox!.max.x).toBeLessThan(1); expect(wall.geometry.boundingBox!.max.x).toBeGreaterThan(0.75)
    const rock = opened('@part p ground box w=2 h=2 d=2 mat=rock', '@part p magma sphere r=0.3 at=-0.5,0,0')
    expect(inner(rock.outer)).toHaveLength(0)
    // A part sitting mostly in the removed half is visible anyway: the casing stays solid.
    const front = opened('@part p case box w=2 h=2 d=2 mat=steel', '@part p dial box w=0.4 h=0.4 d=0.4 at=0.6,0,0')
    expect(inner(front.outer)).toHaveLength(0)
    for (const { graph, sections } of [steel, rock, front]) { sections.dispose(); graph.dispose() }
  })
  it('cuts axes through the built model, follows the camera for a view cut, and lays the cap in the plane', () => {
    const { graph, sections, add, camera, caps } = setup()
    const part = add('@part p barrel tube at=1,0,0')
    graph.reveal(part, 1)
    const bounds = graph.bounds()
    sections.cut('x', bounds.center); sections.update(camera, bounds)
    expect(sections.plane.normal.toArray()).toEqual([-1, 0, 0]); expect(sections.plane.distanceToPoint(bounds.center)).toBeCloseTo(0)
    const capNormal = () => new THREE.Vector3(0, 0, 1).applyQuaternion(caps()[0]!.quaternion)
    expect(Math.abs(capNormal().dot(sections.plane.normal))).toBeCloseTo(1)
    sections.cut('view', bounds.center); sections.update(camera, bounds)
    expect(sections.plane.distanceToPoint(bounds.center)).toBeCloseTo(0)
    expect(sections.plane.distanceToPoint(camera.position)).toBeLessThan(0)
    // A mirrored (left-handed) basis would tilt the hatch quad out of the cut plane.
    expect(Math.abs(capNormal().dot(sections.plane.normal))).toBeCloseTo(1)
    expect(sections.plane.distanceToPoint(caps()[0]!.position)).toBeCloseTo(0)
    camera.position.set(-4, 1, 2); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(); sections.update(camera, bounds)
    expect(sections.plane.normal.dot(camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(1)
    expect(Math.abs(capNormal().dot(sections.plane.normal))).toBeCloseTo(1)
    sections.dispose(); graph.dispose()
  })
})
