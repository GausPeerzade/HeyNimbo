import { BrowserWindow, ipcMain, systemPreferences } from 'electron'
import { hasVoiceUsageDescriptions } from '@heynimbo/native'
import { Channels, type VoiceCommand, type VoiceEvent } from '../shared/ipc'
import { loadPage, secureWebPreferences } from './windows'

/** A hidden window that owns the microphone and speaker through Chromium's
 *  audio stack (echo cancellation, noise suppression, resampling). */
export class AudioWindow {
  private readonly window: BrowserWindow
  /** Commands sent before the page is listening, delivered once it loads. */
  private queued: VoiceCommand[] | undefined = []

  constructor(onEvent: (event: VoiceEvent) => void) {
    this.window = new BrowserWindow({
      show: false,
      webPreferences: {
        ...secureWebPreferences('voice'),
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    })
    const contents = this.window.webContents
    // Only this window may use the microphone, and only for audio.
    contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
      const audioOnly = 'mediaTypes' in details && details.mediaTypes?.every((type) => type === 'audio')
      callback(requester === contents && permission === 'media' && Boolean(audioOnly) && hasVoiceUsageDescriptions())
    })
    contents.session.setPermissionCheckHandler(
      (requester, permission) => requester === contents && permission === 'media' && hasVoiceUsageDescriptions(),
    )
    ipcMain.on(Channels.voiceEvent, (event, payload: VoiceEvent) => {
      if (event.sender === contents) onEvent(payload)
    })
    contents.once('did-finish-load', () => {
      const queued = this.queued ?? []
      this.queued = undefined
      queued.forEach((command) => this.send(command))
    })
    loadPage(this.window, 'voice')
  }

  close(): void { if (!this.window.isDestroyed()) this.window.destroy() }

  send(command: VoiceCommand): void {
    if (this.queued) this.queued.push(command)
    else if (!this.window.isDestroyed()) this.window.webContents.send(Channels.voiceCommand, command)
  }
}

/** The metadata guard owns every microphone authorization query. */
export function microphoneAccessStatus(): ReturnType<typeof systemPreferences.getMediaAccessStatus> | 'unavailable' {
  if (process.platform !== 'darwin') return 'granted'
  return hasVoiceUsageDescriptions() ? systemPreferences.getMediaAccessStatus('microphone') : 'unavailable'
}

/** Only a user action should call this; denied/restricted access needs System Settings. */
export async function ensureMicrophoneAccess(): Promise<boolean> {
  const status = microphoneAccessStatus()
  if (status === 'granted') return true
  if (status !== 'not-determined') return false
  return systemPreferences.askForMediaAccess('microphone')
}
