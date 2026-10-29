import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ packaged: false, isolate: vi.fn(), policy: vi.fn(), exit: vi.fn() }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return state.packaged }, setPath: vi.fn(), getPath: () => '/tmp/unused-profile', on: vi.fn(), quit: vi.fn(), exit: state.exit, setActivationPolicy: state.policy },
  Menu: { setApplicationMenu: vi.fn() }, shell: { openExternal: vi.fn() }, BrowserWindow: vi.fn(), ipcMain: { on: vi.fn() },
  nativeImage: { createFromBitmap: vi.fn() }, screen: {}, session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() } } },
}))
vi.mock('./dev-profile', async (load) => ({ ...await load<typeof import('./dev-profile')>(), isolateDevProfile: state.isolate }))

import { BeatParser, parseMark, type Mark } from '../shared/beats'
import type { OverlayCommand } from '../shared/ipc'
import type { AnswerConnection } from './answer-provider'
import { parseEvalModels, type AnswerRecord, type EvalModel, type EvalRun } from './model-eval'
import { configureModelShow, displayName, laneTimeline, planSubject, recordedStream, runLiveShow, selectSubjects, showLayout, showScript, subjectLanes, subjectWindowMs, type ShowLane } from './model-show'
import type { streamAnswer } from './voice/brain'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); state.packaged = false })

const image = { width: 1440, height: 900 }
const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
// As a model writes it: a 2D side card, its own rect and title, a second model, Windows line ends and an indented line.
const answer = [
  'Sure, here is a lighthouse.',
  '@card notes 760 140 440 300 "Notes" grid',
  '@heading notes "How it works"',
  '@model lh 60 120 620 580 "A lighthouse" turntable=true',
  '@part lh tower cylinder r=0.4 top=0.3 h=2.4 mat=paint color=white\r',
  '  @part lh lamp sphere r=0.2 at=0,1.4,0 mat=glow color=yellow',
  '@part lh rail torus r=0.35 tube=0.02 at=0,1.25,0 in=tower',
  '@cut lh z',
  '@tag lh lamp "Lamp" right',
  'The tower holds the lamp up high.',
  '@step notes "Light turns" down orange',
  '@model second 0 0 400 400 "Another"',
  '@part second extra box',
  '@move lh lamp spin axis=y period=4',
  'The lamp turns, so ships see it flash.',
].join('\n')
const marks = (text: string): Mark[] => { const parser = new BeatParser(image); return [...parser.push(text), ...parser.flush()].flatMap((beat) => beat.marks) }
const record = (timings: AnswerRecord['timings'], extra: Partial<AnswerRecord> = {}): AnswerRecord => ({ model: 'm', subject: 's', subjectSlug: '01-s', status: 'ok', timings, parse: { commandLines: 0, dropped: [], sentences: 0, models: 1, parts: 3, copies: 3, tags: 1, moves: 1, cuts: 1, other: 0 }, ...extra })

