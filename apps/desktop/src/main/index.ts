import { app, dialog, screen, type BrowserWindow } from 'electron'
import { hasInputMonitoringAccess, hasScreenCaptureAccess, type GestureMonitor } from '@heynimbo/native'
import { AppShell } from './app-shell'
import { NotchPeek } from './notch-peek'
import { configureHomePreview, runHomePreview } from './home-preview'
import { devFlag, devSetting } from './dev'
import type { GestureMessage, NotchStatus } from '../shared/ipc'
import { AudioWindow, microphoneAccessStatus } from './audio-window'
import { captureCursorDisplay, restingStatus, scheduleExclusionSelfTest } from './capture'
import { startGestures } from './gestures'
import { Connections } from './connections'
import { openSetupWindow } from './setup-window'
import { configureDrawDemo, limitDrawDemoRuntime, scheduleDrawDemo } from './draw-demo'
import { configureModelGallery, runModelGallery } from './model-gallery'
import { configureModelEval, runModelEval } from './model-eval'
import { configureModelShow, runModelShow } from './model-show'
import { Ears } from './voice/ears'
import { Mouth } from './voice/mouth'
import { OPENAI_KEY_REJECTED } from './openai/realtime'
import { BuiltInEars } from './voice/builtin-ears'
import { BuiltInMouth } from './voice/builtin-mouth'
import { TalkSession } from './voice/talk'
import { NimboAgent, type ApprovalAnswer } from './agent/engine'
import { designModel } from './agent/designer'
import type { Approval } from './agent/policy'
import { createNotchWindow, OverlayManager, positionNotch, sendNotchStatus, setNotchVisibility } from './windows'
import type { CaptureSpace } from './overlay-geometry'

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
      if (!session || session.voiceAvailable === false) return show({ kind: 'active', label: session?.voiceUnavailableReason ?? 'Voice unavailable. Open Settings → Voice.' })
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

/** Voice follows saved credentials and local permission, independently of answers. */
/** The cursor's display in overlay coordinates: where an answer draws when no screenshot exists. */
function cursorCanvas(): CaptureSpace {
  const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return { frame: bounds, pixelWidth: bounds.width, pixelHeight: bounds.height }
}

/** The owner decides each risky action in a sheet on Home whose text main builds, not the model.
 *  A sheet needs a parent: a parentless dialog runs app-modal and freezes the main process. */
async function approve(approval: Approval, signal: AbortSignal, home: () => BrowserWindow): Promise<ApprovalAnswer> {
  if (signal.aborted) return 'deny'
  const { response } = await dialog.showMessageBox(home(), {
    type: 'question', message: approval.title, detail: approval.detail, signal,
    buttons: ['Deny', 'Allow once', approval.tool === 'bash' ? 'Allow commands in this conversation' : 'Allow in this conversation'], defaultId: 1, cancelId: 0,
  })
  return signal.aborted ? 'deny' : (['deny', 'once', 'conversation'] as const)[response] ?? 'deny'
}

function startTalking(key: string | undefined, agent: NimboAgent, notch: BrowserWindow, overlays: OverlayManager, audio: AudioWindow, shell: AppShell, connections: Connections, reconnect: () => void): TalkSession {
  const voice = connections.voiceEngine
  const ears = voice.engine === 'openai' && key ? new Ears(key) : voice.engine === 'builtin' ? new BuiltInEars() : undefined
  const mouth = voice.engine === 'openai' && key ? new Mouth(key, shell.settings.get().voice) : voice.engine === 'builtin' ? new BuiltInMouth(audio) : undefined
  const session = new TalkSession({
    agent, design: designModel, answer: () => connections.answer(),
    conversations: shell.conversations,
    ears,
    mouth,
    voiceUnavailableReason: voice.engine === 'unavailable' ? voice.reason : undefined,
    // Deferred: reconnecting closes the session that is reporting the failure, and clears the notch,
    // so the reason is shown again afterwards.
    onVoiceKeyRejected: () => setTimeout(() => {
      connections.rejectVoiceKey(); reconnect()
      shell.setStatus(OPENAI_KEY_REJECTED); sendNotchStatus(notch, { kind: 'active', label: OPENAI_KEY_REJECTED })
      setTimeout(() => { if (shell.snapshot().status === OPENAI_KEY_REJECTED) { shell.setStatus(undefined); sendNotchStatus(notch, restingStatus()) } }, 6_000)
    }),
    audio,
    capture: captureCursorDisplay,
    canvas: cursorCanvas,
    onStatus: (label) => { shell.setStatus(label); sendNotchStatus(notch, label ? { kind: 'active', label } : restingStatus()) },
    drawing: {
      draw: (marks, durationMs, space) => overlays.drawBeat(marks, durationMs, space),
      prepare: (marks, space) => overlays.prepare(marks, space),
      answerDone: () => overlays.answerDone(),
    },
  })
  ears?.warm()
  mouth?.warm()
  return session
}

