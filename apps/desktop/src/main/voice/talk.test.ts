import type { ScreenCaptures } from '@nimboguide/native'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationController } from '../conversations'
import { HistoryRepository } from '../history'
import { DEFAULT_SETTINGS } from '../settings'
import { TalkSession, type TalkDeps } from './talk'
const mocks = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('./brain', () => ({ streamAnswer: mocks.stream }))
const controllers: ConversationController[] = []
afterEach(() => { controllers.splice(0).forEach(c => c.close()); vi.restoreAllMocks() })
function fixture(capture: Promise<ScreenCaptures | undefined> = Promise.resolve(undefined)): { c: ConversationController; deps: TalkDeps; talk: TalkSession } {
  const c = new ConversationController(new HistoryRepository(), () => DEFAULT_SETTINGS); controllers.push(c)
  const deps = {
    key: 'not-a-real-key', conversations: c, ears: { begin: vi.fn(), append: vi.fn(), finish: vi.fn(async () => 'A spoken question'), cancel: vi.fn(), close: vi.fn() },
    mouth: { speak: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn() }, capture: () => capture,
    audio: { send: vi.fn() }, onStatus: vi.fn(), drawing: { draw: vi.fn(), answerDone: vi.fn() },
  } as unknown as TalkDeps
  return { c, deps, talk: new TalkSession(deps) }
}
it('saves the transcribed voice question before brain dispatch and completes only after playback drains', async () => {
  const { c, deps, talk } = fixture()
  mocks.stream.mockImplementation(async function* () {
    expect(c.turns()[0]).toMatchObject({ question: 'A spoken question', answer: '', state: 'interrupted' })
    yield 'A useful answer.'
  })
  talk.holdStarted(); talk.holdEnded(); talk.onAudioEvent({ kind: 'micStopped', id: 1 })
  await vi.waitFor(() => expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'playEnd' }))
  expect(c.activeTurnId).not.toBeNull()
  expect(c.turns()[0]?.answer).toBe('A useful answer.')
  talk.onAudioEvent({ kind: 'playbackDrained' })
  expect(c.turns()[0]?.state).toBe('complete')
  expect(c.activeTurnId).toBeNull()
})
it('interrupts a text request before capture resolves without dispatching it to the brain', async () => {
  let release!: (value: undefined) => void
  const capture = new Promise<undefined>(resolve => { release = resolve })
  const { c, talk } = fixture(capture)
  mocks.stream.mockClear()
  talk.askText('First question')
  expect(c.turns()[0]?.question).toBe('First question')
  talk.holdCancelled(); release(undefined)
  await new Promise(resolve => setImmediate(resolve))
  expect(mocks.stream).not.toHaveBeenCalled()
  expect(c.turns()[0]?.state).toBe('interrupted')
})
it('retains a partial answer and the provider error without converting an error to interruption', async () => {
  const { c, talk } = fixture()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.stream.mockImplementation(async function* () { yield 'Partial response'; throw new Error('The answer request failed (429).') })
  talk.askText('Second question')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('error'))
  expect(c.turns()[0]).toMatchObject({ answer: 'Partial response', error: 'The answer request failed (429).' })
})

it('stores parsed sentence marks and their capture space, never the screenshot or credential', async () => {
  const frame = { x: -1200, y: 24, width: 1200, height: 800 }
  const { c, talk, deps } = fixture(Promise.resolve({ captureMs: 1, encodeMs: 1, displays: [{ displayId: 1, frame, pixelWidth: 1200, pixelHeight: 800, jpeg: Buffer.from('private-screen-pixels') }] }))
  mocks.stream.mockImplementation(async function* () { yield '@circle 100 120 20\nThis control saves your work.' })
  talk.askText('Where to save?')
  await vi.waitFor(() => expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'playEnd' }))
  talk.onAudioEvent({ kind: 'playbackDrained' })
  expect(c.turns()[0]?.scene.beats[0]).toMatchObject({ sentence: 'This control saves your work.', marks: [{ kind: 'circle', x: 100, y: 120, r: 20 }], space: { frame, pixelWidth: 1200, pixelHeight: 800 } })
  const stored = JSON.stringify(c.turns())
  expect(stored).not.toContain('private-screen-pixels'); expect(stored).not.toContain('not-a-real-key'); expect(stored).not.toContain('@circle')
})