describe('showing an answer in a column', () => {
  it('overrides only the @model rect and title, keeping every 3D line of that model byte for byte and every sentence', () => {
    const card = { x: 24, y: 70, width: 448, height: 582 }
    const shown = showScript(answer, card, 'Claude Sonnet 5.5', image)!
    expect(shown.modelId).toBe('lh')
    const kept = answer.split('\n').filter((line) => /^\s*@(part|move|cut|tag) lh /.test(line))
    expect(shown.script.split('\n').filter((line) => /^\s*@(part|move|cut|tag) /.test(line))).toEqual(kept)
    expect(shown.script.split('\n').filter((line) => !line.trimStart().startsWith('@'))).toEqual(answer.split('\n').filter((line) => !line.trimStart().startsWith('@')))
    expect(shown.script).toContain('@model lh 24 70 448 582 "Claude Sonnet 5.5" turntable=true')
    for (const gone of ['@card', '@heading', '@step', '"A lighthouse"', '@model second', '@part second']) expect(shown.script).not.toContain(gone)
    // Parsed, the 3D commands mean exactly what they meant in the answer.
    const of = (text: string, kinds: string[]) => marks(text).filter((mark) => kinds.includes(mark.kind) && (mark as { id?: string }).id === 'lh')
    expect(of(shown.script, ['part', 'move', 'cut', 'tag'])).toEqual(of(answer, ['part', 'move', 'cut', 'tag']))
    expect(marks(shown.script).find((mark) => mark.kind === 'model')).toMatchObject({ x: 24, y: 70, w: 448, h: 582, title: 'Claude Sonnet 5.5', turntable: true })
    expect(showScript('No model here.\n@card c 0 0 300 200 "C"\nJust words.', card, 'X', image)).toBeUndefined()
  })

  it('opens a card written a sentence early together with its first part', () => {
    const early = '@model lh 60 120 620 580 "A lighthouse"\nA lighthouse guides ships.\n@part lh tower cylinder\nIt is tall.'
    const shown = showScript(early, { x: 24, y: 70, width: 448, height: 582 }, 'M', image)!
    const lane = laneTimeline(early, shown.script, record({ firstModelMs: 400, firstPartMs: 1500, totalMs: 3000 }), image)
    expect(lane.beats).toHaveLength(1)
    expect(lane.beats[0]).toMatchObject({ atMs: 1500 })
    expect(lane.beats[0]!.marks.map((mark) => mark.kind)).toEqual(['model', 'part'])
  })

  it('names models for people and lays equal columns inside the work area, with a pill under each', () => {
    expect(['gpt-6.1-terra', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'anthropic/claude-opus-5.5', 'gemini-3.5-flash-lite', 'claude-haiku-4-5-20251001'].map(displayName))
      .toEqual(['GPT-6.1 Terra', 'Claude Sonnet 5.5', 'Claude Haiku 5.5', 'Claude Opus 5.5', 'Gemini 3.5 Flash Lite', 'Claude Haiku 4.5'])
    const layout = showLayout(display, 3)
    const cards = layout.columns.map((column) => column.card)
    expect(new Set(cards.map((card) => `${card.width}x${card.height}`)).size).toBe(1)
    expect(new Set(cards.map((card) => card.y)).size).toBe(1)
    for (let i = 1; i < 3; i++) expect(cards[i]!.x).toBeGreaterThanOrEqual(cards[i - 1]!.x + cards[i - 1]!.width)
    expect(cards[0]!.x).toBeGreaterThan(0); expect(cards[2]!.x + cards[2]!.width).toBeLessThan(1440)
    expect(cards[0]!.width).toBeGreaterThan(1440 / 3 - 50)
    // Below the menu bar, under the heading, and with room for the small print.
    expect(layout.heading.y - 40).toBeGreaterThanOrEqual(25)
    expect(cards[0]!.y).toBeGreaterThan(layout.heading.y)
    for (const column of layout.columns) {
      expect(column.note.x).toBe(column.card.x + column.card.width / 2)
      expect(column.note.y - 40).toBeGreaterThan(column.card.y + column.card.height)
      expect(column.note.y).toBeLessThanOrEqual(900)
    }
  })
})

