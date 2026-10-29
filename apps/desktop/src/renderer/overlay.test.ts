import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverlayCommand, OverlayEvent } from '../shared/ipc'

/** A small SVG/input test surface; layout measurement and the monotonic clock are explicit stubs. */
class SvgNode {
  children: SvgNode[] = []
  parent?: SvgNode
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<(event: any) => void>>()
  style = { setProperty: vi.fn(), fontSize: '', fill: '', left: '', top: '' }
  textContent = ''
  hidden = true
  capture?: number
  constructor(readonly tag: string) {}
  get isConnected(): boolean { return this.tag === 'stage' || !!this.parent?.isConnected }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value) }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null }
  append(...nodes: SvgNode[]): void { for (const node of nodes) { node.remove(); this.children.push(node); node.parent = this } }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = undefined }
  replaceChildren(...nodes: SvgNode[]): void { for (const child of this.children) child.parent = undefined; this.children = []; this.append(...nodes) }
  all(className: string): SvgNode[] { return this.children.flatMap((child) => [...((child.getAttribute('class') ?? '').split(' ').includes(className) ? [child] : []), ...child.all(className)]) }
  querySelector(selector: string): SvgNode | undefined { return this.all(selector.split('.').at(-1)!)[0] }
  addEventListener(name: string, callback: (event: any) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]) }
  dispatch(name: string, input: Record<string, unknown> = {}): void { for (const callback of this.listeners.get(name) ?? []) callback({ button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...input }) }
  setPointerCapture(pointer: number): void { this.capture = pointer }
  hasPointerCapture(pointer: number): boolean { return this.capture === pointer }
  releasePointerCapture(): void { this.capture = undefined; this.dispatch('lostpointercapture') }
  getComputedTextLength(): number { return Array.from(this.textContent).length * 10 }
  getBBox(): { x: number; y: number; width: number; height: number } { return { x: 50, y: 40, width: this.children.length ? 420 : 0, height: this.children.length ? 200 : 0 } }
  getBoundingClientRect(): { width: number; height: number } { return { width: 70, height: 28 } }
}

