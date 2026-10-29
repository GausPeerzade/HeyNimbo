import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { MODEL_LIMITS, parseModelCommand, partVertexCost, type PartMark } from '../shared/model-protocol'
import { fixtureBeats, MODEL_FIXTURES } from '../main/model-fixtures'
import { CAVITY_SHADE, gearOutline, illustratedFraming, labelSlots, ModelGraph, partGeometry, smoothNormals } from './model-geometry'
const spec = (name: string, shape = 'box', params = '') => parseModelCommand(`@part p ${name} ${shape} ${params}`) as PartMark
const vertex = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number) => new THREE.Vector3().fromBufferAttribute(attribute, i)

/** Every triangle's winding agrees with its vertex normals: faces point outward. */
function windsOutward(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), index = geometry.index
  const count = index ? index.count : position.count
  for (let i = 0; i < count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => index ? index.getX(i + k) : i + k) as [number, number, number]
    const face = vertex(position, b).sub(vertex(position, a)).cross(vertex(position, c).sub(vertex(position, a)))
    if (face.lengthSq() < 1e-14) continue
    if (face.dot(vertex(normal, a).add(vertex(normal, b)).add(vertex(normal, c))) <= 0) return false
  }
  return true
}

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
  it('hangs a ring of copies from the parent origin, so turning the ring turns every copy about that axis', () => {
    const graph = new ModelGraph()
    const ring = graph.add(spec('ring', 'sphere', 'at=2,0,0 around=4 turn=90,0,0'))!
    expect(ring.root.position.toArray()).toEqual([0, 0, 0])
    graph.root.updateMatrixWorld(true)
    const positions = ring.placements.map((p) => p.getWorldPosition(new THREE.Vector3()))
    expect(positions[1]!.x).toBeCloseTo(0); expect(positions[1]!.z).toBeCloseTo(-2); expect(positions[2]!.x).toBeCloseTo(-2)
    ring.root.rotation.y = Math.PI / 2; graph.root.updateMatrixWorld(true)
    expect(ring.placements[0]!.getWorldPosition(new THREE.Vector3()).distanceTo(positions[1]!)).toBeCloseTo(0)
    graph.reveal(ring, 0.01); const small = graph.bounds()
    graph.reveal(ring, 1); const full = graph.bounds()
    expect(small.radius).toBeCloseTo(full.radius)
    graph.dispose()
  })
  it('caps curved tubes with their exact end-ring vertices and outward winding, avoiding section leaks at seams', () => {
    const geometry = partGeometry(spec('hose', 'pipe', 'points=0,0,0;1,1,0;1,2,1')), position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), indices = geometry.index!
    const segments = 36, radial = 12, bodyVertices = (segments + 1) * (radial + 1), capVertices = radial + 2
    for (const end of [0, 1]) {
      const center = bodyVertices + end * capVertices, ring = end * segments * (radial + 1)
      for (let j = 0; j <= radial; j++) expect(vertex(position, center + j + 1).toArray()).toEqual(vertex(position, ring + j).toArray())
      const firstIndex = segments * radial * 6 + end * radial * 3
      const a = vertex(position, indices.getX(firstIndex)), b = vertex(position, indices.getX(firstIndex + 1)), c = vertex(position, indices.getX(firstIndex + 2))
      expect(b.sub(a).cross(c.sub(a)).dot(vertex(normal, center))).toBeGreaterThan(0)
    }
    geometry.dispose()
  })
  it('keeps flat ends flat and straight walls straight, faces outward, and darkens only inward walls', () => {
    const cylinder = partGeometry(spec('c', 'cylinder', 'r=0.5 h=2')), position = cylinder.getAttribute('position'), normal = cylinder.getAttribute('normal')
    let wall = 0, ends = 0
    for (let i = 0; i < position.count; i++) {
      const p = vertex(position, i), n = vertex(normal, i)
      // The wall's end rings must not lean: a lathe that averages across corners shades the whole wall as a gradient.
      if (Math.hypot(p.x, p.z) > 0.4999) { wall++; expect(Math.abs(n.y)).toBeLessThan(0.05) }
      if (Math.abs(p.y) > 0.999 && Math.hypot(p.x, p.z) < 0.4) { ends++; expect(Math.abs(n.y)).toBeCloseTo(1) }
    }
    expect(wall).toBeGreaterThan(0); expect(ends).toBeGreaterThan(0)
    const tube = partGeometry(spec('t', 'tube', 'r=0.5 inner=0.3 h=1'))
    for (const geometry of [cylinder, tube, partGeometry(spec('d', 'sphere', 'half=true')), partGeometry(spec('l', 'lathe', 'profile=0.4,0;0.5,0.5;0.2,1')), partGeometry(spec('g', 'gear', 'teeth=16 hole=0.1')), partGeometry(spec('e', 'extrude', 'points=0,0;1,0;1,1;0,1 d=0.3'))]) {
      expect(windsOutward(geometry)).toBe(true)
    }
    const shade = tube.getAttribute('color'), tubePosition = tube.getAttribute('position'), tubeNormal = tube.getAttribute('normal')
    let cavity = 0
    for (let i = 0; i < tubePosition.count; i++) {
      // Radial component of the normal: walls facing the axis are the bore.
      const radius = Math.hypot(tubePosition.getX(i), tubePosition.getZ(i)), radial = (tubeNormal.getX(i) * tubePosition.getX(i) + tubeNormal.getZ(i) * tubePosition.getZ(i)) / radius
      if (radial < -0.35) cavity++
      expect(shade.getX(i)).toBeCloseTo(radial < -0.35 ? CAVITY_SHADE : 1)
    }
    expect(cavity).toBeGreaterThan(0)
  })
  it('cuts real involute teeth that mesh: pitch radius r, module 2r/teeth, no overlap at r1 + r2', () => {
    const small = gearOutline(0.36, 12), big = gearOutline(0.72, 24), module = 0.06
    const radii = small.map((p) => p.length())
    expect(Math.max(...radii)).toBeCloseTo(0.36 + module)
    expect(Math.min(...radii)).toBeCloseTo(0.36 - 1.25 * module)
    // Tooth 0 is centred on +x.
    expect(Math.atan2(small.reduce((s, p) => s + (p.length() > 0.4 ? p.y : 0), 0), 1)).toBeCloseTo(0)
    // The big gear sits r1 + r2 away, turned half a tooth so a gap faces the small gear's tooth.
    const turn = Math.PI + Math.PI / 24, centre = new THREE.Vector2(0.36 + 0.72, 0)
    const placed = big.map((p) => p.clone().rotateAround(new THREE.Vector2(), turn).add(centre))
    const inside = (point: THREE.Vector2, polygon: THREE.Vector2[]) => {
      let hit = false
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) if ((polygon[i]!.y > point.y) !== (polygon[j]!.y > point.y) && point.x < (polygon[j]!.x - polygon[i]!.x) * (point.y - polygon[i]!.y) / (polygon[j]!.y - polygon[i]!.y) + polygon[i]!.x) hit = !hit
      return hit
    }
    expect(small.some((p) => inside(p, placed))).toBe(false)
    expect(placed.some((p) => inside(p, small))).toBe(false)
    // And they actually engage: the outlines come within a tenth of a module.
    expect(Math.min(...small.flatMap((p) => placed.map((q) => p.distanceTo(q))))).toBeLessThan(module * 0.6)
  })
  it('extrudes an outline to exactly its thickness with the bevel inside the points, and smooths only when asked', () => {
    const sharp = partGeometry(spec('roof', 'extrude', 'points=-1.6,0;1.6,0;0,1 d=2 round=0.05'))
    sharp.computeBoundingBox()
    const box = sharp.boundingBox!
    expect(box.max.z - box.min.z).toBeCloseTo(2); expect(box.min.x).toBeCloseTo(-1.6, 1); expect(box.max.y).toBeCloseTo(1, 1)
    const outline = 'points=0,-1;0.6,-0.85;0.7,-0.4;0.45,0;0.55,0.4;0,0.75;-0.55,0.4;-0.45,0;-0.7,-0.4;-0.6,-0.85 d=0.35'
    const curved = partGeometry(spec('body', 'extrude', `${outline} smooth=true`)), angular = partGeometry(spec('body', 'extrude', outline))
    expect(curved.getAttribute('position').count).toBeGreaterThan(angular.getAttribute('position').count * 2)
    for (const geometry of [sharp, curved, angular]) expect(Array.from(geometry.getAttribute('normal').array).every(Number.isFinite)).toBe(true)
  })
  it('grows a blob to its size, the same for a seed, narrower at the bottom when tapered, and closed', () => {
    const a = partGeometry(spec('a', 'blob', 'w=1.4 h=1.7 d=1.1 lumps=0.12 seed=3')), b = partGeometry(spec('b', 'blob', 'w=1.4 h=1.7 d=1.1 lumps=0.12 seed=3'))
    expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array))
    a.computeBoundingBox()
    const size = a.boundingBox!.getSize(new THREE.Vector3())
    expect(size.x).toBeGreaterThan(1.4 * 0.8); expect(size.x).toBeLessThan(1.4 * 1.2); expect(size.y).toBeGreaterThan(1.7 * 0.8)
    const tapered = partGeometry(spec('t', 'blob', 'w=1 h=1 d=1 lumps=0 taper=0.6')), position = tapered.getAttribute('position')
    const widthAt = (y: number) => Math.max(...Array.from({ length: position.count }, (_, i) => Math.abs(position.getY(i) - y) < 0.06 ? Math.abs(position.getX(i)) : 0))
    expect(widthAt(-0.3)).toBeLessThan(widthAt(0.3) * 0.85)
    // Welded: every edge is shared by exactly two triangles, so stencil sections stay sealed.
    const index = a.index!, edges = new Map<string, number>()
    for (let i = 0; i < index.count; i += 3) for (let k = 0; k < 3; k++) {
      const u = index.getX(i + k), v = index.getX(i + (k + 1) % 3)
      if (u === v) continue
      const key = u < v ? `${u}-${v}` : `${v}-${u}`; edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    expect([...edges.values()].every((count) => count === 2)).toBe(true)
  })
  it('averages one outline normal per position, so the ink shell stays closed across creases', () => {
    const box = new THREE.BoxGeometry(1, 1, 1)
    box.computeBoundingSphere()
    const outline = smoothNormals(box), position = box.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      const p = vertex(position, i), n = vertex(outline, i)
      expect(n.dot(p.clone().normalize())).toBeCloseTo(1)
    }
  })
  it('bounds geometry complexity for each family, including maximum coils, teeth and point lists', () => {
    const shapes = ['box round=0.2', 'cylinder', 'tube', 'cone', 'sphere', 'sphere half=true', 'torus', 'capsule', 'spring coils=12', 'gear teeth=32', 'gear teeth=3', `pipe points=${Array.from({ length: 16 }, (_, i) => `${i},0,0`).join(';')}`, `lathe profile=${Array.from({ length: 16 }, (_, i) => `${1 + (i % 2) * 0.3},${i}`).join(';')}`, `extrude points=${Array.from({ length: 16 }, (_, i) => `${Math.cos(i / 16 * 6.28)},${Math.sin(i / 16 * 6.28)}`).join(';')} smooth=true round=0.1`, 'blob lumps=0.4']
    for (const [i, shape] of shapes.entries()) {
      const part = parseModelCommand(`@part p s${i} ${shape}`) as PartMark
      const geometry = partGeometry(part)
      expect(geometry.getAttribute('position').count, shape).toBeLessThanOrEqual(MODEL_LIMITS.verticesPerPart)
      const edges = new THREE.EdgesGeometry(geometry, 40)
      expect(geometry.getAttribute('position').count + edges.getAttribute('position').count, shape).toBeLessThanOrEqual(partVertexCost(part))
      expect(Array.from(geometry.getAttribute('position').array).every(Number.isFinite)).toBe(true)
      geometry.dispose(); edges.dispose()
    }
    const countGraph = new ModelGraph()
    for (let i = 0; i < 4; i++) expect(countGraph.add(spec(`light${i}`, 'lathe', `profile=0,0;0.1,1 copies=${i === 3 ? 4 : 12}`))).toBeDefined()
    expect(countGraph.add(spec('over', 'lathe', 'profile=0,0;0.1,1'))).toBeUndefined()
    countGraph.dispose()
    const graph = new ModelGraph()
    const heavy = spec('a', 'gear', 'teeth=32 copies=12')
    expect(graph.add(heavy)).toBeDefined()
    expect(graph.add({ ...heavy, name: 'b' })).toBeUndefined()
    const dispose = vi.spyOn(graph.parts.get('a')!.geometry, 'dispose')
    graph.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(graph.parts.size).toBe(0)
  })
})

