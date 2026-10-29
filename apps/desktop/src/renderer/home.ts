import { button, element, icon, isSnapshot, request } from './app-dom'
import type { AppSnapshot, Conversation, SearchHit } from '../shared/app'
import { TurnTranscript } from './turn-transcript'
import { ConversationSearch } from './conversation-search'
import { AgentView } from './agent-view'
import type { AgentApi } from '../shared/agent-protocol'
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
const turnTranscript = new TurnTranscript(transcript)
const drafts = new Map<string, string>(), scrollPositions = new Map<string, number>()
const time = (date: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
const agentApi = (window as unknown as { heynimboApp: { agent?: AgentApi } }).heynimboApp.agent
const agentPanel = document.getElementById('agent-panel'), agentFolders = document.getElementById('agent-folders'), stopAll = document.getElementById('stop-all') as HTMLButtonElement | null
const agentView = agentApi && agentPanel && agentFolders && stopAll ? new AgentView(agentApi, { panel: agentPanel, folders: agentFolders, stopAll }) : undefined
const modeSwitch = document.getElementById('mode-switch')
if (modeSwitch) modeSwitch.hidden = !agentView
let explainDraft = '', doDraft = ''
function setMode(doMode: boolean): void {
  if (!agentView || agentView.active === doMode) return
  if (doMode) { explainDraft = question.value; question.value = doDraft }
  else { doDraft = question.value; question.value = explainDraft }
  agentView.setActive(doMode); transcript.hidden = doMode
  document.getElementById('explain-mode')?.setAttribute('aria-pressed', String(!doMode))
  document.getElementById('do-mode')?.setAttribute('aria-pressed', String(doMode))
  for (const id of ['feedback', 'screen-context', 'composer-note']) { const node = document.getElementById(id); if (node) node.hidden = doMode }
  const agentContext = document.getElementById('agent-context'); if (agentContext) agentContext.hidden = !doMode
  question.setAttribute('aria-describedby', doMode ? 'agent-context' : 'screen-context')
  question.placeholder = doMode ? 'Describe a task…' : 'Ask about your screen…'
  document.getElementById('send')!.setAttribute('aria-label', doMode ? 'Start task' : 'Ask question')
  document.getElementById('send')!.setAttribute('title', doMode ? 'Start task (Enter)' : 'Ask (Enter)')
  document.getElementById('stop')!.hidden = doMode || !snapshot?.busy
  document.getElementById('send')!.hidden = !doMode && Boolean(snapshot?.busy || (snapshot && !snapshot.keyPresent))
  if (!doMode && snapshot) render(snapshot)
  question.focus()
}
const explainMode = document.getElementById('explain-mode'), doMode = document.getElementById('do-mode')
if (explainMode) explainMode.onclick = () => setMode(false)
if (doMode) doMode.onclick = () => setMode(true)

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
    if (renderedId) { drafts.set(renderedId, question.value); scrollPositions.set(renderedId, oldScroll) }
    question.value = drafts.get(s.currentId ?? '') ?? ''
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
function render(s: AppSnapshot): void {
  snapshot = s
  title.textContent = s.conversations.find(c => c.id === s.currentId)?.title ?? 'New conversation'
  renderSidebar(); if (!agentView?.active) renderTranscript(s)
  if (!agentView?.active) {
    document.getElementById('stop')!.hidden = !s.busy
    ;document.getElementById('send')!.hidden = s.busy || !s.keyPresent
  }
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
question.oninput = () => { if (agentView?.active) doDraft = question.value; else drafts.set(snapshot?.currentId ?? '', question.value) }
async function ask(): Promise<void> {
  if (agentView?.active) {
    const value = question.value
    if (await agentView.submit(value)) { doDraft = ''; if (agentView.active && question.value === value) question.value = '' }
    return
  }
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
    if (agentView?.active) question.focus()
    else if (snapshot?.busy) void request({ kind: 'stop' })
    else if (!renameForm.hidden) { renameForm.hidden = true; title.hidden = false; question.focus() }
    else if (search.value) { clearSearch(); question.focus() }
    else question.focus()
  }
}
window.heynimboApp.onSnapshot(render)
window.heynimboApp.onNavigate(navigation => {
  if (navigation.focusSearch) { document.body.classList.remove('sidebar-hidden'); document.body.classList.add('sidebar-open'); search.focus() }
  if (navigation.turnId) requestAnimationFrame(() => document.getElementById(`turn-${navigation.turnId}`)?.scrollIntoView())
  if (navigation.renameId) { renameId = navigation.renameId; rename.value = title.textContent ?? ''; title.hidden = true; renameForm.hidden = false; rename.focus(); rename.select() }
})
void request({ kind: 'snapshot' }).then(value => { if (isSnapshot(value)) render(value) })
