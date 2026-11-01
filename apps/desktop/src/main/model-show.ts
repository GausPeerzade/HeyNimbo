import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, screen, session, type Display } from 'electron'
import type { LanguageModelUsage } from 'ai'
import { BeatParser, parseMark, type Beat, type ImageSize, type Mark } from '../shared/beats'
import type { OverlayCommand } from '../shared/ipc'
import type { AnswerConnection } from './answer-provider'
import { devFlag, devSetting } from './dev'
import { isolateDevProfile, launchInBackground } from './dev-profile'
import {
  askModel, blankScreenshot, EVAL_DISPLAY, EVAL_LIMITS, EVAL_OUTPUT, evalWriter, parseEvalModels, parseSubjects, preflightModels, savedConnections, seconds, slugify, subjectSlug, subjectsFile, WORDS_PER_SECOND,
  type AnswerRecord, type EvalModel, type EvalResult, type EvalRun,
} from './model-eval'
import { hiddenOverlay, sendOverlay, sleep } from './model-gallery'
import type { Rect } from './overlay-geometry'
import { createOverlayWindow } from './windows'
import type { Screenshot, streamAnswer } from './voice/brain'
import type { designModel } from './agent/designer'
import type { ModelCommand } from '../shared/model-protocol'

/** Per subject at speed 1: about 32 s of building, a 6 s hold and a short gap
 *  while each overlay warms its next 3D stage. */
export const SHOW_LIMITS = { subjectMs: 40_000, holdMs: 6_000, gapMs: 2_500, minBuildMs: 4_000, startupMs: 30_000, columns: 4 }
const HEADING_BEAT_MS = 2_500
/** A live beat is drawn as its sentence arrives, as talk.ts draws a text-only answer. */
const LIVE_BEAT_MS = 800
const MARGIN = 24
const GUTTER = 20
const PILL = 28

export interface ShowColumn { card: Rect; note: { x: number; y: number } }
export interface ShowLayout { heading: { x: number; y: number }; status?: { x: number; y: number }; columns: ShowColumn[] }
export interface LaneBeat { atMs: number; durationMs: number; marks: Mark[] }
export interface ShowLane { name: string; note: string; beats: LaneBeat[]; endMs: number; prepared: Mark[] }
export interface SubjectPlan { lanes: ShowLane[]; heading: string; factor: number; buildMs: number; holdMs: number }

/** "gpt-6.1-terra" → "GPT-6.1 Terra", "claude-sonnet-5-5" → "Claude Sonnet 5.5". */
export function displayName(model: string): string {
  const words = (model.split('/').pop() ?? model).replace(/:.*$/, '').split('-').filter(Boolean)
  if (words.length > 1 && /^\d{8}$/.test(words.at(-1)!)) words.pop()
  const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)
  if (words[0]?.toLowerCase() === 'gpt') return [`GPT-${words[1] ?? ''}`, ...words.slice(2).map(capital)].join(' ')
  // A trailing run of plain numbers is one version number.
  let end = words.length
  while (end > 1 && /^\d+$/.test(words[end - 1]!)) end--
  return [...words.slice(0, end).map(capital), words.slice(end).join('.')].filter(Boolean).join(' ') || model
}

/** One card per model in equal columns across the display's work area, a
 *  heading pill above them and a small-print pill under each. Coordinates are
 *  relative to the display, as an overlay window covering it uses. */
export function showLayout(display: Pick<Display, 'bounds' | 'workArea'>, count: number, rows: 1 | 2 = 1): ShowLayout {
  const work = { x: display.workArea.x - display.bounds.x, y: display.workArea.y - display.bounds.y, width: display.workArea.width, height: display.workArea.height }
  const columns = Math.max(1, count)
  const width = Math.floor((work.width - 2 * MARGIN - (columns - 1) * GUTTER) / columns)
  // A pill sits 12 px above the point it labels.
  const headingTop = work.y + 12, top = headingTop + rows * PILL + (rows - 1) * 8 + 18
  const available = work.y + work.height - 16 - (8 + PILL) - top
  const height = Math.max(260, Math.min(available, Math.round(width * 1.3)))
  const cardTop = top + Math.max(0, Math.floor((available - height) / 2))
  return {
    heading: { x: work.x + work.width / 2, y: headingTop + PILL + 12 },
    ...(rows === 2 && { status: { x: work.x + work.width / 2, y: headingTop + 2 * PILL + 8 + 12 } }),
    columns: Array.from({ length: columns }, (_, i) => {
      const card = { x: work.x + MARGIN + i * (width + GUTTER), y: cardTop, width, height }
      return { card, note: { x: card.x + width / 2, y: card.y + height + 8 + PILL + 12 } }
    }),
  }
}

