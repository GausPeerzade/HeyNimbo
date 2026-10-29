import { mkdirSync, writeFileSync } from 'node:fs'
import { app, nativeTheme, session } from 'electron'
import { AppChannels } from '../shared/app'
import { AppShell } from './app-shell'
import { devFlag } from './dev'
import { isolateDevProfile } from './dev-profile'

export function configureHomePreview(): void {
  if (!devFlag('NIMBO_DEBUG_HOME_PREVIEW')) return
  const cleanup = isolateDevProfile('home-preview')
  setTimeout(() => { cleanup(); app.exit(1) }, 28000).unref()
}

/** Only app-owned windows are captured; no capture/audio/credential path runs. */
export async function runHomePreview(): Promise<void> {
  app.dock?.hide()
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('file:') }))
  const shell = new AppShell({ ask() { return { accepted: true } }, stop() {}, clear() {}, replaceKey() {}, settingsChanged() {}, permissions: () => ({ microphone: 'Preview only', screen: 'Preview only', input: 'Preview only' }) }, true)
  shell.keyPresent = true
  const output = '/tmp/nimbo-app-validation'
  mkdirSync(output, { recursive: true })
  const pause = () => new Promise(resolve => setTimeout(resolve, 450))
  const capture = async (window: Electron.BrowserWindow) => {
    await window.webContents.executeJavaScript("Promise.all(Array.from(document.images, image => image.decode().catch(() => {})))")
    return (await window.webContents.capturePage()).toPNG()
  }
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    shell.conversations.deleteAll()
    const home = shell.openHome(), settings = shell.openSettings()
    await pause()
    shell.keyPresent = false; shell.publish(); await pause()
    writeFileSync(`${output}/home-unconnected-${theme}.png`, await capture(home))
    shell.keyPresent = true; shell.publish(); await pause()
    writeFileSync(`${output}/home-empty-${theme}.png`, await capture(home))
    const first = shell.conversations.newConversation()
    const turn = shell.conversations.begin('Where can I export this chart?', 'voice')
    shell.conversations.update(turn, 'Choose Export in the upper-right corner. The download menu lets you save the chart as a PDF.', { version: 1, beats: [{ sentence: 'Choose Export in the upper-right corner.', marks: [{ kind: 'box', x: 700, y: 90, w: 160, h: 50 }, { kind: 'arrow', x1: 500, y1: 240, x2: 720, y2: 130 }, { kind: 'text', x: 480, y: 280, text: 'Export your chart' }], space: { frame: { x: 0, y: 0, width: 960, height: 600 }, pixelWidth: 960, pixelHeight: 600 } }] }, true)
    shell.conversations.finish(turn, 'complete'); shell.conversations.pin(first, true)
    shell.conversations.newConversation()
    const second = shell.conversations.begin('Explain this warning', 'text'); shell.conversations.update(second, 'The file has unsaved changes. Save your work before closing.', { version: 1, beats: [] }, true); shell.conversations.finish(second, 'interrupted')
    shell.conversations.open(first); shell.publish()
    await pause()
    writeFileSync(`${output}/home-populated-${theme}.png`, await capture(home))
    writeFileSync(`${output}/settings-${theme}.png`, await capture(settings))
    for (const category of ['History & privacy', 'About', 'Connection', 'Voice']) {
      settings.webContents.send(AppChannels.navigate, { category }); await pause()
      writeFileSync(`${output}/settings-${category.split(' ')[0]!.toLowerCase()}-${theme}.png`, await capture(settings))
    }
    settings.webContents.send(AppChannels.navigate, { category: 'General' })
    home.setSize(720, 520); await pause()
    writeFileSync(`${output}/home-narrow-${theme}.png`, await capture(home))
    home.setSize(960, 680)
  }
  shell.home?.destroy(); shell.preferences?.destroy(); shell.close()
  app.quit()
}
