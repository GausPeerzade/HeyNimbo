import { app, screen, systemPreferences, type BrowserWindow } from 'electron'
import { hasInputMonitoringAccess, hasScreenCaptureAccess, type GestureMonitor } from '@nimboguide/native'
import { AppShell } from './app-shell'
import { NotchPeek } from './notch-peek'
import { configureHomePreview, runHomePreview } from './home-preview'
import { devFlag } from './dev'
import type { GestureMessage, NotchStatus } from '../shared/ipc'
import { AudioWindow, ensureMicrophoneAccess } from './audio-window'
import { captureCursorDisplay, ensureScreenCaptureAccess, restingStatus, scheduleExclusionSelfTest } from './capture'
import { startGestures } from './gestures'
import { loadOpenAIKey } from './secrets'
import { openSetupWindow } from './setup-window'
import { limitDrawDemoRuntime, scheduleDrawDemo } from './draw-demo'
import { Ears } from './voice/ears'
import { Mouth } from './voice/mouth'
import { TalkSession } from './voice/talk'
import { createNotchWindow, OverlayManager, positionNotch, sendNotchStatus, setNotchVisibility } from './windows'

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
        // A new question replaces whatever the last answer was still drawing.
        overlays.clear()
        overlays.listen(true)
        return session.holdStarted()
      }
      overlays.listen(false)
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
function startTalking(key: string, notch: BrowserWindow, overlays: OverlayManager, audio: AudioWindow, shell: AppShell): TalkSession {
  void ensureMicrophoneAccess()
  const ears = new Ears(key)
  const mouth = new Mouth(key, shell.settings.get().voice)
  const session = new TalkSession({
    key,
    conversations: shell.conversations,
    ears,
    mouth,
    audio,
    capture: captureCursorDisplay,
    onStatus: (label) => { shell.setStatus(label); sendNotchStatus(notch, label ? { kind: 'active', label } : restingStatus()) },
    drawing: {
      draw: (marks, durationMs, space) => overlays.drawBeat(marks, durationMs, space),
      answerDone: () => overlays.answerDone(),
    },
  })
  ears.warm()
  mouth.warm()
  return session
}

let monitor: GestureMonitor | undefined
configureHomePreview()
limitDrawDemoRuntime()
const ownsInstance = devFlag('NIMBO_DEBUG_HOME_PREVIEW') || app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()

if (ownsInstance) app.whenReady().then(async () => {
  if (devFlag('NIMBO_DEBUG_HOME_PREVIEW')) return runHomePreview()
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
  overlays.startFollowing()
  if (scheduleDrawDemo(overlays)) return
  scheduleExclusionSelfTest((point) => overlays.ring(point))

  let talk: TalkSession | undefined
  let key: string | undefined
  const shell = new AppShell({
    ask: (question) => { overlays.clear(); talk?.askText(question) },
    stop: () => { talk?.holdCancelled(); overlays.listen(false); overlays.clear() },
    clear: () => overlays.clear(),
    replaceKey: () => openSetupWindow((saved) => { key = saved; reconnect() }),
    settingsChanged: (settings, previous) => {
      setNotchVisibility(notch, settings.showNotch)
      audio.send({ kind: 'mute', muted: settings.muted })
      if (settings.voice !== previous.voice) reconnect()
    },
    permissions: () => ({
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      screen: hasScreenCaptureAccess() ? 'granted' : 'not granted',
      input: hasInputMonitoringAccess() ? 'granted' : 'not granted',
    }),
  })
  const audio = new AudioWindow((event) => talk?.onAudioEvent(event))
  const reconnect = (): void => {
    talk?.close()
    if (key) talk = startTalking(key, notch, overlays, audio, shell)
    shell.keyPresent = Boolean(key); shell.publish()
  }
  const peek = new NotchPeek(notch, shell)
  shell.onChanged = snapshot => peek.publish(snapshot)
  if (!app.getLoginItemSettings().wasOpenedAtLogin) shell.openHome()
  setNotchVisibility(notch, shell.settings.get().showNotch)
  audio.send({ kind: 'mute', muted: shell.settings.get().muted })
  app.on('before-quit', () => { monitor?.stop(); talk?.close(); audio.close(); overlays.close(); peek.close(); if (!notch.isDestroyed()) notch.destroy(); shell.close() })
  overlays.onStrokeStarted = (durationMs) => audio.send({ kind: 'scribble', durationMs })
  const started = startGestures(createGesturePresenter(notch, overlays, () => talk))
  if (started.ok) {
    monitor = started.monitor
    ensureScreenCaptureAccess()
    sendNotchStatus(notch, restingStatus())
  } else if (started.reason === 'inputMonitoring')
    sendNotchStatus(notch, { kind: 'needsPermission', permission: 'inputMonitoring' })
  else sendNotchStatus(notch, { kind: 'active', label: started.reason })

  key = await loadOpenAIKey()
  reconnect()
})

// A menu-bar style app keeps running with no focused window.
app.on('window-all-closed', () => {})
app.on('will-quit', () => monitor?.stop())
