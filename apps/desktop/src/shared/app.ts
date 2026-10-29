import type { Mark } from './beats'

export type Retention = 0 | 7 | 30 | 90 | 'forever'
export type SpeakingVoice = 'marin' | 'cedar' | 'alloy' | 'coral'
export interface AppSettings {
  openAtLogin: boolean
  showMenuBar: boolean
  showNotch: boolean
  voice: SpeakingVoice
  muted: boolean
  saveHistory: boolean
  retention: Retention
  homeBounds?: { x: number; y: number; width: number; height: number }
}
export interface DrawingScene {
  version: 1
  beats: Array<{
    sentence?: string
    marks: Mark[]
    space: { frame: { x: number; y: number; width: number; height: number }; pixelWidth: number; pixelHeight: number }
  }>
}
export interface Conversation {
  id: string; title: string; created: number; updated: number; pinned: boolean; archived: boolean; preview: string
}
export interface HistoryTurn {
  id: string; conversationId: string; created: number; mode: 'voice' | 'text'; question: string; answer: string
  state: 'complete' | 'interrupted' | 'error'; error: string | null; scene: DrawingScene; screenContextUsed: boolean
}
export interface SearchHit { conversationId: string; turnId: string; title: string; snippet: string; updated: number }
export interface AppSnapshot {
  conversations: Conversation[]; currentId: string | null; turns: HistoryTurn[]; busy: boolean; activeTurnId: string | null
  status: string; settings: AppSettings; keyPresent: boolean; version: string; saved: boolean
  permissions: Record<'microphone' | 'screen' | 'input', string>
}
export type AppRequest =
  | { kind: 'snapshot' }
  | { kind: 'new' }
  | { kind: 'open'; id?: string; turnId?: string }
  | { kind: 'ask'; question: string }
  | { kind: 'stop' }
  | { kind: 'search'; query: string }
  | { kind: 'contextMenu'; id: string }
  | { kind: 'rename'; id: string; title: string }
  | { kind: 'settings'; category?: string }
  | { kind: 'updateSettings'; settings: AppSettings }
  | { kind: 'deleteAll' }
  | { kind: 'replaceKey' }
  | { kind: 'permission'; permission: 'microphone' | 'screen' | 'input' }
export const AppChannels = { request: 'nimbo:app-request', snapshot: 'nimbo:app-snapshot', navigate: 'nimbo:app-navigate', notch: 'nimbo:notch-event' } as const

export type NotchEvent = { kind: 'hover'; over: boolean } | { kind: 'expanded'; expanded: boolean } | { kind: 'home'; id?: string } | { kind: 'new' } | { kind: 'stop' }
