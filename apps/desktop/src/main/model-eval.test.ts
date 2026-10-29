import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnswerConnection } from './answer-provider'
import type { streamAnswer } from './voice/brain'

const state = vi.hoisted(() => ({
  packaged: false, fetch: vi.fn(), saveSecret: vi.fn(), removeSecret: vi.fn(), setPath: vi.fn(), policy: vi.fn(), exit: vi.fn(),
  history: vi.fn(), conversations: vi.fn(), isolate: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { get isPackaged() { return state.packaged }, setPath: state.setPath, getPath: () => '/tmp/unused-profile', getAppPath: () => process.cwd(), on: vi.fn(), quit: vi.fn(), exit: state.exit, isActive: () => false, setActivationPolicy: state.policy },
  Menu: { setApplicationMenu: vi.fn() }, shell: { openExternal: vi.fn() }, BrowserWindow: vi.fn(), ipcMain: { on: vi.fn() },
  nativeImage: { createFromBitmap: vi.fn() }, session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() } } },
}))
vi.mock('./secrets', () => ({
  loadSecret: vi.fn(async (name: string) => name === 'anthropic-key' ? 'sk-ant-synthetic-eval-key' : undefined),
  saveSecret: state.saveSecret, removeSecret: state.removeSecret, secretSavedAt: vi.fn(async () => undefined),
}))
vi.mock('./provider-settings', async (load) => ({ ...await load<typeof import('./provider-settings')>(), noRedirectFetch: state.fetch }))
vi.mock('./history', () => ({ HistoryRepository: state.history }))
vi.mock('./dev-profile', async (load) => ({ ...await load<typeof import('./dev-profile')>(), isolateDevProfile: state.isolate }))
vi.mock('./conversations', () => ({ ConversationController: state.conversations }))

import { answerPhase, configureModelEval, evalCapMs, evaluateAnswer, evalWriter, parseEvalModels, readOnlySettings, replayResults, summaryMarkdown, trackCredential, type EvalModel, type EvalRun } from './model-eval'
import { Connections } from './connections'
import { SettingsStore } from './settings'

const screenshot = { jpeg: Buffer.from('blank-screen'), width: 1440, height: 900, cursor: { x: 720, y: 450 } }
const run = (subjects: string[]): EvalRun => ({ label: 'test', mode: 'live', state: 'running', startedAt: '', display: { width: 1440, height: 900 }, limits: {} as EvalRun['limits'], models: [], subjects, records: [], errors: [] })
const sse = (events: Array<{ type: string }>): Response => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'heynimbo-eval-test-'))
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in tests') }))
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); state.packaged = false })

describe('model list', () => {
  it('reads provider:model[:effort], keeps colons inside model ids, and reports what it cannot use', () => {
    const { models, errors } = parseEvalModels(' openai:gpt-6.1-terra:medium, anthropic:claude-sonnet-5-5,anthropic:claude-haiku-5-5,compatible:llama3.2:latest,openrouter:anthropic/claude-opus-5.5:low,anthropic:claude-sonnet-5-5,mistral:large,openai:,')
    expect(models.map(({ provider, model, effort }) => [provider, model, effort])).toEqual([
      ['openai', 'gpt-6.1-terra', 'medium'], ['anthropic', 'claude-sonnet-5-5', undefined], ['anthropic', 'claude-haiku-5-5', undefined],
      ['compatible', 'llama3.2:latest', undefined], ['openrouter', 'anthropic/claude-opus-5.5', 'low'],
    ])
    expect(new Set(models.map((model) => model.slug)).size).toBe(models.length)
    expect(models.every((model) => /^[a-z0-9.-]+$/.test(model.slug))).toBe(true)
    expect(errors).toHaveLength(2); expect(errors[0]).toContain('mistral:large'); expect(errors[1]).toContain('"openai:"')
    expect(parseEvalModels(undefined).errors[0]).toContain('HEYNIMBO_DEBUG_3D_EVAL_MODELS')
  })
})