describe('model framing and margin labels', () => {
  const camera = (fov: number, width: number, height: number, distance: number, target: THREE.Vector3, yaw: number, pitch: number) => {
    const view = new THREE.PerspectiveCamera(fov, width / height, 0.01, 100)
    view.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(distance).add(target)
    view.lookAt(target); view.updateMatrixWorld()
    return view
  }
  it('makes the pump fixture fill 70–80% of the viewport height at rest, measured on its real silhouette', () => {
    const graph = new ModelGraph()
    for (const beat of fixtureBeats(MODEL_FIXTURES[0]!.script({ x: 40, y: 40, w: 640, h: 600 }, { x: 720, y: 70, w: 440, h: 420 }), { width: 1200, height: 800 })) {
      for (const mark of beat.marks) if (mark.kind === 'part') graph.reveal(graph.add(mark)!, 1)
    }
    const { distance, target } = illustratedFraming(graph.corners(), 20, 638, 570, { left: 64, right: 64 }, [0.1, 0.4, 0.7], 0.36)
    const projected = graph.samples(20000).map((point) => point.project(camera(20, 638, 570, distance, target, 0.4, 0.36)))
    const height = (Math.max(...projected.map((p) => p.y)) - Math.min(...projected.map((p) => p.y))) / 2
    expect(height).toBeGreaterThanOrEqual(0.7); expect(height).toBeLessThanOrEqual(0.8)
    graph.dispose()
  })
  it('keeps a wide model inside the gap between unequal label columns, from every swayed yaw', () => {
    const points = [new THREE.Box3(new THREE.Vector3(-2, -0.3, -0.3), new THREE.Vector3(2, 0.3, 0.3))].flatMap((box) =>
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)))
    const reserve = { left: 160, right: 60 }, yaws = [0.25, 0.55, 0.85]
    const { distance, target } = illustratedFraming(points, 20, 640, 560, reserve, yaws, 0.36)
    for (const yaw of yaws) {
      const xs = points.map((p) => p.clone().project(camera(20, 640, 560, distance, target, yaw, 0.36)).x)
      // The model's half-width never exceeds half of the width left between the columns.
      expect((Math.max(...xs) - Math.min(...xs)) / 2 * 320).toBeLessThanOrEqual((640 - reserve.left - reserve.right) / 2 + 0.5)
    }
    const wider = illustratedFraming(points, 20, 640, 560, { left: 60, right: 60 }, yaws, 0.36)
    expect(wider.distance).toBeLessThan(distance)
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
