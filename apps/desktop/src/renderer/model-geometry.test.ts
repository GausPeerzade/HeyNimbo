import { describe, expect, it } from 'vitest'
import { MODEL_LIMITS, type PartMark } from '../shared/model-protocol'
import { ModelGraph } from './model-geometry'

const box = (name: string, extra: Partial<PartMark> = {}): PartMark => ({
  kind: 'part', id: 'm', name, shape: 'box', dimensions: { w: 1, h: 1, d: 1, round: 0 }, at: [0, 0, 0], turn: [0, 0, 0],
  scale: 1, copies: 1, step: [0, 0, 0], around: false, mat: 'paint', half: false, ...extra,
})

describe('ModelGraph', () => {
  it('lets a replacement use the budget of the parts it replaces, and removes a part with the parts inside it', () => {
    const graph = new ModelGraph()
    graph.add(box('frame', { shape: 'group', dimensions: {} }))
    graph.add(box('wheel', { parent: 'frame', copies: 4, step: [1, 0, 0] }))
    for (let i = 0; graph.add(box(`fill${i}`)); i++) if (i > MODEL_LIMITS.parts) throw new Error('budget never filled')
    // Full: a plain new part is refused, the same part replacing the frame (and its four wheels) is not.
    expect(graph.add(box('extra'))).toBeUndefined()
    expect(graph.add(box('frame-v1', { copies: 5, step: [1, 0, 0], replaces: 'frame' }))).toBeDefined()
    // The old frame takes its wheels with it, and the budget comes back as it goes.
    expect(graph.remove('frame').map((part) => part.spec.name).sort()).toEqual(['frame', 'wheel'])
    expect(graph.remove('frame')).toEqual([])
    expect(graph.add(box('extra'))).toBeUndefined()
    graph.remove('fill0')
    expect(graph.add(box('extra'))).toBeDefined()
  })

  it('frees the budget of every queued removal before any of them runs', () => {
    const graph = new ModelGraph()
    for (let i = 0; graph.add(box(`fill${i}`)); i++) if (i > MODEL_LIMITS.parts) throw new Error('budget never filled')
    // A rejected replacement leaves its original in place, still counted.
    expect(graph.add(box('bad-v1', { replaces: 'fill3', parent: 'missing' }))).toBeUndefined()
    expect(graph.add(box('sneak'))).toBeUndefined()
    // A polish batch prepares all its parts before its first removal begins.
    expect(graph.add(box('a-v1', { replaces: 'fill0' }))).toBeDefined()
    expect(graph.add(box('b-v1', { replaces: 'fill1' }))).toBeDefined()
    graph.retire('fill2'); graph.retire('fill2')
    expect(graph.add(box('new'))).toBeDefined()
    expect(graph.add(box('over'))).toBeUndefined()
    // Removals then run; retiring twice freed the budget once, and nothing is freed twice.
    for (const name of ['fill0', 'fill1', 'fill2']) graph.remove(name)
    expect(graph.add(box('over'))).toBeUndefined()
  })
})
