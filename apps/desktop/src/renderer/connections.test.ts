import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppSettings, AppSnapshot } from '../shared/app'
import { defaultConnectionSettings, PROVIDERS, selectedModel, type ProviderId } from '../shared/providers'
import { DEFAULT_SETTINGS } from '../main/settings'
import { renderConnections } from './connections'

class TestNode {
  children: TestNode[] = []
  id = ''; className = ''; value = ''; label = ''; textContent = ''; open = false; disabled = false; selected = false
  onclick?: () => void
  onchange?: () => void
  constructor(readonly tag: string, className = '', text = '') { this.className = className; this.textContent = text }
  append(...nodes: TestNode[]) { this.children.push(...nodes) }
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
it.each(PROVIDERS)('keeps %s connections ordered, with one Model picker and collapsed Advanced/Voice sections', provider => {
  renderConnections(fields as unknown as HTMLElement, snapshot(provider), vi.fn())
  expect(fields.children.slice(0, 4).map(node => node.id)).toEqual(['connection-answer', 'connection-model-section', 'connection-advanced', 'connection-voice'])
  expect(byId('connection-model-section').querySelectorAll('select')).toHaveLength(1)
  expect(byId('connection-advanced')).toMatchObject({ tag: 'details', open: false })
  expect(byId('connection-voice')).toMatchObject({ tag: 'details', open: false })
  expect(text(byId('connection-voice'))).toMatch(/reads? answers aloud/)
  for (const section of fields.children) expect(section.querySelectorAll('button').filter(button => button.className === 'primary').length).toBeLessThanOrEqual(1)
  const groups = byId('connection-model-picker').children.filter(node => node.tag === 'optgroup')
  expect(groups.map(group => group.label)).toEqual(provider === 'compatible' ? ['Available models'] : ['Recommended', 'Available models'])
  if (provider !== 'compatible') expect(groups[0]!.children.map(option => option.value)).toEqual(['preset:fast', 'preset:balanced', 'preset:best'])
  expect(text(fields)).not.toMatch(/safeStorage|ears and mouth|coordinate drawing/)
  expect(text(byId('connection-model-summary'))).toContain('Reads answers aloud')
  expect(text(byId('connection-model-summary'))).toContain(provider === 'compatible' ? 'Text only' : 'Sees your screen · Draws on screen')
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
it('clears entered keys after submission without changing the selected answer provider', async () => {
  renderConnections(fields as unknown as HTMLElement, snapshot('anthropic'), vi.fn())
  byId('voice-key').value = 'synthetic-voice'
  nodes(byId('connection-voice')).find(node => node.tag === 'button' && node.textContent === 'Test & save voice key')!.onclick!()
  expect(byId('voice-key').value).toBe('')
  expect(mocks.request).toHaveBeenCalledWith({ kind: 'connection', request: { kind: 'saveKey', provider: 'openai', key: 'synthetic-voice' } })
  await Promise.resolve()
})