describe('pacing', () => {
  it('starts each model at its measured first-part time, then no sooner than speech and its own stream allow', () => {
    const text = answer, script = showScript(text, { x: 24, y: 70, width: 448, height: 582 }, 'M', image)!.script
    const fast = laneTimeline(text, script, record({ firstPartMs: 1200, totalMs: 9000 }), image)
    const slow = laneTimeline(text, script, record({ firstPartMs: 5000, totalMs: 60_000 }), image)
    expect(fast.beats[0]!.atMs).toBe(1200); expect(slow.beats[0]!.atMs).toBe(5000)
    // The card opens with its first part.
    expect(fast.beats[0]!.marks.map((mark) => mark.kind).slice(0, 2)).toEqual(['model', 'part'])
    for (const lane of [fast, slow]) for (let i = 1; i < lane.beats.length; i++) expect(lane.beats[i]!.atMs).toBeGreaterThanOrEqual(lane.beats[i - 1]!.atMs + lane.beats[i - 1]!.durationMs)
    // A slow stream holds its later beats back further than speech alone would.
    expect(slow.beats.at(-1)!.atMs - slow.beats[0]!.atMs).toBeGreaterThan(fast.beats.at(-1)!.atMs - fast.beats[0]!.atMs)
    const lanes: ShowLane[] = [3000, 1200, 5000].map((first, i) => ({ name: `m${i}`, note: '', prepared: [], ...laneTimeline(text, script, record({ firstPartMs: first, totalMs: first + 6000 }), image) }))
    const starts = (plan: ReturnType<typeof planSubject>) => plan.lanes.map((lane) => lane.beats[0]!.atMs)
    expect(starts(planSubject('Q', lanes, 1))).toEqual([3000, 1200, 5000])
    expect(starts(planSubject('Q', lanes, 2))).toEqual([1500, 600, 2500])
    // A very slow answer squeezes the whole subject alike, keeping the order and saying so.
    const crawl = { ...lanes[2]!, endMs: 120_000, beats: [{ ...lanes[2]!.beats[0]!, atMs: 50_000 }] }
    const squeezed = planSubject('Q', [lanes[0]!, lanes[1]!, crawl], 1)
    expect(squeezed.factor).toBeLessThan(1); expect(squeezed.heading).toMatch(/^Q · shown \d\.\d× faster$/)
    expect(starts(squeezed)[1]).toBeLessThan(starts(squeezed)[0]!); expect(starts(squeezed)[0]).toBeLessThan(starts(squeezed)[2]!)
    expect(squeezed.buildMs + squeezed.holdMs + 2500).toBeLessThanOrEqual(40_000)
  })

  it('shows what was measured for failed or 3D-free answers instead of a card', () => {
    const run = { models: ['openai:a', 'anthropic:b', 'anthropic:c'].map((spec) => ({ spec, slug: spec.replace(':', '-'), provider: 'openai', model: spec.split(':')[1]!, effort: 'low', preflight: 'ok' })), subjects: ['Q'],
      records: [record({ firstPartMs: 900, totalMs: 5000 }, { model: 'openai:a', subject: 'Q', answerFile: 'a.txt' }), record({}, { model: 'anthropic:b', subject: 'Q', status: 'timeout' }), record({ totalMs: 2000 }, { model: 'anthropic:c', subject: 'Q', answerFile: 'c.txt' })] } as unknown as EvalRun
    const files: Record<string, string> = { '/run/a.txt': answer, '/run/c.txt': 'A heart has four chambers.' }
    const lanes = subjectLanes(run, '/run', 'Q', showLayout(display, 3), image, (file) => files[file]!)
    expect(lanes.map((lane) => [lane.note, lane.beats.length > 0])).toEqual([['first part 0.9 s · 3 parts', true], ['no answer: timed out', false], ['answered without a 3D model', false]])
    expect(lanes[0]!.prepared.every((mark) => mark.kind === 'model' || mark.kind === 'part')).toBe(true)
  })
})

