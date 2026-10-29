import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { Channels, type OverlayCommand, type OverlayEvent } from '../shared/ipc'
import { devFlag, devSetting } from './dev'
import { isolateDevProfile, launchInBackground } from './dev-profile'
import { BLIND_FIXTURES, fixtureBeats, MODEL_FIXTURES, type FixtureRect, type ModelFixture } from './model-fixtures'
import { frameTraceSummary, loadPage, secureWebPreferences } from './windows'

const VIEW = { width: 1200, height: 800 }
const MODEL_CARD: FixtureRect = { x: 40, y: 40, w: 640, h: 600 }
const SIDE_CARD: FixtureRect = { x: 720, y: 70, w: 440, h: 420 }
const CAPTURE = { x: 28, y: 28, width: 664, height: 624 }
const OUTPUT = '/tmp/nimbo-3d-gallery'
/** Includes Electron start-up, so a stalled run still ends inside a minute. */
const DEADLINE_MS = 58_000
/** Hidden windows rendering at once, and speech pace: a full set fits under the deadline. */
const CONCURRENCY = 6
const PACE = 0.6
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface GalleryReport {
  activeAtReady: boolean
  becameActive: number
  activeAtEnd?: boolean
  traces: Record<string, Array<ReturnType<typeof frameTraceSummary> & { slowAtMs: number[] }>>
  /** Beat start (and stage request) to the first visible part, per fixture; logged only while tracing. */
  timing: Record<string, unknown>
  robustness?: { cycles: number; canvasesPerCycle: number[]; canvasesAfterCycles: number; canvasesAfterClose: number; warnings: string[] }
}

export function configureModelGallery(): void {
  if (!devFlag('NIMBO_DEBUG_3D_GALLERY')) return
  launchInBackground()
  const cleanup = isolateDevProfile('model-gallery')
  setTimeout(() => { console.warn('[gallery] deadline reached'); cleanup(); app.exit(2) }, Math.max(0, DEADLINE_MS - process.uptime() * 1000)).unref()
}

/** Renders original fixtures through the real overlay page in windows that are
 *  never shown. No gesture, microphone, audio, network or credential path runs. */
export async function runModelGallery(): Promise<void> {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('file:') }))
  const directory = join(OUTPUT, devSetting('NIMBO_DEBUG_3D_GALLERY_LABEL') ?? new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(directory, { recursive: true })
  // A set name ("core", "blind") or fixture names; the core set and the robustness lane by default.
  const only = devSetting('NIMBO_DEBUG_3D_GALLERY_ONLY')?.split(',')
  const report: GalleryReport = { activeAtReady: app.isActive(), becameActive: 0, traces: {}, timing: {} }
  app.on('did-become-active', () => { report.becameActive++; console.warn('[gallery] the app became active') })
  const names = new Map<WebContents, string>()
  ipcMain.on(Channels.overlayEvent, (event, payload: OverlayEvent) => {
    const name = names.get(event.sender)
    if (!name || payload?.kind !== 'frameTrace') return
    // Where in the trace each slow frame fell, to tie a spike to a beat.
    const slowAtMs = payload.deltas.flatMap((gap, i) => gap > 25 ? [Math.round(payload.deltas.slice(0, i).reduce((sum, d) => sum + d, 0))] : [])
    ;(report.traces[name] ??= []).push({ ...frameTraceSummary(payload.deltas), slowAtMs })
  })
  const timing = (name: string, message: string): void => { if (message.startsWith('[model-timing] ')) report.timing[name] = JSON.parse(message.slice(15)) }
  const fixtures = [...MODEL_FIXTURES.map((fixture) => ({ fixture, set: 'core' })), ...BLIND_FIXTURES.map((fixture) => ({ fixture, set: 'blind' }))]
    .filter(({ fixture, set }) => only ? only.includes(set) || only.includes(fixture.name) : set === 'core').map(({ fixture }) => fixture)
  const queue = [...fixtures]
  const lane = async (): Promise<void> => { for (let fixture = queue.shift(); fixture; fixture = queue.shift()) await runFixture(fixture, directory, names, timing) }
  await Promise.all([...Array.from({ length: Math.min(CONCURRENCY, fixtures.length) }, lane), ...(only ? [] : [runRobustness(directory, report)])])
  report.activeAtEnd = app.isActive()
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.info(`[gallery] ${directory} ${JSON.stringify({ ...report, traces: undefined })}`)
  for (const [name, traces] of Object.entries(report.traces)) console.info(`[gallery] ${name} trace ${JSON.stringify(traces)}`)
  app.quit()
}

/** The real overlay page in a window that is never shown, focused or given
 *  network; on a desktop grey, or transparent for compositing several. */
export async function hiddenOverlay(names: Map<WebContents, string>, name: string, view: { width: number; height: number } = VIEW, backgroundColor = '#7b888e'): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...view, show: false, paintWhenInitiallyHidden: true, frame: false, focusable: false, skipTaskbar: true,
    transparent: backgroundColor === '#00000000', backgroundColor, webPreferences: { ...secureWebPreferences(), backgroundThrottling: false },
  })
  names.set(window.webContents, name)
  await loadPage(window, 'overlay')
  if (devFlag('NIMBO_DEBUG_DRAW_TRACE')) sendOverlay(window.webContents, { kind: 'debug', frameTrace: true })
  return window
}

export function sendOverlay(contents: WebContents, command: OverlayCommand): void {
  if (!contents.isDestroyed()) contents.send(Channels.overlay, command)
}