async function setup(ready = true) {
  vi.resetModules()
  const stage = new SvgNode('stage')
  const clear = new SvgNode('button')
  let now = 0
  let frames: FrameRequestCallback[] = []
  let receive!: (command: OverlayCommand) => void
  let resolveFont!: () => void
  const font = new Promise<void>((resolve) => { resolveFont = resolve })
  const events: Array<{ at: number; event: OverlayEvent }> = []
  vi.stubGlobal('document', {
    getElementById: (id: string) => id === 'stage' ? stage : clear,
    createElementNS: (_: string, tag: string) => new SvgNode(tag),
    createElement: () => ({ getContext: () => ({ font: '', measureText: (text: string) => ({ width: Array.from(text).length * 10 }) }) }),
    fonts: { load: () => font, ready: Promise.resolve() },
  })
  vi.stubGlobal('window', { nimbo: { onOverlayCommand: (callback: typeof receive) => { receive = callback }, sendOverlayEvent: (event: OverlayEvent) => events.push({ at: now, event }) } })
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal('innerHeight', 900)
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback) })
  await import('./overlay')
  const fontsReady = async (): Promise<void> => { resolveFont(); await font; await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  if (ready) await fontsReady()
  const pump = (duration: number, inspect?: () => void): void => {
    const end = now + duration
    while (now < end) { now = Math.min(end, now + 10); const pending = frames; frames = []; for (const callback of pending) callback(now); inspect?.() }
  }
  const beat = (marks: Extract<OverlayCommand, { kind: 'beat' }>['marks'], durationMs = 1500): void => receive({ kind: 'beat', marks, durationMs, epoch: 1, from: { x: 50, y: 50 } })
  return { stage, clear, events, receive, pump, beat, fontsReady, now: () => now }
}
const card = (id = 'a', x = 50) => ({ kind: 'card' as const, id, x, y: 40, w: 420, h: 180, title: 'Water', board: 'grid' as const })
const step = (id = 'a') => ({ kind: 'step' as const, id, text: 'Evaporation', direction: 'up' as const, color: 'orange' as const })

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('overlay card pipeline', () => {
  it('keeps a queued invisible card and its region inactive until the reveal begins', async () => {
    const app = await setup()
    app.beat([{ kind: 'circle', x: 900, y: 700, r: 100 }], 1500)
    app.beat([card()], 1500)
    const root = app.stage.all('paper-card')[0]!
    expect(root.getAttribute('opacity')).toBe('0')
    // This attribute disables hit-testing on the root and every descendant.
    expect(root.getAttribute('data-interactive')).toBe('false')
    expect(root.all('card-drag')).toHaveLength(0)
    root.dispatch('pointerenter')
    app.pump(100)
    expect(root.getAttribute('data-interactive')).toBe('false')
    expect(app.events.some(({ event }) => event.kind === 'interactiveRegion')).toBe(false)
    app.pump(3000)
    expect(root.getAttribute('data-interactive')).toBe('true')
    expect(root.all('card-drag')).toHaveLength(1)
    root.dispatch('pointerenter')
    expect(app.events.at(-1)!.event).toEqual({ kind: 'interactiveRegion', id: 'card:a', over: true, captured: false })
  })

  it('retains a card-owned highlight as a marker wash while converting only pen ink to paper', async () => {
    const app = await setup()
    app.beat([
      card(),
      { kind: 'highlight', x: 100, y: 100, w: 180, h: 26 },
      { kind: 'line', x1: 100, y1: 160, x2: 280, y2: 160 },
    ], 3000)
    app.pump(3000)
    const root = app.stage.all('paper-card')[0]!
    const wash = root.all('wash')[0]!
    expect(wash.all('marker')).toHaveLength(1)
    expect(wash.all('paper')).toHaveLength(0)
    expect(root.all('ink')[0]!.all('paper')).toHaveLength(1)
    expect(app.stage.all('marker')).toEqual(wash.all('marker'))
  })

  it('waits for font readiness, then reveals badge → arrow → partial handwriting within its beat budget', async () => {
    const app = await setup(false)
    app.beat([card()])
    app.pump(100)
    expect(app.stage.all('paper-card')).toHaveLength(0)
    await app.fontsReady()
    app.pump(1500)
    const start = app.now()
    app.beat([step()], 1200)
    const order: string[] = []
    let partialWriting = false
    app.pump(1200, () => {
      if (app.stage.all('badge').length && !order.includes('badge')) order.push('badge')
      if (app.stage.all('paper').length && !order.includes('arrow')) order.push('arrow')
      const text = app.stage.all('note')[0]
      if (text && !order.includes('words')) order.push('words')
      if (text?.getAttribute('opacity') === '1') {
        const mask = text.parent!.children.find((node) => `url(#${node.getAttribute('id')})` === text.getAttribute('mask'))!
        const width = Number(mask.children[0]!.getAttribute('width'))
        if (width > 0 && width < 100) partialWriting = true
      }
    })
    expect(order).toEqual(['badge', 'arrow', 'words'])
    expect(partialWriting).toBe(true)
    expect(app.events.filter(({ event }) => event.kind === 'strokeStarted').every(({ at, event }) => at + (event as { durationMs: number }).durationMs <= start + 1200 + 10)).toBe(true)
    expect(app.stage.all('note')[0]!.textContent).toBe('Evaporation')
  })

  it('close cancels only that card’s active/pending animations and restores click-through', async () => {
    const app = await setup()
    app.beat([card(), card('b', 550)], 1800)
    app.pump(1800)
    app.beat([step(), step('b')], 2400)
    app.pump(100)
    const [a, b] = app.stage.all('paper-card')
    a!.all('card-close')[0]!.dispatch('click')
    expect(app.stage.all('paper-card')).toEqual([b])
    const soundsBefore = app.events.filter(({ event }) => event.kind === 'strokeStarted').length
    app.pump(2500)
    expect(a!.all('note')).toHaveLength(0)
    expect(b!.all('note')[0]!.textContent).toBe('Evaporation')
    // Only b's two ink strokes and writing may start after the close.
    expect(app.events.filter(({ event }) => event.kind === 'strokeStarted').length - soundsBefore).toBe(3)
    expect(app.events.some(({ event }) => event.kind === 'interactiveRegion' && event.id === 'card:a' && !event.over && !event.captured)).toBe(true)
    app.receive({ kind: 'clear' })
    expect(app.stage.all('paper-card')).toHaveLength(0)
  })

  it('drag captures through pointer leave, moves the retained group and releases on pointerup; Clear stays wired', async () => {
    const app = await setup()
    app.beat([card(), { kind: 'note', id: 'a', text: 'A retained note' }], 1800)
    app.pump(1800)
    const root = app.stage.all('paper-card')[0]!
    const handle = root.all('card-drag')[0]!
    root.dispatch('pointerenter')
    handle.dispatch('pointerdown', { clientX: 100, clientY: 50 })
    root.dispatch('pointerleave')
    expect(app.events.at(-1)!.event).toEqual({ kind: 'interactiveRegion', id: 'card:a', over: false, captured: true })
    handle.dispatch('pointermove', { clientX: 250, clientY: 150 })
    expect(root.getAttribute('transform')).toBe('translate(150 100)')
    expect(root.all('note')[0]!.textContent).toBe('A retained note')
    handle.dispatch('pointerup', { clientX: 1100, clientY: 800 })
    expect(handle.capture).toBeUndefined()
    expect(app.events.at(-1)!.event).toEqual({ kind: 'interactiveRegion', id: 'card:a', over: false, captured: false })
    app.receive({ kind: 'offerClear' })
    app.clear.dispatch('pointerenter')
    app.clear.dispatch('click')
    expect(app.events.at(-1)!.event).toEqual({ kind: 'clearClicked' })
  })
  it('warns once with the final omitted step count and never schedules omitted row animation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const app = await setup()
    vi.stubGlobal('innerHeight', 300)
    app.beat([card(), step(), step(), step(), step()], 4000)
    app.pump(4000)
    expect(app.stage.all('badge')).toHaveLength(2)
    expect(app.stage.all('note')).toHaveLength(2)
    app.receive({ kind: 'offerClear' })
    app.receive({ kind: 'offerClear' })
    app.receive({ kind: 'clear' })
    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('[drawing] card a: omitted 2 step(s); no readable slot fits the display.')
  })

})
