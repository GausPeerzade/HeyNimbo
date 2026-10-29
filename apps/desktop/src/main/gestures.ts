import {
  GestureMonitor,
  hasInputMonitoringAccess,
  requestInputMonitoringAccess,
  type GestureBinding,
  type GestureEvent,
  type GestureKind,
} from '@nimboguide/native'
import type { GestureAction, GestureMessage, GesturePhase } from '../shared/ipc'

const PHASES: Record<GestureKind, GesturePhase> = {
  HoldStarted: 'started',
  HoldEnded: 'ended',
  HoldCancelled: 'cancelled',
  Tapped: 'tapped',
}

/** Platform defaults: Ctrl+Option (Ctrl+Alt) to talk, Ctrl taps for text and
 *  always-on, and Fn+Ctrl on Mac or Ctrl+Win on Windows to dictate. */
export function defaultBindings(platform: NodeJS.Platform): GestureBinding[] {
  const dictate: GestureBinding['chord'] = platform === 'darwin' ? ['Fn', 'Control'] : ['Control', 'Command']
  return [
    { action: 'talk', chord: ['Control', 'Option'] },
    { action: 'text', chord: ['Control'], taps: 2 },
    { action: 'alwaysOn', chord: ['Control'], taps: 3 },
    { action: 'dictate', chord: dictate },
    { action: 'handsFree', chord: dictate, taps: 2 },
  ]
}

export type GestureStart = { ok: true; monitor: GestureMonitor } | { ok: false; reason: 'inputMonitoring' | string }

/** Starts global gestures, asking for Input Monitoring first: without it macOS
 *  still creates the tap but silently delivers no events. */
export function startGestures(onGesture: (message: GestureMessage) => void): GestureStart {
  if (!hasInputMonitoringAccess() && !requestInputMonitoringAccess()) {
    return { ok: false, reason: 'inputMonitoring' }
  }
  const monitor = new GestureMonitor()
  try {
    monitor.start(defaultBindings(process.platform), null, (event: GestureEvent) => {
      onGesture({ action: event.action as GestureAction, phase: PHASES[event.kind] })
    })
    return { ok: true, monitor }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