export async function saveCapture(contents: WebContents, file: string, rect = CAPTURE): Promise<void> {
  writeFileSync(file, (await contents.capturePage(rect)).toPNG())
}

/** Trusted pointer input through DevTools: sendInputEvent needs a focused window. */
export async function drag(contents: WebContents, from: [number, number], by: [number, number]): Promise<void> {
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  const mouse = (type: string, x: number, y: number): Promise<unknown> =>
    contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await mouse('mousePressed', ...from)
  for (let step = 1; step <= 10; step++) {
    await mouse('mouseMoved', from[0] + by[0] * step / 10, from[1] + by[1] * step / 10)
    await sleep(16)
  }
  await mouse('mouseReleased', from[0] + by[0], from[1] + by[1])
}

async function runFixture(fixture: ModelFixture, directory: string, names: Map<WebContents, string>, timing: (name: string, message: string) => void): Promise<void> {
  const window = await hiddenOverlay(names, fixture.name)
  const contents = window.webContents
  contents.on('console-message', ({ message }) => timing(fixture.name, message))
  const beats = fixtureBeats(fixture.script(MODEL_CARD, SIDE_CARD), VIEW)
  // 3D lines stream in a sentence ahead of speech, as the parser forwards them; "0" measures without.
  const streamed = devSetting('NIMBO_DEBUG_3D_GALLERY_PREPARE') !== '0'
  const prepare = (index: number): void => {
    const marks = beats[index]?.marks.filter((mark) => mark.kind === 'model' || mark.kind === 'part') ?? []
    if (streamed && marks.length) sendOverlay(contents, { kind: 'prepare', marks, epoch: 1 })
  }
  // The real overlay loads at app start, long before an answer: let its warm stage finish first.
  await sleep(1200)
  prepare(0)
  await sleep(300)
  for (const [index, beat] of beats.entries()) {
    prepare(index + 1)
    const durationMs = Math.round(beat.durationMs * PACE)
    sendOverlay(contents, { kind: 'beat', marks: beat.marks, durationMs, from: { x: 1100, y: 720 }, epoch: 1 })
    await sleep(durationMs)
    if (fixture.stages.includes(index + 1)) await saveCapture(contents, join(directory, `${fixture.name}-${index + 1}-build.png`))
  }
  await sleep(1400)
  await saveCapture(contents, join(directory, `${fixture.name}-final-a.png`))
  if (fixture.name === 'pump') await saveCapture(contents, join(directory, 'pump-final-cards.png'), { x: 0, y: 0, ...VIEW })
  await drag(contents, [MODEL_CARD.x + MODEL_CARD.w / 2, MODEL_CARD.y + MODEL_CARD.h / 2 + 40], [-110, 36])
  await sleep(450)
  await saveCapture(contents, join(directory, `${fixture.name}-final-b.png`))
  // A swaying model never goes idle, so end the trace explicitly to get its report.
  if (devFlag('NIMBO_DEBUG_DRAW_TRACE')) { sendOverlay(contents, { kind: 'debug', frameTrace: false }); await sleep(400) }
  window.destroy()
}

/** Twenty open/clear cycles must not exhaust WebGL contexts, and a card dragged
 *  and closed mid-build must leave nothing behind. */
async function runRobustness(directory: string, report: GalleryReport): Promise<void> {
  const window = await hiddenOverlay(new Map(), 'robustness')
  const contents = window.webContents
  const warnings: string[] = []
  contents.on('console-message', ({ message, level }) => { if (level === 'error' || /too many active webgl/i.test(message)) warnings.push(message) })
  const canvases = (): Promise<number> => contents.executeJavaScript('document.querySelectorAll("canvas").length')
  const cycle = fixtureBeats('@model cycle 40 40 640 600 "Cycle"\n@part cycle block box round=0.1 mat=brass\nA block.', VIEW)[0]!
  const cycles = 20, canvasesPerCycle: number[] = []
  for (let i = 0; i < cycles; i++) {
    sendOverlay(contents, { kind: 'beat', marks: cycle.marks, durationMs: 300, epoch: i })
    await sleep(320)
    sendOverlay(contents, { kind: 'clear' })
    // DevTools evaluation is not ordered with IPC, so give the clear time to land first.
    await sleep(200)
    canvasesPerCycle.push(await canvases())
  }
  await sleep(300)
  const canvasesAfterCycles = await canvases()
  const pump = fixtureBeats(MODEL_FIXTURES[0]!.script(MODEL_CARD, SIDE_CARD), VIEW)
  for (const beat of pump.slice(0, 2)) sendOverlay(contents, { kind: 'beat', marks: beat.marks, durationMs: beat.durationMs, epoch: 99 })
  // Drag while the first parts grow, then close while later ones are still queued.
  await sleep(pump[0]!.durationMs + 600)
  await drag(contents, [MODEL_CARD.x + 120, MODEL_CARD.y + 14], [-20, 40])
  await sleep(700)
  // The close control sits at the card's top-right corner, moved with the drag.
  const close = { x: MODEL_CARD.x + MODEL_CARD.w - 17 - 20, y: MODEL_CARD.y + 14 + 40 }
  contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...close, button: 'left', buttons: 1, clickCount: 1 })
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...close, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(1200)
  const canvasesAfterClose = await canvases()
  await saveCapture(contents, join(directory, 'robustness-after-close.png'), { x: 0, y: 0, ...VIEW })
  report.robustness = { cycles, canvasesPerCycle, canvasesAfterCycles, canvasesAfterClose, warnings }
  window.destroy()
}