/** The answer with only its first 3D model kept: that @model line gets the
 *  column's rect and title, the model's @part, @move, @cut and @tag lines stay
 *  byte for byte, every sentence stays, and every other command line (2D
 *  cards, steps, notes, pointers, a second model) is left out. */
export function showScript(text: string, card: Rect, title: string, image: ImageSize): { script: string; modelId: string } | undefined {
  let modelId: string | undefined
  const lines = text.split('\n').flatMap((line) => {
    const command = /^\s*@(\w+)(?:\s+(\S+))?/.exec(line)
    if (!command) return [line]
    if (!modelId && command[1] === 'model') {
      const mark = parseMark(line.trim(), image)
      if (mark?.kind !== 'model') return []
      modelId = mark.id
      return [`@model ${mark.id} ${[card.x, card.y, card.width, card.height].map(Math.round).join(' ')} "${title.replace(/"/g, "'")}"${mark.turntable ? ' turntable=true' : ''}`]
    }
    return modelId && ['part', 'move', 'cut', 'tag'].includes(command[1]!) && command[2] === modelId ? [line] : []
  })
  return modelId ? { script: lines.join('\n'), modelId } : undefined
}

/** For each sentence of the original answer, how far into the text it ended,
 *  and where the first accepted @part line ended. */
function streamOffsets(text: string): { sentences: number[]; firstPart?: number } {
  const sentences: number[] = []
  let firstPart: number | undefined, offset = 0
  const parser = new BeatParser(EVAL_DISPLAY, (mark) => { if (mark.kind === 'part') firstPart ??= offset })
  for (const char of text) {
    offset += char.length
    for (const beat of parser.push(char)) if (beat.sentence !== undefined) sentences.push(offset)
  }
  for (const beat of parser.flush()) if (beat.sentence !== undefined) sentences.push(text.length)
  return { sentences, ...(firstPart !== undefined && { firstPart }) }
}

/** Times from the request for one answer's 3D beats. Its first part appears at
 *  the measured first-part time; each later beat lasts as long as its sentence
 *  would be spoken and never starts before its text could have streamed in,
 *  taking the stream as steady between the first @part line and the end. */
export function laneTimeline(text: string, script: string, record: Pick<AnswerRecord, 'timings'>, image: ImageSize): { beats: LaneBeat[]; endMs: number } {
  const parser = new BeatParser(image)
  const beats: Beat[] = [...parser.push(script), ...parser.flush()]
  let first = beats.findIndex((beat) => beat.marks.some((mark) => mark.kind === 'part'))
  if (first < 0) first = beats.findIndex((beat) => beat.marks.length)
  if (first < 0) return { beats: [], endMs: 0 }
  const { timings } = record, stream = streamOffsets(text)
  const startMs = beats[first]!.marks.some((mark) => mark.kind === 'part') ? timings.firstPartMs ?? timings.firstModelMs ?? 0 : timings.firstModelMs ?? timings.firstPartMs ?? 0
  const from = stream.firstPart ?? 0, total = Math.max(startMs, timings.totalMs ?? startMs)
  const arrival = (offset: number): number => offset <= from || text.length <= from ? startMs : startMs + (total - startMs) * (offset - from) / (text.length - from)
  // A model card opened before the first part opens with it.
  const opening = beats.slice(0, first).flatMap((beat) => beat.marks)
  const lane: LaneBeat[] = []
  let sentence = beats.slice(0, first).filter((beat) => beat.sentence !== undefined).length, previousEnd = startMs, endMs = startMs
  for (const [index, beat] of beats.entries()) {
    if (index < first) continue
    const at = index === first ? startMs : Math.max(previousEnd, beat.sentence === undefined ? total : arrival(stream.sentences[sentence] ?? text.length))
    const durationMs = beat.sentence === undefined ? 800 : Math.max(800, Math.round(beat.sentence.split(/\s+/).length / WORDS_PER_SECOND * 1000))
    const marks = index === first ? [...opening, ...beat.marks] : beat.marks
    if (marks.length) { lane.push({ atMs: Math.round(at), durationMs, marks }); endMs = at + durationMs }
    previousEnd = at + durationMs
    if (beat.sentence !== undefined) sentence++
  }
  return { beats: lane, endMs: Math.round(endMs) }
}

