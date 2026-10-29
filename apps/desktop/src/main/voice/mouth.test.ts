import { describe, expect, it } from 'vitest'
import type { RealtimeEvent, SocketFactory } from '../openai/realtime'
import { Mouth } from './mouth'

function fakeSocket(): { connect: SocketFactory; server: (event: RealtimeEvent) => void; sent: Array<Record<string, unknown>> } {
  let deliver: (event: RealtimeEvent) => void = () => {}
  const sent: Array<Record<string, unknown>> = []
  const connect: SocketFactory = (_query, _key, onEvent) => {
    deliver = onEvent
    return { isOpen: true, send: (event) => sent.push(event), close: () => {} }
  }
  return { connect, server: (event) => deliver(event), sent }
}

const created = (line: string, id: string): RealtimeEvent => ({
  type: 'response.created',
  response: { id, metadata: { heynimbo_line: line } },
})

describe('Mouth', () => {
  it('streams a line’s audio and resolves only when the response completed', async () => {
    const { connect, server } = fakeSocket()
    const mouth = new Mouth('sk-test', 'marin', connect)
    const audio: number[] = []
    const spoken = mouth.speak('Hello there.', (pcm) => audio.push(pcm.byteLength))
    server(created('line-1', 'resp_1'))
    server({ type: 'response.output_audio.delta', response_id: 'resp_1', delta: Buffer.alloc(8).toString('base64') })
    server({ type: 'response.output_audio.delta', response_id: 'other', delta: Buffer.alloc(4).toString('base64') })
    server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })
    await expect(spoken).resolves.toBeUndefined()
    expect(audio).toEqual([8])
  })

  it('rejects when speech fails instead of pretending the line was spoken', async () => {
    const { connect, server } = fakeSocket()
    const mouth = new Mouth('sk-test', 'marin', connect)
    const failed = mouth.speak('One.', () => {})
    server(created('line-1', 'resp_1'))
    server({ type: 'response.done', response: { id: 'resp_1', status: 'failed' } })
    await expect(failed).rejects.toThrow('failed')

    const errored = mouth.speak('Two.', () => {})
    server({ type: 'error', error: { message: 'quota exceeded' } })
    await expect(errored).rejects.toThrow('quota exceeded')
  })

  it('cancels a line server-side even when interrupted before it was created', async () => {
    const { connect, server, sent } = fakeSocket()
    const mouth = new Mouth('sk-test', 'marin', connect)
    const interrupted = mouth.speak('Long answer.', () => {})
    mouth.cancel()
    await expect(interrupted).resolves.toBeUndefined()
    server(created('line-1', 'resp_late'))
    expect(sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'resp_late' })
  })
})
