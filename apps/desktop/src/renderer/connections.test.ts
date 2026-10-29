import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSettings, AppSnapshot } from '../shared/app'
import { defaultConnectionSettings, PROVIDERS, RECOMMENDED_MODELS, selectedModel, type ProviderId } from '../shared/providers'
import { DEFAULT_SETTINGS } from '../main/settings'
import { renderConnections } from './connections'

class TestNode {
  children: TestNode[] = []
  parent?: TestNode
  focus = vi.fn()
  scrollIntoView = vi.fn()
  classList = { add: (value: string) => { this.className += ` ${value}` } }
  id = ''; className = ''; value = ''; label = ''; textContent = ''; open = false; disabled = false; selected = false
  onclick?: () => void
  onchange?: () => void
  constructor(readonly tag: string, className = '', text = '') { this.className = className; this.textContent = text }
  append(...nodes: TestNode[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node) } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = undefined }
  replaceChildren(...nodes: TestNode[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes) }
  setAttribute() {}
  querySelectorAll(tag: string): TestNode[] { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]) }
}
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('./app-dom', () => ({
  element: (tag: string, className?: string, text?: string) => new TestNode(tag, className, text),
  button: (text: string, action: () => void, className?: string) => Object.assign(new TestNode('button', className, text), { onclick: action }),
  request: mocks.request,
}))
let fields: TestNode
beforeEach(() => {
  fields = new TestNode('div'); mocks.request.mockReset(); mocks.request.mockResolvedValue({ ok: true, message: 'Saved.' })
  vi.stubGlobal('document', { getElementById: (id: string) => nodes(fields).find(node => node.id === id) })
})
afterEach(() => vi.unstubAllGlobals())
function nodes(node: TestNode): TestNode[] { return [node, ...node.children.flatMap(nodes)] }
function text(node: TestNode): string { return nodes(node).map(child => child.textContent).join(' ') }
function byId(id: string): TestNode { return nodes(fields).find(node => node.id === id)! }
function click(node: TestNode, label: string): void { node.querySelectorAll('button').find(button => button.textContent === label)!.onclick!() }
function snapshot(provider: ProviderId = 'compatible'): AppSnapshot {
  const config = defaultConnectionSettings(); config.provider = provider
  if (provider === 'compatible') config.models.compatible = { model: 'model-a' }
  const model = selectedModel(config)
  return { conversations: [], currentId: null, turns: [], activeTurnId: null, busy: false, status: '', settings: { ...DEFAULT_SETTINGS, connection: config }, keyPresent: true, saved: true, version: 'fixture', permissions: { microphone: '', screen: '', input: '' }, connection: { providers: Object.fromEntries(PROVIDERS.map(p => [p, p === provider])) as Record<ProviderId, boolean>, accounts: [], models: [{ id: 'discovered-model', name: 'Discovered model', vision: false, tested: false }], answerModel: model.model, answerVision: model.vision, voice: 'OpenAI' } }
}
it.each(PROVIDERS)('offers one provider/model/thinking decision group for %s without duplicate summaries', provider => {
  renderConnections(fields as unknown as HTMLElement, snapshot(provider), vi.fn())
  const answer = byId('connection-answer')
  expect(answer.querySelectorAll('select').map(node => node.id)).toEqual(['connection-provider', 'connection-model-picker', 'connection-thinking'])
  expect(byId('your-ai')).toBeUndefined()
  expect(PROVIDERS.every(p => byId(`saved-${p}`))).toBe(true)
  expect(byId('connection-advanced')).toMatchObject({ tag: 'details', open: false })
  expect(byId('voice-key')).toBeUndefined()
  const recommended = byId('connection-model-picker').children.find(node => node.label === 'Recommended')
  expect(recommended?.children.map(option => option.value) ?? []).toEqual(RECOMMENDED_MODELS[provider].map(model => model.model))
  expect(byId('connection-thinking').disabled).toBe(!['chatgpt', 'openai', 'anthropic'].includes(provider))
  expect(mocks.request).not.toHaveBeenCalled()
})
it('changes model and thinking independently, clears unsupported effort, and preserves other providers', () => {
  const state = snapshot('anthropic'), update = vi.fn(async (_patch: Partial<AppSettings>) => {})
  renderConnections(fields as unknown as HTMLElement, state, update)
  const picker = byId('connection-model-picker'), thinking = byId('connection-thinking')
  thinking.value = 'high'; thinking.onchange!()
  expect(update.mock.calls.at(-1)?.[0].connection?.models.anthropic).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
  picker.value = 'claude-opus-5-5'; picker.onchange!()
  expect(update.mock.calls.at(-1)?.[0].connection?.models.anthropic).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  picker.value = 'discovered-model'; picker.onchange!()
  expect(update.mock.calls.at(-1)?.[0].connection?.models).toEqual({ ...state.settings.connection!.models, anthropic: { model: 'discovered-model' } })
  thinking.value = ''; thinking.onchange!()
  expect(update.mock.calls.at(-1)?.[0].connection?.models.anthropic).toEqual({ model: 'claude-sonnet-5-5' })
})
it('preserves an explicitly selected Provider default when the model changes', () => {
  const state = snapshot('openai'); state.settings.connection!.models.openai = { model: 'gpt-6.1-terra' }
  const update = vi.fn(async (_patch: Partial<AppSettings>) => {})
  renderConnections(fields as unknown as HTMLElement, state, update)
  const picker = byId('connection-model-picker'); picker.value = 'gpt-6.1-sol'; picker.onchange!()
  expect(update.mock.calls[0]?.[0].connection?.models.openai).toEqual({ model: 'gpt-6.1-sol' })
})
it('selects a provider without changing its model and opens setup inline if not connected', async () => {
  const state = snapshot('anthropic')
  renderConnections(fields as unknown as HTMLElement, state, vi.fn())
  const provider = byId('connection-provider'); provider.value = 'google'; provider.onchange!()
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'useForAnswers', provider: 'google' } })
  await Promise.resolve(); fields.replaceChildren(); state.settings.connection!.provider = 'google'
  renderConnections(fields as unknown as HTMLElement, state, vi.fn())
  const input = byId('connection-key-google')
  expect(nodes(byId('connection-answer'))).toContain(input)
  expect(input.focus).not.toHaveBeenCalled()
  expect(byId('connection-thinking').disabled).toBe(true)
})
it.each([['Save endpoint', 'https://b.example.invalid/v1'], ['Ollama', 'http://127.0.0.1:11434/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']])('clears the endpoint-bound model through %s', (action, endpoint) => {
  const update = vi.fn(async (_patch: Partial<AppSettings>) => {})
  renderConnections(fields as unknown as HTMLElement, snapshot(), update)
  byId('connection-endpoint').value = endpoint!; click(byId('connection-advanced'), action!)
  expect(update.mock.calls[0]?.[0].connection).toMatchObject({ baseURL: endpoint, models: { compatible: { model: '' } } })
})
it('manages a saved key without changing billing, clears its input, and requests confirmed removal', async () => {
  const state = snapshot('anthropic'), update = vi.fn(); state.connection!.providers.openai = true
  renderConnections(fields as unknown as HTMLElement, state, update, { openai: { suffix: 'abcd', savedAt: 0 } })
  expect(text(byId('saved-openai'))).toContain('Key saved · ends in ••••abcd · Saved')
  expect(text(byId('saved-anthropic'))).toContain('Current answers')
  byId('replace-key-openai').onclick!()
  const input = byId('connection-key-openai'); input.value = 'synthetic-openai'
  expect(input.focus).toHaveBeenCalled()
  click(byId('saved-openai'), 'Test & save key')
  expect(input.value).toBe('')
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'saveKey', provider: 'openai', key: 'synthetic-openai' } })
  expect(update).not.toHaveBeenCalled(); await Promise.resolve()
  click(byId('saved-openai'), 'Remove')
  expect(mocks.request).toHaveBeenLastCalledWith({ kind: 'connection', request: { kind: 'removeKey', provider: 'openai' } })
  await Promise.resolve(); click(byId('saved-openai'), 'Use')
  expect(mocks.request).toHaveBeenLastCalledWith({ kind: 'connection', request: { kind: 'useForAnswers', provider: 'openai' } })
})
it('shows a single signed-in ChatGPT state and no redundant sign-in action', () => {
  const state = snapshot('chatgpt'); state.connection!.activeAccount = 'preview-account'; state.connection!.accounts = [{ id: 'preview-account', name: 'Alex', email: 'alex@example.invalid', connected: true, sharing: true }]
  renderConnections(fields as unknown as HTMLElement, state, vi.fn())
  expect(text(byId('saved-chatgpt'))).toContain('Signed in as Alex · alex@example.invalid')
  expect(byId('saved-chatgpt').querySelectorAll('button').map(node => node.textContent)).toEqual(['Sign out', 'Manage usage'])
  expect(text(fields)).not.toMatch(/Continue with ChatGPT|Registration|preview-/)
})
it('keeps voice automatic with an explicit permission action only when needed', async () => {
  const state = snapshot('anthropic'); state.connection = { ...state.connection!, voice: 'unavailable', voiceReason: 'Allow speech recognition.', needsSpeechPermission: true }
  renderConnections(fields as unknown as HTMLElement, state, vi.fn())
  expect(mocks.request).not.toHaveBeenCalled(); expect(text(byId('connection-voice'))).toContain('Allow speech recognition.')
  click(byId('connection-voice'), 'Allow speech recognition')
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'allowSpeechRecognition' } }); await Promise.resolve()
  for (const voice of ['OpenAI', 'Built into your Mac', 'unavailable'] as const) {
    fields.replaceChildren(); state.connection.voice = voice; state.connection.needsSpeechPermission = false; state.connection.voiceReason = 'Missing usage descriptions.'
    renderConnections(fields as unknown as HTMLElement, state, vi.fn())
    expect(text(byId('connection-voice'))).toContain(voice === 'unavailable' ? 'Missing usage descriptions.' : `Voice: ${voice}`)
    expect(byId('connection-voice').querySelectorAll('button')).toHaveLength(0)
  }
})
