import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, nativeImage, session } from 'electron'
import type { LanguageModelUsage } from 'ai'
import { BeatParser, type Beat, type Mark } from '../shared/beats'
import { PROVIDERS, type ProviderId } from '../shared/providers'
import type { AnswerConnection } from './answer-provider'
import { Connections } from './connections'
import { devFlag, devSetting } from './dev'
import { isolateDevProfile, launchInBackground } from './dev-profile'
import { drag, hiddenOverlay, sendOverlay, sleep } from './model-gallery'
import { toOverlaySpace, type CaptureSpace } from './overlay-geometry'
import { SettingsStore } from './settings'
import { streamAnswer, type Screenshot } from './voice/brain'

/** Every model sees the same blank display, with the pointer in the middle. */
export const EVAL_DISPLAY = { width: 1440, height: 900 }
const SPACE: CaptureSpace = { frame: { x: 0, y: 0, ...EVAL_DISPLAY }, pixelWidth: EVAL_DISPLAY.width, pixelHeight: EVAL_DISPLAY.height }
const POINTER = { x: EVAL_DISPLAY.width / 2, y: EVAL_DISPLAY.height / 2 }
const OUTPUT = '/tmp/nimbo-3d-eval'
/** Requests and hidden renders at once, and the bound on each. Every step is
 *  bounded, so the overall cap only ever stops a run that is stuck. */
export const EVAL_LIMITS = { requests: 2, renders: 4, requestMs: 90_000, preflightMs: 30_000, renderMs: 60_000, setupMs: 120_000, maxRunMs: 90 * 60_000 }
/** Beat budgets as talk.ts declares them, sped up for rendering. */
const WORDS_PER_SECOND = 2.6
const RENDER_PACE = 0.6

export interface EvalModel { spec: string; slug: string; provider: ProviderId; model: string; effort?: 'low' | 'medium' }
export interface EvalUsage { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number; totalTokens?: number }
export interface ParseStats {
  /** Lines starting with "@", and those the parser dropped (verbatim, shortened). */
  commandLines: number; dropped: string[]
  sentences: number; models: number; parts: number; copies: number; tags: number; moves: number; cuts: number; other: number
}
export interface RenderRecord { captures: string[]; warnings: string[]; errors: string[]; crashed: boolean; timedOut: boolean; ms: number }
export interface AnswerRecord {
  model: string; subject: string; subjectSlug: string
  status: 'ok' | 'error' | 'timeout' | 'skipped'
  error?: string
  /** Milliseconds from the request, to the first text and to the first accepted @model and @part lines. */
  timings: { firstTokenMs?: number; firstModelMs?: number; firstPartMs?: number; totalMs?: number }
  usage?: EvalUsage
  parse: ParseStats
  answerFile?: string
  render?: RenderRecord
}
export interface EvalResult { record: AnswerRecord; text: string; beats: Beat[]; modelSlug: string }
export interface EvalRun {
  label: string; mode: 'live' | 'replay'; source?: string; state: 'running' | 'complete' | 'stopped'
  startedAt: string; finishedAt?: string
  display: typeof EVAL_DISPLAY; limits: typeof EVAL_LIMITS
  models: Array<{ spec: string; slug: string; provider: ProviderId; model: string; effort: string; vision?: boolean; preflight: string }>
  subjects: string[]
  records: AnswerRecord[]
  errors: string[]
}

/** "provider:model[:low|medium]", comma-separated. A model id may contain
 *  colons (an Ollama tag), so only a final low or medium is read as effort. */
export function parseEvalModels(text: string | undefined): { models: EvalModel[]; errors: string[] } {
  const models: EvalModel[] = [], errors: string[] = []
  for (const spec of (text ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [provider = '', ...rest] = spec.split(':')
    const effort = rest.length > 1 && ['low', 'medium'].includes(rest.at(-1)!) ? rest.pop() as 'low' | 'medium' : undefined
    const model = rest.join(':')
    if (!(PROVIDERS as readonly string[]).includes(provider)) errors.push(`Unknown provider in "${spec}"; use one of ${PROVIDERS.join(', ')}.`)
    else if (!model || model.length > 200) errors.push(`Missing model in "${spec}"; write provider:model[:low|medium].`)
    else if (!models.some((known) => known.spec === spec)) {
      let slug = slugify(spec.replace(/[:/]/g, '-'), 80)
      while (models.some((known) => known.slug === slug)) slug += '-x'
      models.push({ spec, slug, provider: provider as ProviderId, model, ...(effort && { effort }) })
    }
  }
  if (!models.length && !errors.length) errors.push('Set NIMBO_DEBUG_3D_EVAL_MODELS, for example anthropic:claude-sonnet-5-5,openai:gpt-6.1-terra:medium.')
  return { models, errors }
}

/** One request per line; blank lines and # comments are skipped. */
export function parseSubjects(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
}

export function slugify(text: string, max = 40): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^\w.\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'item'
}

