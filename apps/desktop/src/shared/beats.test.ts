import { describe, expect, it } from 'vitest'
import { BeatParser, type Mark } from './beats'

const SCREEN = { width: 1440, height: 900 }

/** Streams an answer through the parser in small chunks, as a model would. */
function parse(answer: string, chunk = 7): { marks: Mark[]; sentences: string[]; dropped: string[] } {
  const dropped: string[] = []
  const parser = new BeatParser(SCREEN, undefined, line => dropped.push(line))
  const beats = []
  for (let i = 0; i < answer.length; i += chunk) beats.push(...parser.push(answer.slice(i, i + chunk)))
  beats.push(...parser.flush())
  return { marks: beats.flatMap(beat => beat.marks), sentences: beats.flatMap(beat => beat.sentence ? [beat.sentence] : []), dropped }
}

describe('3D commands', () => {
  it('keeps parts with long anatomical names and the tags that refer to them', () => {
    // From a real GPT-6.1 Sol heart: names over 16 characters used to drop the part and its tag.
    const { marks, dropped } = parse([
      'The heart is two pumps side by side.',
      '@model heart 420 120 600 560 "Heart"',
      '@part heart pulmonary-vein-left pipe r=0.095 points=-0.96,0.73,-0.35;-0.22,0.74,-0.34;0.3,0.63,-0.1 mat=paint color=red',
      '@tag heart pulmonary-vein-left "Pulmonary vein"',
      '@part heart ' + 'x'.repeat(33) + ' sphere r=0.2',
      'Blood returns from the lungs here.',
    ].join('\n'))
    expect(marks.map(mark => mark.kind)).toEqual(['model', 'part', 'tag'])
    expect(dropped).toHaveLength(1)
  })
})

describe('card commands', () => {
  it('keeps a card and all its rows when the model adds an option the protocol does not know', () => {
    // A real Claude Sonnet 5.5 answer: "lines" is not a paper style, and "navy" is not a step colour.
    const { marks, dropped } = parse([
      'A bill becomes law after both chambers pass it and the president signs it.',
      '@card law 360 120 720 660 "How a Bill Becomes a Law" lines',
      '@heading law "From idea to law"',
      '@step law "A member introduces the bill" down navy',
      '@step law "Committee votes" right orange',
      'Most bills stop in committee.',
    ].join('\n'))
    expect(dropped).toEqual([])
    expect(marks.map(mark => mark.kind)).toEqual(['card', 'heading', 'step', 'step'])
    expect(marks[0]).toMatchObject({ kind: 'card', id: 'law', board: 'grid', title: 'How a Bill Becomes a Law' })
    expect(marks[2]).toMatchObject({ kind: 'step', direction: 'down', color: 'blue' })
    expect(marks[3]).toMatchObject({ kind: 'step', direction: 'right', color: 'orange' })
  })

  it('reads known options in any order and still rejects cards that are not valid', () => {
    const { marks, dropped } = parse([
      '@card a 10 10 400 300 "Plain" plain',
      '@model m 50 80 600 560 "Pump" extra turntable=true',
      '@card b 10 10 0 300 "Zero width"',
      '@card UPPER 10 10 400 300 "Bad id"',
      '@step a "Too long ' + 'x'.repeat(60) + '"',
      '@note a "' + 'A note wraps over up to three lines, so a full sentence like this one that runs well past sixty characters still fits.' + '"',
      '@note a "' + 'x'.repeat(141) + '"',
      'Done.',
    ].join('\n'))
    expect(marks).toMatchObject([{ kind: 'card', board: 'plain' }, { kind: 'model', id: 'm', turntable: true }, { kind: 'note', id: 'a' }])
    expect(dropped).toHaveLength(4)
  })

  it('attaches command lines to the sentence after them and never speaks them', () => {
    const { marks, sentences } = parse('Tea needs hot water.\n@card tea 100 100 420 300 "Tea"\n@step tea "Boil water"\nSteep it for three minutes.')
    expect(sentences).toEqual(['Tea needs hot water.', 'Steep it for three minutes.'])
    expect(sentences.join(' ')).not.toContain('@')
    expect(marks.map(mark => mark.kind)).toEqual(['card', 'step'])
  })
})