/** The small print under a card: what was measured for this answer. */
export function laneNote(record: AnswerRecord | undefined, drawn: boolean): string {
  if (!record) return 'not in this run'
  if (record.status === 'timeout') return 'no answer: timed out'
  if (record.status === 'error') return 'no answer: request failed'
  if (record.status === 'skipped') return 'not run'
  if (!drawn) return 'answered without a 3D model'
  const first = record.timings.firstPartMs
  return `first part ${first === undefined ? '–' : `${(first / 1000).toFixed(1)} s`} · ${record.parse.parts} part${record.parse.parts === 1 ? '' : 's'}`
}

/** Pick subjects by number ("3"), slug ("03-saturn-with-its-rings") or a slug
 *  fragment that names one subject ("saturn"). */
export function selectSubjects(subjects: readonly string[], only: string | undefined): number[] {
  const all = subjects.map((_, index) => index)
  const wanted = only?.trim().toLowerCase()
  if (!wanted) return all
  if (/^\d+$/.test(wanted)) return all.filter((index) => index + 1 === Number(wanted))
  const slugs = subjects.map((subject, index) => subjectSlug(subject, index))
  const exact = all.filter((index) => slugs[index] === wanted || slugs[index]!.slice(3) === wanted)
  return exact.length ? exact : all.filter((index) => slugs[index]!.includes(slugify(wanted, 60)))
}

export function showSpeed(text: string | undefined): number {
  const speed = Number(text ?? 1)
  return Number.isFinite(speed) && speed > 0 ? Math.min(8, Math.max(0.25, speed)) : 1
}

/** A subject's time on screen: the gap, its build (compressed to fit when a
 *  slow answer would overrun) and the hold. */
export function subjectWindowMs(speed: number): number {
  return SHOW_LIMITS.gapMs + buildBudgetMs(speed) + SHOW_LIMITS.holdMs / speed
}
function buildBudgetMs(speed: number): number {
  return Math.max(SHOW_LIMITS.minBuildMs, (SHOW_LIMITS.subjectMs - SHOW_LIMITS.holdMs) / speed - SHOW_LIMITS.gapMs)
}

/** Scales every lane by the chosen speed, and all lanes together further if
 *  the slowest would overrun the subject's window, so their order and their
 *  relative timing are kept. */
export function planSubject(request: string, lanes: ShowLane[], speed: number): SubjectPlan {
  const natural = Math.max(0, ...lanes.map((lane) => lane.endMs)) / speed
  const factor = natural > buildBudgetMs(speed) ? buildBudgetMs(speed) / natural : 1
  const scale = factor / speed
  return {
    heading: factor < 1 ? `${request} · shown ${(1 / factor).toFixed(1)}× faster` : request,
    factor, buildMs: Math.round(natural * factor), holdMs: Math.round(SHOW_LIMITS.holdMs / speed),
    lanes: lanes.map((lane) => ({
      ...lane, endMs: Math.round(lane.endMs * scale),
      beats: lane.beats.map((beat) => ({ ...beat, atMs: Math.round(beat.atMs * scale), durationMs: Math.max(400, Math.round(beat.durationMs * scale)) })),
    })),
  }
}

/** Card titles for the columns; one model at two efforts is told apart by its effort. */
export function columnNames(models: ReadonlyArray<{ model: string; effort?: string }>): string[] {
  const names = models.map((model) => displayName(model.model))
  return names.map((name, index) => names.filter((other) => other === name).length > 1 ? `${name} (${models[index]!.effort ?? 'default'})` : name)
}