describe('one request', () => {
  it('times the first token, then the first accepted @model and @part lines when their line ends, then the total', async () => {
    let clock = 0
    const stream = async function* (options: Parameters<typeof streamAnswer>[0]) {
      clock = 120; yield 'Sure.\n'
      clock = 250; yield '@model lh 40 40 600 560 "Lighthouse"'
      clock = 300; yield '\n@part lh tower cyl'
      clock = 410; yield 'inder r=0.4 h=2\n@part lh bad hexagon\nThe tower stands tall.'
      options.onUsage?.({ inputTokens: 9000, outputTokens: 640, totalTokens: 9640, inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 600, reasoningTokens: 40 } })
      clock = 900
    }
    const answer = await evaluateAnswer({ connection: {} as AnswerConnection, question: 'Lighthouse?', screenshot, timeoutMs: 5000, stream: stream as typeof streamAnswer, now: () => clock })
    expect(answer.status).toBe('ok')
    expect(answer.timings).toEqual({ firstTokenMs: 120, firstModelMs: 300, firstPartMs: 410, totalMs: 900 })
    expect(answer.usage).toEqual({ inputTokens: 9000, outputTokens: 640, reasoningTokens: 40, cachedInputTokens: 8000, totalTokens: 9640 })
    expect(answer.parse).toMatchObject({ commandLines: 3, dropped: ['@part lh bad hexagon'], models: 1, parts: 1, sentences: 2 })
  })

  it('goes through the real provider path with saved keys and INSTRUCTIONS, saving the answer verbatim and never writing settings, history or secrets', async () => {
    const settingsFile = join(directory, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({ voice: 'cedar' }))
    const before = { bytes: readFileSync(settingsFile, 'utf8'), modified: statSync(settingsFile).mtimeMs }
    const store = new SettingsStore(settingsFile), set = vi.spyOn(store, 'set')
    const connections = new Connections(readOnlySettings(store), () => {})
    await connections.load()
    const answerText = '@model lh 40 40 600 560 "A lighthouse" turntable=true\n@part lh tower cylinder r=0.4 top=0.3 h=2.4 mat=paint color=white\nA lighthouse is a tall tower — “a beacon” ✓.\r\n@part lh lamp sphere r=0.2 at=0,1.4,0 mat=glow color=yellow\nThe lamp turns.  '
    const deltas = [answerText.slice(0, 31), answerText.slice(31, 140), answerText.slice(140)]
    state.fetch.mockImplementation(async (url: URL | string, init?: RequestInit) => {
      if (String(url).startsWith('https://api.anthropic.com/v1/models')) return Response.json({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: false })
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
      expect(init?.method).toBe('POST')
      return sse([
        { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 4100, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...deltas.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 87 } },
        { type: 'message_stop' },
      ] as Array<{ type: string }>)
    })
    const secrets = new Set<string>(), writer = evalWriter(directory, secrets), results = run(['Show me a lighthouse in 3D.'])
    const model = parseEvalModels('anthropic:claude-sonnet-5-5').models[0]!
    await answerPhase({
      run: results, models: [model], screenshot, connectionFor: (choice) => trackCredential(connections.answerFor(choice.provider, choice.model, choice.effort), secrets),
      onResult: (result) => { result.record.answerFile = writer.file(`${result.modelSlug}/${result.record.subjectSlug}-answer.txt`, result.text) },
    })
    writer.summary(results)
    const [record] = results.records
    expect(record).toMatchObject({ status: 'ok', usage: { inputTokens: 4100, outputTokens: 87 }, parse: { models: 1, parts: 2, dropped: [] } })
    expect(readFileSync(join(directory, record!.answerFile!), 'utf8')).toBe(answerText)
    expect(results.models).toEqual([expect.objectContaining({ spec: 'anthropic:claude-sonnet-5-5', effort: 'low', vision: true, preflight: 'ok' })])
    // The same request talk.ts makes: INSTRUCTIONS, the screenshot, no history, the preset's effort.
    const body = JSON.parse(String(state.fetch.mock.calls.find(([url]) => String(url).endsWith('/messages'))![1].body))
    expect(body.system[0].text).toContain('For any physical thing')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toContainEqual(expect.objectContaining({ type: 'image' }))
    expect(body.output_config).toMatchObject({ effort: 'low' })
    // Nothing of the user's is written, and the key appears in no output.
    expect(set).not.toHaveBeenCalled(); expect(() => readOnlySettings(store).set({})).toThrow()
    expect(readFileSync(settingsFile, 'utf8')).toBe(before.bytes); expect(statSync(settingsFile).mtimeMs).toBe(before.modified)
    for (const spy of [state.history, state.conversations, state.saveSecret, state.removeSecret]) expect(spy).not.toHaveBeenCalled()
    expect(secrets.has('sk-ant-synthetic-eval-key')).toBe(true)
    for (const file of readdirSync(directory, { recursive: true }).map(String).filter((name) => !statSync(join(directory, name)).isDirectory())) {
      expect(readFileSync(join(directory, file), 'utf8'), file).not.toContain('sk-ant-synthetic-eval-key')
    }
  })
})

