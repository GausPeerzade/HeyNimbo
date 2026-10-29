import { describe, expect, it } from 'vitest'
import { BeatParser, parseMark, type Mark } from './beats'
import { MODEL_LIMITS, ModelRegistry, parseModelCommand, partVertexCost, type PartMark } from './model-protocol'

const image = { width: 1200, height: 900 }
const part = (args = '') => parseModelCommand(`@part pump barrel tube ${args}`) as PartMark
const shape = (args: string) => parseModelCommand(`@part p a ${args}`) as PartMark | undefined
const answer = (text: string) => { const parser = new BeatParser(image); return [...parser.push(text), ...parser.flush()].flatMap((beat) => beat.marks) }

describe('model command validation', () => {
  it('parses defaults, explicit placement, parents, ring repeats and all primitive families', () => {
    expect(part('at=1,2,3 turn=90,0,-20 in=base around=4 mat=copper color=green')).toMatchObject({ dimensions: { r: 0.5, inner: 0.35, h: 1 }, at: [1, 2, 3], turn: [90, 0, -20], parent: 'base', copies: 4, around: true, mat: 'copper', color: 'green' })
    for (const family of ['box', 'cylinder', 'tube', 'cone', 'sphere', 'torus', 'capsule', 'spring', 'gear', 'pipe points=0,0,0;1,1,0', 'lathe profile=0,-1;1,0;0,1', 'extrude points=0,0;1,0;0,1', 'blob']) expect(shape(family), family).toBeDefined()
    expect(parseModelCommand('@part p a cylinder r=2')).toMatchObject({ dimensions: { r: 2, top: 2 } })
    expect(parseMark('@model p -10 20 600 500 "Pump" turntable=true', image)).toMatchObject({ kind: 'model', x: 0, turntable: true })
    expect(parseModelCommand('@move p a slide axis=y amount=1 period=3')).toMatchObject({ kind: 'move', axis: 'y', amount: 1, period: 3 })
  })
  it('defaults an unset material by form: paint for built things, tissue for organic blobs', () => {
    expect(shape('box')).toMatchObject({ mat: 'paint' })
    expect(shape('blob w=1')).toMatchObject({ mat: 'tissue', dimensions: { w: 1, h: 1, d: 1, lumps: 0.1, seed: 1, taper: 0 } })
    expect(shape('extrude points=0,0;1,0;0,1 smooth=true')).toMatchObject({ mat: 'paint', smooth: true, outline: [[0, 0], [1, 0], [0, 1]], dimensions: { d: 0.2, round: 0.02 } })
  })
  it('keeps a near-miss part, clamping or falling back on what it got wrong, and every value stays bounded', () => {
    const cases: Array<[string, Partial<PartMark>]> = [
      ['box wat=1', { shape: 'box' }],
      ['tube inner=0.6', { dimensions: { r: 0.5, inner: 0.46, h: 1 } }],
      ['box w=0', { dimensions: { w: MODEL_LIMITS.minDimension, h: 1, d: 1, round: 0 } }],
      ['box round=1', { dimensions: { w: 1, h: 1, d: 1, round: 0.5 } }],
      ['sphere half=yes', { half: true }],
      ['sphere r=Infinity', { dimensions: { r: 0.5 } }],
      ['gear teeth=2', { dimensions: { r: 0.5, teeth: 3, w: 0.15, hole: 0.1 } }],
      ['gear teeth=33', { dimensions: { r: 0.5, teeth: 32, w: 0.15, hole: 0.1 } }],
      ['gear teeth=4.5', { dimensions: { r: 0.5, teeth: 5, w: 0.15, hole: 0.1 } }],
      ['spring coils=99', { dimensions: { r: 0.4, h: 1, coils: 12, wire: 0.04 } }],
      ['box mat=chrome', { mat: 'steel' }],
      ['box mat=unobtainium', { mat: 'paint' }],
      ['box color=cyan', { color: 'blue' }],
      ['box at=0,0,99', { at: [0, 0, MODEL_LIMITS.coordinate] }],
      ['box turn=0,0,999', { turn: [0, 0, 279] }],
      ['box scale=5', { scale: MODEL_LIMITS.scale }],
      ['box copies=13', { copies: MODEL_LIMITS.repeats }],
      ['box copies=2 around=2', { copies: 2, around: true }],
      ['box around=2 step=1,0,0', { around: true, step: [0, 0, 0] }],
      ['box w=1 w=2', { dimensions: { w: 2, h: 1, d: 1, round: 0 } }],
      ['rod', { shape: 'cylinder' }],
      ['dome r=1', { shape: 'sphere', half: true }],
      ['box position=1,2,3 rotation=0,90,0 material=gold', { at: [1, 2, 3], turn: [0, 90, 0], mat: 'brass' }],
      [`pipe points=${Array.from({ length: 17 }, (_, i) => `${i},0,0`).join(';')}`, { points: Array.from({ length: 16 }, (_, i) => [i, 0, 0]) }],
      ['pipe points=0,0,0;0,0,0;1,0,0', { points: [[0, 0, 0], [1, 0, 0]] }],
    ]
    for (const [args, expected] of cases) expect(shape(args), args).toMatchObject(expected)
    expect(shape('box in=Bad')!.parent).toBeUndefined()
    expect(shape('box color=puce')!.color).toBeUndefined()
    // A long run of copies is shortened in step so the last copy stays inside the model box.
    expect(shape('box copies=12 step=12,0,0')!.step[0]).toBeCloseTo(MODEL_LIMITS.coordinate / 11)
    for (const [args] of cases) {
      const parsed = shape(args)!
      expect(Object.values(parsed.dimensions).every(Number.isFinite), args).toBe(true)
      expect(parsed.at.every((v) => Math.abs(v) <= MODEL_LIMITS.coordinate) && parsed.scale <= MODEL_LIMITS.scale && parsed.copies <= MODEL_LIMITS.repeats, args).toBe(true)
      expect(partVertexCost(parsed) / parsed.copies, args).toBeLessThanOrEqual(MODEL_LIMITS.verticesPerPart)
    }
  })
  it('still drops a line it cannot use, and only that line', () => {
    for (const args of ['hexagon', 'pipe', 'pipe points=0,0,0;0,0,0', 'lathe', 'lathe profile=0,0;0,1', 'extrude points=0,0;1,0;2,0', 'extrude points=0,0;1,1']) expect(shape(args), args).toBeUndefined()
    for (const line of ['@part p Bad box', '@tag p a " "', '@cut p all', '@move p a wobble']) expect(parseMark(line, image), line).toBeUndefined()
    // Near-misses on other commands keep their line.
    expect(parseMark('@model p 0 0 400 400 "P" grid', image)).toMatchObject({ kind: 'model', turntable: false })
    expect(parseMark('@model p 0 0 400 400 "P" turntable', image)).toMatchObject({ kind: 'model', turntable: true })
    expect(parseModelCommand('@move p a slide amount=90')).toMatchObject({ amount: MODEL_LIMITS.dimension })
    expect(parseModelCommand('@move p a spin axis=q period=0 junk=1')).toMatchObject({ axis: 'y', period: MODEL_LIMITS.minPeriod, amount: 360 })
    expect(parseModelCommand('@cut p')).toMatchObject({ axis: 'view' })
    expect(parseModelCommand('@cut p front')).toMatchObject({ axis: 'z' })
    expect(parseModelCommand(`@tag p a "${'a'.repeat(45)}"`)).toMatchObject({ text: `${'a'.repeat(39)}…` })
    const marks = answer('@model p 0 0 500 500 "M"\n@part p body box\n@part p bad hexagon\n@part p lid box in=body\n@tag p lid "Lid"\nShown.\n')
    expect(marks.map((mark) => (mark as { name?: string }).name ?? mark.kind)).toEqual(['model', 'body', 'lid', 'tag'])
  })
  it('retains sentence attachment across streaming, with unique shared card ids and answer-local references', () => {
    const text = '@model p 0 0 500 500 "Pump"\n@part p barrel tube\nThe barrel holds air.\n@part p barrel box\n@part missing a box\n@part p a box in=missing\n@move p missing spin\n@tag p missing "No"\n@part p rod cylinder in=barrel\nThe rod moves.\n@card p 0 0 300 200 "Duplicate"\n@clear\n@part p gone box\n'
    const parser = new BeatParser(image)
    const beats = [...Array.from(text).flatMap((char) => parser.push(char)), ...parser.flush()]
    expect(beats[0]).toMatchObject({ sentence: 'The barrel holds air.', marks: [{ kind: 'model' }, { kind: 'part', name: 'barrel' }] })
    expect(beats.flatMap((beat) => beat.marks).map((m) => m.kind)).toEqual(['model', 'part', 'part', 'clear'])
  })
  it('hands each accepted command over the moment its line ends, before its sentence is complete', () => {
    const seen: Array<{ mark: Mark; beats: number }> = []
    let beats = 0
    const parser = new BeatParser(image, (mark) => seen.push({ mark, beats }))
    for (const char of '@model p 0 0 500 500 "Pump"\n@part p barrel tube\n@part p bad hexagon\nThe barrel holds air.\n') beats += parser.push(char).length
    expect(seen.map(({ mark }) => mark.kind)).toEqual(['model', 'part'])
    // Both arrived while their sentence was still streaming.
    expect(seen.every((entry) => entry.beats === 0)).toBe(true)
    expect(beats).toBe(1)
  })
  it('caps two models within the shared three-card registry and preserves the existing 2D budget', () => {
    expect(answer(['@card c 0 0 300 200 "C"', ...['a', 'b', 'd'].map((id) => `@model ${id} 0 0 400 400 "M"`)].join('\n')).map((m) => m.kind)).toEqual(['card', 'model', 'model'])
    expect(answer('@dot 1 2 1\n'.repeat(25))).toHaveLength(20)
    expect(answer(['a', 'b', 'c'].map((id) => `@model ${id} 0 0 400 400 "M"`).join('\n')).filter((m) => m.kind === 'model')).toHaveLength(2)
  })
  it('counts copies and vertex reservations, rejecting without poisoning subsequent names', () => {
    const registry = new ModelRegistry(); registry.open('pump')
    const repeated = parseModelCommand('@part pump barrel lathe profile=0,0;0.1,1 copies=12') as PartMark
    for (let i = 0; i < 3; i++) expect(registry.accept({ ...repeated, name: `b${i}` })).toBe(true)
    expect(registry.accept({ ...repeated, name: 'last', copies: 5 })).toBe(false)
    expect(registry.accept({ ...repeated, name: 'last', copies: 4 })).toBe(true)
    expect(registry.models.get('pump')!.count).toBe(MODEL_LIMITS.parts)
    const heavy = new ModelRegistry(); heavy.open('pump')
    const gear = parseModelCommand('@part pump gear gear teeth=32 copies=12') as PartMark
    expect(heavy.accept(gear)).toBe(true)
    expect(heavy.accept({ ...gear, name: 'second' })).toBe(false)
    expect(heavy.models.get('pump')!.count).toBe(12)
  })
})
