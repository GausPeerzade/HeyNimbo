import { app, screen, type BrowserWindow } from 'electron'
import type { GestureMonitor } from '@nimboguide/native'
import type { GestureMessage, NotchStatus } from '../shared/ipc'
import { AudioWindow, ensureMicrophoneAccess } from './audio-window'
import { captureCursorDisplay, ensureScreenCaptureAccess, restingStatus, scheduleExclusionSelfTest } from './capture'
import { startGestures } from './gestures'
import { loadOpenAIKey } from './secrets'
import { openSetupWindow } from './setup-window'
import { Ears } from './voice/ears'
import { Mouth } from './voice/mouth'
import { TalkSession } from './voice/talk'
import { createNotchWindow, OverlayManager, positionNotch, sendNotchStatus } from './windows'

const LABELS: Partial<Record<GestureMessage['action'], string>> = {
  dictate: 'Dictating…',
}

const TAP_LABELS: Partial<Record<GestureMessage['action'], string>> = {
  text: 'Text box',
  alwaysOn: 'Always-on toggled',
  handsFree: 'Hands-free dictation',
}

/** Routes gestures: talk goes to the voice session (once a key is set up); the
 *  other actions still only show in the notch until they are built. */
function createGesturePresenter(
  notch: BrowserWindow,
  overlays: OverlayManager,
  talk: () => TalkSession | undefined,
): (message: GestureMessage) => void {
  let idleTimer: NodeJS.Timeout | undefined
  const show = (status: NotchStatus): void => {
    clearTimeout(idleTimer)
    sendNotchStatus(notch, status)
  }
  return (message) => {
    console.info(`[gesture] ${message.action} ${message.phase}`)
    if (message.action === 'talk') {
      const session = talk()
      if (!session) return show({ kind: 'active', label: 'Add your OpenAI key first' })
      if (message.phase === 'started') {
        overlays.ring(screen.getCursorScreenPoint())
        return session.holdStarted()
      }
      overlays.clear()
      return message.phase === 'ended' ? session.holdEnded() : session.holdCancelled()
    }
    switch (message.phase) {
      case 'started':
        return show({ kind: 'active', label: LABELS[message.action] ?? message.action })
      case 'ended':
      case 'cancelled':
        return show(restingStatus())
      case 'tapped':
        show({ kind: 'active', label: TAP_LABELS[message.action] ?? message.action })
        idleTimer = setTimeout(() => show(restingStatus()), 1500)
    }
  }
}

/** Builds the voice pipeline once a key is available. */
function startTalking(key: string, notch: BrowserWindow): TalkSession {
  void ensureMicrophoneAccess()
  const ears = new Ears(key)
  const mouth = new Mouth(key)
  let session: TalkSession | undefined
  const audio = new AudioWindow((event) => session?.onAudioEvent(event))
  session = new TalkSession({
    key,
    ears,
    mouth,
    audio,
    capture: captureCursorDisplay,
    onStatus: (label) => sendNotchStatus(notch, label ? { kind: 'active', label } : restingStatus()),
  })
  ears.warm()
  mouth.warm()
  return session
}

let monitor: GestureMonitor | undefined

app.whenReady().then(async () => {
  app.dock?.hide()
  const notch = createNotchWindow()
  const overlays = new OverlayManager()
  overlays.sync()
  const resync = (): void => {
    overlays.sync()
    positionNotch(notch)
  }
  screen.on('display-added', resync)
  screen.on('display-removed', resync)
  screen.on('display-metrics-changed', resync)
  scheduleExclusionSelfTest((point) => overlays.ring(point))

  let talk: TalkSession | undefined
  const started = startGestures(createGesturePresenter(notch, overlays, () => talk))
  if (started.ok) {
    monitor = started.monitor
    ensureScreenCaptureAccess()
    sendNotchStatus(notch, restingStatus())
  } else if (started.reason === 'inputMonitoring')
    sendNotchStatus(notch, { kind: 'needsPermission', permission: 'inputMonitoring' })
  else sendNotchStatus(notch, { kind: 'active', label: started.reason })

  const key = await loadOpenAIKey()
  if (key) talk = startTalking(key, notch)
  else openSetupWindow((saved) => (talk = startTalking(saved, notch)))
})

// A menu-bar style app keeps running with no focused window.
app.on('window-all-closed', () => {})
app.on('will-quit', () => monitor?.stop())
