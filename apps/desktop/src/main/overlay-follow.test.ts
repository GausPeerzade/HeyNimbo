import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Two displays side by side; the test moves the OS cursor between them.
const state = vi.hoisted(() => ({
  cursor: { x: 100, y: 100 },
  windows: [] as Array<{ webContents: { send: ReturnType<typeof vi.fn> }; setIgnoreMouseEvents: ReturnType<typeof vi.fn> }>,
  overlayEvent: undefined as undefined | ((event: { sender: unknown }, payload: unknown) => void),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
    { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 800 } },
  ]
  class BrowserWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() })
    setIgnoreMouseEvents = vi.fn()
    setContentProtection = vi.fn()
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setBounds = vi.fn()
    showInactive = vi.fn()
    hide = vi.fn()
    isDestroyed = () => false
    loadFile = () => new Promise(() => {})
    loadURL = () => new Promise(() => {})
    constructor() {
      super()
      state.windows.push(this)
    }
  }
  return {
    BrowserWindow,
    app: { isPackaged: false },
    ipcMain: {
      on: (channel: string, handler: (event: { sender: unknown }, payload: unknown) => void) => {
        if (channel === 'nimbo:overlay-event') state.overlayEvent = handler
      },
    },
    screen: {
      getAllDisplays: () => displays,
      getCursorScreenPoint: () => state.cursor,
      getDisplayNearestPoint: (point: { x: number }) => displays[point.x < 1000 ? 0 : 1],
    },
  }
})

import { OverlayManager } from './windows'

const SPACE = { frame: { x: 0, y: 0, width: 1000, height: 800 }, pixelWidth: 1000, pixelHeight: 800 }
const sent = (display: 0 | 1): Array<{ kind: string; at?: unknown; epoch?: number }> =>
  state.windows[display]!.webContents.send.mock.calls.map(([, command]) => command)

function setup(): OverlayManager {
  const overlays = new OverlayManager()
  overlays.sync()
  overlays.startFollowing(16)
  return overlays
}

function moveCursor(x: number, y: number): void {
  state.cursor = { x, y }
  vi.advanceTimersByTime(16)
}

beforeEach(() => {
  vi.useFakeTimers()
  state.windows.length = 0
  state.cursor = { x: 100, y: 100 }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OverlayManager cursor following', () => {
  it('feeds the cursor to its display and hands the idle buddy over across displays', () => {
    const overlays = setup()
    moveCursor(120, 140)
    expect(sent(0).at(-1)).toEqual({ kind: 'cursor', at: { x: 120, y: 140 } })

    moveCursor(1300, 200)
    expect(sent(0).at(-1)).toEqual({ kind: 'park' })
    expect(sent(1).at(-1)).toEqual({ kind: 'cursor', at: { x: 300, y: 200 } })
    overlays.stopFollowing()
  })

  it('keeps the buddy on the drawing display until it reports back home', () => {
    const overlays = setup()
    moveCursor(120, 140)
    overlays.drawBeat([{ kind: 'dot', x: 50, y: 50, r: 4 }], 1000, SPACE)

    moveCursor(1300, 200) // the user wanders off mid-drawing
    expect(sent(0).some((command) => command.kind === 'park')).toBe(false)
    expect(sent(1)).toEqual([])

    state.overlayEvent!({ sender: state.windows[0]!.webContents }, { kind: 'buddyIdle' })
    moveCursor(1310, 210)
    expect(sent(0).at(-1)).toEqual({ kind: 'park' })
    expect(sent(1).at(-1)).toEqual({ kind: 'cursor', at: { x: 310, y: 210 } })
    overlays.stopFollowing()
  })

  it('starts no sound for strokes from a scene that was cleared', () => {
    const overlays = setup()
    const scribble = vi.fn()
    overlays.onStrokeStarted = scribble
    overlays.drawBeat([{ kind: 'dot', x: 50, y: 50, r: 4 }], 1000, SPACE)
    const stale = sent(0).find((command) => command.kind === 'beat')!.epoch
    overlays.clear()
    state.overlayEvent!({ sender: state.windows[0]!.webContents }, { kind: 'strokeStarted', durationMs: 300, epoch: stale })
    expect(scribble).not.toHaveBeenCalled()

    overlays.drawBeat([{ kind: 'dot', x: 50, y: 50, r: 4 }], 1000, SPACE)
    const current = sent(0).filter((command) => command.kind === 'beat').at(-1)!.epoch
    state.overlayEvent!({ sender: state.windows[0]!.webContents }, { kind: 'strokeStarted', durationMs: 300, epoch: current })
    expect(scribble).toHaveBeenCalledWith(300)
    overlays.stopFollowing()
  })

  it('makes only the hovered overlay clickable and clears everything on Clear', () => {
    const overlays = setup()
    overlays.drawBeat([{ kind: 'dot', x: 50, y: 50, r: 4 }], 1000, SPACE)
    overlays.answerDone()
    expect(sent(0).at(-1)).toEqual({ kind: 'offerClear' })

    const [left, right] = state.windows
    const button = (payload: unknown): void => state.overlayEvent!({ sender: left!.webContents }, payload)
    button({ kind: 'clearHover', over: true })
    expect(left!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true })
    expect(right!.setIgnoreMouseEvents).not.toHaveBeenCalledWith(false, { forward: true })

    button({ kind: 'clearClicked' })
    expect(left!.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true })
    expect(sent(0).at(-1)?.kind).toBe('clear')
    expect(sent(1).at(-1)?.kind).toBe('clear')

    // Without a click, the drawing stays a full minute, not the old 6 s.
    overlays.answerDone()
    vi.advanceTimersByTime(59_000)
    expect(sent(0).some((command) => command.kind === 'fade')).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(sent(0).at(-1)?.kind).toBe('fade')
    overlays.stopFollowing()
  })
})
