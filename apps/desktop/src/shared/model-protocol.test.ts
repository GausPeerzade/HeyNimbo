import { describe, expect, it } from 'vitest'
import { BeatParser, parseMark } from './beats'
import { MODEL_LIMITS, ModelRegistry, parseModelCommand, type PartMark } from './model-protocol'

const image = { width: 1200, height: 900 }
const part = (args = '') => parseModelCommand(`@part pump barrel tube ${args}`) as PartMark
const answer = (text: string) => { const parser = new BeatParser(image); return [...parser.push(text), ...parser.flush()].flatMap((beat) => beat.marks) }

describe('model command validation', () => {
  it('parses defaults, explicit placement, parents, ring repeats and all primitive families', () => {
    expect(part('at=1,2,3 turn=90,0,-20 in=base around=4 mat=copper color=green')).toMatchObject({ dimensions: { r: 0.5, inner: 0.35, h: 1 }, at: [1, 2, 3], turn: [90, 0, -20], parent: 'base', copies: 4, around: true, mat: 'copper', color: 'green' })
    for (const shape of ['box', 'cylinder', 'tube', 'cone', 'sphere', 'torus', 'capsule', 'spring', 'gear', 'pipe points=0,0,0;1,1,0', 'lathe profile=0,-1;1,0;0,1']) expect(parseModelCommand(`@part p a ${shape}`), shape).toBeDefined()
    expect(parseModelCommand('@part p a cylinder r=2')).toMatchObject({ dimensions: { r: 2, top: 2 } })
    expect(parseMark('@model p -10 20 600 500 "Pump" turntable=true', image)).toMatchObject({ kind: 'model', x: 0, turntable: true })
    expect(parseModelCommand('@move p a slide axis=y amount=1 period=3')).toMatchObject({ kind: 'move', axis: 'y', amount: 1, period: 3 })
  })
  it('rejects invalid shapes, keys, dimensions, transforms, repeat explosions and oversized point lists', () => {
    for (const args of ['blob', 'box wat=1', 'box r=1', 'tube inner=0.6', 'box w=0', 'box round=1', 'sphere half=yes', 'sphere r=Infinity', 'gear teeth=2', 'gear teeth=33', 'gear teeth=4.5', 'spring coils=99', 'pipe', 'lathe', 'lathe profile=1,0;1,0', 'box mat=chrome', 'box color=cyan', 'box at=0,0,99', 'box turn=0,0,999', 'box scale=5', 'box copies=13', 'box copies=2 around=2', 'box around=2 step=1,0,0', 'box copies=12 step=12,0,0', 'box w=1 w=2', 'box in=Bad', `pipe points=${Array.from({ length: 17 }, (_, i) => `${i},0,0`).join(';')}`, 'pipe points=0,0,0;0,0,0']) expect(parseModelCommand(`@part p a ${args}`), args).toBeUndefined()
    for (const line of ['@move p a slide amount=90', '@move p a spin axis=q', '@move p a spin period=0', '@move p a spin junk=1', `@tag p a "${'a'.repeat(41)}"`, '@tag p a " "', '@cut p all', '@part p Bad box', '@model p 0 0 400 400 "P" grid']) expect(parseMark(line, image), line).toBeUndefined()
  })
  it('retains sentence attachment across streaming, with unique shared card ids and answer-local references', () => {
    const text = '@model p 0 0 500 500 "Pump"\n@part p barrel tube\nThe barrel holds air.\n@part p barrel box\n@part missing a box\n@part p a box in=missing\n@move p missing spin\n@tag p missing "No"\n@part p rod cylinder in=barrel\nThe rod moves.\n@card p 0 0 300 200 "Duplicate"\n@clear\n@part p gone box\n'
    const parser = new BeatParser(image)
    const beats = [...Array.from(text).flatMap((char) => parser.push(char)), ...parser.flush()]
    expect(beats[0]).toMatchObject({ sentence: 'The barrel holds air.', marks: [{ kind: 'model' }, { kind: 'part', name: 'barrel' }] })
    expect(beats.flatMap((beat) => beat.marks).map((m) => m.kind)).toEqual(['model', 'part', 'part', 'clear'])
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
