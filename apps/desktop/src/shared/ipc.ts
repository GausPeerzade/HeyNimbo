// IPC contract between the main process and the sandboxed windows. Preload
// exposes only these channels, so renderers cannot reach arbitrary IPC.

/** Actions bound to global gestures; names stay stable across platforms. */
export type GestureAction = 'talk' | 'text' | 'alwaysOn' | 'dictate' | 'handsFree'

export type GesturePhase = 'started' | 'ended' | 'cancelled' | 'tapped'

export interface GestureMessage {
  action: GestureAction
  phase: GesturePhase
}

/** What the notch shows; the main process owns this state. */
export type NotchStatus =
  | { kind: 'idle' }
  | { kind: 'needsPermission'; permission: 'inputMonitoring' | 'screenRecording' }
  | { kind: 'active'; label: string }

/** A pointer ring in overlay-local CSS pixels. */
export interface OverlayRing {
  x: number
  y: number
}

export type OverlayCommand = { kind: 'ring'; ring: OverlayRing } | { kind: 'clear' }

export const Channels = {
  notchStatus: 'nimbo:notch-status',
  overlay: 'nimbo:overlay',
} as const