describe('a whole run', () => {
  it('records a failed, a timed-out and a refused model without stopping, and redacts any key from the summary', async () => {
    const secrets = new Set<string>(), streamed: string[] = []
    const models = parseEvalModels('openai:fails,openai:hangs,openai:works,openai:refused').models
    const connectionFor = (model: EvalModel): AnswerConnection => trackCredential({
      provider: 'openai', model: model.model, vision: true,
      credential: async () => { if (model.model === 'refused') throw new Error('Add a key for the selected answer provider in Settings → Connection.'); return 'sk-synthetic-secret-abcdef' },
    }, secrets)
    const stream = async function* (options: Parameters<typeof streamAnswer>[0]) {
      const name = options.connection!.model
      streamed.push(name)
      await options.connection!.credential()
      if (name === 'fails') throw new Error('Upstream said: invalid key sk-synthetic-secret-abcdef')
      yield 'Partial '
      if (name === 'hangs') await new Promise(() => {})
      yield 'answer.'
    }
    const results = run(['Lighthouse?', 'Heart?']), seen: string[] = []
    await answerPhase({ run: results, models, connectionFor, screenshot, stream: stream as typeof streamAnswer, timeoutMs: 60, onResult: (result) => seen.push(`${result.record.model}/${result.record.subjectSlug}`) })
    expect(seen).toHaveLength(8)
    const status = (model: string, subject: number) => results.records.find((record) => record.model === `openai:${model}` && record.subject === results.subjects[subject])!
    for (const subject of [0, 1]) {
      expect(status('fails', subject)).toMatchObject({ status: 'error' })
      expect(status('hangs', subject)).toMatchObject({ status: 'timeout', error: expect.stringContaining('within') })
      expect(status('works', subject)).toMatchObject({ status: 'ok' })
      expect(status('refused', subject)).toMatchObject({ status: 'error', error: 'Credential check: Add a key for the selected answer provider in Settings → Connection.' })
    }
    expect(streamed).not.toContain('refused')
    const writer = evalWriter(directory, secrets)
    writer.summary(results)
    const summary = readFileSync(join(directory, 'summary.json'), 'utf8'), table = readFileSync(join(directory, 'summary.md'), 'utf8')
    expect(summary).not.toContain('sk-synthetic-secret-abcdef'); expect(summary).toContain('[redacted]')
    expect(table).toContain('| openai:hangs | 01-lighthouse | timeout')
    expect(summaryMarkdown(results)).toContain('| openai:works | provider default | yes | ok | 2 | 0 | 0 |')
  })

  it('starts nothing new once the run reaches its cap, recording the rest as skipped', async () => {
    const models = parseEvalModels('openai:works').models, results = run(['A?', 'B?'])
    const stream = async function* () { yield 'Fine.' }
    await answerPhase({ run: results, models, screenshot, startBefore: Date.now() - 1, stream: stream as unknown as typeof streamAnswer, onResult: () => {}, connectionFor: () => ({ provider: 'openai', model: 'works', vision: true, credential: async () => '' }) })
    expect(results.records.map((record) => record.status)).toEqual(['skipped', 'skipped'])
  })
})

