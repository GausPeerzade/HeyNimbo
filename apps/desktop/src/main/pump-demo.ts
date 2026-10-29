import type { Mark } from '../shared/beats'
import { fixtureBeats, MODEL_FIXTURES } from './model-fixtures'

/** The gallery's original pump answer, laid out for this display and paced
 *  a little brisker than speech so the whole demo fits its time cap. */
export function pumpDemo(width: number, height: number): Array<{ durationMs: number; marks: Mark[] }> {
  const y = Math.round(height * 0.1)
  const model = { x: Math.round(width * 0.05), y, w: Math.round(width * 0.46), h: Math.round(height * 0.75) }
  const side = { x: Math.round(width * 0.57), y: y + 30, w: Math.round(width * 0.37), h: 390 }
  const pump = MODEL_FIXTURES.find((fixture) => fixture.name === 'pump')!
  return fixtureBeats(pump.script(model, side), { width, height }).map(({ durationMs, marks }) => ({ durationMs: Math.round(durationMs * 0.75), marks }))
}
