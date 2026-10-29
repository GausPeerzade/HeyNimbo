import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { MODEL_LIMITS, parseModelCommand, partVertexCost, type PartMark } from '../shared/model-protocol'
import { boxCorners, cameraDistance, illustratedDistance, ModelGraph, partGeometry, labelSlots } from './model-geometry'
const spec = (name: string, shape = 'box', params = '') => parseModelCommand(`@part p ${name} ${shape} ${params}`) as PartMark

describe('procedural model graph', () => {
  it('inherits transforms and expands copies without multiplying child graphs or reveals', () => {
    const graph = new ModelGraph()
    const parent = graph.add(spec('parent', 'box', 'at=1,2,0 turn=0,0,90'))!
    const child = graph.add(spec('child', 'sphere', 'in=parent at=2,0,0 copies=3 step=0,1,0'))!
    expect(child.root.parent).toBe(parent.placements[0])
    expect(graph.anchor('child')!.toArray()).toEqual(expect.arrayContaining([expect.closeTo(1), expect.closeTo(4), expect.closeTo(0)]))
    expect(child.placements.map((node) => node.position.y)).toEqual([0, 1, 2])
    graph.reveal(child, 0.5)
    expect(child.reveals.every((node) => node.visible && node.scale.x === 0.5)).toBe(true)
    expect(graph.add(spec('orphan', 'box', 'in=absent'))).toBeUndefined()
    expect(graph.add(spec('child'))).toBeUndefined()
    graph.dispose()
  })
  it('places ring copies around the parent y axis and frames full built parts, not growing scales', () => {
    const graph = new ModelGraph()
    const ring = graph.add(spec('ring', 'sphere', 'at=2,0,0 around=4 turn=90,0,0'))!
    graph.root.updateMatrixWorld(true)
    const positions = ring.placements.map((p) => p.getWorldPosition(new THREE.Vector3()).toArray())
    expect(positions[1]![0]).toBeCloseTo(0); expect(positions[1]![2]).toBeCloseTo(-2)
    expect(positions[2]![0]).toBeCloseTo(-2)
    graph.reveal(ring, 0.01); const small = graph.bounds()
    graph.reveal(ring, 1); const full = graph.bounds()
    expect(small.radius).toBeCloseTo(full.radius)
    expect(full.center.length()).toBeCloseTo(0)
    expect(full.radius).toBeGreaterThan(2)
    const queued = graph.add(spec('later', 'box', 'at=24,0,0'))!
    expect(graph.bounds().radius).toBe(full.radius)
    graph.reveal(queued, 0); expect(graph.bounds().radius).toBeGreaterThan(full.radius)
    graph.dispose()
  })
  it('caps curved tubes with their exact end-ring vertices and outward winding, avoiding section leaks at seams', () => {
    const part = spec('hose', 'pipe', 'points=0,0,0;1,1,0;1,2,1')
    const geometry = partGeometry(part), position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), indices = geometry.index!
    const segments = 36, radial = 12, bodyVertices = (segments + 1) * (radial + 1), capVertices = radial + 2
    for (const end of [0, 1]) {
      const center = bodyVertices + end * capVertices, ring = end * segments * (radial + 1)
      for (let j = 0; j <= radial; j++) expect(new THREE.Vector3().fromBufferAttribute(position, center + j + 1).toArray()).toEqual(new THREE.Vector3().fromBufferAttribute(position, ring + j).toArray())
      const firstIndex = segments * radial * 6 + end * radial * 3
      const a = new THREE.Vector3().fromBufferAttribute(position, indices.getX(firstIndex)), b = new THREE.Vector3().fromBufferAttribute(position, indices.getX(firstIndex + 1)), c = new THREE.Vector3().fromBufferAttribute(position, indices.getX(firstIndex + 2))
      expect(b.sub(a).cross(c.sub(a)).dot(new THREE.Vector3().fromBufferAttribute(normal, center))).toBeGreaterThan(0)
    }
    geometry.dispose()
  })
  it('bounds geometry complexity for each family, including maximum coils, teeth and point lists', () => {
    const shapes = ['box round=0.2', 'cylinder', 'tube', 'cone', 'sphere', 'sphere half=true', 'torus', 'capsule', 'spring coils=12', 'gear teeth=32', `pipe points=${Array.from({ length: 16 }, (_, i) => `${i},0,0`).join(';')}`, `lathe profile=${Array.from({ length: 16 }, (_, i) => `1,${i}`).join(';')}`]
    for (const [i, shape] of shapes.entries()) {
      const part = parseModelCommand(`@part p s${i} ${shape}`) as PartMark
      const geometry = partGeometry(part)
      expect(geometry.getAttribute('position').count, shape).toBeLessThanOrEqual(MODEL_LIMITS.verticesPerPart)
      const edges = new THREE.EdgesGeometry(geometry, 32)
      expect(geometry.getAttribute('position').count + edges.getAttribute('position').count, shape).toBeLessThanOrEqual(partVertexCost(part))
      expect(Array.from(geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true)
      geometry.dispose(); edges.dispose()
    }
    const countGraph = new ModelGraph()
    for (let i = 0; i < 4; i++) expect(countGraph.add(spec(`light${i}`, 'lathe', `profile=0,0;0.1,1 copies=${i === 3 ? 4 : 12}`))).toBeDefined()
    expect(countGraph.add(spec('over', 'lathe', 'profile=0,0;0.1,1'))).toBeUndefined()
    countGraph.dispose()
    const graph = new ModelGraph()
    const heavy = spec('a', 'box', 'round=0.1 copies=12')
    expect(graph.add(heavy)).toBeDefined()
    expect(graph.add({ ...heavy, name: 'b' })).toBeUndefined()
    const dispose = vi.spyOn(graph.parts.get('a')!.geometry, 'dispose')
    graph.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(graph.parts.size).toBe(0)
  })
})