/** Builds each model's lane for one subject from the saved run. */
export function subjectLanes(run: EvalRun, source: string, subject: string, layout: ShowLayout, image: ImageSize, read = (file: string): string => readFileSync(file, 'utf8')): ShowLane[] {
  const models = run.models.slice(0, layout.columns.length)
  const names = columnNames(models)
  return models.map((model, index) => {
    const name = names[index]!
    const record = run.records.find((candidate) => candidate.model === model.spec && candidate.subject === subject)
    let text = ''
    if (record?.status === 'ok' && record.answerFile) try { text = read(join(source, record.answerFile)) } catch { /* Shown as not drawn. */ }
    const shown = text ? showScript(text, layout.columns[index]!.card, name, image) : undefined
    const timeline = shown && record ? laneTimeline(text, shown.script, record, image) : { beats: [], endMs: 0 }
    // A designer-built model is saved as commands, not answer text: it joins the column's own model card.
    let designed: Mark[] = []
    if (shown && record?.designFile) try { designed = (JSON.parse(read(join(source, record.designFile))) as Mark[]).filter(mark => 'id' in mark && mark.kind !== 'model' && mark.id === shown.modelId) } catch { /* Shown without the design. */ }
    if (designed.length) {
      const atMs = Math.max(record!.timings.firstPartMs ?? 0, timeline.beats[0]?.atMs ?? 0), durationMs = Math.max(800, (record!.timings.totalMs ?? atMs) - atMs)
      timeline.beats.push({ atMs, durationMs, marks: designed }); timeline.endMs = Math.max(timeline.endMs, atMs + durationMs)
    }
    const prepared = timeline.beats.flatMap((beat) => beat.marks).filter((mark) => mark.kind === 'model' || mark.kind === 'part')
    return { name, note: laneNote(record, timeline.beats.length > 0), ...timeline, prepared }
  })
}

/** Which 3D marks of a streamed answer a column shows: its first model, with
 *  the column's rect and title, and that model's parts, motions, cuts and tags
 *  unchanged. 2D cards, steps, notes and pointers are left out. */
export function columnFilter(card: Rect, title: string): (mark: Mark) => Mark | undefined {
  let modelId: string | undefined
  return (mark) => {
    if (mark.kind === 'model') {
      if (modelId) return undefined
      modelId = mark.id
      return { ...mark, x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.width), h: Math.round(card.height), title }
    }
    return (mark.kind === 'part' || mark.kind === 'move' || mark.kind === 'cut' || mark.kind === 'tag' || mark.kind === 'remove') && mark.id === modelId ? mark : undefined
  }
}

export interface LiveShow {
  run: EvalRun; models: EvalModel[]; subjects: number[]; layout: ShowLayout
  ready: Map<string, string>; connectionFor: (model: EvalModel) => AnswerConnection; screenshot: Screenshot
  /** Layers 0…n-1 are the model columns; layer n holds the pills. */
  send: (layer: number, command: OverlayCommand) => void
  sleep: (ms: number) => Promise<void>; now: () => number
  stream?: typeof streamAnswer; timeoutMs?: number; startBefore?: number
  /** The 3D designer; a recorded one in mock shows, so they stay offline. */
  design?: typeof designModel
  onResult: (result: EvalResult) => void
  capture?: (file: string) => Promise<void>
  log?: (line: string) => void
}

/** Asks each model in turn, drawing its answer in its column as the lines
 *  arrive; the next model starts only once the last has finished drawing.
 *  Each subject's finished models hold for a few seconds, then clear. */