describe('replay', () => {
  it('redraws saved answers verbatim with parsing redone, keeping the original timings and the failed requests', () => {
    const source = join(directory, 'earlier'), target = join(directory, 'again')
    const text = '@model lh 40 40 600 560 "Lighthouse"\n@part lh tower cylinder\n@part lh bad hexagon\nTall.\n'
    const earlier = run(['Lighthouse?', 'Heart?'])
    earlier.models = [{ spec: 'openai:x', slug: 'openai-x', provider: 'openai', model: 'x', effort: 'medium', vision: true, preflight: 'ok' }]
    earlier.records = [
      { model: 'openai:x', subject: 'Lighthouse?', subjectSlug: '01-lighthouse', status: 'ok', timings: { firstTokenMs: 800, totalMs: 9000 }, parse: { commandLines: 0, dropped: [], sentences: 0, models: 0, parts: 0, copies: 0, tags: 0, moves: 0, cuts: 0, other: 0 }, answerFile: 'openai-x/01-lighthouse-answer.txt' },
      { model: 'openai:x', subject: 'Heart?', subjectSlug: '02-heart', status: 'timeout', error: 'No complete answer within 90 s.', timings: {}, parse: { commandLines: 0, dropped: [], sentences: 0, models: 0, parts: 0, copies: 0, tags: 0, moves: 0, cuts: 0, other: 0 } },
    ]
    const old = evalWriter(source, new Set())
    old.file('openai-x/01-lighthouse-answer.txt', text); old.summary(earlier)
    const again = run([])
    const results = replayResults(source, again, evalWriter(target, new Set()))
    expect(results[0]!.record).toMatchObject({ status: 'ok', timings: { firstTokenMs: 800, totalMs: 9000 }, parse: { models: 1, parts: 1, dropped: ['@part lh bad hexagon'] } })
    expect(results[0]!.beats.flatMap((beat) => beat.marks)).toHaveLength(2)
    expect(readFileSync(join(target, results[0]!.record.answerFile!), 'utf8')).toBe(text)
    expect(results[1]).toMatchObject({ record: { status: 'timeout' }, beats: [] })
    expect(again.models).toEqual(earlier.models); expect(again.records).toHaveLength(2)
  })
})

describe('launch', () => {
  it('keeps the normal profile for a live run, installs a bounded cap, and never focuses', () => {
    vi.useFakeTimers(); vi.spyOn(process, 'uptime').mockReturnValue(0)
    vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL', '1'); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_MODELS', 'openai:gpt-6.1-terra:medium')
    configureModelEval()
    expect(state.isolate).not.toHaveBeenCalled()
    if (process.platform === 'darwin') expect(state.policy).toHaveBeenCalledWith('prohibited')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(90 * 60_000)
    expect(state.exit).toHaveBeenCalledWith(2)
  })
  it('gives a replay a throwaway profile, and does nothing at all in a packaged app', () => {
    vi.useFakeTimers()
    vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL', '1'); vi.stubEnv('HEYNIMBO_DEBUG_3D_EVAL_REPLAY', '/tmp/heynimbo-3d-eval/earlier')
    configureModelEval()
    expect(state.isolate).toHaveBeenCalledWith('model-eval')
    // Bounded by its work: a replay only draws, a live run also asks, and nothing outlasts 90 minutes.
    expect(evalCapMs(45, 0, true)).toBe(120_000 + 12 * 60_000)
    expect(evalCapMs(45, 3)).toBe(120_000 + 3 * 30_000 + 23 * 90_000 + 12 * 60_000)
    expect(evalCapMs(500, 10)).toBe(90 * 60_000)
    vi.clearAllTimers(); vi.clearAllMocks(); state.packaged = true
    configureModelEval()
    expect(state.policy).not.toHaveBeenCalled(); expect(state.isolate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
})
