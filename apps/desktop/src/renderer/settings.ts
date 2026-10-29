import { renderConnections } from './connections'
import { button, element, icon, isSnapshot, request } from './app-dom'
import type { AppSettings, AppSnapshot } from '../shared/app'
import type { ConnectionResult, KeyHints } from '../shared/providers'
import logo from '../../build/brand/logo.png?url'
import darkLogo from '../../build/brand/logo-dark.png?url'

const categories = ['General', 'Voice', 'History & privacy', 'Connection', 'About'] as const
const fields = document.getElementById('fields')!
let category = 'General', snapshot: AppSnapshot | undefined
let groupTarget = fields
let keyHints: KeyHints = {}, detailsGeneration = 0
async function refreshKeyHints(): Promise<void> {
  if (category !== 'Connection') return
  const generation = ++detailsGeneration
  const result = await request({ kind: 'connection', request: { kind: 'details' } }) as ConnectionResult | undefined
  if (category !== 'Connection' || generation !== detailsGeneration) return
  keyHints = result?.keyHints ?? {}
  if (!(document.activeElement instanceof HTMLInputElement)) render()
}
function navigate(name: string): void {
  category = name; keyHints = {}; detailsGeneration++; render()
  const main = document.querySelector('main'); if (main) main.scrollTop = 0
  if (category === 'Connection') void refreshKeyHints()
}
const nav = document.getElementById('categories')!
for (const name of categories) {
  const glyph = ({ General: 'general', Voice: 'voice', 'History & privacy': 'history', Connection: 'connection', About: 'about' } as const)[name]
  const node = button('', () => { navigate(name) }); node.append(icon(glyph), element('span', '', name)); node.dataset.category = name; nav.append(node)
}
async function update(patch: Partial<AppSettings>): Promise<void> {
  if (snapshot) await request({ kind: 'updateSettings', settings: { ...snapshot.settings, ...patch } })
}
function toggle(key: 'openAtLogin' | 'showMenuBar' | 'showNotch' | 'muted' | 'saveHistory', label: string, description?: string): void {
  const row = element('label', 'row'), text = element('span', '', label), input = element('input')
  if (description) text.append(element('small', '', description))
  input.type = 'checkbox'; input.name = key; input.id = key; input.checked = Boolean(snapshot?.settings[key]); input.onchange = () => { void update({ [key]: input.checked }) }
  row.append(text, input); groupTarget.append(row)
}
function select<T extends 'voice' | 'retention'>(key: T, label: string, options: Array<[string, AppSettings[T]]>): void {
  const row = element('label', 'row'), input = element('select')
  input.name = key; input.id = key
  for (const [text, value] of options) { const option = element('option', '', text); option.value = String(value); option.selected = value === snapshot?.settings[key]; input.append(option) }
  input.onchange = () => { const option = options.find(([, value]) => String(value) === input.value); if (option) void update({ [key]: option[1] }) }
  row.append(element('span', '', label), input); groupTarget.append(row)
}
function explanation(text: string): void { fields.append(element('p', 'explanation', text)) }
function group(title: string): void {
  fields.append(element('h2', 'section-title', title))
  groupTarget = element('section', 'settings-group'); groupTarget.setAttribute('aria-label', title); fields.append(groupTarget)
}
function intro(text: string): void { fields.append(element('p', 'settings-intro', text)) }
function microphoneRow(): void {
  const status = snapshot?.permissions.microphone ?? 'unknown'
  const names: Record<string, string> = { granted: 'Allowed', 'not-determined': 'Not requested yet', denied: 'Denied in System Settings', restricted: 'Restricted by macOS', unavailable: 'Unavailable in this build' }
  const row = element('div', 'permission'), text = element('span')
  text.append(element('strong', '', 'Microphone'), element('small', '', names[status] ?? status))
  const action = button(status === 'not-determined' ? 'Allow microphone…' : 'Open System Settings', () => { void request({ kind: 'permission', permission: 'microphone' }) }); action.id = 'microphone-permission'
  if (status === 'unavailable') { action.disabled = true; text.append(element('small', '', 'Development build: run pnpm dev:speech-permissions, then restart the app.')) }
  row.append(text, action); groupTarget.append(row)
}
function render(): void {
  if (!snapshot) return
  const focused = document.activeElement?.id
  const openSections = Array.from(fields.querySelectorAll('details')).filter(node => node.open).map(node => node.id)
  const scroll = document.querySelector('main')?.scrollTop ?? 0
  const connectionMessage = document.getElementById('connection-feedback')?.textContent
  document.getElementById('heading')!.textContent = category
  nav.querySelectorAll('button').forEach(node => node.setAttribute('aria-current', String(node.dataset.category === category)))
  fields.replaceChildren(); groupTarget = fields
  switch (category) {
    case 'General':
      intro('A quiet companion, ready when you need it.')
      group('Desktop presence')
      toggle('openAtLogin', 'Open at login', 'Start quietly in the background when you sign in.')
      toggle('showMenuBar', 'Show menu-bar icon')
      toggle('showNotch', 'Show notch pill', 'Hover for recent conversations. Click to open Home.')
      explanation('Closing Home keeps NimboGuide running. Open it again from the menu bar or notch pill; choose Quit NimboGuide to stop it.')
      break
    case 'Voice':
      intro('Hold Control + Option to speak. Release to ask.')
      group('Speaking & sound')
      if (snapshot.connection?.voice === 'OpenAI') select('voice', 'Speaking voice', [['Marin', 'marin'], ['Cedar', 'cedar'], ['Alloy', 'alloy'], ['Coral', 'coral']])
      const engine = element('div', 'row'); engine.append(element('span', '', 'Voice engine'), element('span', 'value', snapshot.connection?.voice === 'unavailable' ? 'Not available' : snapshot.connection?.voice ?? 'Not available')); groupTarget.append(engine)
      explanation('Uses OpenAI when its key is saved, otherwise built-in Mac speech. There’s nothing else to configure.')
      if (snapshot.connection?.voiceReason) explanation(snapshot.connection.voiceReason)
      toggle('muted', 'Mute speech & drawing sounds', 'The written answer and drawings remain available.')
      explanation('Hold Control + Option to speak; release to ask. Press again to interrupt the current answer. Changing the voice stops the current response.')
      group('Microphone access'); microphoneRow()
      explanation('Allow microphone access here the first time. If you previously denied it, enable NimboGuide (Electron in development) in System Settings → Privacy & Security → Microphone.')
      break
    case 'History & privacy':
      intro('Your conversations stay here. You decide what to keep.')
      group('Local history')
      toggle('saveHistory', 'Save history on this Mac', 'When off, new conversations stay in memory only. Existing saved history is not deleted.')
      select('retention', 'Keep history', [['Off', 0], ['7 days', 7], ['30 days', 30], ['90 days', 90], ['Until deleted', 'forever']])
      explanation('Saved here: questions, answers, generated drawing text and marks, times, and whether screen context was used. No screenshots, microphone audio or API key. Pinned items use the same retention. Off stops saving new conversations.')
      fields.append(element('h2', 'section-title', 'What leaves this Mac'))
      explanation('Your question and a capture of the display under your pointer go to the selected answer provider (or your local endpoint). Built-in speech is processed on this Mac; nothing is sent for voice. When an OpenAI key is saved, voice uses OpenAI and sends audio for transcription and answer text for speech. Provider handling depends on your account and policies. Local history is not local processing. Hovering never captures.')
      group('Delete history')
      const deletion = element('div', 'row'); deletion.append(element('span', '', 'Remove saved conversations'), button('Delete all…', () => { void request({ kind: 'deleteAll' }) }, 'danger')); groupTarget.append(deletion)
      explanation('Deletion removes local conversations, drawing records and search entries. This database is not encrypted. Deletion does not erase backups or data already sent to providers.')
      break
    case 'Connection':
      renderConnections(fields, snapshot, update, keyHints, () => { void refreshKeyHints() })
      break
    case 'About': {
      const picture = element('picture'), source = element('source'), image = element('img')
      source.media = '(prefers-color-scheme: dark)'; source.srcset = darkLogo
      image.src = logo; image.alt = 'NimboGuide pen buddy and ink trail'; image.width = 72; image.height = 72; image.className = 'about-logo'; picture.append(source, image)
      const brand = element('div', 'about-brand'); brand.append(picture, element('h2', '', `NimboGuide ${snapshot.version}`)); fields.append(brand)
      explanation('Explains your screen with speech and drawings.')
      group('macOS permissions')
      microphoneRow()
      for (const [key, label] of [['screen', 'Screen Recording'], ['input', 'Input Monitoring']] as const) {
        const row = element('div', 'permission'), text = element('span')
        text.append(element('strong', '', label), element('small', '', snapshot.permissions[key]))
        row.append(text, button('Open System Settings', () => { void request({ kind: 'permission', permission: key }) }))
        groupTarget.append(row)
      }
      explanation('After changing a permission, return here to refresh its status. macOS may require an app restart for a new grant.')
    }
  }
  const feedback = document.getElementById('connection-feedback'); if (feedback && connectionMessage) feedback.textContent = connectionMessage
  for (const id of openSections) { const details = document.getElementById(id) as HTMLDetailsElement | null; if (details) details.open = true }
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true })
  const main = document.querySelector('main'); if (main) main.scrollTop = scroll
}
window.nimboApp.onSnapshot(value => {
  snapshot = value
  if (category === 'Connection' && document.activeElement instanceof HTMLInputElement) return
  render()
  if (category === 'Connection') void refreshKeyHints()
})
window.nimboApp.onNavigate(value => { if (value.category && categories.some(category => category === value.category)) navigate(value.category) })
document.onkeydown = event => { if (event.key === 'Escape') window.close() }
void request({ kind: 'snapshot' }).then(value => { if (isSnapshot(value)) { snapshot = value; render() } })