export async function runLiveShow(show: LiveShow): Promise<void> {
  const names = columnNames(show.models.map((model) => ({ model: model.model, effort: model.effort })))
  const pills = show.models.length
  const status = (subject: string, line: string): void => {
    show.send(pills, { kind: 'clear' })
    const marks: Mark[] = [{ kind: 'point', ...show.layout.heading, label: subject }, ...(show.layout.status ? [{ kind: 'point' as const, ...show.layout.status, label: line }] : [])]
    show.send(pills, { kind: 'beat', marks, durationMs: 300, from: show.layout.status ?? show.layout.heading, epoch: 1 })
  }
  for (const [position, index] of show.subjects.entries()) {
    const subject = show.run.subjects[index]!, slug = subjectSlug(subject, index), progress = `${position + 1}/${show.subjects.length}`
    for (const [slot, model] of show.models.entries()) {
      const name = names[slot]!, column = show.layout.columns[slot]!, shown = columnFilter(column.card, name)
      const shownMarks = new Map<Mark, Mark | undefined>()
      const show3d = (mark: Mark): Mark | undefined => { if (!shownMarks.has(mark)) shownMarks.set(mark, shown(mark)); return shownMarks.get(mark) }
      let drawnUntil = show.now(), drew = false, opened = false
      const waiting: Mark[] = []
      status(subject, `${name} · ${progress} · first part …`)
      const result = await askModel({
        run: show.run, model, subject, index, ready: show.ready, connectionFor: show.connectionFor, screenshot: show.screenshot,
        stream: show.stream, now: show.now, timeoutMs: show.timeoutMs, startBefore: show.startBefore, ...(show.design && { design: show.design }),
        onMark: (mark, elapsedMs) => {
          const kept = show3d(mark)
          if (kept && (kept.kind === 'model' || kept.kind === 'part')) show.send(slot, { kind: 'prepare', marks: [kept], epoch: 1 })
          if (mark.kind === 'part' && !drew && kept) status(subject, `${name} · ${progress} · first part ${seconds(elapsedMs)} s`)
          if (kept?.kind === 'part') drew = true
        },
        onBeat: (beat) => {
          const marks = beat.marks.flatMap((mark) => { const kept = show3d(mark); return kept ? [kept] : [] })
          if (!marks.length) return
          // Designed parts can arrive before their card's own beat, as in a real turn; they wait for it.
          if (!opened && !marks.some(mark => mark.kind === 'model')) { waiting.push(...marks); return }
          const ready = opened ? marks : [...marks, ...waiting.splice(0)]
          opened = true
          show.send(slot, { kind: 'beat', marks: ready, durationMs: LIVE_BEAT_MS, from: column.note, epoch: 1 })
          // The overlay queues beats, so its drawing ends no later than this.
          drawnUntil = Math.max(show.now(), drawnUntil) + LIVE_BEAT_MS
        },
      })
      show.onResult(result)
      const { record } = result
      if (record.status !== 'ok' || !drew) status(subject, `${name} · ${progress} · ${laneNote(record, drew)}`)
      await show.sleep(Math.max(0, drawnUntil - show.now()) + 800)
      show.send(slot, { kind: 'beat', marks: [{ kind: 'point', ...column.note, label: laneNote(record, drew) }], durationMs: 400, from: column.note, epoch: 1 })
      show.log?.(`${model.spec} ${slug}: ${record.status}${record.error ? ` (${record.error})` : ''}, first part ${seconds(record.timings.firstPartMs)} s, ${record.parse.parts} parts`)
      await show.capture?.(`${slug}-${slot + 1}-${model.slug}.png`)
    }
    await show.sleep(SHOW_LIMITS.holdMs)
    await show.capture?.(`${slug}-end.png`)
    for (let layer = 0; layer <= pills; layer++) show.send(layer, { kind: 'clear' })
    await show.sleep(SHOW_LIMITS.gapMs)
  }
}

/** Plays a saved run's designed parts back in short batches with no request, for offline mock shows.
 *  The request is found by its question, as `recordedStream` finds the answer. */
export function recordedDesign(source: string, run: EvalRun, sleepFor = sleep): typeof designModel {
  return async function* (options) {
    const { provider, model, effort } = options.connection
    const spec = run.models.find((candidate) => candidate.provider === provider && candidate.model === model && (!effort || candidate.effort === effort))?.spec
    const record = run.records.find((candidate) => candidate.model === spec && candidate.subject === options.question)
    if (!record?.designFile) return
    const marks = (JSON.parse(readFileSync(join(source, record.designFile), 'utf8')) as Mark[]).filter(mark => 'id' in mark && mark.kind !== 'model' && mark.id === options.id) as ModelCommand[]
    for (let i = 0; i < marks.length; i += 8) {
      await sleepFor(150)
      if (options.signal.aborted) return
      yield marks.slice(i, i + 8)
    }
  }
}

/** Plays a saved run's answers back as if a provider were streaming them, at
 *  their recorded first-token and total times, for validating the live show
 *  without keys or network. Failed requests fail again. */
