import { describe, expect, it } from 'vitest'
import { BeatParser, parseMark, type Beat } from './beats'

const IMAGE = { width: 1280, height: 800 }

function stream(text: string, chunkSize: number): Beat[] {
  const parser = new BeatParser(IMAGE)
  const beats: Beat[] = []
  for (let i = 0; i < text.length; i += chunkSize) beats.push(...parser.push(text.slice(i, i + chunkSize)))
  return [...beats, ...parser.flush()]
}

describe('parseMark', () => {
  it('parses every command and clamps coordinates to the screenshot', () => {
    expect(parseMark('@point 812 344 "Save button"', IMAGE)).toEqual({ kind: 'point', x: 812, y: 344, label: 'Save button' })
    expect(parseMark('@circle 1300 -5 40', IMAGE)).toEqual({ kind: 'circle', x: 1280, y: 0, r: 40 })
    expect(parseMark('@box 1200 700 200 200', IMAGE)).toEqual({ kind: 'box', x: 1200, y: 700, w: 80, h: 100 })
    expect(parseMark('@highlight 10 20 30.5 40', IMAGE)).toEqual({ kind: 'highlight', x: 10, y: 20, w: 30.5, h: 40 })
    expect(parseMark('@arrow 100 100 400 300', IMAGE)).toEqual({ kind: 'arrow', x1: 100, y1: 100, x2: 400, y2: 300 })
    expect(parseMark('@text 50 60 "Click here first"', IMAGE)).toEqual({ kind: 'text', x: 50, y: 60, text: 'Click here first' })
    expect(parseMark('@clear', IMAGE)).toEqual({ kind: 'clear' })
    expect(parseMark('@arc 640 400 60 -135 90', IMAGE)).toEqual({ kind: 'arc', x: 640, y: 400, r: 60, start: -135, sweep: 90 })
    expect(parseMark('@arc 10 10 5 0 720', IMAGE)).toEqual({ kind: 'arc', x: 10, y: 10, r: 5, start: 0, sweep: 360 })
    expect(parseMark('@curve 10 20 1500 40 30 -9', IMAGE)).toEqual({ kind: 'curve', points: [[10, 20], [1280, 40], [30, 0]] })
    expect(parseMark('@dot 100 100 90', IMAGE)).toEqual({ kind: 'dot', x: 100, y: 100, r: 30 })
  })

  it('rejects unknown commands, wrong argument counts and degenerate shapes', () => {
    const tooLong = `@curve ${'1 2 '.repeat(25)}`
    for (const bad of ['@explode 1 2', '@circle 10 10', '@circle 10 10 0', '@box 1280 800 50 50', '@text 1 2', '@point 1 2 3', '@clear "x"', 'point 1 2',
      '@arc 1 2 30 90 0', '@arc 1 2 0 0 90', '@curve 1 2', '@curve 1 2 3', '@curve 1 2 3 4 "x"', tooLong, '@dot 1 2 0']) {
      expect(parseMark(bad, IMAGE), bad).toBeUndefined()
    }
  })
})

describe('BeatParser', () => {
  const answer = [
    'Sure!',
    '@circle 812 344 40',
    '@point 812 344 "Save"',
    'That blue button saves your work. Then email me at hi@example.com when done.',
    '@nonsense 1 2 3',
    '@arrow 100 100 300 300',
  ].join('\n')

  it('attaches commands to the next sentence, drops invalid ones and never speaks them', () => {
    const expected: Beat[] = [
      { marks: [], sentence: 'Sure!' },
      {
        marks: [
          { kind: 'circle', x: 812, y: 344, r: 40 },
          { kind: 'point', x: 812, y: 344, label: 'Save' },
        ],
        sentence: 'That blue button saves your work.',
      },
      { marks: [], sentence: 'Then email me at hi@example.com when done.' },
      { marks: [{ kind: 'arrow', x1: 100, y1: 100, x2: 300, y2: 300 }] },
    ]
    for (const chunkSize of [1, 4, 13, answer.length]) expect(stream(answer, chunkSize), `chunk ${chunkSize}`).toEqual(expected)
  })

  it('streams a sentence before its line ends, so speech is not held for a newline', () => {
    const parser = new BeatParser(IMAGE)
    expect(parser.push('The menu is on the left. And the')).toEqual([{ marks: [], sentence: 'The menu is on the left.' }])
  })
})

describe('card protocol', () => {
  it('validates every new command, defaults and outer bounds', () => {
    expect(parseMark('@card water -20 790 10 20 "Water cycle" dots', IMAGE)).toEqual({ kind: 'card', id: 'water', x: 0, y: 620, w: 240, h: 180, title: 'Water cycle', board: 'dots' })
    expect(parseMark('@heading water "A journey"', IMAGE)).toEqual({ kind: 'heading', id: 'water', text: 'A journey' })
    expect(parseMark('@note water "Clouds form"', IMAGE)).toEqual({ kind: 'note', id: 'water', text: 'Clouds form' })
    expect(parseMark('@step water "Rise"', IMAGE)).toEqual({ kind: 'step', id: 'water', text: 'Rise', direction: 'down', color: 'blue' })
    for (const direction of ['up', 'down', 'left', 'right']) for (const color of ['blue', 'red', 'orange', 'green', 'purple', 'grey'])
      expect(parseMark(`@step water "Move" ${direction} ${color}`, IMAGE)).toMatchObject({ direction, color })
    expect(parseMark('@label -1 900 120 160 "Cloud"', IMAGE)).toEqual({ kind: 'label', x: 0, y: 800, lx: 120, ly: 160, text: 'Cloud' })
    for (const bad of ['@card Bad 0 0 300 200 "Bad"', '@card abcdefghijklmnopq 0 0 300 200 "Bad"', '@card a 0 0 0 200 "Bad"', '@card a 0 0 300 200 "Bad" stripes', '@heading a ""', '@step a "a" north blue', '@step a "a" up cyan', '@note a "x" up', `@label 1 2 3 4 "${'a'.repeat(61)}"`, `@card a 1 2 300 200 "${'b'.repeat(61)}"`, `@heading a "${'x'.repeat(61)}"`, `@step a "${'x'.repeat(61)}"`, `@note a "${'x'.repeat(61)}"`]) expect(parseMark(bad, IMAGE), bad).toBeUndefined()
  })

  it('retains references across sentences, bounds cards/steps, drops unknown and cleared refs', () => {
    const answer = ['@step missing "Drop"', '@card a 0 0 300 200 "A"', 'First.', ...Array.from({ length: 9 }, (_, i) => `@step a "Step ${i}" up green\nNext.`), '@card b 0 0 300 200 "B"', '@card c 0 0 300 200 "C"', '@card d 0 0 300 200 "D"', '@heading missing "Drop"', '@note missing "Drop"', '@clear', '@note a "Drop"'].join('\n')
    for (const chunk of [1, 17, answer.length]) {
      const marks = stream(answer, chunk).flatMap((beat) => beat.marks)
      expect(marks.filter((mark) => mark.kind === 'step')).toHaveLength(8)
      expect(marks.filter((mark) => mark.kind === 'card')).toHaveLength(3)
      expect(marks.some((mark) => 'text' in mark && mark.text === 'Drop')).toBe(false)
    }
    expect(stream('@dot 1 2 1\n'.repeat(25), 5).flatMap((beat) => beat.marks)).toHaveLength(20)
  })
})
