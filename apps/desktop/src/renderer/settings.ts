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
/** A titled group; an empty title groups rows without a heading. */
function group(title = ''): void {
  if (title) fields.append(element('h2', 'section-title', title))
  groupTarget = element('section', 'settings-group'); groupTarget.setAttribute('aria-label', title || category); fields.append(groupTarget)
}
function value(label: string, text: string): void {
  const row = element('div', 'row'); row.append(element('span', '', label), element('span', 'value', text)); groupTarget.append(row)
}
const STATUS: Record<string, string> = { granted: 'Allowed', 'not granted': 'Not allowed', 'not-determined': 'Not asked yet', denied: 'Not allowed', restricted: 'Blocked by macOS', unavailable: 'Unavailable in this build' }
/** One permission: its state, and the one action that fixes it. Nothing to do when it is allowed. */
function permissionRow(key: 'microphone' | 'screen' | 'input', label: string): void {
  const status = snapshot?.permissions[key] ?? 'unknown'
  const row = element('div', 'permission'), text = element('span')
  text.append(element('strong', '', label), element('small', '', STATUS[status] ?? status))
  row.append(text)
  if (status !== 'granted' && status !== 'unavailable') {
    const action = button(key === 'microphone' && status === 'not-determined' ? 'Allow…' : 'Open System Settings', () => { void request({ kind: 'permission', permission: key }) })
    action.id = `${key}-permission`; row.append(action)
  }
  groupTarget.append(row)
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
      group()
      toggle('openAtLogin', 'Open at login')
      toggle('showMenuBar', 'Show in menu bar')
      toggle('showNotch', 'Show notch pill', 'Hover for recent conversations.')
      break
    case 'Voice': {
      group()
      value('Talk', 'Hold Control + Option')
      const voice = snapshot.connection?.voice
      value('Engine', voice === 'OpenAI' ? 'OpenAI' : voice === 'Built into your Mac' ? 'Mac speech' : 'Not available')
      if (voice === 'OpenAI') select('voice', 'Voice', [['Marin', 'marin'], ['Cedar', 'cedar'], ['Alloy', 'alloy'], ['Coral', 'coral']])
      toggle('muted', 'Mute')
      if (snapshot.connection?.voiceReason) explanation(snapshot.connection.voiceReason)
      if (snapshot.connection?.needsSpeechPermission) {
        const allow = button('Allow speech recognition', () => {
          allow.disabled = true
          void (request({ kind: 'connection', request: { kind: 'allowSpeechRecognition' } }) as Promise<ConnectionResult | undefined>)
            .then(result => { document.getElementById('feedback')!.textContent = result?.ok === false ? result.message : '' })
            .finally(() => { allow.disabled = false })
        })
        fields.append(allow)
      }
      group(); permissionRow('microphone', 'Microphone')
      break
    }
    case 'History & privacy':
      group()
      toggle('saveHistory', 'Save history')
      select('retention', 'Keep for', [['Off', 0], ['7 days', 7], ['30 days', 30], ['90 days', 90], ['Until deleted', 'forever']])
      explanation('Questions, answers and drawings stay on this Mac. Screenshots and audio are never saved.')
      explanation('Each question and a screenshot go to your answer provider. With an OpenAI key, your voice goes to OpenAI.')
      group()
      const deletion = element('div', 'row'); deletion.append(element('span', '', 'All conversations'), button('Delete…', () => { void request({ kind: 'deleteAll' }) }, 'danger')); groupTarget.append(deletion)
      break
    case 'Connection':
      renderConnections(fields, snapshot, update, keyHints, () => { void refreshKeyHints() })
      break
    case 'About': {
      const picture = element('picture'), source = element('source'), image = element('img')
      source.media = '(prefers-color-scheme: dark)'; source.srcset = darkLogo
      image.src = logo; image.alt = ''; image.width = 72; image.height = 72; image.className = 'about-logo'; picture.append(source, image)
      const brand = element('div', 'about-brand'); brand.append(picture, element('h2', '', 'HeyNimbo'), element('span', 'about-version', snapshot.version)); fields.append(brand)
      group('Permissions')
      permissionRow('microphone', 'Microphone')
      permissionRow('screen', 'Screen Recording')
      permissionRow('input', 'Input Monitoring')
      if (Object.values(snapshot.permissions).some(status => status !== 'granted')) explanation('Restart HeyNimbo after changing a permission.')
    }
  }
  const feedback = document.getElementById('connection-feedback'); if (feedback && connectionMessage) feedback.textContent = connectionMessage
  for (const id of openSections) { const details = document.getElementById(id) as HTMLDetailsElement | null; if (details) details.open = true }
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true })
  const main = document.querySelector('main'); if (main) main.scrollTop = scroll
}
window.heynimboApp.onSnapshot(value => {
  snapshot = value
  if (category === 'Connection' && document.activeElement instanceof HTMLInputElement) return
  render()
  if (category === 'Connection') void refreshKeyHints()
})
window.heynimboApp.onNavigate(value => { if (value.category && categories.some(category => category === value.category)) navigate(value.category) })
document.onkeydown = event => { if (event.key === 'Escape') window.close() }
void request({ kind: 'snapshot' }).then(value => { if (isSnapshot(value)) { snapshot = value; render() } })
