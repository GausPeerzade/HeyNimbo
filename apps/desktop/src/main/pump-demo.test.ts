import * as THREE from 'three'
import { expect, it } from 'vitest'
import { ModelRegistry, MODEL_LIMITS } from '../shared/model-protocol'
import { ModelGraph } from '../renderer/model-geometry'
import { pumpDemo } from './pump-demo'

it('builds a bounded, parented pump whose front section exposes the barrel but preserves volumetric moving parts', () => {
  const beats = pumpDemo(1440, 900), registry = new ModelRegistry(), graph = new ModelGraph()
  const marks = beats.flatMap((beat) => beat.marks)
  for (const mark of marks) {
    if (mark.kind === 'model') expect(registry.open(mark.id)).toBe(true)
    if (mark.kind === 'part' || mark.kind === 'move' || mark.kind === 'cut' || mark.kind === 'tag') expect(registry.accept(mark), `${mark.kind} ${mark.id}`).toBe(true)
    if (mark.kind === 'part') { const part = graph.add(mark); expect(part, mark.name).toBeDefined(); graph.reveal(part!, 1) }
  }
  expect(registry.models.get('pump')!.count).toBe(28)
  expect(registry.models.get('pump')!.vertices).toBeLessThan(MODEL_LIMITS.verticesPerModel)
  expect(beats.reduce((sum, beat) => sum + beat.durationMs, 0)).toBe(18_500)
  graph.root.updateMatrixWorld(true)
  const box = (name: string) => { const part = graph.parts.get(name)!; return part.geometry.boundingBox!.clone().applyMatrix4(part.placements[0]!.matrixWorld) }
  expect(box('barrel').min.z).toBeLessThan(0); expect(box('barrel').max.z).toBeGreaterThan(0)
  for (const name of ['rod', 'handle', 'grips', 'nozzle', 'gauge']) expect(box(name).max.z, name).toBeLessThan(0)
  for (const name of ['piston', 'seals', 'handle', 'grips']) expect(graph.parts.get(name)!.root.parent).toBe(graph.parts.get('rod')!.placements[0])
  expect(graph.parts.get('ticks')!.placements).toHaveLength(8)
  graph.dispose()
})
