import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { BeatParser, type Mark } from '../shared/beats'
import { MODEL_LIMITS } from '../shared/model-protocol'
import { ModelStage } from './model-stage'

vi.mock('three', async (load) => {
  const original = await load<typeof import('three')>()
  return { ...original, PMREMGenerator: class { fromScene = () => new original.WebGLRenderTarget(4, 4); dispose = vi.fn() }, WebGLRenderer: class {
    domElement = { addEventListener: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => false, releasePointerCapture: vi.fn() }
    localClippingEnabled = false
    shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false }
    setClearColor = vi.fn(); setPixelRatio = vi.fn(); setSize = vi.fn(); render = vi.fn(); clear = vi.fn()
    getRenderTarget = vi.fn(() => null); setRenderTarget = vi.fn(); getClearAlpha = vi.fn(() => 0); setClearAlpha = vi.fn()
    dispose = vi.fn(); forceContextLoss = vi.fn()
  } }
})

/** Deterministic, so a failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296 }
}

function answer(seed: number): string {
  const next = random(seed), pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!
  const number = () => pick([String(Math.round((next() - 0.5) * 6 * 100) / 100), String(Math.round(next() * 1000)), '-0', '1e9', '-50', '0', '.5', 'NaN', 'abc', '', String(next())])
  const triple = () => pick([`${number()},${number()},${number()}`, `${number()},${number()}`, `${number()},${number()},${number()},${number()}`, 'x,y,z'])
  const list = (size: number) => Array.from({ length: Math.floor(next() * 22) }, () => Array.from({ length: size }, number).join(',')).join(';')
  const names = ['body', 'arm', 'lid', 'wheel', 'core', 'Bad', 'x-1', 'a'.repeat(20)]
  const shapes = ['box', 'cylinder', 'tube', 'cone', 'sphere', 'torus', 'capsule', 'spring', 'gear', 'pipe', 'lathe', 'extrude', 'blob', 'rod', 'ring', 'cube', 'egg', 'hexagon', '']
  const keys = ['w', 'h', 'd', 'r', 'top', 'inner', 'round', 'tube', 'coils', 'wire', 'teeth', 'hole', 'lumps', 'seed', 'taper', 'half', 'smooth', 'scale', 'copies', 'around', 'mat', 'color', 'radius', 'material', 'junk']
  const value = (key: string) => key === 'mat' || key === 'material' ? pick(['steel', 'glass', 'tissue', 'rock', 'chrome', 'plasma', 'glow']) : key === 'color' ? pick(['red', 'cyan', 'white', 'puce']) : key === 'half' || key === 'smooth' ? pick(['true', 'no', '1']) : number()
  const id = pick(['m', 'n'])
  // Most answers open a model, so the parts behind it are exercised too; some headers are broken.
  const header = next() < 0.85 ? `${Math.round(next() * 1500) - 100} ${Math.round(next() * 900) - 50}` : `${number()} ${number()}`
  const lines = [`@model ${id} ${header} ${pick(['600', '50', '9000', '640'])} ${pick(['560', '20', '9000', '600'])} "Fuzz"${pick(['', ' turntable', ' turntable=true', ' grid'])}`]
  for (let i = 0; i < 10 + Math.floor(next() * 14); i++) {
    const kind = next()
    if (kind < 0.55) {
      const extras = Array.from({ length: Math.floor(next() * 6) }, () => { const key = pick(keys); return `${key}=${value(key)}` })
      const placement = [pick(['', `at=${triple()}`]), pick(['', `turn=${triple()}`]), pick(['', `step=${triple()}`]), pick(['', `in=${pick(names)}`]), pick(['', `points=${list(next() < 0.5 ? 2 : 3)}`, `profile=${list(2)}`])]
      lines.push(`@part ${next() < 0.85 ? id : pick(['m', 'zz'])} ${pick(names)} ${pick(shapes)} ${[...extras, ...placement].filter(Boolean).join(' ')}`)
    } else if (kind < 0.65) lines.push(`@move ${id} ${pick(names)} ${pick(['spin', 'bob', 'slide', 'orbit', 'wobble'])} axis=${pick(['x', 'y', 'z', 'q'])} amount=${number()} period=${number()}`)
    else if (kind < 0.72) lines.push(`@cut ${id} ${pick(['x', 'y', 'z', 'view', 'front', 'all', ''])}`)
    else if (kind < 0.82) lines.push(`@tag ${id} ${pick(names)} "${pick(['Lid', '', 'A very long label that goes on and on past forty', 'é ✓'])}" ${pick(['left', 'right', 'up', ''])}`)
    else if (kind < 0.9) lines.push(pick(['@', '@part', '@part m', '@model', '@cut', '@tag m', `@${pick(shapes)} 1 2 3`]))
    else lines.push(pick(['Here is how it works.', 'And this part turns.', 'Done.']))
  }
  return `${lines.join('\n')}\nThat is the model.\n`
}

const finite = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined) => !attribute || Array.from(attribute.array as ArrayLike<number>).every(Number.isFinite)

describe('model fuzzing', () => {
  // CPU-bound and deterministic (~2 s alone); the explicit timeout keeps it from
  // failing when the agent load/perf files run in parallel workers.
  it('never throws, never leaves a value unbounded, and never leaves an accepted part empty', { timeout: 20_000 }, () => {
    let accepted = 0
    for (let seed = 1; seed <= 160; seed++) {
      const text = answer(seed), parser = new BeatParser({ width: 1200, height: 800 })
      const marks: Mark[] = [...parser.push(text), ...parser.flush()].flatMap((beat) => beat.marks)
      const stages = new Map<string, ModelStage>()
      let now = 0
      const tick = () => { for (const stage of stages.values()) expect(typeof stage.tick(now += 16)).toBe('boolean') }
      try {
        for (const mark of marks) {
          if (mark.kind === 'model') {
            stages.set(mark.id, new ModelStage({ append: vi.fn(), remove: vi.fn() } as unknown as HTMLElement, { id: mark.id, width: mark.w - 2, height: mark.h - 30, turntable: mark.turntable, wake: vi.fn(), capture: vi.fn(), overCard: () => false, trace: vi.fn(), debug: () => false }))
            continue
          }
          if (!('id' in mark)) continue
          const stage = stages.get(mark.id)
          if (!stage) continue
          if (mark.kind === 'part') {
            const part = stage.prepare(mark)
            if (!part) continue
            stage.reveal(part, 0.3); tick(); stage.reveal(part, 1); tick()
            accepted++
            // Something visible: a mesh with real, finite geometry.
            const meshes = part.reveals[0]!.children.filter((node) => (node as THREE.Mesh).isMesh) as THREE.Mesh[]
            expect(meshes.length, `${seed}: ${mark.name}`).toBeGreaterThan(0)
            expect(part.geometry.getAttribute('position').count, `${seed}: ${mark.name}`).toBeGreaterThan(0)
            expect(finite(part.geometry.getAttribute('position')) && finite(part.geometry.getAttribute('normal')), `${seed}: ${mark.name}`).toBe(true)
          } else if (mark.kind === 'move') stage.move(mark, now)
          else if (mark.kind === 'cut') stage.cut(mark.axis)
          else if (mark.kind === 'tag') { stage.locate(mark.part); expect(stage.project(mark.part).every(Number.isFinite)).toBe(true) }
          tick()
        }
        for (let i = 0; i < 30; i++) tick()
        for (const stage of stages.values()) {
          expect(stage.camera.position.toArray().every(Number.isFinite), `${seed}`).toBe(true)
          let count = 0
          for (const part of stage.graph.parts.values()) count += part.spec.copies
          expect(count).toBeLessThanOrEqual(MODEL_LIMITS.parts)
        }
      } finally {
        for (const stage of stages.values()) stage.dispose()
      }
    }
    // The generator really exercises the renderer, not just the parser's rejections.
    expect(accepted).toBeGreaterThan(250)
  })
})
