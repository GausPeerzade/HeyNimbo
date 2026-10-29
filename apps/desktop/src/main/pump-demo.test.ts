import { expect, it } from 'vitest'
import { ModelRegistry, MODEL_LIMITS } from '../shared/model-protocol'
import { pumpDemo } from './pump-demo'

it('builds the casing before its cut and the moving parts after it, inside every model budget', () => {
  const beats = pumpDemo(1440, 900), registry = new ModelRegistry()
  const marks = beats.flatMap((beat) => beat.marks)
  for (const mark of marks) {
    if (mark.kind === 'model') expect(registry.open(mark.id)).toBe(true)
    if (mark.kind === 'part' || mark.kind === 'move' || mark.kind === 'cut' || mark.kind === 'tag') expect(registry.accept(mark), `${mark.kind} ${mark.id}`).toBe(true)
  }
  expect(registry.models.get('pump')!.count).toBeLessThanOrEqual(MODEL_LIMITS.parts)
  expect(registry.models.get('pump')!.vertices).toBeLessThan(MODEL_LIMITS.verticesPerModel)
  // A cut opens the parts already built: the barrel is built on the cut's own beat, before it;
  // the rod, piston and seals arrive on later beats and so stay whole inside the opened barrel.
  const beatOf = (name: string) => beats.findIndex((beat) => beat.marks.some((mark) => mark.kind === 'part' && mark.name === name))
  const cutBeat = beats.findIndex((beat) => beat.marks.some((mark) => mark.kind === 'cut'))
  const cutMarks = beats[cutBeat]!.marks
  expect(cutMarks.findIndex((mark) => mark.kind === 'part' && mark.name === 'barrel')).toBeLessThan(cutMarks.findIndex((mark) => mark.kind === 'cut'))
  for (const name of ['rod', 'piston', 'seals', 'hose', 'gauge']) expect(beatOf(name), name).toBeGreaterThan(cutBeat)
  expect(marks.find((mark) => mark.kind === 'move')).toMatchObject({ part: 'rod', motion: 'slide', axis: 'y' })
  expect(beats.every((beat) => beat.durationMs > 0)).toBe(true)
})
