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
  })

  it('rejects unknown commands, wrong argument counts and degenerate shapes', () => {
    for (const bad of ['@explode 1 2', '@circle 10 10', '@circle 10 10 0', '@box 1280 800 50 50', '@text 1 2', '@point 1 2 3', '@clear "x"', 'point 1 2']) {
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
