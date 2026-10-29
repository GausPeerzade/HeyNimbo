import { speechAvailability, requestSpeechAuthorization } from '@nimboguide/native'
import type { VoiceSelection } from '../../shared/providers'

/** All callers, including the connection summary, use this one selection rule. */
export function selectVoiceEngine(key: string | undefined): VoiceSelection {
  if (key) return { engine: 'openai' }
  const speech = speechAvailability()
  if (speech.available && speech.authorization === 'authorized') return { engine: 'builtin' }
  return {
    engine: 'unavailable',
    reason: speech.reason ?? 'Built-in speech recognition is not authorized.',
    needsPermission: speech.authorization === 'notDetermined',
  }
}

export async function allowSpeechRecognition(): Promise<void> { await requestSpeechAuthorization() }