export function recordedStream(source: string, run: EvalRun, sleepFor = sleep): typeof streamAnswer {
  return async function* (options) {
    const { provider, model, effort } = options.connection!
    const spec = run.models.find((candidate) => candidate.provider === provider && candidate.model === model && (!effort || candidate.effort === effort))?.spec
    const record = run.records.find((candidate) => candidate.model === spec && candidate.subject === options.question)
    if (!record) throw new Error('The source run has no answer for this request.')
    const wait = async (ms: number): Promise<void> => { await sleepFor(ms); if (options.signal.aborted) throw new Error('The answer was interrupted.') }
    await wait(record.timings.firstTokenMs ?? 500)
    if (record.status !== 'ok' || !record.answerFile) throw new Error(`Recorded as ${record.status} in the source run.`)
    const text = readFileSync(join(source, record.answerFile), 'utf8'), size = 24
    const pace = Math.max(0, (record.timings.totalMs ?? 0) - (record.timings.firstTokenMs ?? 0)) / Math.max(1, text.length)
    for (let at = 0; at < text.length; at += size) {
      yield text.slice(at, at + size)
      await wait(pace * Math.min(size, text.length - at))
    }
    const usage = record.usage ?? {}
    options.onUsage?.({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: undefined }, outputTokenDetails: { textTokens: undefined, reasoningTokens: usage.reasoningTokens } } as LanguageModelUsage)
  }
}

function liveCapMs(subjects: number, models: number): number {
  const perRequest = EVAL_LIMITS.requestMs + 15_000
  return Math.min(EVAL_LIMITS.maxRunMs, SHOW_LIMITS.startupMs + models * EVAL_LIMITS.preflightMs + Math.max(1, subjects) * (Math.max(1, models) * perRequest + SHOW_LIMITS.holdMs + SHOW_LIMITS.gapMs))
}

function readRun(source: string): EvalRun {
  const run = JSON.parse(readFileSync(join(source, 'summary.json'), 'utf8')) as EvalRun
  if (!run.subjects?.length) run.subjects = [...new Set(run.records.map((record) => record.subject))]
  return run
}

/** Call before `ready`. A replay, or a live show fed by a recorded run, gets
 *  a throwaway profile; a real live show keeps the normal profile, read-only,
 *  for the saved keys. Neither ever takes focus, and each has a time cap. */
