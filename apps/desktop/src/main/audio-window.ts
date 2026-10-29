import { BrowserWindow, ipcMain, systemPreferences } from 'electron'
import { Channels, type VoiceCommand, type VoiceEvent } from '../shared/ipc'
import { loadPage, secureWebPreferences } from './windows'

/** A hidden window that owns the microphone and speaker through Chromium's
 *  audio stack (echo cancellation, noise suppression, resampling). */
export class AudioWindow {
  private readonly window: BrowserWindow

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
      callback(requester === contents && permission === 'media' && Boolean(audioOnly))
    })
    contents.session.setPermissionCheckHandler(
      (requester, permission) => requester === contents && permission === 'media',
    )
    ipcMain.on(Channels.voiceEvent, (event, payload: VoiceEvent) => {
      if (event.sender === contents) onEvent(payload)
    })
    loadPage(this.window, 'voice')
  }

  send(command: VoiceCommand): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(Channels.voiceCommand, command)
  }
}

/** Asks macOS for microphone access once; true when granted. */
export async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
  return systemPreferences.askForMediaAccess('microphone')
}