/** "01-lighthouse-and-explain-how-it-works": numbered, without the request's lead-in words. */
export function subjectSlug(subject: string, index: number): string {
  const words = subject.split(/\s+/).filter((word) => !/^(show|me|a|an|the|3d|model|of|please|can|you|build|make|draw)$/i.test(word))
  return `${String(index + 1).padStart(2, '0')}-${slugify(words.join(' '), 36)}`
}

/** Every request and render is bounded, so this cap never cuts a run that is
 *  merely slow. A replay makes no requests and only draws. */
export function evalCapMs(answers: number, models: number, replay = false): number {
  const asking = replay ? 0 : models * EVAL_LIMITS.preflightMs + Math.ceil(answers / EVAL_LIMITS.requests) * EVAL_LIMITS.requestMs
  return Math.min(EVAL_LIMITS.maxRunMs, EVAL_LIMITS.setupMs + asking + Math.ceil(answers / EVAL_LIMITS.renders) * EVAL_LIMITS.renderMs)
}

function usageOf(usage: LanguageModelUsage): EvalUsage {
  const values: EvalUsage = {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens, totalTokens: usage.totalTokens,
  }
  return Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'number')) as EvalUsage
}

export function parseStats(beats: readonly Beat[], dropped: string[]): ParseStats {
  const marks = beats.flatMap((beat) => beat.marks)
  const count = (kind: Mark['kind']): number => marks.filter((mark) => mark.kind === kind).length
  return {
    commandLines: marks.length + dropped.length, dropped,
    sentences: beats.filter((beat) => beat.sentence !== undefined).length,
    models: count('model'), parts: count('part'), copies: marks.reduce((sum, mark) => sum + (mark.kind === 'part' ? mark.copies : 0), 0),
    tags: count('tag'), moves: count('move'), cuts: count('cut'),
    other: marks.filter((mark) => !['model', 'part', 'tag', 'move', 'cut'].includes(mark.kind)).length,
  }
}

/** Parses a saved answer exactly as the turn pipeline would have streamed it. */
export function answerBeats(text: string, onCommand?: (mark: Mark) => void): { beats: Beat[]; dropped: string[] } {
  const dropped: string[] = []
  const parser = new BeatParser({ width: SPACE.pixelWidth, height: SPACE.pixelHeight }, onCommand, (line) => dropped.push(line.slice(0, 200)))
  return { beats: [...parser.push(text), ...parser.flush()], dropped }
}

