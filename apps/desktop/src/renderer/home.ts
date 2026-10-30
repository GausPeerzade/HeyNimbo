import { button, element, icon, isSnapshot, request } from './app-dom'
import type { AppSnapshot, Conversation, SearchHit } from '../shared/app'
import { TurnTranscript } from './turn-transcript'
import { ConversationSearch } from './conversation-search'
import logo from '../../build/brand/logo.png?url'
import darkLogo from '../../build/brand/logo-dark.png?url'

const search = document.getElementById('search') as HTMLInputElement
const question = document.getElementById('question') as HTMLTextAreaElement
const transcript = document.getElementById('transcript')!
const conversations = document.getElementById('conversations')!
const title = document.getElementById('title')!
const renameForm = document.getElementById('rename-form') as HTMLFormElement
const rename = document.getElementById('rename') as HTMLInputElement
let snapshot: AppSnapshot | undefined
let emptyKey = '', renderedId: string | null = null, renameId = ''
/** The conversation the composer's text belongs to; kept in step on every snapshot, whatever view is showing. */
let composerId: string | null = null
const drafts = new Map<string, string>(), scrollPositions = new Map<string, number>()
const time = (date: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
const turnTranscript = new TurnTranscript(transcript)

function row(c: Conversation, hit?: SearchHit): HTMLButtonElement {
  const node = button('', () => { void request({ kind: 'open', id: c.id, turnId: hit?.turnId }) }, 'conversation')
  node.setAttribute('aria-current', String(c.id === snapshot?.currentId)); node.dataset.id = c.id
  node.append(element('span', 'row-title', c.title), element('time', '', time(c.updated)), element('span', 'preview', hit?.snippet ?? c.preview ?? 'No questions yet'))
  node.oncontextmenu = event => { event.preventDefault(); void request({ kind: 'contextMenu', id: c.id }) }
  node.onkeydown = event => { if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); void request({ kind: 'contextMenu', id: c.id }) } }
  return node
}
function renderSidebar(): void {
  if (!snapshot || search.value.trim()) return
  const focused = (document.activeElement as HTMLElement)?.dataset.id
  conversations.replaceChildren()
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const groups = new Map<string, Conversation[]>()
  for (const c of snapshot.conversations) {
    const days = (midnight.getTime() - c.updated) / 86400000
    const group = c.pinned ? 'Pinned' : days < 0 ? 'Today' : days < 1 ? 'Yesterday' : days < 7 ? 'Previous 7 days' : 'Older'
    groups.set(group, [...groups.get(group) ?? [], c])
  }
  for (const group of ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older']) {
    const items = groups.get(group); if (!items?.length) continue
    conversations.append(element('h2', '', group), ...items.map(c => row(c)))
  }
  if (focused) [...conversations.querySelectorAll<HTMLButtonElement>('button')].find(b => b.dataset.id === focused)?.focus()
}
function renderTranscript(s: AppSnapshot): void {
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100
  const oldScroll = transcript.scrollTop
  const changedConversation = renderedId !== s.currentId
  if (changedConversation) {
    if (renderedId) scrollPositions.set(renderedId, oldScroll)
    renderedId = s.currentId
    turnTranscript.clear(); transcript.replaceChildren(); emptyKey = ''
  }
  const key = `${s.keyPresent}:${s.connection?.answerVision}`
  if (!s.turns.length && emptyKey !== key) {
    turnTranscript.clear(); transcript.replaceChildren(); emptyKey = key
    const empty = element('section', s.keyPresent ? 'empty' : 'empty connection-needed')
    const picture = element('picture'), source = element('source'), image = element('img')
    source.media = '(prefers-color-scheme: dark)'; source.srcset = darkLogo
    image.src = logo; image.alt = ''; image.width = 80; image.height = 80; picture.append(source, image)
    empty.append(picture, element('h2', '', s.connection?.answerVision === false ? 'Ask a question.' : 'Ask about your screen.'), element('p', '', s.keyPresent ? 'Describe what you want to find or understand.' : 'Connect a provider to ask about your screen and get a drawn explanation.'))
    if (!s.keyPresent) {
      empty.append(button('Connect a provider', () => { void request({ kind: 'settings', category: 'Connection' }) }, 'primary'))
      empty.append(element('p', 'privacy-summary', 'When you ask, your question and a screen capture go to your selected answer provider or local endpoint, if the model supports images. Local history saves text and generated drawings, not screen images or audio.'))
    }
    transcript.append(empty)
  }
  if (s.turns.length) {
    if (emptyKey) { transcript.replaceChildren(); emptyKey = '' }
    turnTranscript.render(s.turns, s.activeTurnId)
  }
  requestAnimationFrame(() => { transcript.scrollTop = changedConversation ? scrollPositions.get(s.currentId ?? '') ?? 0 : nearBottom ? transcript.scrollHeight : oldScroll })
}
function syncComposer(s: AppSnapshot): void {
  if (composerId === s.currentId) return
  if (composerId) drafts.set(composerId, question.value)
  question.value = drafts.get(s.currentId ?? '') ?? ''
  composerId = s.currentId
}
function render(s: AppSnapshot): void {
  snapshot = s
  syncComposer(s)
  title.textContent = s.conversations.find(c => c.id === s.currentId)?.title ?? 'New conversation'
  renderSidebar(); renderTranscript(s)
  document.getElementById('stop')!.hidden = !s.busy
  document.getElementById('send')!.hidden = s.busy || !s.keyPresent
  const screenContext = document.getElementById('screen-context')
  if (screenContext) screenContext.textContent = s.connection?.answerVision === false ? 'Text only · does not see or draw on your screen' : 'Includes a screen capture when you ask'
  document.getElementById('feedback')!.textContent = s.status
  document.getElementById('saving')!.textContent = !s.saved ? 'Not saved' : s.settings.retention === 'forever' ? 'Kept until deleted' : `Saved locally for ${s.settings.retention} days`
}
const conversationSearch = new ConversationSearch(
  () => search.value,
  async query => await request({ kind: 'search', query }) as SearchHit[] | undefined,
  hits => {
    if (!hits) { renderSidebar(); return }
    if (!snapshot) return
    conversations.replaceChildren(element('h2', '', 'Search results'))
    for (const hit of hits) {
      const c = snapshot.conversations.find(c => c.id === hit.conversationId) ?? { id: hit.conversationId, title: hit.title, created: hit.updated, updated: hit.updated, pinned: false, archived: false, preview: hit.snippet }
      conversations.append(row(c, hit))
    }
    if (!hits.length) conversations.append(element('p', 'no-results', 'No conversations match your search.'), button('Clear search', () => { clearSearch(); search.focus() }))
  },
)
function clearSearch(): void { search.value = ''; conversationSearch.changed() }
search.oninput = () => conversationSearch.changed()
question.oninput = () => { drafts.set(composerId ?? '', question.value) }
async function ask(): Promise<void> {
  // Send exactly what is visible, for the conversation it belongs to.
  const value = question.value, conversation = composerId
  if (snapshot?.busy || !value.trim()) return
  const result = await request({ kind: 'ask', question: value })
  // Clear only the composer that still shows the sent question in the conversation it was sent from.
  if (result && typeof result === 'object' && 'accepted' in result && result.accepted) { if (composerId === conversation && question.value === value) question.value = ''; drafts.delete(conversation ?? '') }
}
document.getElementById('composer')!.onsubmit = event => { event.preventDefault(); void ask() }
question.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void ask() } }
for (const id of ['new', 'new-top']) document.getElementById(id)!.onclick = () => { void request({ kind: 'new' }); question.focus() }
document.getElementById('new-top')!.append(icon('plus'))
document.getElementById('toggle')!.append(icon('sidebar'))
document.getElementById('send')!.append(icon('send'))
document.getElementById('toggle')!.onclick = () => { document.body.classList.toggle(innerWidth <= 800 ? 'sidebar-open' : 'sidebar-hidden') }
document.getElementById('settings')!.onclick = () => { void request({ kind: 'settings' }) }
document.getElementById('stop')!.onclick = () => { void request({ kind: 'stop' }) }
renameForm.onsubmit = event => { event.preventDefault(); void request({ kind: 'rename', id: renameId, title: rename.value }); renameForm.hidden = true; title.hidden = false }
document.onkeydown = event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); document.body.classList.remove('sidebar-hidden'); document.body.classList.add('sidebar-open'); search.focus() }
  if (event.key === 'Escape') {
    if (snapshot?.busy) void request({ kind: 'stop' })
    else if (!renameForm.hidden) { renameForm.hidden = true; title.hidden = false; question.focus() }
    else if (search.value) { clearSearch(); question.focus() }
    else question.focus()
  }
}
window.heynimboApp.onSnapshot(render)
window.heynimboApp.onNavigate(navigation => {
  if (navigation.focusSearch) { document.body.classList.remove('sidebar-hidden'); document.body.classList.add('sidebar-open'); search.focus() }
  if (navigation.turnId) { requestAnimationFrame(() => document.getElementById(`turn-${navigation.turnId}`)?.scrollIntoView()) }
  if (navigation.renameId) { renameId = navigation.renameId; rename.value = title.textContent ?? ''; title.hidden = true; renameForm.hidden = false; rename.focus(); rename.select() }
})
void request({ kind: 'snapshot' }).then(value => { if (isSnapshot(value)) render(value) })
