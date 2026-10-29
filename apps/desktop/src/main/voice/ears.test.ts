import { describe, expect, it } from 'vitest'
import type { RealtimeEvent, SocketFactory } from '../openai/realtime'
import { Ears } from './ears'

/** A transcription socket whose server events the test delivers by hand. */
function fakeSocket(): { connect: SocketFactory; server: (event: RealtimeEvent) => void; sent: string[] } {
  let deliver: (event: RealtimeEvent) => void = () => {}
  const sent: string[] = []
  const connect: SocketFactory = (_query, _key, onEvent) => {
    deliver = onEvent
    return { isOpen: true, send: (event) => sent.push(event.type), close: () => {} }
  }
  return { connect, server: (event) => deliver(event), sent }
}

const SECOND_OF_AUDIO = new Uint8Array(48_000)

describe('Ears', () => {
  it('never answers a newer turn with an interrupted turn’s late transcript', async () => {
    const { connect, server } = fakeSocket()
    const ears = new Ears('sk-test', connect)

    ears.begin()
    ears.append(SECOND_OF_AUDIO)
    const first = ears.finish()
    ears.begin() // the user pressed again before turn one was transcribed
    ears.append(SECOND_OF_AUDIO)
    const second = ears.finish()

    server({ type: 'input_audio_buffer.committed', item_id: 'item_a' })
    server({ type: 'input_audio_buffer.committed', item_id: 'item_b' })
    server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_a', transcript: 'old question' })
    server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_b', transcript: ' new question ' })

    await expect(first).resolves.toBe('')
    await expect(second).resolves.toBe('new question')
  })

  it('skips taps too short to transcribe and fails on server errors', async () => {
    const { connect, server, sent } = fakeSocket()
    const ears = new Ears('sk-test', connect)
    ears.begin()
    ears.append(new Uint8Array(100))
    await expect(ears.finish()).resolves.toBe('')
    expect(sent).not.toContain('input_audio_buffer.commit')

    ears.append(SECOND_OF_AUDIO)
    const turn = ears.finish()
    server({ type: 'error', error: { message: 'boom' } })
    await expect(turn).rejects.toThrow('boom')
  })
})
