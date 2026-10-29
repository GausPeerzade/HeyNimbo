import { app, screen, type BrowserWindow } from 'electron'
import type { GestureMonitor } from '@nimboguide/native'
import type { GestureMessage, NotchStatus } from '../shared/ipc'
import { startGestures } from './gestures'
import { createNotchWindow, OverlayManager, positionNotch, sendNotchStatus } from './windows'

const LABELS: Partial<Record<GestureMessage['action'], string>> = {
  talk: 'Listening…',
  dictate: 'Dictating…',
}

const TAP_LABELS: Partial<Record<GestureMessage['action'], string>> = {
  text: 'Text box',
  alwaysOn: 'Always-on toggled',
  handsFree: 'Hands-free dictation',
}

/** Phase 0 presenter: shows each gesture in the notch and rings the cursor while
 *  talking, proving input, notch and per-display overlays work end to end. */
function createGesturePresenter(notch: BrowserWindow, overlays: OverlayManager): (message: GestureMessage) => void {
  let idleTimer: NodeJS.Timeout | undefined
  const show = (status: NotchStatus): void => {
    clearTimeout(idleTimer)
    sendNotchStatus(notch, status)
  }
  return (message) => {
    console.info(`[gesture] ${message.action} ${message.phase}`)
    switch (message.phase) {
      case 'started':
        show({ kind: 'active', label: LABELS[message.action] ?? message.action })
        if (message.action === 'talk') overlays.ring(screen.getCursorScreenPoint())
        return
      case 'ended':
      case 'cancelled':
        overlays.clear()
        show({ kind: 'idle' })
        return
      case 'tapped':
        show({ kind: 'active', label: TAP_LABELS[message.action] ?? message.action })
        idleTimer = setTimeout(() => show({ kind: 'idle' }), 1500)
    }
  }
}

let monitor: GestureMonitor | undefined

app.whenReady().then(() => {
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
  const started = startGestures(createGesturePresenter(notch, overlays))
  if (started.ok) monitor = started.monitor
  else if (started.reason === 'inputMonitoring')
    sendNotchStatus(notch, { kind: 'needsPermission', permission: 'inputMonitoring' })
  else sendNotchStatus(notch, { kind: 'active', label: started.reason })
})

// A menu-bar style app keeps running with no focused window.
app.on('window-all-closed', () => {})
app.on('will-quit', () => monitor?.stop())
