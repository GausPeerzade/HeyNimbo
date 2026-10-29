import { afterEach, expect, it, vi } from 'vitest'
import { ConversationController } from '../conversations'
import { HistoryRepository } from '../history'
import { DEFAULT_SETTINGS } from '../settings'
import { TalkSession } from './talk'

afterEach(() => vi.unstubAllGlobals())
it.each(['openai', 'anthropic'] as const)('turn cancellation aborts a stalled %s SDK fetch', async provider => {
  const conversations = new ConversationController(new HistoryRepository(), () => DEFAULT_SETTINGS)
  let signal: AbortSignal | undefined
  const aborted = vi.fn()
  const transport = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? undefined
    signal?.addEventListener('abort', () => { aborted(); reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
  }))
  vi.stubGlobal('fetch', transport)
  const onStatus = vi.fn()
  const talk = new TalkSession({
    conversations, answer: () => ({ provider, model: provider === 'openai' ? 'gpt-6.1-terra' : 'claude-sonnet-5-5', vision: false, credential: async () => 'synthetic-only' }),
    capture: async () => undefined, audio: { send() {} }, onStatus, drawing: { draw() {}, answerDone() {} },
  })
  try {
    talk.askText('A question with a stalled response')
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
    expect(signal?.aborted).toBe(false)
    talk.holdCancelled()
    expect(signal?.aborted).toBe(true)
    expect(aborted).toHaveBeenCalledOnce()
    await new Promise(resolve => setImmediate(resolve))
    expect(conversations.turns()[0]).toMatchObject({ state: 'interrupted', error: null })
    expect(conversations.activeTurnId).toBeNull()
    expect(onStatus).toHaveBeenLastCalledWith(undefined)
  } finally { talk.close(); conversations.close() }
})
