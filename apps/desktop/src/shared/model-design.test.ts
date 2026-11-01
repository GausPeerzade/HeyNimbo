import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { ModelDesign } from './model-design'
import { MODEL_LIMITS, type ModelCommand, type PartMark, type Vec3 } from './model-protocol'

const parts = (commands: ModelCommand[]): PartMark[] => commands.filter((c): c is PartMark => c.kind === 'part')
/** Where the renderer puts a local point of a part: its placement's Euler XYZ turn, then its position. */
function world(at: Vec3, turn: Vec3, local: Vec3): THREE.Vector3 {
  return new THREE.Vector3(...local).applyEuler(new THREE.Euler(...turn.map(THREE.MathUtils.degToRad) as Vec3, 'XYZ')).add(new THREE.Vector3(...at))
}
const close = (a: THREE.Vector3, b: Vec3): void => { expect(a.x).toBeCloseTo(b[0], 3); expect(a.y).toBeCloseTo(b[1], 3); expect(a.z).toBeCloseTo(b[2], 3) }

describe('designer lines', () => {
  it('lays rods, cones and capsules exactly between their two ends, whatever the direction', () => {
    const design = new ModelDesign('jet')
    for (const [from, to] of [[[0, 0, 0], [0, 0, 2]], [[1, 2, 3], [-1, 0.5, 0]], [[0, 1, 0], [0, -1, 0]], [[0, 0, 0], [0, 3, 0]]] as Array<[Vec3, Vec3]>) {
      const [cone] = parts(design.push(JSON.stringify({ shape: 'cone', from, to, radius: 0.2 })))
      // The cone's base centre sits at `from` and its tip at `to`.
      close(world(cone!.at, cone!.turn, [0, -cone!.dimensions.h! / 2, 0]), from)
      close(world(cone!.at, cone!.turn, [0, cone!.dimensions.h! / 2, 0]), to)
    }
    const [capsule] = parts(design.push('{"shape":"capsule","from":[0,0,0],"to":[2,0,0],"radius":0.25}'))
    // Capsule ends are cap centres, so its overall length adds a radius at each end.
    expect(capsule!.dimensions.h).toBeCloseTo(2.5)
  })

  it('keeps a stated rotation exactly as the renderer applies it, alone and with repeats', () => {
    const design = new ModelDesign('m')
    for (const rotation of [[90, 0, 0], [0, -90, 0], [0, 0, 90], [30, 40, 50], [-120, 75, 10]] as Vec3[]) {
      const [box] = parts(design.push(JSON.stringify({ shape: 'box', position: [1, 2, 3], size: [1, 1, 1], rotation })))
      for (const local of [[0, 1, 0], [1, 0, 0], [0, 0, 1]] as Vec3[]) {
        const expected = new THREE.Vector3(...local).applyEuler(new THREE.Euler(...rotation.map(THREE.MathUtils.degToRad) as Vec3, 'XYZ')).add(new THREE.Vector3(1, 2, 3))
        close(world(box!.at, box!.turn, local), expected.toArray() as Vec3)
      }
    }
  })

  it('spreads a repeat around any axis and pivot, turning each copy with its position', () => {
    const design = new ModelDesign('fan')
    const [blades] = parts(design.push(JSON.stringify({ shape: 'box', id: 'blade', position: [0, 0, 1], size: [0.2, 0.05, 1], repeat: { count: 4, axis: [0, 1, 0], pivot: [0, 0, 0] } })))
    expect(blades!.copies).toBe(4)
    // Each blade's outer tip (local +z end) lands a quarter turn further round the y axis.
    const tips = blades!.instances!.map(({ at, turn }) => world(at, turn, [0, 0, 0.5]))
    close(tips[0]!, [0, 0, 1.5]); close(tips[1]!, [1.5, 0, 0]); close(tips[2]!, [0, 0, -1.5]); close(tips[3]!, [-1.5, 0, 0])
    const [row] = parts(design.push('{"shape":"sphere","position":[0,0,0],"radius":0.1,"repeat":{"count":3,"step":[0.5,0,0]}}'))
    expect(row!.instances!.map(i => i.at)).toEqual([[0, 0, 0], [0.5, 0, 0], [1, 0, 0]])
  })

  it('places grouped parts relative to the pivot and spins the group about its main axis', () => {
    const design = new ModelDesign('turbine')
    const [group, spin] = design.push('{"group":"rotor","pivot":[0,4,1],"spin":[0,0,-1],"rps":0.25}')
    expect(group).toMatchObject({ kind: 'part', shape: 'group', name: 'rotor', at: [0, 4, 1] })
    expect(spin).toMatchObject({ kind: 'move', part: 'rotor', motion: 'spin', axis: 'z', amount: -360, period: 4 })
    const [hub] = parts(design.push('{"shape":"sphere","id":"hub","position":[0,4,1.2],"radius":0.3,"group":"rotor"}'))
    expect(hub).toMatchObject({ parent: 'rotor', at: [0, 0, 0.2] })
    // A tube's points are model space: placed under the pivot, they must land where they were written.
    const [cable] = parts(design.push('{"shape":"tube","id":"cable","points":[[0,4,1],[0,5,1]],"radius":0.05,"group":"rotor"}'))
    for (const point of cable!.points!) close(world(cable!.at, cable!.turn, point).add(new THREE.Vector3(0, 4, 1)), [0, point[1] < 4.5 ? 4 : 5, 1])
  })

  it('applies a declared material by reference, with the line itself winning', () => {
    const design = new ModelDesign('m')
    expect(design.push('{"mat":"steel","color":"#9aa4ab","metalness":0.9,"roughness":0.3}')).toEqual([])
    const [plain, red] = [...parts(design.push('{"shape":"sphere","position":[0,0,0],"radius":1,"m":"steel"}')), ...parts(design.push('{"shape":"sphere","position":[2,0,0],"radius":1,"m":"steel","color":"#ff0000","emission":"#ff0000"}'))]
    expect(plain!.finish).toEqual({ color: 0x9aa4ab, metalness: 0.9, roughness: 0.3 })
    expect(red!.finish).toMatchObject({ color: 0xff0000, metalness: 0.9, emission: 0xff0000 })
  })

  it('pins a label to the nearest part, once each, and drops what it cannot use', () => {
    const design = new ModelDesign('m')
    design.push('{"title":"Lamp","concept":"brushed steel"}')
    design.push('{"shape":"sphere","id":"bulb","position":[0,2,0],"radius":0.2}')
    design.push('{"shape":"box","id":"base","position":[0,0,0],"size":[1,0.2,1]}')
    expect(design.title).toBe('Lamp')
    expect(design.push('{"label":"Bulb","position":[0.1,2.2,0]}')).toEqual([{ kind: 'tag', id: 'm', part: 'bulb', text: 'Bulb' }])
    expect(design.push('{"label":"Again","position":[0,2,0]}')).toEqual([{ kind: 'tag', id: 'm', part: 'base', text: 'Again' }])
    for (const bad of ['not json', '[1,2]', '{"shape":"cylinder","from":[0,0,0],"to":[0,0,0]}', '{"shape":"lathe","profile":[[0,0]]}', '{"shape":"hexagon","position":[0,0,0]}']) expect(design.push(bad)).toEqual([])
  })

  it('replaces a part whose id is reused, and removes a group with everything inside it', () => {
    const design = new ModelDesign('m')
    design.push('{"group":"rotor","pivot":[0,2,0],"spin":[0,1,0],"rps":0.2}')
    design.push('{"shape":"box","id":"blade","position":[1,2,0],"size":[1,0.1,0.2],"group":"rotor"}')
    design.push('{"shape":"sphere","id":"hub","position":[0,2,0],"radius":0.3}')
    expect(design.push('{"label":"Hub","position":[0,2.1,0]}')).toMatchObject([{ kind: 'tag', part: 'hub' }])
    // A designer id that looks like a generated version must not be taken over by one.
    design.push('{"shape":"box","id":"hub-v1","position":[3,0,0],"size":[1,1,1]}')
    // The polish pass reuses "hub": a new version replaces it, and the old one comes off as it grows.
    const replaced = design.push('{"shape":"sphere","id":"hub","position":[0,2,0],"radius":0.4}')
    expect(replaced).toMatchObject([{ kind: 'part', replaces: 'hub', dimensions: { r: 0.4 } }])
    const version = (replaced[0] as PartMark).name
    expect(['hub', 'hub-v1']).not.toContain(version)
    // Replacing again replaces the latest version, not the original.
    expect(design.push('{"shape":"sphere","id":"hub","position":[0,2,0],"radius":0.4}')).toMatchObject([{ replaces: version }])
    expect(design.push('{"shape":"sphere","id":"hub","position":[0,2,0],"radius":0.4}')).toHaveLength(1)
    // Its label went with it, so the same words can name the new version.
    const latest = (design.push('{"shape":"sphere","id":"hub","position":[0,2,0],"radius":0.4}')[0] as PartMark).name
    expect(design.push('{"label":"Hub","position":[0,2.1,0]}')).toMatchObject([{ kind: 'tag', part: latest }])
    // Parts declared later in the group still find it; removing the group frees its children's names too.
    expect(parts(design.push('{"shape":"box","id":"tip","position":[2,2,0],"size":[0.1,0.1,0.1],"group":"rotor"}'))[0]).toMatchObject({ parent: 'rotor' })
    expect(design.push('{"remove":"rotor"}')).toEqual([{ kind: 'remove', id: 'm', part: 'rotor' }])
    expect(design.push('{"remove":"blade"}')).toEqual([])
    // An id used again after removal gets a fresh name: the renderer may still hold the old part until its removal runs.
    const blade = parts(design.push('{"shape":"box","id":"blade","position":[0,0,0],"size":[1,1,1]}'))[0]!
    expect(blade.name).not.toBe('blade')
    expect(blade.replaces).toBeUndefined()
    expect(design.push('{"group":"rotor","pivot":[0,0,0]}')[0]).toMatchObject({ kind: 'part', shape: 'group' })
    expect((design.push('{"group":"rotor","pivot":[0,0,0]}'))).toEqual([])
  })

  it('frees the budget of a replaced part for its replacement', () => {
    const design = new ModelDesign('m')
    const big = JSON.stringify({ shape: 'box', id: 'grid', position: [0, 0, 0], size: [0.1, 0.1, 0.1], repeat: { count: 64, step: [0.01, 0, 0] } })
    for (let i = 0; i < Math.floor(MODEL_LIMITS.parts / 64) - 1; i++) design.push(JSON.stringify({ shape: 'box', position: [0, i, 0], size: [0.1, 0.1, 0.1], repeat: { count: 64, step: [0.01, 0, 0] } }))
    expect(parts(design.push(big))).toHaveLength(1)
    // Full now: only replacing the same 64 copies fits.
    expect(parts(design.push(JSON.stringify({ shape: 'box', id: 'extra', position: [0, 0, 0], size: [1, 1, 1], repeat: { count: 64, step: [1, 0, 0] } })))).toHaveLength(0)
    expect(design.push(big)).toMatchObject([{ kind: 'part', replaces: 'grid' }])
  })

  it('stops adding parts at the model budget instead of overloading the renderer', () => {
    const design = new ModelDesign('m')
    let placed = 0
    for (let i = 0; i < 40; i++) placed += parts(design.push(JSON.stringify({ shape: 'box', position: [0, i * 0.01, 0], size: [0.1, 0.1, 0.1], repeat: { count: 64, step: [0.01, 0, 0] } }))).reduce((n, p) => n + p.copies, 0)
    expect(placed).toBeLessThanOrEqual(MODEL_LIMITS.parts)
    expect(placed).toBeGreaterThan(MODEL_LIMITS.parts - 64)
  })
})
