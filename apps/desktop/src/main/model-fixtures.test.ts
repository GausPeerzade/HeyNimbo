import { describe, expect, it } from 'vitest'
import type { Mark } from '../shared/beats'
import { INSTRUCTIONS } from './voice/brain'
import { BLIND_FIXTURES, fixtureBeats, MODEL_FIXTURES } from './model-fixtures'

const image = { width: 1200, height: 800 }
const model = { x: 40, y: 40, w: 640, h: 600 }, side = { x: 720, y: 70, w: 440, h: 420 }
/** One canonical line per mark, so a parser default or clamp that drifts changes the golden text. */
function canonical(mark: Mark): string {
  const { kind, ...rest } = mark
  return `${kind} ${JSON.stringify(rest)}`
}

describe('gallery fixture scripts', () => {
  for (const fixture of [...MODEL_FIXTURES, ...BLIND_FIXTURES]) {
    it(`${fixture.name} parses to its golden marks`, () => {
      const text = fixture.script(model, side)
      const beats = fixtureBeats(text, image)
      expect(beats.flatMap((beat) => beat.marks).map(canonical)).toMatchSnapshot()
      expect(beats.map((beat) => beat.sentence ?? '')).toMatchSnapshot()
    })
  }
  it('core fixtures, written against the kit, lose no command line', () => {
    for (const fixture of MODEL_FIXTURES) {
      const text = fixture.script(model, side)
      const lines = text.split('\n').filter((line) => line.startsWith('@')).length
      expect(fixtureBeats(text, image).flatMap((beat) => beat.marks), fixture.name).toHaveLength(lines)
    }
  })
  it("keeps every line of the prompt's own example", () => {
    const example = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf('Tiny example'), INSTRUCTIONS.indexOf('Use drawings to point things out')).split('\n').slice(1).join('\n')
    const lines = example.split('\n').filter((line) => line.startsWith('@')).length
    const marks = fixtureBeats(example, image).flatMap((beat) => beat.marks)
    expect(lines).toBeGreaterThanOrEqual(8)
    expect(marks).toHaveLength(lines)
  })
})
