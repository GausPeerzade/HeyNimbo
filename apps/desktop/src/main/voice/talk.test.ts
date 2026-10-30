import type { ScreenCaptures } from '@heynimbo/native'
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
  expect(deps.ears!.cancel).toHaveBeenCalled()
  expect(deps.mouth!.cancel).toHaveBeenCalled()
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
  expect(deps.ears!.close).toHaveBeenCalledOnce(); expect(deps.mouth!.close).toHaveBeenCalledOnce()
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

it('gates Anthropic-only voice before microphone or capture while typed answers complete without audio', async () => {
  const { c, deps } = fixture()
  const capture = vi.fn(async () => undefined)
  const talk = new TalkSession({ ...deps, ears: undefined, mouth: undefined, capture, answer: () => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', vision: true, credential: async () => 'synthetic-anthropic' }) })
  expect(talk.voiceAvailable).toBe(false)
  talk.holdStarted()
  expect(capture).not.toHaveBeenCalled(); expect(deps.ears!.begin).not.toHaveBeenCalled()
  expect(deps.onStatus).toHaveBeenLastCalledWith(expect.stringContaining('add an OpenAI key'))
  mocks.stream.mockImplementation(async function* () { yield 'Typed Claude answer.' })
  talk.askText('Typed question')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  expect(c.turns()[0]).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', answer: 'Typed Claude answer.' })
  expect(deps.mouth!.speak).not.toHaveBeenCalled()
  talk.close()
})
it('does not capture, persist screen context or draw model commands for non-vision models', async () => {
  const { c, deps } = fixture()
  const capture = vi.fn(async () => undefined)
  const talk = new TalkSession({ ...deps, ears: undefined, mouth: undefined, capture, answer: () => ({ provider: 'compatible', model: 'text-only', vision: false, credential: async () => '' }) })
  mocks.stream.mockImplementation(async function* () { yield '@circle 100 100 10\nA text answer.' })
  talk.askText('No image please')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  expect(capture).not.toHaveBeenCalled(); expect(deps.drawing.draw).not.toHaveBeenCalled()
  expect(c.turns()[0]).toMatchObject({ screenContextUsed: false, scene: { version: 1, beats: [] } })
  expect(mocks.stream).toHaveBeenLastCalledWith(expect.objectContaining({ screenshot: undefined }))
  talk.close()
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
  expect(deps.mouth!.speak).not.toHaveBeenCalled(); expect(deps.drawing.draw).not.toHaveBeenCalled()
  expect(vi.mocked(deps.drawing.prepare!).mock.calls[0]![1]).toMatchObject({ frame, pixelWidth: 1200 })
  releaseSentence()
  await vi.waitFor(() => expect(deps.mouth!.speak).toHaveBeenCalled())
})
it.each([false, true])('streams speech and 2D before later 3D on one high-thinking request; cancel during preparation: %s', async cancel => {
  vi.useFakeTimers()
  const frame = { x: 0, y: 0, width: 1200, height: 800 }
  const { c, deps } = fixture(Promise.resolve({ captureMs: 1, encodeMs: 1, displays: [{ displayId: 1, frame, pixelWidth: 1200, pixelHeight: 800, jpeg: Buffer.from('synthetic-pixels') }] }))
  const connection = { provider: 'openai' as const, model: 'gpt-6.1-terra', effort: 'medium' as const, vision: true, credential: async () => 'synthetic-only' }
  const talk = new TalkSession({ ...deps, answer: () => connection })
  let continueTo2D!: () => void, continueTo3D!: () => void, finish3D!: () => void
  const page = new Promise<void>(resolve => { continueTo2D = resolve })
  const model = new Promise<void>(resolve => { continueTo3D = resolve })
  const detail = new Promise<void>(resolve => { finish3D = resolve })
  mocks.stream.mockReset()
  mocks.stream.mockImplementation(async function* () {
    yield 'A hydraulic jack lifts a load by pushing oil under a piston.\n'
    await page
    yield '@card steps 20 20 400 300 "Oil pressure"\n@step steps "Push oil under the piston"\nA small piston pushes the oil.\n'
    await model
    yield '@model jack 500 20 600 560 "Hydraulic jack"\n@part jack body tube r=0.45 inner=0.36 h=1.6 mat=steel\n'
    await detail
    yield '@part jack ram cylinder r=0.3 h=1.4 at=0,0.4,0 mat=brass\n@tag jack ram "Ram"\nThe larger ram rises under pressure.\n'
  })
  talk.askText('Explain a jack with steps and 3D')
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.stream).toHaveBeenCalledOnce()
  expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ connection }))
  expect(deps.mouth!.speak).toHaveBeenCalledTimes(1)
  expect(deps.drawing.prepare).not.toHaveBeenCalled()
  continueTo2D(); await vi.advanceTimersByTimeAsync(0)
  expect(deps.mouth!.speak).toHaveBeenCalledTimes(2)
  talk.onAudioEvent({ kind: 'lineScheduled', line: 2, startsInMs: 0 }); await vi.advanceTimersByTimeAsync(0)
  expect(vi.mocked(deps.drawing.draw).mock.calls.flatMap(([marks]) => marks.map(mark => mark.kind))).toEqual(['card', 'step'])
  continueTo3D(); await vi.advanceTimersByTimeAsync(0)
  expect(vi.mocked(deps.drawing.prepare!).mock.calls.map(([marks]) => marks[0]!.kind)).toEqual(['model', 'part'])
  // Geometry is prepared while earlier speech can still be playing, not revealed early.
  expect(deps.drawing.draw).toHaveBeenCalledTimes(1)
  if (cancel) talk.holdCancelled()
  finish3D(); await vi.advanceTimersByTimeAsync(0)
  if (cancel) {
    expect(deps.drawing.prepare).toHaveBeenCalledTimes(2)
    expect(deps.mouth!.speak).toHaveBeenCalledTimes(2)
    talk.onAudioEvent({ kind: 'lineScheduled', line: 3, startsInMs: 0 }); await vi.advanceTimersByTimeAsync(0)
    expect(deps.drawing.draw).toHaveBeenCalledTimes(1)
    expect(c.turns()[0]?.state).toBe('interrupted')
  } else {
    expect(deps.mouth!.speak).toHaveBeenCalledTimes(3)
    expect(deps.drawing.draw).toHaveBeenCalledTimes(1)
    talk.onAudioEvent({ kind: 'lineScheduled', line: 3, startsInMs: 0 }); await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(deps.drawing.draw).mock.calls[1]![0].map(mark => mark.kind)).toEqual(['model', 'part', 'part', 'tag'])
    talk.onAudioEvent({ kind: 'playbackDrained' })
    expect(c.turns()[0]?.state).toBe('complete')
    expect(c.turns()[0]?.scene.beats.flatMap(beat => beat.marks.map(mark => mark.kind))).toEqual(['card', 'step', 'model', 'part', 'part', 'tag'])
  }
  expect(mocks.stream).toHaveBeenCalledOnce(); talk.close()
})
it('still draws cards and 3D on the cursor display when screen capture fails, without claiming screen context', async () => {
  const { c, deps } = fixture(Promise.resolve(undefined))
  const space = { frame: { x: 0, y: 0, width: 1440, height: 900 }, pixelWidth: 1440, pixelHeight: 900 }
  const talk = new TalkSession({ ...deps, mouth: undefined, canvas: () => space, answer: () => ({ provider: 'openai', model: 'gpt-6.1-terra', vision: true, credential: async () => 'synthetic' }) })
  mocks.stream.mockImplementation(async function* () { yield '@model bottle 40 40 600 560 "Water bottle"\n@part bottle body cylinder r=0.4 h=1.6\nPressure grows with depth.' })
  talk.askText('Draw a 3D water bottle')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  expect(mocks.stream).toHaveBeenLastCalledWith(expect.objectContaining({ screenshot: undefined, canvas: { width: 1440, height: 900 } }))
  expect(deps.drawing.prepare).toHaveBeenCalledWith([expect.objectContaining({ kind: 'model' })], space)
  expect(vi.mocked(deps.drawing.draw).mock.calls.flatMap(([marks]) => marks.map(mark => mark.kind))).toEqual(['model', 'part'])
  expect(c.turns()[0]).toMatchObject({ screenContextUsed: false, scene: { beats: [{ space }] } })
  talk.close()
})
it('starts one model-proposed task in the turn conversation and records its outcome on the turn, even after the turn ends', async () => {
  const { c, deps } = fixture()
  let resolve!: (value: { runId: string }) => void
  const startTask = vi.fn(() => new Promise<{ runId: string } | { cancelled: true }>(done => { resolve = done }))
  const talk = new TalkSession({ ...deps, mouth: undefined, startTask })
  mocks.stream.mockImplementation(async function* () { yield 'I started a research task.\n@task web "Find current M5 laptop prices"\n' })
  talk.askText('Research M5 laptop prices')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  expect(startTask).toHaveBeenCalledWith({ goal: 'Find current M5 laptop prices', mode: 'web', conversationId: c.currentId, signal: expect.any(AbortSignal) })
  expect(c.turns()[0]?.scene.tasks).toEqual([{ goal: 'Find current M5 laptop prices', mode: 'web', state: 'starting' }])
  expect(c.turns()[0]?.answer).toBe('I started a research task.')
  resolve({ runId: 'run_1' })
  await vi.waitFor(() => expect(c.turns()[0]?.scene.tasks).toEqual([{ goal: 'Find current M5 laptop prices', mode: 'web', state: 'started', runId: 'run_1' }]))
  talk.close()
})
it.each([
  ['cancelled picker', async () => ({ cancelled: true as const }), { state: 'failed', error: 'No folder was chosen.' }],
  ['host failure', async () => { throw new Error('Agent host unavailable. Try again.') }, { state: 'failed', error: 'Agent host unavailable. Try again.' }],
])('records a %s on the task without failing the spoken answer', async (_name, start, outcome) => {
  const { c, deps } = fixture()
  const talk = new TalkSession({ ...deps, mouth: undefined, startTask: vi.fn(start) })
  mocks.stream.mockImplementation(async function* () { yield '@task files "List TODO comments"\nI asked for a folder.' })
  talk.askText('Find TODOs in my project')
  await vi.waitFor(() => expect(c.turns()[0]?.scene.tasks?.[0]).toMatchObject(outcome))
  expect(c.turns()[0]).toMatchObject({ state: 'complete', answer: 'I asked for a folder.' })
  talk.close()
})
it('neither offers nor starts tasks when the connection cannot run them (ChatGPT plan access)', async () => {
  const { c, deps } = fixture()
  const startTask = vi.fn(async () => ({ runId: 'never' }))
  const talk = new TalkSession({ ...deps, mouth: undefined, startTask, tasksAvailable: () => false })
  mocks.stream.mockImplementation(async function* () { yield '@task web "Find prices"\nHere is what I know.' })
  talk.askText('Find prices')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  expect(mocks.stream).toHaveBeenLastCalledWith(expect.not.objectContaining({ tasks: true }))
  expect(startTask).not.toHaveBeenCalled()
  expect(c.turns()[0]?.scene.tasks).toBeUndefined()
  talk.close()
})
it('says a declined web task was cancelled, not that no folder was chosen', async () => {
  const { c, deps } = fixture()
  const talk = new TalkSession({ ...deps, mouth: undefined, startTask: vi.fn(async () => ({ cancelled: true as const })) })
  mocks.stream.mockImplementation(async function* () { yield '@task web "Find prices"\nI can look that up.' })
  talk.askText('Find prices')
  await vi.waitFor(() => expect(c.turns()[0]?.scene.tasks?.[0]).toMatchObject({ state: 'failed', error: 'You cancelled this task.' }))
  talk.close()
})
it.each(['stop', 'next question', 'close'] as const)('withdraws a pending task decision on %s, even after its answer finished', async action => {
  const { c, deps } = fixture()
  let signal!: AbortSignal
  const startTask = vi.fn((task: { signal?: AbortSignal }) => new Promise<{ runId: string } | { cancelled: true }>((_resolve, reject) => { signal = task.signal!; signal.addEventListener('abort', () => reject(new Error('Task expired.'))) }))
  const talk = new TalkSession({ ...deps, mouth: undefined, startTask })
  mocks.stream.mockImplementation(async function* () { yield '@task files "Read my project"\nChoose a folder.' })
  talk.askText('Read my project')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  expect(signal.aborted).toBe(false)
  mocks.stream.mockImplementation(async function* () { yield 'Next answer.' })
  if (action === 'stop') talk.holdCancelled()
  if (action === 'next question') talk.askText('Something else')
  if (action === 'close') talk.close()
  expect(signal.aborted).toBe(true)
  if (action !== 'close') await vi.waitFor(() => expect(c.turns()[0]?.scene.tasks?.[0]).toMatchObject({ state: 'failed', error: 'Task expired.' }))
  talk.close()
})
it('writes a late task outcome to the repository the turn was saved in, after history saving is switched off', async () => {
  let settings = { ...DEFAULT_SETTINGS }
  const c = new ConversationController(new HistoryRepository(), () => settings); controllers.push(c)
  let resolve!: (value: { runId: string }) => void
  const { deps } = fixture()
  const talk = new TalkSession({ ...deps, conversations: c, mouth: undefined, startTask: vi.fn(() => new Promise<{ runId: string }>(done => { resolve = done })) })
  mocks.stream.mockImplementation(async function* () { yield '@task web "Research"\nStarted.' })
  talk.askText('Research')
  await vi.waitFor(() => expect(c.turns()[0]?.state).toBe('complete'))
  const conversation = c.currentId!
  settings = { ...settings, saveHistory: false }; c.reset()
  resolve({ runId: 'actual_run' }); await new Promise(next => setImmediate(next))
  settings = { ...settings, saveHistory: true }; c.open(conversation)
  expect(c.turns()[0]?.scene.tasks).toEqual([{ goal: 'Research', mode: 'web', state: 'started', runId: 'actual_run' }])
  talk.close()
})
it('does not start a task after the turn is interrupted or when no task runner is wired', async () => {
  const { c, deps } = fixture()
  const startTask = vi.fn(async () => ({ runId: 'never' }))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const talk = new TalkSession({ ...deps, mouth: undefined, startTask })
  mocks.stream.mockImplementation(async function* () { yield 'Starting.'; await gate; yield '\n@task web "Too late"\n' })
  talk.askText('Research something'); await vi.waitFor(() => expect(c.turns()[0]?.answer).toBe('Starting.'))
  talk.holdCancelled(); release(); await new Promise(resolve => setImmediate(resolve))
  expect(startTask).not.toHaveBeenCalled()
  const plain = new TalkSession({ ...deps, mouth: undefined })
  mocks.stream.mockImplementation(async function* () { yield '@task web "Unwired"\nAnswer.' })
  plain.askText('Research'); await vi.waitFor(() => expect(c.turns().at(-1)?.state).toBe('complete'))
  expect(c.turns().at(-1)?.scene.tasks).toBeUndefined()
  talk.close(); plain.close()
})
it('an empty local transcript says it did not catch speech and never asks the answer provider', async () => {
  const { deps, talk, c } = fixture()
  mocks.stream.mockClear()
  vi.mocked(deps.ears!.finish).mockResolvedValue('')
  talk.holdStarted(); talk.holdEnded(); talk.onAudioEvent({ kind: 'micStopped', id: 1 })
  await vi.waitFor(() => expect(deps.onStatus).toHaveBeenLastCalledWith("Didn't catch that. Hold Control + Option and try again."))
  expect(mocks.stream).not.toHaveBeenCalled(); expect(c.turns()).toHaveLength(0)
})
it('forwards the sentence line to local mouth and fails playback errors without a stuck turn', async () => {
  const { deps, talk, c } = fixture()
  mocks.stream.mockImplementation(async function* () { yield 'A local answer.' })
  talk.askText('A question')
  await vi.waitFor(() => expect(deps.mouth!.speak).toHaveBeenCalledWith('A local answer.', expect.any(Function), 1))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  talk.onAudioEvent({ kind: 'playbackError', message: 'Local speech failed.' })
  expect(deps.mouth!.cancel).toHaveBeenCalled(); expect(c.activeTurnId).toBeNull()
  expect(c.turns()[0]).toMatchObject({ state: 'error', error: 'Local speech failed.' })
  talk.close()
})