let monitor: GestureMonitor | undefined
configureHomePreview()
configureDrawDemo()
configureModelGallery()
configureModelEval()
configureModelShow()
limitDrawDemoRuntime()
const ownsInstance = devFlag('HEYNIMBO_DEBUG_HOME_PREVIEW') || app.requestSingleInstanceLock()
if (!ownsInstance) {
  // A live eval or live show shares the normal profile, so the running app must be quit first.
  if (devFlag('HEYNIMBO_DEBUG_3D_EVAL') || devFlag('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE')) console.error('[eval] Quit the running HeyNimbo first; it holds this profile.')
  app.quit()
}

if (ownsInstance) app.whenReady().then(async () => {
  if (devFlag('HEYNIMBO_DEBUG_HOME_PREVIEW')) return runHomePreview()
  app.dock?.hide()
  if (devFlag('HEYNIMBO_DEBUG_3D_GALLERY')) return runModelGallery()
  if (devSetting('HEYNIMBO_DEBUG_3D_EVAL_SHOW') || devFlag('HEYNIMBO_DEBUG_3D_EVAL_SHOW_LIVE')) return runModelShow()
  if (devFlag('HEYNIMBO_DEBUG_3D_EVAL')) return runModelEval()
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
  let connections: Connections
  const agent = new NimboAgent({
    dataDir: app.getPath('userData'),
    approve: (approval, signal) => { shell.setStatus('Waiting for your OK in HeyNimbo…'); return approve(approval, signal, () => shell.openHome()) },
  })
  const shell = new AppShell({
    ask: (question) => {
      if (!talk) throw new Error('The voice connection is not ready. Try again.')
      overlays.clear(); return talk.askText(question)
    },
    stop: () => { talk?.holdCancelled(); overlays.listen(false); overlays.clear() },
    clear: () => { talk?.holdCancelled(); overlays.listen(false); overlays.clear() },
    replaceKey: () => openSetupWindow(request => connections.request(request, { selectSavedProvider: true })),
    connectionRequest: request => connections.request(request),
    connectionSnapshot: () => connections.snapshot(),
    forget: id => agent.drop(id),
    validateSettings: async settings => ({ ...settings, connection: await connections.validateSettings(settings.connection) }),
    settingsChanged: (settings, previous) => {
      setNotchVisibility(notch, settings.showNotch)
      audio.send({ kind: 'mute', muted: settings.muted })
      if (settings.voice !== previous.voice || JSON.stringify(settings.connection) !== JSON.stringify(previous.connection)) reconnect()
    },
    permissions: () => ({
      microphone: microphoneAccessStatus(),
      screen: hasScreenCaptureAccess() ? 'granted' : 'not granted',
      input: hasInputMonitoringAccess() ? 'granted' : 'not granted',
    }),
  })
  const audio = new AudioWindow((event) => talk?.onAudioEvent(event))
  const reconnect = (): void => {
    try { talk?.close() } finally { overlays.listen(false) }
    talk = startTalking(connections.voiceKey, agent, notch, overlays, audio, shell, connections, reconnect)
    shell.keyPresent = connections.answerReady; shell.publish()
  }
  connections = new Connections(shell.settings, reconnect, () => { shell.openSettings('Connection') })
  const peek = new NotchPeek(notch, shell)
  shell.onChanged = snapshot => peek.publish(snapshot)
  if (!app.getLoginItemSettings().wasOpenedAtLogin) shell.openHome()
  setNotchVisibility(notch, shell.settings.get().showNotch)
  audio.send({ kind: 'mute', muted: shell.settings.get().muted })
  app.on('before-quit', () => {
    screen.removeListener('display-added', resync); screen.removeListener('display-removed', resync); screen.removeListener('display-metrics-changed', resync)
    monitor?.stop(); talk?.close(); agent.close(); audio.close(); overlays.close(); peek.close(); if (!notch.isDestroyed()) notch.destroy(); shell.close() })
  overlays.onStrokeStarted = (durationMs) => audio.send({ kind: 'scribble', durationMs })
  const started = startGestures(createGesturePresenter(notch, overlays, () => talk))
  if (started.ok) {
    monitor = started.monitor
    sendNotchStatus(notch, restingStatus())
  } else if (started.reason === 'inputMonitoring') {
    sendNotchStatus(notch, { kind: 'needsPermission', permission: 'inputMonitoring' })
    // The notch can be hidden in Settings; without this the hold chord silently does nothing.
    shell.setStatus('Hold-to-talk unavailable: turn on HeyNimbo in System Settings → Privacy & Security → Input Monitoring, then reopen HeyNimbo.')
  } else sendNotchStatus(notch, { kind: 'active', label: started.reason })

  try { await connections.load() } catch { shell.setStatus('Connection storage unavailable; reconnect in Settings.') }
  reconnect()
  if (!connections.answerReady) openSetupWindow(request => connections.request(request, { selectSavedProvider: true }))
})

// A menu-bar style app keeps running with no focused window.
app.on('window-all-closed', () => {})
app.on('will-quit', () => monitor?.stop())
