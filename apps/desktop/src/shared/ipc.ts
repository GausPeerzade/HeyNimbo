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

export type SaveKeyResult = { ok: true } | { ok: false; reason: string }

/** Main → hidden audio window. Audio is mono PCM16 at 24 kHz. */
export type VoiceCommand =
  /** `id` tags this recording so late audio from an earlier one is dropped. */
  | { kind: 'micStart'; id: number }
  | { kind: 'micStop' }
  | { kind: 'play'; pcm: Uint8Array }
  /** No more audio for this answer; report when it has finished playing. */
  | { kind: 'playEnd' }
  /** Stop speaking now, e.g. the user started talking again. */
  | { kind: 'playCancel' }

/** Hidden audio window → main. */
export type VoiceEvent =
  | { kind: 'micStarted'; id: number }
  | { kind: 'micChunk'; id: number; pcm: Uint8Array }
  | { kind: 'micStopped'; id: number }
  | { kind: 'micError'; message: string }
  | { kind: 'playbackStarted' }
  | { kind: 'playbackDrained' }

export const Channels = {
  notchStatus: 'nimbo:notch-status',
  overlay: 'nimbo:overlay',
  saveOpenAIKey: 'nimbo:save-openai-key',
  voiceCommand: 'nimbo:voice-command',
  voiceEvent: 'nimbo:voice-event',
} as const