export function configureModelShow(): void {
  const source = devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW'), live = devFlag('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE')
  if (!source && !live) return
  launchInBackground()
  const mock = devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_MOCK')
  if (!live || mock) isolateDevProfile('model-show')
  let cap: number
  if (live) {
    let subjects = 15, models = parseEvalModels(devSetting('HEYNIMBO_DEBUG_3D_EVAL_MODELS')).models.length
    try {
      const list = mock ? readRun(mock).subjects : parseSubjects(readFileSync(subjectsFile(), 'utf8'))
      if (mock && !models) models = readRun(mock).models.length
      subjects = selectSubjects(list, devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_ONLY')).length
    } catch { /* Reported once the show starts. */ }
    cap = liveCapMs(subjects, Math.min(SHOW_LIMITS.columns, models))
  } else {
    let subjects = 15
    try { subjects = selectSubjects(readRun(source!).subjects, devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_ONLY')).length } catch { /* Reported once the show starts. */ }
    cap = SHOW_LIMITS.startupMs + Math.max(1, subjects) * subjectWindowMs(showSpeed(devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_SPEED')))
  }
  setTimeout(() => { console.warn('[show] stopped at the time cap'); app.exit(2) }, Math.max(0, cap - process.uptime() * 1000)).unref()
}

interface Surface { layers: BrowserWindow[]; capture?: (file: string) => Promise<void> }

/** Visible click-through panels on the cursor's display that never take
 *  focus, or, with a capture directory, hidden windows that are composited
 *  into one image per moment. One layer per model, so each builds on its own
 *  timeline, plus one for the pills. */
async function openSurface(display: Display, count: number, captureDirectory: string | undefined): Promise<Surface> {
  if (!captureDirectory) {
    const layers = Array.from({ length: count }, () => createOverlayWindow(display))
    await Promise.all(layers.map((layer) => new Promise<void>((resolve) => layer.webContents.once('did-finish-load', () => resolve()))))
    return { layers }
  }
  const size = { width: display.bounds.width, height: display.bounds.height }
  const layers = await Promise.all(Array.from({ length: count }, (_, i) => hiddenOverlay(new Map(), `layer-${i}`, size, '#00000000')))
  mkdirSync(captureDirectory, { recursive: true })
  return {
    layers,
    capture: async (file) => {
      const images = await Promise.all(layers.map((layer) => layer.webContents.capturePage()))
      writeFileSync(join(captureDirectory, file), composite(images, size))
    },
  }
}

/** Layers in order over a neutral desktop grey, as the panels would stack. */
function composite(images: Electron.NativeImage[], size: { width: number; height: number }): Buffer {
  let output: Buffer | undefined
  for (const image of images) {
    const pixels = image.toBitmap(), scale = Math.max(1, Math.round(Math.sqrt(pixels.length / 4 / (size.width * size.height))))
    if (!output) {
      output = Buffer.alloc(size.width * scale * size.height * scale * 4)
      for (let i = 0; i < output.length; i += 4) { output[i] = 0x8e; output[i + 1] = 0x88; output[i + 2] = 0x7b; output[i + 3] = 0xff }
    }
    if (pixels.length !== output.length) continue
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3]! / 255
      if (alpha === 0) continue
      // Captures are premultiplied, so colour adds over what is beneath.
      for (let c = 0; c < 3; c++) output[i + c] = Math.min(255, Math.round(pixels[i + c]! + output[i + c]! * (1 - alpha)))
    }
  }
  const scale = Math.round(Math.sqrt(output!.length / 4 / (size.width * size.height)))
  return nativeImage.createFromBitmap(output!, { width: size.width * scale, height: size.height * scale }).toPNG()
}

/** The showcase: a saved eval run replayed side by side, or, live, real
 *  requests drawn one model at a time. Overlay windows are offline; requests
 *  come from this process. It quits when done. */
export async function runModelShow(): Promise<void> {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('file:') }))
  let activated = 0
  app.on('did-become-active', () => { activated++; console.warn('[show] the app became active') })
  try {
    if (devFlag('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE')) await showLive()
    else await showReplay(devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW')!)
    console.info(`[show] done; the app became active ${activated} times`)
  } catch (error) {
    console.warn(`[show] ${error instanceof Error ? error.message : 'stopped'}`)
  } finally {
    app.quit()
  }
}

/** Per subject, each model's saved 3D answer builds in its own column at its
 *  measured pace, holds, then clears. No network, keys, settings or history. */
async function showReplay(source: string): Promise<void> {
  const captureDirectory = devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_CAPTURE')
  const speed = showSpeed(devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_SPEED'))
  const run = readRun(source)
  const chosen = selectSubjects(run.subjects, devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_ONLY'))
  if (!chosen.length) throw new Error('No subject matches HEYNIMBO_DEBUG_3D_EVAL_SHOW_ONLY.')
  if (run.models.length > SHOW_LIMITS.columns) console.warn(`[show] showing the first ${SHOW_LIMITS.columns} of ${run.models.length} models`)
  const cursor = screen.getCursorScreenPoint(), display = screen.getDisplayNearestPoint(cursor)
  const layout = showLayout(display, Math.min(SHOW_LIMITS.columns, run.models.length))
  const image = { width: display.bounds.width, height: display.bounds.height }
  const surface = await openSurface(display, layout.columns.length + 1, captureDirectory)
  const pills = surface.layers.at(-1)!.webContents
  const from = { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y }
  // Each overlay warms a 3D stage once its page has loaded.
  await sleep(1500)
  for (const index of chosen) {
    const subject = run.subjects[index]!, slug = subjectSlug(subject, index)
    const plan = planSubject(subject, subjectLanes(run, source, subject, layout, image), speed)
    console.info(`[show] ${slug}: ${plan.lanes.map((lane) => `${lane.name} ${lane.note}`).join('; ')}${plan.factor < 1 ? ` (compressed ${(1 / plan.factor).toFixed(1)}×)` : ''}`)
    plan.lanes.forEach((lane, i) => { if (lane.prepared.length) sendOverlay(surface.layers[i]!.webContents, { kind: 'prepare', marks: lane.prepared, epoch: 1 }) })
    const marks: Mark[] = [{ kind: 'point', ...layout.heading, label: plan.heading }, ...plan.lanes.map((lane, i) => ({ kind: 'point' as const, ...layout.columns[i]!.note, label: lane.note }))]
    sendOverlay(pills, { kind: 'beat', marks, durationMs: HEADING_BEAT_MS, from, epoch: 1 })
    const timers = plan.lanes.flatMap((lane, i) => lane.beats.map((beat) => setTimeout(() => {
      const command: OverlayCommand = { kind: 'beat', marks: beat.marks, durationMs: beat.durationMs, from, epoch: 1 }
      sendOverlay(surface.layers[i]!.webContents, command)
    }, beat.atMs)))
    if (surface.capture) {
      await sleep(plan.buildMs / 2); await surface.capture(`${slug}-mid.png`)
      await sleep(plan.buildMs - plan.buildMs / 2 + 1500); await surface.capture(`${slug}-end.png`)
      await sleep(Math.max(0, plan.holdMs - 1500))
    } else await sleep(plan.buildMs + plan.holdMs)
    timers.forEach(clearTimeout)
    for (const layer of surface.layers) sendOverlay(layer.webContents, { kind: 'clear' })
    await sleep(SHOW_LIMITS.gapMs)
  }
}

/** Real requests, one model at a time, drawn as they stream, with the
 *  answers and timings saved like a live eval run. */
async function showLive(): Promise<void> {
  const mock = devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_MOCK'), mockRun = mock ? readRun(mock) : undefined
  const label = slugify(devSetting('HEYNIMBO_DEBUG_3D_EVAL_LABEL') ?? `show-${new Date().toISOString().replace(/[:.]/g, '-')}`, 60)
  const directory = join(EVAL_OUTPUT, label), secrets = new Set<string>(), writer = evalWriter(directory, secrets)
  const log = (line: string): void => console.info(writer.redact(`[show] ${line}`))
  const run: EvalRun = { label, mode: 'live', state: 'running', startedAt: new Date().toISOString(), display: EVAL_DISPLAY, limits: EVAL_LIMITS, models: [], subjects: [], records: [], errors: [] }
  try {
    const parsed = parseEvalModels(devSetting('HEYNIMBO_DEBUG_3D_EVAL_MODELS'))
    const models = mockRun && !parsed.models.length ? mockRun.models.map((model) => ({ ...model, effort: ['low', 'medium'].includes(model.effort) ? model.effort as 'low' | 'medium' : undefined })) : parsed.models
    if (!mockRun || parsed.models.length) run.errors.push(...parsed.errors)
    if (models.length > SHOW_LIMITS.columns) { run.errors.push(`Showing the first ${SHOW_LIMITS.columns} models.`); models.length = SHOW_LIMITS.columns }
    run.subjects = mockRun ? mockRun.subjects : parseSubjects(readFileSync(subjectsFile(), 'utf8'))
    const chosen = selectSubjects(run.subjects, devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_ONLY'))
    if (!models.length || !chosen.length) throw new Error(models.length ? 'No subject to ask.' : 'No models to ask.')
    const connectionFor = mockRun
      ? (model: EvalModel): AnswerConnection => ({ provider: model.provider, model: model.model, effort: model.effort, vision: true, credential: async () => '' })
      : await savedConnections(secrets, log)
    const ready = await preflightModels(run, models, connectionFor)
    writer.summary(run)
    const cursor = screen.getCursorScreenPoint(), display = screen.getDisplayNearestPoint(cursor)
    const layout = showLayout(display, models.length, 2)
    const surface = await openSurface(display, models.length + 1, devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW_CAPTURE'))
    await sleep(1500)
    log(`${chosen.length} subjects × ${models.map((model) => model.spec).join(', ')}${mockRun ? ` (recorded answers from ${mock})` : ''}`)
    await runLiveShow({
      run, models, subjects: chosen, layout, ready, connectionFor, screenshot: blankScreenshot(),
      send: (layer, command) => sendOverlay(surface.layers[layer]!.webContents, command),
      sleep, now: () => performance.now(), ...(mockRun && { stream: recordedStream(mock!, mockRun), design: recordedDesign(mock!, mockRun) }),
      startBefore: Date.now() + liveCapMs(chosen.length, models.length) - SHOW_LIMITS.startupMs - process.uptime() * 1000,
      onResult: (result) => {
        if (result.text) result.record.answerFile = writer.file(`${result.modelSlug}/${result.record.subjectSlug}-answer.txt`, result.text)
        if (result.designed) result.record.designFile = writer.file(`${result.modelSlug}/${result.record.subjectSlug}-design.json`, JSON.stringify(result.designed))
        writer.summary(run)
      },
      capture: surface.capture, log,
    })
    run.state = 'complete'
  } catch (error) {
    run.errors.push(error instanceof Error ? error.message : 'The show stopped.'); run.state = 'stopped'
    throw error
  } finally {
    run.finishedAt = new Date().toISOString()
    writer.summary(run)
    log(`${run.state}: ${run.records.filter((record) => record.status === 'ok').length}/${run.records.length} answered; ${join(directory, 'summary.md')}`)
  }
}
