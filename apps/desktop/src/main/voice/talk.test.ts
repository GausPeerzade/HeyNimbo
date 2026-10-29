import type { ScreenCaptures } from '@nimboguide/native'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationController } from '../conversations'
import { HistoryRepository } from '../history'
import { DEFAULT_SETTINGS } from '../settings'
import { TalkSession, type TalkDeps } from './talk'
const mocks = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('./brain', () => ({ streamAnswer: mocks.stream }))
const controllers: ConversationController[] = []
afterEach(() => { controllers.splice(0).forEach(c => c.close()); vi.restoreAllMocks(); vi.useRealTimers() })
function fixture(capture: Promise<ScreenCaptures | undefined> = Promise.resolve(undefined)): { c: ConversationController; deps: TalkDeps; talk: TalkSession } {
  const c = new ConversationController(new HistoryRepository(), () => DEFAULT_SETTINGS); controllers.push(c)
  const deps = {
    key: 'not-a-real-key', conversations: c, ears: { begin: vi.fn(), append: vi.fn(), finish: vi.fn(async () => 'A spoken question'), cancel: vi.fn(), close: vi.fn() },
    mouth: { speak: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn() }, capture: () => capture,
    audio: { send: vi.fn() }, onStatus: vi.fn(), drawing: { draw: vi.fn(), answerDone: vi.fn(), prepare: vi.fn() },
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
it('always aborts and cancels mic/speech and clears status when persistence of interruption throws', async () => {
  const { c, deps, talk } = fixture()
  let signal!: AbortSignal
  mocks.stream.mockImplementation(async function* (options: { signal: AbortSignal }) { signal = options.signal; yield 'Partial'; await new Promise(() => {}) })
  talk.askText('A question')
  await vi.waitFor(() => expect(signal).toBeDefined())
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(c, 'finish').mockImplementation(() => { throw new Error('Disk full') })
  expect(() => talk.holdCancelled()).not.toThrow()
  expect(signal.aborted).toBe(true)
  expect(deps.ears.cancel).toHaveBeenCalled()
  expect(deps.mouth.cancel).toHaveBeenCalled()
  expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'micStop' })
  expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'playCancel' })
  expect(deps.onStatus).toHaveBeenLastCalledWith(undefined)
})
it('close follows the cancellation path so reconnect cannot leave Home listening or busy', () => {
  const { deps, talk } = fixture()
  talk.holdStarted()
  expect(deps.onStatus).toHaveBeenLastCalledWith('Listening…')
  talk.close()
  expect(deps.onStatus).toHaveBeenLastCalledWith(undefined)
  expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'micStop' })
  expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'playCancel' })
  expect(deps.ears.close).toHaveBeenCalledOnce(); expect(deps.mouth.close).toHaveBeenCalledOnce()
})
it('clears completion status and the active owner even if the final repository write fails', async () => {
  const { c, deps, talk } = fixture()
  mocks.stream.mockImplementation(async function* () { yield 'Answer.' })
  talk.askText('Question')
  await vi.waitFor(() => expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'playEnd' }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(c.history, 'finish').mockImplementation(() => { throw new Error('Disk full') })
  expect(() => talk.onAudioEvent({ kind: 'playbackDrained' })).not.toThrow()
  expect(c.activeTurnId).toBeNull()
  expect(deps.onStatus).toHaveBeenLastCalledWith(undefined)
})
it('coalesces token/scene writes at 250 ms and flushes the final answer immediately', async () => {
  vi.useFakeTimers()
  const { c, deps, talk } = fixture()
  const update = vi.spyOn(c, 'update')
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  mocks.stream.mockImplementation(async function* () { for (let i = 0; i < 100; i++) yield 'word '; await pending; yield 'done.' })
  talk.askText('Question')
  await vi.advanceTimersByTimeAsync(0)
  expect(update).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(249); expect(update).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); expect(update).toHaveBeenCalledTimes(1)
  expect(c.turns()[0]?.answer).toBe('word '.repeat(100).trim())
  complete(); await vi.advanceTimersByTimeAsync(0)
  expect(update).toHaveBeenCalledTimes(2)
  expect(c.turns()[0]?.answer).toBe(`${'word '.repeat(100)}done.`)
  expect(deps.audio.send).toHaveBeenCalledWith({ kind: 'playEnd' })
  talk.onAudioEvent({ kind: 'playbackDrained' })
  await vi.advanceTimersByTimeAsync(1000); expect(update).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
})
it('forwards each 3D line as it streams in, before its sentence is spoken or drawn', async () => {
  const frame = { x: 0, y: 0, width: 1200, height: 800 }
  const { talk, deps } = fixture(Promise.resolve({ captureMs: 1, encodeMs: 1, displays: [{ displayId: 1, frame, pixelWidth: 1200, pixelHeight: 800, jpeg: Buffer.from('x') }] }))
  let releaseSentence!: () => void
  const sentenceArrives = new Promise<void>((resolve) => { releaseSentence = resolve })
  mocks.stream.mockImplementation(async function* () {
    yield '@model pump 40 40 600 560 "Pump"\n@part pump barrel tube\n@circle 1 2 3\n'
    await sentenceArrives
    yield 'The barrel holds the air.'
  })
  talk.askText('How does a pump work?')
  await vi.waitFor(() => expect(deps.drawing.prepare).toHaveBeenCalledTimes(2))
  const prepared = vi.mocked(deps.drawing.prepare!).mock.calls.map(([marks]) => marks[0]!.kind)
  expect(prepared).toEqual(['model', 'part'])
  expect(deps.mouth.speak).not.toHaveBeenCalled(); expect(deps.drawing.draw).not.toHaveBeenCalled()
  expect(vi.mocked(deps.drawing.prepare!).mock.calls[0]![1]).toMatchObject({ frame, pixelWidth: 1200 })
  releaseSentence()
  await vi.waitFor(() => expect(deps.mouth.speak).toHaveBeenCalled())
})