/** One request through the real answer path: talk.ts's streamAnswer, INSTRUCTIONS and parser. */
export async function evaluateAnswer(input: {
  connection: AnswerConnection; question: string; screenshot: Screenshot; timeoutMs: number
  stream?: typeof streamAnswer; now?: () => number
}): Promise<{ text: string; beats: Beat[]; status: AnswerRecord['status']; error?: string; timings: AnswerRecord['timings']; usage?: EvalUsage; parse: ParseStats }> {
  const now = input.now ?? (() => performance.now()), start = now(), elapsed = (): number => Math.round(now() - start)
  const timings: AnswerRecord['timings'] = {}, dropped: string[] = [], beats: Beat[] = []
  let text = '', usage: EvalUsage | undefined, status: AnswerRecord['status'] = 'ok', error: string | undefined
  const parser = new BeatParser({ width: SPACE.pixelWidth, height: SPACE.pixelHeight }, (mark) => {
    if (mark.kind === 'model') timings.firstModelMs ??= elapsed()
    if (mark.kind === 'part') timings.firstPartMs ??= elapsed()
  }, (line) => dropped.push(line.slice(0, 200)))
  const controller = new AbortController()
  const iterator = (input.stream ?? streamAnswer)({
    connection: input.connection, question: input.question, screenshot: input.screenshot, history: [], signal: controller.signal,
    onUsage: (value) => { usage = usageOf(value) },
  })[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), input.timeoutMs) })
  try {
    for (;;) {
      const pending = iterator.next()
      const next = await Promise.race([pending, expired])
      if (next === 'timeout') {
        // The provider sees the abort; a late rejection from the abandoned read is expected.
        pending.catch(() => {}); controller.abort(); void iterator.return?.(undefined)?.catch(() => {})
        status = 'timeout'; error = `No complete answer within ${Math.round(input.timeoutMs / 1000)} s.`
        break
      }
      if (next.done) break
      if (next.value && timings.firstTokenMs === undefined) timings.firstTokenMs = elapsed()
      text += next.value
      beats.push(...parser.push(next.value))
    }
  } catch (cause) {
    status = 'error'; error = cause instanceof Error ? cause.message : 'The request failed.'
  } finally { clearTimeout(timer) }
  beats.push(...parser.flush())
  timings.totalMs = elapsed()
  return { text, beats, status, ...(error && { error }), timings, ...(usage && { usage }), parse: parseStats(beats, dropped) }
}

/** The answer phase: each model's credentials and catalog are checked once,
 *  then requests run at most two at a time, interleaved across models. A
 *  failed or timed-out request is recorded and the run moves on. */
export async function answerPhase(input: {
  run: EvalRun; models: EvalModel[]; connectionFor: (model: EvalModel) => AnswerConnection; screenshot: Screenshot
  stream?: typeof streamAnswer; now?: () => number; timeoutMs?: number; startBefore?: number
  onResult: (result: EvalResult) => void
}): Promise<EvalResult[]> {
  const { run } = input
  const ready = new Map<string, string>()
  for (const model of input.models) {
    let preflight = 'ok'
    try {
      await Promise.race([input.connectionFor(model).credential(), sleep(EVAL_LIMITS.preflightMs).then(() => { throw new Error('The credential check timed out.') })])
    } catch (error) { preflight = error instanceof Error ? error.message : 'The credential check failed.' }
    ready.set(model.spec, preflight)
    // Vision comes from the provider's catalog, which the check just loaded.
    const { vision, effort } = input.connectionFor(model)
    run.models.push({ spec: model.spec, slug: model.slug, provider: model.provider, model: model.model, effort: effort ?? 'provider default', vision, preflight })
  }
  const tasks = run.subjects.flatMap((subject, index) => input.models.map((model) => ({ subject, slug: subjectSlug(subject, index), model })))
  const results: EvalResult[] = []
  const lane = async (): Promise<void> => {
    for (let task = tasks.shift(); task; task = tasks.shift()) {
      const base = { model: task.model.spec, subject: task.subject, subjectSlug: task.slug }
      const preflight = ready.get(task.model.spec)!
      let result: EvalResult
      if (preflight !== 'ok') result = { record: { ...base, status: 'error', error: `Credential check: ${preflight}`, timings: {}, parse: parseStats([], []) }, text: '', beats: [], modelSlug: task.model.slug }
      else if (input.startBefore !== undefined && Date.now() > input.startBefore) result = { record: { ...base, status: 'skipped', error: 'Not started: the run reached its time cap.', timings: {}, parse: parseStats([], []) }, text: '', beats: [], modelSlug: task.model.slug }
      else {
        const answer = await evaluateAnswer({ connection: input.connectionFor(task.model), question: task.subject, screenshot: input.screenshot, timeoutMs: input.timeoutMs ?? EVAL_LIMITS.requestMs, stream: input.stream, now: input.now })
        result = { record: { ...base, status: answer.status, ...(answer.error && { error: answer.error }), timings: answer.timings, ...(answer.usage && { usage: answer.usage }), parse: answer.parse }, text: answer.text, beats: answer.beats, modelSlug: task.model.slug }
      }
      results.push(result); run.records.push(result.record)
      input.onResult(result)
    }
  }
  await Promise.all(Array.from({ length: EVAL_LIMITS.requests }, lane))
  return results
}

const seconds = (ms: number | undefined): string => ms === undefined ? '–' : (ms / 1000).toFixed(1)
const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

