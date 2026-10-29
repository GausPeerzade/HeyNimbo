import { speechLanguage } from '@nimboguide/native'
import type { VoiceCommand } from '../../shared/ipc'

/** System speech is queued in the same renderer that plays realtime PCM. */
export class BuiltInMouth {
  constructor(private readonly audio: { send(command: VoiceCommand): void }) {}
  warm(): void {}
  speak(text: string, _onAudio: (pcm: Uint8Array) => void, line = 0): Promise<void> {
    this.audio.send({ kind: 'systemSpeak', text, line, language: speechLanguage(text) ?? undefined })
    return Promise.resolve()
  }
  cancel(): void { this.audio.send({ kind: 'playCancel' }) }
  close(): void { this.cancel() }
}
