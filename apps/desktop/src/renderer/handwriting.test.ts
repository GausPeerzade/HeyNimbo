import { describe, expect, it } from 'vitest'
import { graphemes, sampleWriting, wrapWriting, writingDuration } from './handwriting'

const measure = (text: string): number => graphemes(text).length * 10

describe('handwriting layout and line-local reveal', () => {
  it('greedily wraps measured words, preserves newlines/empty lines and complete graphemes', () => {
    expect(wrapWriting('one two three\n\nfour', 70, 26, measure).lines.map((line) => line.text)).toEqual(['one two', 'three', '', 'four'])
    const family = '👩‍👩‍👧‍👦'
    const writing = wrapWriting(`é${family}AB`, 20, 26, measure)
    expect(writing.lines.map((line) => line.text)).toEqual([`é${family}`, 'AB'])
    expect(writing.lines[0]!.clusters).toEqual(['é', family])
    const variableWidth = (text: string): number => [...text].reduce((sum, char) => sum + (char === 'W' ? 20 : 4), 0)
    expect(wrapWriting('WW ii', 42, 26, variableWidth).lines.map((line) => line.text)).toEqual(['WW', 'ii'])
  })

  it('shortens by clusters at a fixed readable size, never silent font shrinking', () => {
    const writing = wrapWriting('one two three four five six', 70, 26, measure, 2)
    expect(writing.shortened).toBe(true)
    expect(writing.size).toBe(26)
    expect(writing.lines).toHaveLength(2)
    expect(writing.lines.at(-1)!.text.endsWith('…')).toBe(true)
    expect(writing.lines.every((line) => line.width <= 70)).toBe(true)
    expect(writingDuration('é👩‍👩‍👧‍👦')).toBeCloseTo(0.43)
  })

  it('exposes one shaped line at a time, with the pen on that exact moving edge', () => {
    const layout = wrapWriting('abcd\nef', 100, 20, measure)
    const start = sampleWriting(layout, [100, 80], 0)
    const middle = sampleWriting(layout, [100, 80], 0.5)
    const later = sampleWriting(layout, [100, 80], 5 / 6)
    const end = sampleWriting(layout, [100, 80], 1)
    expect(start.widths).toEqual([0, 0])
    expect(middle.widths).toEqual([30, 0])
    expect(middle.tip).toEqual([130, 76.4])
    expect(later.widths).toEqual([40, 10])
    expect(later.line).toBe(1)
    expect(later.tip).toEqual([110, 102.4])
    expect(end.widths).toEqual([40, 20])
    expect(end.tip).toEqual([120, 102.4])
  })
})

it('writes RTL lines from their right edge while keeping each complete shaped string', () => {
  const layout = wrapWriting('שלום\nאב', 100, 20, measure)
  expect(layout.lines.map((line) => line.rtl)).toEqual([true, true])
  expect(sampleWriting(layout, [100, 80], 0).tip[0]).toBe(140)
  expect(sampleWriting(layout, [100, 80], 0.5).tip[0]).toBe(110)
  expect(sampleWriting(layout, [100, 80], 5 / 6).tip[0]).toBe(110)
  expect(sampleWriting(layout, [100, 80], 1).tip[0]).toBe(100)
  expect(layout.lines[0]!.text).toBe('שלום')
})
