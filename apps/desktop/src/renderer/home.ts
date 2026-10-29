import { button, element, icon, isSnapshot, request } from './app-dom'
import type { AppSnapshot, Conversation, SearchHit } from '../shared/app'
import { sceneThumbnail } from './scene-thumbnail'
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
let transcriptKey = '', renderedId: string | null = null, renameId = '', searchSequence = 0
const drafts = new Map<string, string>(), scrollPositions = new Map<string, number>()
let searchTimer: ReturnType<typeof setTimeout>
const time = (date: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)

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
  const key = JSON.stringify([s.currentId, s.turns, s.activeTurnId, s.keyPresent])
  if (key === transcriptKey) return
  transcriptKey = key
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100
  const oldScroll = transcript.scrollTop
  const changedConversation = renderedId !== s.currentId
  if (changedConversation) {
    if (renderedId) { drafts.set(renderedId, question.value); scrollPositions.set(renderedId, oldScroll) }
    question.value = drafts.get(s.currentId ?? '') ?? ''
    renderedId = s.currentId
  }
  transcript.replaceChildren()
  if (!s.turns.length) {
    const empty = element('section', s.keyPresent ? 'empty' : 'empty connection-needed')
    const picture = element('picture'), source = element('source'), image = element('img')
    source.media = '(prefers-color-scheme: dark)'; source.srcset = darkLogo
    image.src = logo; image.alt = ''; image.width = 80; image.height = 80; picture.append(source, image)
    empty.append(picture, element('h2', '', 'Ask about something on your screen'), element('p', '', s.keyPresent ? 'Type a question below, or hold Control + Option and speak.' : 'Connect OpenAI to get a spoken answer and a little guidance on your screen.'))
    if (!s.keyPresent) {
      empty.append(button('Connect OpenAI', () => { void request({ kind: 'settings', category: 'Connection' }) }, 'primary'))
      empty.append(element('p', 'privacy-summary', 'Your question and screen capture go to OpenAI. Only text and generated drawings are saved in local history, not screen images or audio.'))
    }
    transcript.append(empty)
  }
  for (const turn of s.turns) {
    const section = element('section', 'turn'); section.id = `turn-${turn.id}`
    section.append(element('h2', 'question', turn.question), element('p', 'turn-meta', `${turn.mode === 'voice' ? 'Voice' : 'Text'} · ${time(turn.created)} · ${turn.screenContextUsed ? 'Screen context used, not saved' : s.activeTurnId === turn.id ? 'Preparing screen context' : 'No screen context used'}`))
    section.append(element('p', 'answer', turn.answer || (s.activeTurnId === turn.id ? 'Thinking…' : 'No answer received.')))
    if (s.activeTurnId === turn.id) section.append(element('p', 'turn-state', 'In progress · partial answer'))
    else if (turn.state !== 'complete') section.append(element('p', `turn-state ${turn.state}`, turn.state === 'interrupted' ? 'Interrupted · this answer may be incomplete' : `Error · ${turn.error ?? 'The answer failed. Check your connection and try again.'}`))
    const svg = sceneThumbnail(turn.scene)
    if (svg) { const figure = element('figure', 'drawing'); figure.append(svg, element('figcaption', '', 'Generated drawing · screen image not saved')); section.append(figure) }
    transcript.append(section)
  }
  requestAnimationFrame(() => { transcript.scrollTop = changedConversation ? scrollPositions.get(s.currentId ?? '') ?? 0 : nearBottom ? transcript.scrollHeight : oldScroll })
}
function render(s: AppSnapshot): void {
  snapshot = s
  title.textContent = s.conversations.find(c => c.id === s.currentId)?.title ?? 'New conversation'
  renderSidebar(); renderTranscript(s)
  document.getElementById('stop')!.hidden = !s.busy
  ;(document.getElementById('send') as HTMLButtonElement).disabled = s.busy
  document.getElementById('feedback')!.textContent = s.status
  document.getElementById('saving')!.textContent = !s.saved ? 'Not saved' : s.settings.retention === 'forever' ? 'Kept until deleted' : `Saved locally for ${s.settings.retention} days`
}
async function performSearch(): Promise<void> {
  const sequence = ++searchSequence, query = search.value.trim()
  if (!query) { renderSidebar(); return }
  const hits = await request({ kind: 'search', query }) as SearchHit[] | undefined
  if (sequence !== searchSequence || !hits || !snapshot) return
  conversations.replaceChildren(element('h2', '', 'Search results'))
  for (const hit of hits) {
    const c = snapshot.conversations.find(c => c.id === hit.conversationId)
    if (c) conversations.append(row(c, hit))
  }
  if (!hits.length) conversations.append(element('p', 'no-results', 'No conversations match your search.'), button('Clear search', () => { search.value = ''; renderSidebar(); search.focus() }))
}
search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { void performSearch() }, 120) }
question.oninput = () => { drafts.set(snapshot?.currentId ?? '', question.value) }
async function ask(): Promise<void> {
  if (snapshot?.busy || !question.value.trim()) return
  const value = question.value
  const result = await request({ kind: 'ask', question: value })
  if (result && typeof result === 'object' && 'accepted' in result && result.accepted) { question.value = ''; drafts.delete(snapshot?.currentId ?? '') }
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
    else if (search.value) { search.value = ''; renderSidebar(); question.focus() }
    else question.focus()
  }
}
window.nimboApp.onSnapshot(render)
window.nimboApp.onNavigate(navigation => {
  if (navigation.focusSearch) { document.body.classList.remove('sidebar-hidden'); document.body.classList.add('sidebar-open'); search.focus() }
  if (navigation.turnId) requestAnimationFrame(() => document.getElementById(`turn-${navigation.turnId}`)?.scrollIntoView())
  if (navigation.renameId) { renameId = navigation.renameId; rename.value = title.textContent ?? ''; title.hidden = true; renameForm.hidden = false; rename.focus(); rename.select() }
})
void request({ kind: 'snapshot' }).then(value => { if (isSnapshot(value)) render(value) })
