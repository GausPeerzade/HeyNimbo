import type { Point } from './ink'

export type MeasureText = (text: string) => number
export interface WritingLine { text: string; width: number; rtl: boolean; clusters: string[] }
export interface WritingLayout { lines: WritingLine[]; lineHeight: number; size: number; shortened: boolean }

export function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), ({ segment }) => segment)
}

/** Keep the chosen size; shorten at cluster boundaries rather than making tiny words. */
export function wrapWriting(text: string, width: number, size: number, measure: MeasureText, maxLines = Infinity): WritingLayout {
  const lines: string[] = []
  let shortened = false
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(candidate) <= width) { line = candidate; continue }
      if (line) { lines.push(line); line = '' }
      // A single long word still wraps, without splitting surrogate/combining clusters.
      for (const cluster of graphemes(word)) {
        if (line && measure(line + cluster) > width) { lines.push(line); line = '' }
        line += cluster
      }
    }
    lines.push(line)
  }
  if (lines.length > maxLines) { lines.length = Math.max(0, maxLines); shortened = true }
  if (shortened && lines.length) {
    const last = graphemes(lines.at(-1)!)
    while (last.length && measure(last.join('') + '…') > width) last.pop()
    lines[lines.length - 1] = last.join('').trimEnd() + '…'
  }
  return { lines: lines.map((text) => ({ text, width: measure(text), rtl: /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text.match(/\p{Letter}/u)?.[0] ?? ''), clusters: graphemes(text) })), lineHeight: size * 1.3, size, shortened }
}

export function writingDuration(text: string): number {
  return Math.max(0.35, 0.4 + 0.015 * graphemes(text).length)
}

/** A line's shaped glyphs stay intact; only its narrow, soft mask edge moves. */
export function sampleWriting(layout: WritingLayout, origin: Point, progress: number): { widths: number[]; tip: Point; line: number } {
  const weights = layout.lines.map((line) => Math.max(1, line.clusters.length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let remaining = Math.max(0, Math.min(1, progress)) * total
  let active = Math.max(0, weights.length - 1)
  const widths = layout.lines.map((line, i) => {
    const part = Math.min(1, remaining / weights[i]!)
    if (remaining > 0 && remaining <= weights[i]!) active = i
    remaining = Math.max(0, remaining - weights[i]!)
    return line.width * part
  })
  if (progress <= 0) active = 0
  return { widths, line: active, tip: [origin[0] + (layout.lines[active]?.rtl ? layout.lines[active]!.width - (widths[active] ?? 0) : widths[active] ?? 0), origin[1] + active * layout.lineHeight - layout.size * 0.18] }
}