export function summaryMarkdown(run: EvalRun): string {
  const lines = [
    `# 3D eval ${run.label}`, '',
    `${run.mode === 'replay' ? `Replay of ${run.source}. ` : ''}${run.records.length} requests, ${run.state}. Blank ${run.display.width}×${run.display.height} display, no history. Times in seconds from the request.`, '',
    ...run.errors.map((error) => `- ${error}`), ...(run.errors.length ? [''] : []),
    '## By model', '',
    '| Model | Effort | Vision | Check | OK | Errors | Timeouts | First token | First @model | First @part | Total | Parts | Copies | Dropped lines | Tokens out | Render problems |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const model of run.models) {
    const records = run.records.filter((record) => record.model === model.spec), ok = records.filter((record) => record.status === 'ok')
    const pick = (value: (record: AnswerRecord) => number | undefined): number[] => ok.flatMap((record) => { const v = value(record); return v === undefined ? [] : [v] })
    const mean = (values: number[]): string => values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : '–'
    lines.push(`| ${model.spec} | ${model.effort} | ${model.vision ? 'yes' : 'no'} | ${model.preflight === 'ok' ? 'ok' : 'failed'} | ${ok.length} | ${records.filter((r) => r.status === 'error').length} | ${records.filter((r) => r.status === 'timeout').length} | ${seconds(median(pick((r) => r.timings.firstTokenMs)))} | ${seconds(median(pick((r) => r.timings.firstModelMs)))} | ${seconds(median(pick((r) => r.timings.firstPartMs)))} | ${seconds(median(pick((r) => r.timings.totalMs)))} | ${mean(pick((r) => r.parse.parts))} | ${mean(pick((r) => r.parse.copies))} | ${pick((r) => r.parse.dropped.length).reduce((a, b) => a + b, 0)} | ${pick((r) => r.usage?.outputTokens).reduce((a, b) => a + b, 0) || '–'} | ${records.filter((r) => r.render && (r.render.errors.length || r.render.crashed || r.render.timedOut)).length} |`)
  }
  lines.push('', 'Medians over completed requests; parts and copies are means; dropped lines and tokens are totals.', '', '## Requests', '',
    '| Model | Subject | Status | First token | First @model | First @part | Total | Models | Parts (copies) | Tags | Moves | Cuts | Dropped | Tokens in/out | Render | End view |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const record of run.records) {
    const render = record.render ? record.render.crashed ? 'crashed' : record.render.timedOut ? 'timed out' : record.render.errors.length ? `${record.render.errors.length} errors` : record.render.warnings.length ? `${record.render.warnings.length} warnings` : 'ok' : '–'
    const end = record.render?.captures.find((file) => file.includes('-3-end-a'))
    lines.push(`| ${record.model} | ${record.subjectSlug} | ${record.status}${record.error ? `: ${record.error.replace(/\|/g, '/')}` : ''} | ${seconds(record.timings.firstTokenMs)} | ${seconds(record.timings.firstModelMs)} | ${seconds(record.timings.firstPartMs)} | ${seconds(record.timings.totalMs)} | ${record.parse.models} | ${record.parse.parts} (${record.parse.copies}) | ${record.parse.tags} | ${record.parse.moves} | ${record.parse.cuts} | ${record.parse.dropped.length} | ${record.usage?.inputTokens ?? '–'}/${record.usage?.outputTokens ?? '–'} | ${render} | ${end ? `[png](${end})` : '–'} |`)
  }
  return `${lines.join('\n')}\n`
}

/** Writes inside the run's directory only, with every known credential redacted. */
export function evalWriter(directory: string, secrets: ReadonlySet<string>, write = (file: string, data: string | Buffer): void => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data) }) {
  const redact = (text: string): string => [...secrets].filter((secret) => secret.length >= 8).reduce((result, secret) => result.split(secret).join('[redacted]'), text)
  return {
    redact,
    file: (relative: string, data: string | Buffer): string => { write(join(directory, relative), typeof data === 'string' ? redact(data) : data); return relative },
    summary: (run: EvalRun): void => {
      write(join(directory, 'summary.json'), redact(JSON.stringify(run, null, 2)))
      write(join(directory, 'summary.md'), redact(summaryMarkdown(run)))
    },
  }
}

