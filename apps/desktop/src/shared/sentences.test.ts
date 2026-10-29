import { describe, expect, it } from 'vitest'
import { SentenceSplitter } from './sentences'

/** Feeds text in small, uneven chunks, the way a model streams it. */
function stream(text: string, chunkSize = 3): string[] {
  const splitter = new SentenceSplitter()
  const sentences: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) sentences.push(...splitter.push(text.slice(i, i + chunkSize)))
  return [...sentences, ...splitter.flush()]
}

describe('SentenceSplitter', () => {
  it('emits each sentence as soon as it is complete, regardless of chunking', () => {
    const text = 'Sure! The red button saves your file. Want me to show you where it is?'
    const expected = ['Sure!', 'The red button saves your file.', 'Want me to show you where it is?']
    for (const chunkSize of [1, 3, 7, 1000]) expect(stream(text, chunkSize)).toEqual(expected)
  })

  it('does not split decimals, file names, abbreviations or ellipses', () => {
    expect(stream('Version 3.5 is in index.ts, e.g. the top line... Then save.')).toEqual([
      'Version 3.5 is in index.ts, e.g. the top line...',
      'Then save.',
    ])
  })

  it('keeps closing quotes and brackets with their sentence and splits on newlines', () => {
    expect(stream('Click "Save." Then wait (about a second.)\nDone')).toEqual([
      'Click "Save."',
      'Then wait (about a second.)',
      'Done',
    ])
  })

  it('cuts a run-on sentence at a comma so speech can start early', () => {
    const runOn = `${'word '.repeat(30)}and, ${'more '.repeat(30)}end.`
    const [first, ...rest] = stream(runOn, 5)
    expect(first?.endsWith('and,')).toBe(true)
    expect(first!.length).toBeLessThanOrEqual(240)
    expect([first, ...rest].join(' ')).toBe(runOn.replace(/\s+/g, ' ').trim())
  })

  it('returns nothing for whitespace-only input', () => {
    expect(stream('  \n ')).toEqual([])
  })
})
