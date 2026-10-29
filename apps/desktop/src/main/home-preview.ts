import { mkdirSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { defaultConnectionSettings, PRESETS, selectedModel, PROVIDERS, type ConnectionSnapshot } from '../shared/providers'
import { AppChannels } from '../shared/app'
import { Channels } from '../shared/ipc'
import { AppShell } from './app-shell'
import { devFlag } from './dev'
import { isolateDevProfile } from './dev-profile'
import { loadPage, secureWebPreferences } from './windows'
let cleanup: (() => void) | undefined

export function configureHomePreview(): void {
  if (!devFlag('NIMBO_DEBUG_HOME_PREVIEW')) return
  cleanup = isolateDevProfile('home-preview')
  // Long enough for every screen in both themes; the profile goes with the exit.
  setTimeout(() => { cleanup?.(); app.exit(1) }, 60000).unref()
}

/** Only app-owned, never-shown windows are captured; no capture/audio/credential path runs. */
export async function runHomePreview(): Promise<void> {
  app.dock?.hide()
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('file:') }))
  const shell = new AppShell({ ask() { return { accepted: true } }, stop() {}, clear() {}, replaceKey() {}, settingsChanged() {}, connectionSnapshot: (): ConnectionSnapshot => {
    const config = shell.settings.get().connection ?? defaultConnectionSettings(), model = selectedModel(config)
    return { providers: Object.fromEntries(PROVIDERS.map(p => [p, true])) as ConnectionSnapshot['providers'], accounts: [{ id: 'preview-account', name: 'Alex Example', email: 'alex@example.invalid', connected: true, sharing: true }], activeAccount: 'preview-account', models: [...new Map(Object.values(PRESETS[config.provider]).filter(p => p.model).map(p => [p.model, { id: p.model, name: p.model, vision: p.vision, tested: false }])).values()], answerModel: model.model, answerVision: model.vision, voice: config.provider === 'compatible' ? 'unavailable' : 'OpenAI key' }
  }, permissions: () => ({ microphone: 'Preview only', screen: 'Preview only', input: 'Preview only' }) }, true)
  shell.keyPresent = true
  const output = '/tmp/nimbo-auth-validation'
  mkdirSync(output, { recursive: true })
  const pause = () => new Promise(resolve => setTimeout(resolve, 350))
  const diagnostics: Record<string, unknown> = {}
  const errors: string[] = []
  const observe = (window: BrowserWindow) => {
    window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
    window.webContents.on('did-fail-load', (_event, code, message) => errors.push(`${code}: ${message}`))
  }
  const capture = async (window: BrowserWindow, name: string) => {
    await window.webContents.executeJavaScript("Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode().catch(() => {}))])")
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    if (name.startsWith('home-unconnected') && !await window.webContents.executeJavaScript("Boolean(document.querySelector('.connection-needed'))")) throw new Error(`Wrong preview state: ${name}`)
    if (name.startsWith('home-') && !await window.webContents.executeJavaScript("document.getElementById('screen-context').textContent === 'Includes a screen capture when you ask'")) throw new Error(`Misleading capture copy: ${name}`)
    if (name.startsWith('home-empty')) {
      const gap = await window.webContents.executeJavaScript("document.getElementById('composer').getBoundingClientRect().top - document.querySelector('.empty').getBoundingClientRect().bottom") as number
      if (gap < 0 || gap > 32) throw new Error(`Empty instruction detached from composer: ${gap}`)
      diagnostics[`empty-gap-${name}`] = gap
    }
    diagnostics[name] = await window.webContents.executeJavaScript(`({ visible: ${window.isVisible()}, overflowX: document.documentElement.scrollWidth > innerWidth, overflowY: document.body.scrollHeight > innerHeight, fonts: document.fonts.status, peekBottom: document.getElementById('peek')?.getBoundingClientRect().bottom, height: innerHeight })`)
    writeFileSync(`${output}/${name}.png`, (await window.webContents.capturePage()).toPNG())
  }
  const setup = new BrowserWindow({ width: 460, height: 560, show: false, paintWhenInitiallyHidden: true, webPreferences: { ...secureWebPreferences('setup'), backgroundThrottling: false } })
  const notch = new BrowserWindow({ width: 384, height: 420, frame: false, transparent: true, backgroundColor: '#00000000', show: false, paintWhenInitiallyHidden: true, webPreferences: { ...secureWebPreferences(), backgroundThrottling: false } })
  observe(setup); observe(notch)
  await Promise.all([loadPage(setup, 'setup'), loadPage(notch, 'notch')])
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    shell.conversations.deleteAll()
    shell.settings.set({ ...shell.settings.get(), connection: defaultConnectionSettings() })
    const home = shell.openHome(), settings = shell.openSettings()
    home.webContents.setBackgroundThrottling(false); settings.webContents.setBackgroundThrottling(false)
    if (theme === 'light') { observe(home); observe(settings) }
    await pause()
    shell.keyPresent = false; shell.publish(true); await pause()
    await capture(home, `home-unconnected-${theme}`)
    shell.keyPresent = true; shell.publish(true); await pause()
    await capture(home, `home-empty-${theme}`)
    home.setSize(720, 520); await pause(); await capture(home, `home-empty-narrow-${theme}`); home.setSize(960, 680)
    notch.webContents.send(Channels.notchStatus, { kind: 'idle' })
    notch.webContents.send(AppChannels.snapshot, shell.snapshot())
    await notch.webContents.executeJavaScript("window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 400 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: 192, clientY: 20 }))")
    await pause(); await pause(); await capture(notch, `peek-empty-${theme}`)
    notch.webContents.send('nimbo:peek-dismiss')
    const first = shell.conversations.newConversation()
    const turn = shell.conversations.begin('Where can I export this chart?', 'voice')
    shell.conversations.update(turn, 'Choose Export in the upper-right corner. The download menu lets you save the chart as a PDF.', { version: 1, beats: [{ sentence: 'Choose Export in the upper-right corner.', marks: [{ kind: 'box', x: 700, y: 90, w: 160, h: 50 }, { kind: 'arrow', x1: 500, y1: 240, x2: 720, y2: 130 }, { kind: 'text', x: 480, y: 280, text: 'Export your chart' }], space: { frame: { x: 0, y: 0, width: 960, height: 600 }, pixelWidth: 960, pixelHeight: 600 } }] }, true)
    shell.conversations.finish(turn, 'complete'); shell.conversations.pin(first, true)
    shell.conversations.newConversation()
    const second = shell.conversations.begin('Explain this warning', 'text'); shell.conversations.update(second, 'The file has unsaved changes. Save your work before closing.', { version: 1, beats: [] }, true); shell.conversations.finish(second, 'interrupted')
    shell.conversations.newConversation()
    const third = shell.conversations.begin('Where are my downloads?', 'text'); shell.conversations.update(third, 'Open Downloads in Finder to see saved files.', { version: 1, beats: [] }, true); shell.conversations.finish(third, 'complete')
    shell.conversations.open(first); shell.publish(true); await pause()
    await capture(home, `home-populated-${theme}`)
    await home.webContents.executeJavaScript("{ const search = document.getElementById('search'); search.value = 'export'; search.dispatchEvent(new Event('input')) }")
    await pause(); await capture(home, `home-searching-${theme}`)
    await home.webContents.executeJavaScript("document.getElementById('search').value = 'no matching question'; document.getElementById('search').dispatchEvent(new Event('input'))")
    await pause(); await capture(home, `home-search-empty-${theme}`)
    await home.webContents.executeJavaScript("document.getElementById('search').value = ''; document.getElementById('search').dispatchEvent(new Event('input'))")
    shell.setStatus('Drawing an explanation…'); shell.publish(true); await pause()
    await capture(home, `home-busy-${theme}`)
    shell.setStatus(undefined)
    for (const category of ['General', 'Voice', 'History & privacy', 'Connection', 'About']) {
      settings.webContents.send(AppChannels.navigate, { category }); await pause()
      await capture(settings, `settings-${category.split(' ')[0]!.toLowerCase()}-${theme}`)
    }
    home.setSize(720, 520); await pause(); await capture(home, `home-narrow-${theme}`)
    for (const draft of ['wrapped', 'overflow'] as const) {
      await home.webContents.executeJavaScript(`{ const question = document.getElementById('question'); question.value = 'Could you point me to the export menu and explain whether choosing PDF will keep the chart labels readable? I want to send this chart to a colleague without changing the original file. '.repeat(${draft === 'wrapped' ? 1 : 8}); question.dispatchEvent(new Event('input')); question.focus() }`)
      await pause(); await capture(home, `home-draft-${draft}-${theme}`)
      const metrics = await home.webContents.executeJavaScript(`(() => { const q = document.getElementById('question'), style = getComputedStyle(q); return { lines: (q.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight), scrolling: q.scrollHeight > q.clientHeight + 1, composerBottom: document.querySelector('.composer-area').getBoundingClientRect().bottom, viewport: innerHeight, intrinsicSizing: CSS.supports('field-sizing', 'content') } })()`) as { lines: number; scrolling: boolean; composerBottom: number; viewport: number; intrinsicSizing: boolean }
      diagnostics[`draft-${draft}-${theme}`] = metrics
      if (!metrics.intrinsicSizing || metrics.lines > 5.1 || metrics.composerBottom > metrics.viewport || (draft === 'wrapped' ? metrics.lines <= 1.1 || metrics.scrolling : metrics.lines < 4.9 || !metrics.scrolling)) throw new Error(`Textarea sizing failed: ${JSON.stringify(metrics)}`)
    }
    await home.webContents.executeJavaScript("document.getElementById('question').value = ''; document.getElementById('question').dispatchEvent(new Event('input'))")
    await pause()
    const resetLines = await home.webContents.executeJavaScript("(() => { const q = document.getElementById('question'), s = getComputedStyle(q); return (q.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)) / parseFloat(s.lineHeight) })()") as number
    if (resetLines > 1.1) throw new Error(`Textarea did not shrink: ${resetLines}`)
    diagnostics[`draft-reset-${theme}`] = resetLines
    home.setSize(960, 680)
    for (const provider of ['chatgpt', 'openai', 'anthropic'] as const) {
      const config = shell.settings.get().connection ?? defaultConnectionSettings()
      shell.settings.set({ ...shell.settings.get(), connection: { ...config, provider } })
      shell.publish(true); settings.webContents.send(AppChannels.navigate, { category: 'Connection' }); await pause()
      await capture(settings, `connection-${provider}-${theme}`)
      if (provider === 'chatgpt') {
        await settings.webContents.executeJavaScript("{ const voice = document.getElementById('connection-voice'); voice.open = true; voice.scrollIntoView() }")
        await pause(); await capture(settings, `connection-chatgpt-voice-${theme}`)
        await settings.webContents.executeJavaScript("document.getElementById('connection-voice').open = false")
      }
      await settings.webContents.executeJavaScript("document.getElementById('connection-model-section').scrollIntoView()")
      await pause(); await capture(settings, `connection-${provider}-models-${theme}`)
      await settings.webContents.executeJavaScript("document.querySelector('main').scrollTop = 0")
      await setup.webContents.executeJavaScript(`{ const provider = document.getElementById('provider'); provider.value = '${provider}'; provider.dispatchEvent(new Event('change')) }`)
      await pause(); await capture(setup, `setup-${provider}-${theme}`)
    }
    {
      const config = shell.settings.get().connection ?? defaultConnectionSettings()
      shell.settings.set({ ...shell.settings.get(), connection: { ...config, provider: 'compatible', models: { ...config.models, compatible: { preset: 'custom', customModel: 'local-text' } } } })
      shell.publish(true); settings.webContents.send(AppChannels.navigate, { category: 'Connection' }); await pause()
      await capture(settings, `connection-local-${theme}`)
      await settings.webContents.executeJavaScript("{ const advanced = document.getElementById('connection-advanced'); advanced.open = true; advanced.scrollIntoView() }")
      await pause(); await capture(settings, `connection-local-advanced-${theme}`)
      await settings.webContents.executeJavaScript("document.getElementById('connection-advanced').open = false; document.getElementById('connection-model-section').scrollIntoView()")
      await pause(); await capture(settings, `connection-local-models-${theme}`)
      settings.setSize(680, 520); await pause(); await capture(settings, `connection-local-narrow-${theme}`)
      await settings.webContents.executeJavaScript("{ const advanced = document.getElementById('connection-advanced'); advanced.open = true; advanced.scrollIntoView() }")
      await pause(); await capture(settings, `connection-local-advanced-narrow-${theme}`)
      const overflow = await settings.webContents.executeJavaScript("document.documentElement.scrollWidth > innerWidth || document.getElementById('fields').scrollWidth > document.getElementById('fields').clientWidth")
      if (overflow) throw new Error('Connection fields overflow their window.')
      settings.setSize(760, 610); await settings.webContents.executeJavaScript("document.querySelector('main').scrollTop = 0")
    }
    notch.webContents.send('nimbo:peek-dismiss')
    notch.webContents.send(Channels.notchStatus, { kind: 'idle' })
    notch.webContents.send(AppChannels.snapshot, shell.snapshot())
    await pause(); await capture(notch, `pill-${theme}`)
    // Leave first to clear Escape/dismiss suppression, then exercise actual hover.
    await notch.webContents.executeJavaScript("window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 400 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: 192, clientY: 20 }))")
    await pause(); await pause(); await capture(notch, `peek-${theme}`)
    await notch.webContents.executeJavaScript("document.getElementById('surface').dispatchEvent(new MouseEvent('mouseleave'))")
    await new Promise(resolve => setTimeout(resolve, 170))
    diagnostics[`peek-exit-${theme}`] = await notch.webContents.executeJavaScript("({ inert: document.getElementById('peek').inert, hidden: document.getElementById('peek').hidden, display: getComputedStyle(document.getElementById('peek')).display, opacity: getComputedStyle(document.getElementById('peek')).opacity })")
    await capture(notch, `peek-exiting-${theme}`)
    await pause()
    diagnostics[`peek-closed-${theme}`] = await notch.webContents.executeJavaScript("({ inert: document.getElementById('peek').inert, display: getComputedStyle(document.getElementById('peek')).display })")
  }
  writeFileSync(`${output}/diagnostics.json`, JSON.stringify({ screens: diagnostics, errors }, null, 2))
  setup.destroy(); notch.destroy(); shell.home?.destroy(); shell.preferences?.destroy(); shell.close()
  cleanup?.()
  app.quit()
}