/** Any key that passes through the connection is redacted from every file and log line. */
export function trackCredential(connection: AnswerConnection, secrets: Set<string>): AnswerConnection {
  return { ...connection, credential: async () => { const key = await connection.credential(); if (key) secrets.add(key); return key } }
}

/** The saved settings, readable but never writable from this harness. */
export function readOnlySettings(store: Pick<SettingsStore, 'get'>): Pick<SettingsStore, 'get' | 'set'> {
  return { get: () => store.get(), set: () => { throw new Error('The 3D eval never writes settings.') } }
}

/** A neutral grey screen, encoded like a capture. */
function blankScreenshot(): Screenshot {
  const pixels = Buffer.alloc(EVAL_DISPLAY.width * EVAL_DISPLAY.height * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 0x8e; pixels[i + 1] = 0x88; pixels[i + 2] = 0x7b; pixels[i + 3] = 0xff }
  return { jpeg: nativeImage.createFromBitmap(pixels, EVAL_DISPLAY).toJPEG(85), ...EVAL_DISPLAY, cursor: POINTER }
}

function subjectsFile(): string {
  return devSetting('NIMBO_DEBUG_3D_EVAL_SUBJECTS') ?? join(app.getAppPath(), 'scripts', 'eval-3d-subjects.txt')
}

/** Call before `ready`. A live run keeps the normal profile, since it reads
 *  saved keys; a replay needs none and gets a throwaway one. */
export function configureModelEval(): void {
  if (!devFlag('NIMBO_DEBUG_3D_EVAL')) return
  launchInBackground()
  const replay = devSetting('NIMBO_DEBUG_3D_EVAL_REPLAY')
  if (replay) isolateDevProfile('model-eval')
  let cap = EVAL_LIMITS.maxRunMs
  try {
    if (replay) cap = evalCapMs((JSON.parse(readFileSync(join(replay, 'summary.json'), 'utf8')) as EvalRun).records.length, 0, true)
    else {
      const models = parseEvalModels(devSetting('NIMBO_DEBUG_3D_EVAL_MODELS')).models.length
      cap = evalCapMs(models * parseSubjects(readFileSync(subjectsFile(), 'utf8')).length, models)
    }
  } catch { /* A missing file is reported once the run starts. */ }
  setTimeout(() => { console.warn('[eval] stopped at the overall time cap'); app.exit(2) }, Math.max(0, cap - process.uptime() * 1000)).unref()
}

/** Asks each model for each request through the real answer path, then draws
 *  every answer, unchanged, in hidden overlay windows. Nothing is shown, no
 *  gesture, microphone or audio starts, and settings and history are never written. */
export async function runModelEval(): Promise<void> {
  // Hidden overlays stay offline; provider requests are made by this process.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('file:') }))
  const label = slugify(devSetting('NIMBO_DEBUG_3D_EVAL_LABEL') ?? new Date().toISOString().replace(/[:.]/g, '-'), 60)
  const directory = join(OUTPUT, label), replay = devSetting('NIMBO_DEBUG_3D_EVAL_REPLAY')
  const secrets = new Set<string>(), writer = evalWriter(directory, secrets)
  const run: EvalRun = { label, mode: replay ? 'replay' : 'live', ...(replay && { source: replay }), state: 'running', startedAt: new Date().toISOString(), display: EVAL_DISPLAY, limits: EVAL_LIMITS, models: [], subjects: [], records: [], errors: [] }
  const log = (line: string): void => console.info(writer.redact(`[eval] ${line}`))
  try {
    const results = replay ? replayResults(replay, run, writer) : await liveResults(run, writer, secrets, log)
    writer.summary(run)
    await renderPhase(results, writer, () => writer.summary(run), log)
    run.state = 'complete'
  } catch (error) {
    run.errors.push(error instanceof Error ? error.message : 'The run stopped.'); run.state = 'stopped'
  } finally {
    run.finishedAt = new Date().toISOString()
    writer.summary(run)
    log(`${run.state}: ${run.records.filter((record) => record.status === 'ok').length}/${run.records.length} answered; ${join(directory, 'summary.md')}`)
    app.quit()
  }
}

