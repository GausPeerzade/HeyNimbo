import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSettings, AppSnapshot } from '../shared/app'
import { defaultConnectionSettings, PROVIDERS, selectedModel, type ProviderId } from '../shared/providers'
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
function snapshot(provider: ProviderId = 'compatible'): AppSnapshot {
  const config = defaultConnectionSettings(); config.provider = provider
  if (provider === 'compatible') config.models.compatible = { preset: 'custom', customModel: 'model-a' }
  const model = selectedModel(config)
  return { conversations: [], currentId: null, turns: [], activeTurnId: null, busy: false, status: '', settings: { ...DEFAULT_SETTINGS, connection: config }, keyPresent: true, saved: true, version: 'fixture', permissions: { microphone: '', screen: '', input: '' }, connection: { providers: Object.fromEntries(PROVIDERS.map(p => [p, false])) as Record<ProviderId, boolean>, accounts: [], models: [{ id: 'discovered-model', name: 'Discovered model', vision: false, tested: false }], answerModel: model.model, answerVision: model.vision, voice: 'OpenAI key' } }
}
it.each(PROVIDERS)('keeps %s connections ordered, with Your AI, one Model picker, all saved providers and collapsed Advanced', provider => {
  renderConnections(fields as unknown as HTMLElement, snapshot(provider), vi.fn())
  expect(fields.children.slice(0, 5).map(node => node.id)).toEqual(['your-ai', 'connection-answer', 'connection-model-section', 'saved-connections', 'connection-advanced'])
  expect(PROVIDERS.every(p => byId(`saved-${p}`))).toBe(true)
  expect(byId('connection-model-section').querySelectorAll('select')).toHaveLength(1)
  expect(byId('connection-advanced')).toMatchObject({ tag: 'details', open: false })
  expect(byId('connection-voice')).toBeUndefined()
  expect(byId('voice-key')).toBeUndefined()
  for (const section of fields.children) expect(section.querySelectorAll('button').filter(button => button.className === 'primary').length).toBeLessThanOrEqual(1)
  const groups = byId('connection-model-picker').children.filter(node => node.tag === 'optgroup')
  expect(groups.map(group => group.label)).toEqual(provider === 'compatible' ? ['Available models'] : ['Recommended', 'Available models'])
  if (provider !== 'compatible') expect(groups[0]!.children.map(option => option.value)).toEqual(['preset:fast', 'preset:balanced', 'preset:best'])
  expect(text(fields)).not.toMatch(/safeStorage|ears and mouth|coordinate drawing/)
  expect(text(byId('your-ai'))).toContain('Reads answers aloud · Yes')
  expect(text(byId('your-ai'))).toContain(provider === 'compatible' ? 'Sees your screen · No' : 'Sees your screen · Yes')
  expect(text(byId(`saved-${provider}`))).toContain('Current answers')
})
it('uses the same Model picker for recommended presets and discovered model IDs', () => {
  const update = vi.fn(async (_patch: Partial<AppSettings>) => {})
  renderConnections(fields as unknown as HTMLElement, snapshot('anthropic'), update)
  const picker = byId('connection-model-picker')
  picker.value = 'preset:fast'; picker.onchange!()
  expect(update.mock.calls.at(-1)?.[0].connection?.models.anthropic.preset).toBe('fast')
  picker.value = 'model:discovered-model'; picker.onchange!()
  expect(update.mock.calls.at(-1)?.[0].connection?.models.anthropic).toEqual({ preset: 'custom', customModel: 'discovered-model' })
})
it.each([['Save endpoint', 'https://b.example.invalid/v1'], ['Ollama', 'http://127.0.0.1:11434/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']])('clears the endpoint-bound model through %s', (action, endpoint) => {
  const update = vi.fn(async (_patch: Partial<AppSettings>) => {})
  renderConnections(fields as unknown as HTMLElement, snapshot(), update)
  byId('connection-endpoint').value = endpoint!
  expect(nodes(byId('connection-advanced'))).toContain(byId('connection-endpoint'))
  nodes(fields).find(node => node.tag === 'button' && node.textContent === action)!.onclick!()
  expect(update.mock.calls[0]?.[0].connection).toMatchObject({ baseURL: endpoint, models: { compatible: { preset: 'custom', customModel: '' } } })
})
it('adds or replaces the single OpenAI provider key without changing the answer provider', async () => {
  const update = vi.fn()
  renderConnections(fields as unknown as HTMLElement, snapshot('anthropic'), update)
  byId('replace-key-openai').onclick!()
  const input = byId('connection-key-openai'); input.value = 'synthetic-openai'
  expect(input.focus).toHaveBeenCalled()
  nodes(byId('saved-openai')).find(node => node.tag === 'button' && node.textContent === 'Test & save key')!.onclick!()
  expect(input.value).toBe('')
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'saveKey', provider: 'openai', key: 'synthetic-openai' } })
  expect(update).not.toHaveBeenCalled()
  await Promise.resolve()
})
it.each([0, 1793232000000])('shows saved hints and date %s for every provider, and sends Use for answers without a model change', savedAt => {
  const state = snapshot('anthropic'); state.connection!.providers.openai = true; state.connection!.providers.anthropic = true
  const before = JSON.stringify(state)
  renderConnections(fields as unknown as HTMLElement, state, vi.fn(), { openai: { suffix: 'abcd', savedAt }, anthropic: { suffix: 'wxyz', savedAt } })
  expect(text(byId('saved-openai'))).toContain(`Key saved · ends in ••••abcd · Saved ${new Date(savedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`)
  expect(text(byId('saved-anthropic'))).toContain('Key saved · ends in ••••wxyz · Saved')
  expect(text(byId('saved-google'))).toContain('Not set')
  expect(text(byId('saved-compatible'))).toContain('127.0.0.1:11434 · Not set')
  expect(text(byId('your-ai'))).toContain('Answers: Claude Sonnet 5.5 · Anthropic')
  expect(text(byId('your-ai'))).toContain('Voice: OpenAI')
  nodes(byId('your-ai')).find(node => node.tag === 'button' && node.textContent === 'Change')!.onclick!()
  expect(byId('connection-provider').focus).toHaveBeenCalled()
  nodes(byId('saved-openai')).find(node => node.tag === 'button' && node.textContent === 'Use for answers')!.onclick!()
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'useForAnswers', provider: 'openai' } })
  expect(JSON.stringify(state)).toBe(before)
})
it('shows one clear signed-in ChatGPT state without duplicate sign-in or registration labels', () => {
  const state = snapshot('chatgpt'); state.connection!.activeAccount = 'preview-account'; state.connection!.accounts = [{ id: 'preview-account', name: 'Alex', email: 'alex@example.invalid', connected: true, sharing: true }]
  renderConnections(fields as unknown as HTMLElement, state, vi.fn())
  const row = byId('saved-chatgpt')
  expect(text(row)).toContain('Signed in as Alex · alex@example.invalid')
  expect(row.querySelectorAll('button').map(node => node.textContent)).toEqual(['Use for answers', 'Sign out', 'Manage usage'])
  expect(text(fields)).not.toMatch(/Continue with ChatGPT|Add ChatGPT account|Registration|preview-/)
})
it('makes voice automatic and read-only, directing setup to the one OpenAI provider row', () => {
  const state = snapshot(); state.connection!.voice = 'unavailable'
  renderConnections(fields as unknown as HTMLElement, state, vi.fn())
  expect(text(byId('your-ai'))).toContain('Voice: not available yet. Add an OpenAI key, or use built-in Mac speech (coming soon)')
  expect(byId('your-ai').querySelectorAll('button').map(node => node.textContent)).toEqual(['Change'])
  expect(fields.querySelectorAll('input').some(node => node.id.includes('voice'))).toBe(false)
})
it('requests removal from the row, then relies on main-process confirmation', () => {
  const state = snapshot(); state.connection!.providers.anthropic = true
  renderConnections(fields as unknown as HTMLElement, state, vi.fn(), { anthropic: { suffix: 'abcd' } })
  nodes(byId('saved-anthropic')).find(node => node.tag === 'button' && node.textContent === 'Remove')!.onclick!()
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'removeKey', provider: 'anthropic' } })
})
