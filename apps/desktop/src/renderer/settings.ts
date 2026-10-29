import { button, element, isSnapshot, request } from './app-dom'
import type { AppSettings, AppSnapshot } from '../shared/app'
import logo from '../../build/brand/logo.png?url'
import darkLogo from '../../build/brand/logo-dark.png?url'

const categories = ['General', 'Voice', 'History & privacy', 'Connection', 'About']
const fields = document.getElementById('fields')!
let category = 'General', snapshot: AppSnapshot | undefined
const nav = document.getElementById('categories')!
for (const name of categories) {
  const node = button(name, () => { category = name; render() }); node.dataset.category = name; nav.append(node)
}
async function update(patch: Partial<AppSettings>): Promise<void> {
  if (snapshot) await request({ kind: 'updateSettings', settings: { ...snapshot.settings, ...patch } })
}
function toggle(key: 'openAtLogin' | 'showMenuBar' | 'showNotch' | 'muted' | 'saveHistory', label: string, description?: string): void {
  const row = element('label', 'row'), text = element('span', '', label), input = element('input')
  if (description) text.append(element('small', '', description))
  input.type = 'checkbox'; input.name = key; input.id = key; input.checked = Boolean(snapshot?.settings[key]); input.onchange = () => { void update({ [key]: input.checked }) }
  row.append(text, input); fields.append(row)
}
function select<T extends 'voice' | 'retention'>(key: T, label: string, options: Array<[string, AppSettings[T]]>): void {
  const row = element('label', 'row'), input = element('select')
  input.name = key; input.id = key
  for (const [text, value] of options) { const option = element('option', '', text); option.value = String(value); option.selected = value === snapshot?.settings[key]; input.append(option) }
  input.onchange = () => { const option = options.find(([, value]) => String(value) === input.value); if (option) void update({ [key]: option[1] }) }
  row.append(element('span', '', label), input); fields.append(row)
}
function explanation(text: string): void { fields.append(element('p', 'explanation', text)) }
function render(): void {
  if (!snapshot) return
  const focused = document.activeElement?.id
  document.getElementById('heading')!.textContent = category
  nav.querySelectorAll('button').forEach(node => node.setAttribute('aria-current', String(node.dataset.category === category)))
  const introductions: Record<string, string> = { General: 'Make room for your guide.', Voice: 'Speak, listen and interrupt.', 'History & privacy': 'Choose what stays on this Mac.', Connection: 'Bring your own OpenAI key.', About: 'A guide that points things out.' }
  fields.replaceChildren(element('p', 'category-intro', introductions[category]))
  switch (category) {
    case 'General':
      toggle('openAtLogin', 'Open at login', 'Start quietly in the background when you sign in.')
      toggle('showMenuBar', 'Show menu-bar icon')
      toggle('showNotch', 'Show notch pill', 'Hover for recent conversations. Click to open Home.')
      explanation('Closing Home keeps voice available. Choose Quit NimboGuide to stop the app. Reopen it from the Dock or Applications.')
      break
    case 'Voice':
      select('voice', 'Speaking voice', [['Marin', 'marin'], ['Cedar', 'cedar'], ['Alloy', 'alloy'], ['Coral', 'coral']])
      toggle('muted', 'Mute speech & drawing sounds', 'The written answer and drawings remain available.')
      explanation('Hold Control + Option to speak; release to ask. Press again to interrupt the current answer. Changing the voice stops the current response.')
      break
    case 'History & privacy':
      toggle('saveHistory', 'Save history on this Mac', 'When off, new conversations stay in memory only. Existing saved history is not deleted.')
      select('retention', 'Keep history', [['Off', 0], ['7 days', 7], ['30 days', 30], ['90 days', 90], ['Until deleted', 'forever']])
      explanation('Saved here: questions, answers, generated drawing text and marks, times, and whether screen context was used. No screenshots, microphone audio or API key. Pinned items use the same retention. Off stops saving new conversations.')
      fields.append(element('h2', '', 'What leaves this Mac'))
      explanation('Your question and a capture of the display under your pointer go to OpenAI. Voice also sends audio for transcription and answer text for speech. Provider handling depends on your account and policies. Local history is not local processing. Hovering never captures.')
      fields.append(button('Delete all history…', () => { void request({ kind: 'deleteAll' }) }, 'danger'))
      explanation('Deletion removes local conversations, drawing records and search entries. This database is not encrypted. Deletion does not erase backups or data already sent to OpenAI.')
      break
    case 'Connection':
      fields.append(element('p', 'connection-state', snapshot.keyPresent ? 'OpenAI key is present' : 'OpenAI key is missing'))
      explanation('The key is encrypted using the macOS Keychain. It is never displayed here or stored with your conversations. Your OpenAI account is billed for requests.')
      fields.append(button(snapshot.keyPresent ? 'Replace key…' : 'Add OpenAI key…', () => { void request({ kind: 'replaceKey' }) }, 'primary'))
      break
    case 'About': {
      const picture = element('picture'), source = element('source'), image = element('img')
      source.media = '(prefers-color-scheme: dark)'; source.srcset = darkLogo
      image.src = logo; image.alt = 'NimboGuide pen-corner mark'; image.width = 72; image.height = 72; image.className = 'about-logo'; picture.append(source, image)
      fields.append(picture, element('h2', '', `NimboGuide ${snapshot.version}`))
      explanation('A quiet guide for the screen in front of you.')
      fields.append(element('h2', '', 'macOS permissions'))
      for (const [key, label] of [['microphone', 'Microphone'], ['screen', 'Screen Recording'], ['input', 'Input Monitoring']] as const) {
        const row = element('div', 'permission'), text = element('span')
        text.append(element('strong', '', label), element('small', '', snapshot.permissions[key]))
        row.append(text, button('Open System Settings', () => { void request({ kind: 'permission', permission: key }) }))
        fields.append(row)
      }
      explanation('After changing a permission, return here to refresh its status. macOS may require an app restart for a new grant.')
    }
  }
  if (focused) document.getElementById(focused)?.focus()
}
window.nimboApp.onSnapshot(value => { snapshot = value; render() })
window.nimboApp.onNavigate(value => { if (value.category && categories.includes(value.category)) { category = value.category; render() } })
document.onkeydown = event => { if (event.key === 'Escape') window.close() }
void request({ kind: 'snapshot' }).then(value => { if (isSnapshot(value)) { snapshot = value; render() } })