async function liveResults(run: EvalRun, writer: ReturnType<typeof evalWriter>, secrets: Set<string>, log: (line: string) => void): Promise<EvalResult[]> {
  const { models, errors } = parseEvalModels(devSetting('NIMBO_DEBUG_3D_EVAL_MODELS'))
  run.errors.push(...errors)
  run.subjects = parseSubjects(readFileSync(subjectsFile(), 'utf8'))
  if (!models.length || !run.subjects.length) throw new Error(run.subjects.length ? 'No models to evaluate.' : 'The subjects file has no requests.')
  const connections = new Connections(readOnlySettings(new SettingsStore(join(app.getPath('userData'), 'settings.json'))), () => {})
  await connections.load()
  const saved = Object.entries(connections.snapshot().providers).filter(([, present]) => present).map(([provider]) => provider)
  log(`profile ${app.getPath('userData')}; saved credentials for: ${saved.join(', ') || 'none'}`)
  const connectionFor = (model: EvalModel): AnswerConnection => trackCredential(connections.answerFor(model.provider, model.model, model.effort), secrets)
  const requests = models.length * run.subjects.length, cap = evalCapMs(requests, models.length)
  const startBefore = Date.now() + cap - Math.ceil(requests / EVAL_LIMITS.renders) * EVAL_LIMITS.renderMs - EVAL_LIMITS.setupMs - process.uptime() * 1000
  log(`${requests} requests: ${models.map((model) => model.spec).join(', ')} × ${run.subjects.length} subjects`)
  return answerPhase({
    run, models, connectionFor, screenshot: blankScreenshot(), startBefore,
    onResult: (result) => {
      if (result.text) result.record.answerFile = writer.file(`${result.modelSlug}/${result.record.subjectSlug}-answer.txt`, result.text)
      writer.summary(run)
      const { record } = result
      log(`${record.model} ${record.subjectSlug}: ${record.status}${record.error ? ` (${record.error})` : ''}, first token ${seconds(record.timings.firstTokenMs)} s, first part ${seconds(record.timings.firstPartMs)} s, ${record.parse.parts} parts`)
    },
  })
}

/** Re-reads a previous run's saved answers; no credential or network is used.
 *  Timings and usage describe the original requests; parsing is redone, so a
 *  parser change shows up in the drop counts. */
export function replayResults(source: string, run: EvalRun, writer: ReturnType<typeof evalWriter>): EvalResult[] {
  const previous = JSON.parse(readFileSync(join(source, 'summary.json'), 'utf8')) as EvalRun
  run.models = previous.models; run.subjects = previous.subjects
  return previous.records.map((saved) => {
    const modelSlug = previous.models.find((model) => model.spec === saved.model)?.slug ?? slugify(saved.model)
    const text = saved.answerFile ? readFileSync(join(source, saved.answerFile), 'utf8') : ''
    const { beats, dropped } = answerBeats(text)
    const record: AnswerRecord = { ...saved, parse: parseStats(beats, dropped), render: undefined }
    if (text) record.answerFile = writer.file(`${modelSlug}/${saved.subjectSlug}-answer.txt`, text)
    run.records.push(record)
    return { record, text, beats, modelSlug }
  })
}

async function renderPhase(results: EvalResult[], writer: ReturnType<typeof evalWriter>, changed: () => void, log: (line: string) => void): Promise<void> {
  const queue = results.filter((result) => result.beats.some((beat) => beat.marks.length))
  const lane = async (): Promise<void> => {
    for (let result = queue.shift(); result; result = queue.shift()) {
      result.record.render = await renderAnswer(result, writer)
      changed()
      const { render } = result.record
      log(`drew ${result.record.model} ${result.record.subjectSlug}: ${render.captures.length} views, ${render.errors.length} errors, ${render.warnings.length} warnings`)
    }
  }
  await Promise.all(Array.from({ length: EVAL_LIMITS.renders }, lane))
}

/** The cards an answer opened, in overlay space, padded for capture. */
function captureRect(beats: readonly Beat[]): { x: number; y: number; width: number; height: number } | undefined {
  const cards = beats.flatMap((beat) => beat.marks).filter((mark): mark is Extract<Mark, { kind: 'model' }> => mark.kind === 'model')
  if (!cards.length) return
  const left = Math.max(0, Math.min(...cards.map((card) => card.x)) - 12), top = Math.max(0, Math.min(...cards.map((card) => card.y)) - 12)
  const right = Math.min(EVAL_DISPLAY.width, Math.max(...cards.map((card) => card.x + card.w)) + 12), bottom = Math.min(EVAL_DISPLAY.height, Math.max(...cards.map((card) => card.y + card.h)) + 12)
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) }
}