describe('choosing and bounding', () => {
  const subjects = ['Show me a 3D model of a lighthouse and explain how it works.', 'How does the human heart pump blood? Show me in 3D.', 'Can you build a 3D model of Saturn with its rings?']
  it('picks one subject by number, slug or a slug fragment, and nothing for no match', () => {
    expect(selectSubjects(subjects, undefined)).toEqual([0, 1, 2])
    expect(selectSubjects(subjects, '3')).toEqual([2]); expect(selectSubjects(subjects, '03')).toEqual([2])
    expect(selectSubjects(subjects, '03-saturn-with-its-rings')).toEqual([2])
    expect(selectSubjects(subjects, 'saturn-with-its-rings')).toEqual([2])
    expect(selectSubjects(subjects, 'Heart')).toEqual([1])
    expect(selectSubjects(subjects, '9')).toEqual([]); expect(selectSubjects(subjects, 'volcano')).toEqual([])
  })
  it('caps the run at forty seconds a subject, launched without focus in a throwaway profile, and does nothing packaged', () => {
    expect(subjectWindowMs(1)).toBe(40_000)
    vi.useFakeTimers(); vi.spyOn(process, 'uptime').mockReturnValue(0)
    vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW', '/tmp/heynimbo-3d-eval-synthetic/missing-run')
    configureModelShow()
    expect(state.isolate).toHaveBeenCalledWith('model-show')
    if (process.platform === 'darwin') expect(state.policy).toHaveBeenCalledWith('prohibited')
    // An unreadable run still gets a cap: fifteen subjects' worth plus start-up.
    vi.advanceTimersByTime(30_000 + 15 * 40_000 - 1); expect(state.exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(state.exit).toHaveBeenCalledWith(2)
    vi.clearAllTimers(); vi.clearAllMocks(); state.packaged = true
    configureModelShow()
    expect(state.isolate).not.toHaveBeenCalled(); expect(state.policy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
})

describe('live show', () => {
  const screenshot = { jpeg: Buffer.from('blank'), width: 1440, height: 900 }
  const connectionFor = (model: EvalModel): AnswerConnection => ({ provider: model.provider, model: model.model, effort: model.effort, vision: true, credential: async () => '' })
  const emptyRun = (subjects: string[]): EvalRun => ({ label: 't', mode: 'live', state: 'running', startedAt: '', display: { width: 1440, height: 900 }, limits: {} as EvalRun['limits'], models: [], subjects, records: [], errors: [] })
  /** A virtual clock: sleeping and streaming advance it, so pacing is exact and instant. */
  function harness(models: EvalModel[], subjects: string[], stream: (options: Parameters<typeof streamAnswer>[0], clock: { now: number }, events: string[]) => AsyncGenerator<string>, ready?: Map<string, string>) {
    const clock = { now: 0 }, events: string[] = [], sent: Array<{ layer: number; command: OverlayCommand; at: number }> = [], run = emptyRun(subjects)
    const show = {
      run, models, subjects: subjects.map((_, index) => index), layout: showLayout(display, models.length, 2), screenshot, connectionFor,
      ready: ready ?? new Map(models.map((model) => [model.spec, 'ok'])),
      send: (layer: number, command: OverlayCommand) => { sent.push({ layer, command, at: clock.now }); events.push(`send ${layer} ${command.kind}`) },
      sleep: async (ms: number) => { clock.now += ms; events.push(`sleep ${ms}`) }, now: () => clock.now,
      stream: ((options) => stream(options, clock, events)) as typeof streamAnswer, timeoutMs: 40,
      onResult: vi.fn(),
    }
    return { show, clock, events, sent, run }
  }
  const streamed = '@card side 700 100 300 200 "Side" grid\n@model lh 40 40 600 560 "Mine"\n@part lh tower cylinder r=0.4 h=2\nThe tower stands.\n@step side "Light" down\n@part lh lamp sphere r=0.2 at=0,1.1,0 in=tower\nThe lamp shines.'

  it('asks one model at a time, drawing each in its own column as its lines arrive, then holds and clears before the next subject', async () => {
    const models = parseEvalModels('openai:gpt-6.1-terra:low,anthropic:claude-sonnet-5-5:medium').models
    const { show, events, sent, run } = harness(models, ['Lighthouse?', 'Heart?'], async function* (options, clock, log) {
      log.push(`ask ${options.connection!.model} ${options.question}`)
      clock.now += 500; yield streamed.slice(0, 110)
      clock.now += 300; yield streamed.slice(110)
      log.push(`end ${options.connection!.model}`)
    })
    await runLiveShow(show)
    expect(events.filter((event) => event.startsWith('ask'))).toEqual(['ask gpt-6.1-terra Lighthouse?', 'ask claude-sonnet-5-5 Lighthouse?', 'ask gpt-6.1-terra Heart?', 'ask claude-sonnet-5-5 Heart?'])
    expect(run.records.map((record) => [record.model, record.subject, record.status])).toEqual([
      ['openai:gpt-6.1-terra:low', 'Lighthouse?', 'ok'], ['anthropic:claude-sonnet-5-5:medium', 'Lighthouse?', 'ok'], ['openai:gpt-6.1-terra:low', 'Heart?', 'ok'], ['anthropic:claude-sonnet-5-5:medium', 'Heart?', 'ok'],
    ])
    expect(show.onResult).toHaveBeenCalledTimes(4)
    // Each request draws in its own column while it streams; the next waits for the drawing and the stats pill.
    const asks = events.flatMap((event, i) => event.startsWith('ask') ? [i] : [])
    for (const [n, start] of asks.entries()) {
      const slot = n % 2, end = events.indexOf(`end ${models[slot]!.model}`, start), next = asks[n + 1] ?? events.length
      const during = events.slice(start, next).filter((event) => /^send [01] (beat|prepare)$/.test(event))
      expect(during.every((event) => event.startsWith(`send ${slot} `))).toBe(true)
      expect(events.slice(start, end).some((event) => event === `send ${slot} beat`)).toBe(true)
      expect(events.slice(end, next).findIndex((event) => event.startsWith('sleep'))).toBeLessThan(events.slice(end, next).lastIndexOf(`send ${slot} beat`))
    }
    expect(events.slice(asks[1]!, asks[2]!)).toEqual(expect.arrayContaining(['sleep 6000', 'send 0 clear', 'send 1 clear', 'send 2 clear']))
    // Only the column's model is drawn: its card moved and renamed, its parts unchanged, and no 2D card or step.
    const drawn = sent.filter(({ layer, command }) => layer < 2 && command.kind === 'beat').flatMap(({ layer, command }) => (command as Extract<OverlayCommand, { kind: 'beat' }>).marks.map((mark) => ({ layer, mark })))
    for (const slot of [0, 1]) {
      const card = show.layout.columns[slot]!.card
      expect(drawn.find(({ layer, mark }) => layer === slot && mark.kind === 'model')!.mark).toMatchObject({ x: card.x, y: card.y, w: card.width, h: card.height, title: ['GPT-6.1 Terra', 'Claude Sonnet 5.5'][slot] })
    }
    const parts = streamed.split('\n').filter((line) => line.startsWith('@part')).map((line) => parseMark(line, image))
    expect(drawn.filter(({ layer, mark }) => layer === 0 && mark.kind === 'part').map(({ mark }) => mark).slice(0, 2)).toEqual(parts)
    expect(drawn.some(({ mark }) => ['card', 'step', 'heading', 'note'].includes(mark.kind))).toBe(false)
    expect(sent.filter(({ layer, command }) => layer < 2 && command.kind === 'prepare').every(({ command }) => (command as Extract<OverlayCommand, { kind: 'prepare' }>).marks.every((mark) => mark.kind === 'model' || mark.kind === 'part'))).toBe(true)
    // The status pill reports progress and the first part as soon as it arrives.
    const labels = sent.filter(({ layer, command }) => layer === 2 && command.kind === 'beat').map(({ command }) => (command as Extract<OverlayCommand, { kind: 'beat' }>).marks.at(-1)).map((mark) => (mark as { label?: string }).label)
    // The first chunk already holds the whole first @part line, so it arrives at 0.5 s.
    expect(labels).toEqual(['GPT-6.1 Terra', 'Claude Sonnet 5.5', 'GPT-6.1 Terra', 'Claude Sonnet 5.5'].flatMap((name, i) => [`${name} · ${(i >> 1) + 1}/2 · first part …`, `${name} · ${(i >> 1) + 1}/2 · first part 0.5 s`]))
    const notes = sent.filter(({ layer, command }) => layer < 2 && command.kind === 'beat' && (command as Extract<OverlayCommand, { kind: 'beat' }>).marks[0]!.kind === 'point')
    expect(notes.map(({ command }) => ((command as Extract<OverlayCommand, { kind: 'beat' }>).marks[0] as { label: string }).label)).toEqual(Array(4).fill('first part 0.5 s · 2 parts'))
  })

  it('records a failed, a timed-out and an unchecked model and moves on, each with its reason under its column', async () => {
    const models = parseEvalModels('openai:fails,openai:hangs,openai:works,openai:refused').models
    const ready = new Map([...models.map((model) => [model.spec, 'ok'] as [string, string]), ['openai:refused', 'Add a key for the selected answer provider in Settings → Connection.']])
    const { show, events, run, sent } = harness(models, ['Lighthouse?'], async function* (options, _clock, log) {
      const name = options.connection!.model
      log.push(`ask ${name}`)
      if (name === 'fails') throw new Error('Upstream refused.')
      if (name === 'hangs') { yield 'Thinking'; await new Promise(() => {}) }
      yield streamed
    }, ready)
    await runLiveShow(show)
    expect(events.filter((event) => event.startsWith('ask'))).toEqual(['ask fails', 'ask hangs', 'ask works'])
    expect(run.records.map((record) => record.status)).toEqual(['error', 'timeout', 'ok', 'error'])
    const notes = sent.filter(({ layer, command }) => layer < 4 && command.kind === 'beat' && (command as Extract<OverlayCommand, { kind: 'beat' }>).marks[0]!.kind === 'point')
      .map(({ layer, command }) => [layer, ((command as Extract<OverlayCommand, { kind: 'beat' }>).marks[0] as { label: string }).label])
    expect(notes).toEqual([[0, 'no answer: request failed'], [1, 'no answer: timed out'], [2, 'first part 0.0 s · 2 parts'], [3, 'no answer: request failed']])
  })

  it('plays a recorded run back as a provider stream: its first token late, its text verbatim, its failures again', async () => {
    const source = mkdtempSync(join(tmpdir(), 'heynimbo-show-test-'))
    try {
      writeFileSync(join(source, 'a.txt'), streamed)
      const run = emptyRun(['Lighthouse?', 'Heart?'])
      run.models = [{ spec: 'anthropic:claude-haiku-5-5', slug: 'h', provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', preflight: 'ok' }]
      run.records = [record({ firstTokenMs: 700, totalMs: 1200 }, { model: 'anthropic:claude-haiku-5-5', subject: 'Lighthouse?', answerFile: 'a.txt', usage: { inputTokens: 900, outputTokens: 80 } }), record({}, { model: 'anthropic:claude-haiku-5-5', subject: 'Heart?', status: 'timeout' })]
      const waits: number[] = [], usage = vi.fn()
      const stream = recordedStream(source, run, async (ms) => { waits.push(ms) })
      const options = (question: string) => ({ connection: { provider: 'anthropic' as const, model: 'claude-haiku-5-5', effort: 'low' as const, vision: true, credential: async () => '' }, question, history: [], signal: new AbortController().signal, onUsage: usage })
      let text = ''
      for await (const chunk of stream(options('Lighthouse?'))) text += chunk
      expect(text).toBe(streamed); expect(waits[0]).toBe(700)
      expect(waits.slice(1).reduce((a, b) => a + b, 0)).toBeCloseTo(500)
      expect(usage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 900, outputTokens: 80 }))
      await expect((async () => { for await (const _ of stream(options('Heart?'))) { /* drain */ } })()).rejects.toThrow('timeout')
    } finally { rmSync(source, { recursive: true, force: true }) }
  })

  it('keeps the normal profile for real requests, a throwaway one for recorded answers, and nothing at all when packaged', () => {
    vi.useFakeTimers()
    vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE', '1'); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_MODELS', 'openai:gpt-6.1-terra:low')
    configureModelShow()
    expect(state.isolate).not.toHaveBeenCalled()
    if (process.platform === 'darwin') expect(state.policy).toHaveBeenCalledWith('prohibited')
    expect(vi.getTimerCount()).toBe(1)
    vi.clearAllTimers(); vi.clearAllMocks()
    vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_SHOW_MOCK', '/tmp/heynimbo-3d-eval-synthetic/missing-run')
    configureModelShow()
    expect(state.isolate).toHaveBeenCalledWith('model-show')
    vi.clearAllTimers(); vi.clearAllMocks(); state.packaged = true
    configureModelShow()
    expect(state.isolate).not.toHaveBeenCalled(); expect(state.policy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
})
