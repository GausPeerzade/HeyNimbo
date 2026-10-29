import { describe, expect, it } from 'vitest'
import { SseParser } from './sse'

const stream = [
  ': keep-alive comment\n\n',
  'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n',
  'event: response.output_text.delta\r\ndata: {"delta":" there"}\r\n\r\n',
  'data: line one\ndata: line two\n\n',
  'event: response.completed\ndata: {}\n\n',
].join('')

describe('SseParser', () => {
  it('yields the same events however the stream is chunked', () => {
    const expected = [
      { event: 'response.output_text.delta', data: '{"delta":"Hi"}' },
      { event: 'response.output_text.delta', data: '{"delta":" there"}' },
      { event: undefined, data: 'line one\nline two' },
      { event: 'response.completed', data: '{}' },
    ]
    for (const size of [1, 2, 5, 17, stream.length]) {
      const parser = new SseParser()
      const events = []
      for (let i = 0; i < stream.length; i += size) events.push(...parser.push(stream.slice(i, i + size)))
      expect(events, `chunk size ${size}`).toEqual(expected)
    }
  })

  it('holds back an event until its terminating blank line arrives', () => {
    const parser = new SseParser()
    expect(parser.push('event: x\ndata: {"a":1}\n')).toEqual([])
    expect(parser.push('\n')).toEqual([{ event: 'x', data: '{"a":1}' }])
  })
})