/** Draws an answer's beats unchanged, paced like speech, in a hidden window:
 *  views after the first part, at mid-build and at the end from two angles. */
async function renderAnswer(result: EvalResult, writer: ReturnType<typeof evalWriter>): Promise<RenderRecord> {
  const started = performance.now(), render: RenderRecord = { captures: [], warnings: [], errors: [], crashed: false, timedOut: false, ms: 0 }
  const beats = result.beats.map((beat) => ({ ...beat, marks: toOverlaySpace(beat.marks, SPACE, SPACE.frame) }))
  const natural = beats.map((beat) => beat.sentence === undefined ? 800 : Math.max(800, beat.sentence.split(/\s+/).length / WORDS_PER_SECOND * 1000))
  // A long answer is drawn faster, so every render fits its bound.
  const pace = Math.min(RENDER_PACE, (EVAL_LIMITS.renderMs - 12_000) / Math.max(1, natural.reduce((a, b) => a + b, 0)))
  const parts = beats.map((beat) => beat.marks.filter((mark) => mark.kind === 'part').length)
  const total = parts.reduce((a, b) => a + b, 0)
  const firstPart = parts.findIndex((count) => count > 0)
  let running = 0
  const mid = total ? parts.findIndex((count) => (running += count) >= Math.ceil(total / 2)) : -1
  const rect = captureRect(beats), card = beats.flatMap((beat) => beat.marks).find((mark): mark is Extract<Mark, { kind: 'model' }> => mark.kind === 'model')
  const name = `${result.modelSlug}/${result.record.subjectSlug}`
  const window = await hiddenOverlay(new Map(), name, EVAL_DISPLAY)
  const contents = window.webContents
  contents.on('console-message', ({ level, message }) => {
    if (level === 'error' && render.errors.length < 20) render.errors.push(message.slice(0, 300))
    else if ((level === 'warning' || message.startsWith('[drawing]')) && render.warnings.length < 20) render.warnings.push(message.slice(0, 300))
  })
  contents.on('render-process-gone', (_event, details) => { render.crashed = true; render.errors.push(`The overlay renderer stopped: ${details.reason}.`) })
  const capture = async (suffix: string): Promise<void> => {
    if (render.crashed) return
    const image = await contents.capturePage(rect ?? { x: 0, y: 0, ...EVAL_DISPLAY })
    render.captures.push(writer.file(`${name}-${suffix}.png`, image.toPNG()))
  }
  const draw = async (): Promise<void> => {
    const prepare = (index: number): void => {
      const marks = beats[index]?.marks.filter((mark) => mark.kind === 'model' || mark.kind === 'part') ?? []
      if (marks.length) sendOverlay(contents, { kind: 'prepare', marks, epoch: 1 })
    }
    // The real overlay loads long before an answer: let its warm stage finish first.
    await sleep(1200)
    prepare(0)
    for (const [index, beat] of beats.entries()) {
      prepare(index + 1)
      const durationMs = Math.round(natural[index]! * pace)
      sendOverlay(contents, { kind: 'beat', marks: beat.marks, durationMs, from: POINTER, epoch: 1 })
      await sleep(durationMs)
      if (index === firstPart) await capture('1-first')
      if (index === mid && mid !== firstPart) await capture('2-mid')
    }
    await sleep(1400)
    await capture('3-end-a')
    if (card) {
      await drag(contents, [card.x + card.w / 2, Math.min(card.y + card.h - 20, card.y + card.h / 2 + 40)], [-110, 36])
      await sleep(450)
      await capture('4-end-b')
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([draw().then(() => 'done' as const), new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), EVAL_LIMITS.renderMs) })])
    render.timedOut = outcome === 'timeout'
  } catch (error) {
    render.errors.push(error instanceof Error ? error.message.slice(0, 300) : 'The render failed.')
  } finally {
    clearTimeout(timer)
    if (!window.isDestroyed()) window.destroy()
    render.ms = Math.round(performance.now() - started)
  }
  return render
}