describe('model framing and margin labels', () => {
  it('fits the sphere to the tighter field of view and reserves both label margins', () => {
    const distance = cameraDistance(2, 34, 600, 500, 140)
    const vertical = THREE.MathUtils.degToRad(17)
    const horizontal = Math.atan(Math.tan(vertical) * 320 / 500)
    expect(distance).toBeCloseTo(2 / Math.sin(horizontal) * 1.08)
    expect(distance).toBeGreaterThan(cameraDistance(2, 34, 600, 500, 0))
    expect(cameraDistance(4, 34, 600, 500, 140)).toBeCloseTo(distance * 2)
    expect(cameraDistance(2, 34, 2000, 500, 140)).toBeCloseTo(2 / Math.sin(vertical) * 1.08)
  })
  it('fills a tall subject to 70–80% of the viewport height without wasting label space on a sphere', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -2.2, -0.5), new THREE.Vector3(1.8, 2.3, 0.5))
    const distance = illustratedDistance(box, 30, 700, 640, 120, 0.6, 0.4)
    const camera = new THREE.PerspectiveCamera(30, 700 / 640, 0.01, 100)
    const center = box.getCenter(new THREE.Vector3())
    camera.position.set(Math.sin(0.6) * Math.cos(0.4), Math.sin(0.4), Math.cos(0.6) * Math.cos(0.4)).multiplyScalar(distance).add(center)
    camera.lookAt(center); camera.updateMatrixWorld()
    const projected = boxCorners(box).map((point) => point.project(camera))
    const height = (Math.max(...projected.map((p) => p.y)) - Math.min(...projected.map((p) => p.y))) / 2
    expect(height).toBeGreaterThanOrEqual(0.7); expect(height).toBeLessThanOrEqual(0.8)
    expect(Math.max(...projected.map((p) => Math.abs(p.x)))).toBeLessThanOrEqual(1 - 240 / 700)
    expect(distance).toBeLessThan(cameraDistance(box.getBoundingSphere(new THREE.Sphere()).radius, 30, 700, 640, 120))
  })
  it('keeps requested sides, resolves collisions by y, and never moves already written slots', () => {
    const labels = [{ id: 'c', y: 150, side: 'left' as const, height: 26 }, { id: 'b', y: 100, side: 'left' as const, height: 26 }, { id: 'a', y: 100, side: 'right' as const, height: 26 }, { id: 'd', y: 110, side: 'left' as const, height: 26 }]
    const slots = labelSlots(labels, 10, 300)
    const left = slots.filter((slot) => slot.side === 'left')
    expect(left.map((slot) => slot.id)).toEqual(['b', 'd', 'c'])
    for (let i = 1; i < left.length; i++) expect(left[i]!.baseline - left[i - 1]!.baseline).toBeGreaterThanOrEqual(34)
    const packed = labelSlots([{ id: 'low', y: 290, side: 'right', height: 26 }, { id: 'lower', y: 299, side: 'right', height: 26 }], 10, 300)
    expect(packed).toHaveLength(2)
    expect(packed[0]!.baseline + 34).toBeLessThanOrEqual(packed[1]!.baseline)
    expect(packed[1]!.baseline).toBeLessThanOrEqual(300)
    const previous = JSON.stringify(slots)
    const added = labelSlots([{ id: 'next', y: 105, side: 'left', height: 26 }], 10, 300, slots)
    expect(JSON.stringify(slots)).toBe(previous)
    expect(added).toHaveLength(1)
    expect(slots.filter((slot) => slot.side === 'left').every((slot) => Math.abs(slot.baseline - added[0]!.baseline) >= 34)).toBe(true)
  })
})
