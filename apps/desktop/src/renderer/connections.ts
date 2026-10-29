import type { AppSettings, AppSnapshot } from '../shared/app'
import { PROVIDERS, PROVIDER_NAMES, PRESETS, defaultConnectionSettings, selectedModel, type ConnectionRequest, type ConnectionResult, type ConnectionSettings, type KeyHints, type KeyProvider, type Preset, type ProviderId } from '../shared/providers'
import { button, element, request } from './app-dom'

function providerName(provider: ProviderId): string { return provider === 'openai' ? 'OpenAI' : provider === 'compatible' ? 'Custom endpoint' : PROVIDER_NAMES[provider] }
function modelName(id: string, name?: string): string {
  if (name && name !== id) return name
  const claude = id.match(/(?:^|\/)claude-(haiku|sonnet|opus)-5[-.]5$/)
  if (claude) return `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} 5.5`
  return ({ 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite', 'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-4-argon': 'Gemini 4 Argon', 'deepseek-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro' } as Record<string, string>)[id.replace(/^(openai|google)\//, '')] ?? id
}
export function renderConnections(fields: HTMLElement, snapshot: AppSnapshot, update: (patch: Partial<AppSettings>) => Promise<void>, keyHints: KeyHints = {}, refresh: () => void = () => {}): void {
  const config = snapshot.settings.connection ?? defaultConnectionSettings(), state = snapshot.connection
  const provider = config.provider, choice = config.models[provider]
  const feedback = element('p', 'explanation'); feedback.id = 'connection-feedback'; feedback.role = 'status'
  const run = async (value: ConnectionRequest): Promise<void> => {
    feedback.textContent = value.kind === 'signIn' ? 'Finish signing in in your browser…' : 'Updating connection…'
    const buttons = Array.from(fields.querySelectorAll('button'), node => ({ node, disabled: node.disabled }))
    buttons.forEach(({ node }) => { node.disabled = true })
    const result = await request({ kind: 'connection', request: value }) as ConnectionResult | undefined
    buttons.forEach(({ node, disabled }) => { node.disabled = disabled })
    feedback.textContent = result?.message ?? 'Could not update the connection.'
    const live = document.getElementById('connection-feedback'); if (live) live.textContent = feedback.textContent
    refresh()
  }
  const change = async (patch: Partial<ConnectionSettings>): Promise<void> => update({ connection: { ...config, ...patch } })
  const chooseModel = (preset: Preset, customModel = choice.customModel): void => { void change({ models: { ...config.models, [provider]: { preset, customModel } } }) }
  const saveEndpoint = (baseURL: string): void => { void change({ baseURL, models: { ...config.models, compatible: { preset: 'custom', customModel: '' } } }) }
  const currentModel = state?.answerModel ?? selectedModel(config).model
  const vision = state?.answerVision ?? selectedModel(config).vision
  const yourAI = element('section', 'connection-section your-ai'); yourAI.id = 'your-ai'
  yourAI.append(element('h2', '', 'Your AI'))
  const answerSummary = element('div', 'ai-summary-row')
  answerSummary.append(element('p', '', `Answers: ${currentModel ? modelName(currentModel, state?.models.find(model => model.id === currentModel)?.name) : 'Choose a model'} · ${providerName(provider)}`), button('Change', () => { const control = document.getElementById('connection-provider'); control?.scrollIntoView({ block: 'center' }); control?.focus() }))
  yourAI.append(answerSummary, element('p', 'voice-summary', state?.voice === 'OpenAI key' ? 'Voice: OpenAI' : 'Voice: not available yet. Add an OpenAI key, or use built-in Mac speech (coming soon)'))
  const capabilities = element('ul', 'connection-capabilities')
  capabilities.append(element('li', '', `Sees your screen · ${vision && snapshot.keyPresent ? 'Yes' : 'No'}`), element('li', '', `Draws on screen · ${vision && snapshot.keyPresent ? 'Yes' : 'No'}`), element('li', '', `Reads answers aloud · ${state?.voice === 'OpenAI key' ? snapshot.settings.muted ? 'Muted' : 'Yes' : 'Not available yet'}`))
  yourAI.append(capabilities); fields.append(yourAI)

  const answer = element('section', 'connection-section'); answer.id = 'connection-answer'
  const providerRow = element('label', 'row'), providerSelect = element('select')
  providerSelect.id = 'connection-provider'; providerSelect.setAttribute('aria-label', 'Answer provider')
  for (const p of PROVIDERS) { const option = element('option', '', providerName(p)); option.value = p; option.selected = p === provider; providerSelect.append(option) }
  providerSelect.onchange = () => { void run({ kind: 'useForAnswers', provider: providerSelect.value as ProviderId }) }
  providerRow.append(element('span', '', 'Answer provider'), providerSelect); answer.append(providerRow); fields.append(answer)
  const model = element('section', 'connection-section'); model.id = 'connection-model-section'
  model.append(element('h2', '', 'Model'))
  const picker = element('select'); picker.id = 'connection-model-picker'; picker.setAttribute('aria-label', 'Model')
  const placeholder = element('option', '', 'Choose a model…'); placeholder.value = ''; picker.append(placeholder)
  if (provider !== 'compatible') {
    const recommended = element('optgroup'); recommended.label = 'Recommended'
    for (const preset of ['fast', 'balanced', 'best'] as const) {
      const option = element('option', '', `${preset === 'balanced' ? 'Balanced (default)' : preset === 'fast' ? 'Fast' : 'Best'} · ${PRESETS[provider][preset].model}`)
      option.value = `preset:${preset}`; option.selected = choice.preset === preset; recommended.append(option)
    }
    picker.append(recommended)
  }
  const available = element('optgroup'); available.label = 'Available models'
  for (const entry of state?.models ?? []) {
    const option = element('option', '', `${entry.name} · ${entry.tested ? 'Tested' : 'Experimental'}${entry.vision ? '' : ' · Text only'}`)
    option.value = `model:${entry.id}`; option.selected = choice.preset === 'custom' && choice.customModel === entry.id; available.append(option)
  }
  if (choice.preset === 'custom' && choice.customModel && !state?.models.some(entry => entry.id === choice.customModel)) {
    const option = element('option', '', `${choice.customModel} · Custom`); option.value = `model:${choice.customModel}`; option.selected = true; available.append(option)
  }
  if (available.children.length) picker.append(available)
  if (!selectedModel(config).model) placeholder.selected = true
  picker.onchange = () => {
    if (picker.value.startsWith('preset:')) chooseModel(picker.value.slice(7) as Preset)
    else if (picker.value.startsWith('model:')) chooseModel('custom', picker.value.slice(6))
  }
  const modelLabel = element('label', 'connection-field'); modelLabel.append(picker); model.append(modelLabel)
  const modelId = state?.answerModel ?? selectedModel(config).model
  const summary = element('p', 'explanation', modelId ? `${modelId} · ${state?.models.find(entry => entry.id === modelId)?.tested ? 'Tested' : 'Experimental'}` : 'Choose a model to start.')
  summary.id = 'connection-model-summary'; model.append(summary, button(state?.models.length ? 'Refresh models' : 'Find models', () => { void run({ kind: 'models', provider }) }))
  fields.append(model)

  const saved = element('section', 'connection-section'); saved.id = 'saved-connections'
  saved.append(element('h2', '', 'Saved connections'))
  const list = element('ul', 'saved-connection-list'), editor = element('div', 'connection-key-editor')
  const showKeyEditor = (p: KeyProvider): void => {
    editor.replaceChildren()
    const input = element('input'); input.id = `connection-key-${p}`; input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false
    const label = element('label', 'connection-field', `${providerName(p)} API key`); input.setAttribute('aria-label', `${providerName(p)} API key`); label.append(input)
    const actions = element('div', 'connection-actions')
    actions.append(button('Test & save key', () => { const key = input.value; input.value = ''; void run({ kind: 'saveKey', provider: p, key }) }, 'primary'), button('Cancel', () => { input.value = ''; editor.remove(); document.getElementById(`replace-key-${p}`)?.focus() }))
    editor.append(label, actions)
    document.getElementById(`saved-${p}`)?.append(editor)
    input.scrollIntoView({ block: 'nearest' }); input.focus()
  }
  for (const p of PROVIDERS) {
    const row = element('li', 'saved-connection'); row.id = `saved-${p}`
    if (p === provider) row.classList.add('current-connection')
    const heading = element('div', 'saved-connection-heading'); heading.append(element('strong', '', providerName(p)))
    if (p === provider) heading.append(element('span', 'current-connection-label', 'Current answers'))
    const status = element('p', 'saved-connection-status'), actions = element('div', 'connection-actions')
    const use = button('Use for answers', () => { void run({ kind: 'useForAnswers', provider: p }) }); use.disabled = p === provider; use.setAttribute('aria-label', `Use ${providerName(p)} for answers`); actions.append(use)
    if (p === 'chatgpt') {
      const account = state?.accounts.find(account => account.id === state.activeAccount)
      status.textContent = account?.connected ? `Signed in as ${[account.name, account.email].filter(Boolean).join(' · ')}${account.sharing ? '' : ' · Plan usage disabled'}` : 'Not signed in'
      if (account?.connected) {
        if (!account.sharing) actions.append(button('Enable plan usage', () => { void run({ kind: 'signIn', accountId: account.id }) }))
        actions.append(button('Sign out', () => { void run({ kind: 'signOut' }) }), button('Manage usage', () => { void run({ kind: 'usage' }) }))
      } else actions.append(button('Sign in', () => { void run({ kind: 'signIn' }) }))
    } else {
      const present = p === 'compatible' ? state?.compatibleKeyPresent : state?.providers[p]
      const hint = present ? keyHints[p] : undefined
      const keyStatus = present ? `Key saved${hint?.suffix ? ` · ends in ••••${hint.suffix}` : ''}${hint?.savedAt !== undefined ? ` · Saved ${new Date(hint.savedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}` : 'Not set'
      status.textContent = p === 'compatible' ? `${new URL(config.baseURL).host} · ${keyStatus}` : keyStatus
      const replace = button(present ? 'Replace key' : 'Add key', () => showKeyEditor(p)); replace.id = `replace-key-${p}`; replace.setAttribute('aria-label', `${present ? 'Replace' : 'Add'} ${providerName(p)} key`); actions.append(replace)
      if (present) { const remove = button('Remove', () => { void run({ kind: 'removeKey', provider: p }) }); remove.setAttribute('aria-label', `Remove ${providerName(p)} key`); actions.append(remove) }
    }
    row.append(heading, status, actions); list.append(row)
  }
  saved.append(list); fields.append(saved)
  const advanced = element('details', 'connection-section'); advanced.id = 'connection-advanced'
  advanced.append(element('summary', '', 'Advanced'))
  const modelInput = element('input'); modelInput.id = 'connection-model'; modelInput.value = choice.customModel; modelInput.placeholder = 'Provider model ID'; modelInput.setAttribute('aria-label', 'Custom model ID')
  const custom = element('label', 'connection-field', 'Custom model ID'); custom.append(modelInput, button('Use custom model', () => chooseModel('custom', modelInput.value))); advanced.append(custom)
  {
    const endpoints = element('div', 'connection-actions')
    for (const [name, baseURL] of [['Ollama', 'http://127.0.0.1:11434/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']]) endpoints.append(button(name!, () => saveEndpoint(baseURL!)))
    const label = element('label', 'connection-field', 'Endpoint'), input = element('input')
    input.id = 'connection-endpoint'; input.value = config.baseURL; input.type = 'url'; input.setAttribute('aria-label', 'OpenAI-compatible base URL')
    label.append(input, button('Save endpoint', () => saveEndpoint(input.value))); advanced.append(endpoints, label)
    advanced.append(element('p', 'explanation', 'Changing endpoints clears the model selection. Find models, then choose one. Enter a new key only if the new endpoint needs it. Use HTTPS, or HTTP on localhost or 127.0.0.1 for local servers.'))
  }
  advanced.append(element('p', 'explanation', 'Storage: keys and sign-in tokens are encrypted and kept only on this Mac, separate from settings and history. Models remain Experimental until evaluated in NimboGuide.'))
  fields.append(advanced)

  if (state?.accounts.length) {
    const accounts = element('select'); accounts.setAttribute('aria-label', 'ChatGPT account'); accounts.id = 'connection-account'
    for (const [index, account] of state.accounts.entries()) { const option = element('option', '', `Account ${index + 1} · ${[account.name, account.email].filter(Boolean).join(' · ') || 'ChatGPT account'}`); option.value = account.id; option.selected = account.id === state.activeAccount; accounts.append(option) }
    accounts.onchange = () => { const account = state.accounts.find(account => account.id === accounts.value); if (account) void run(account.connected ? { kind: 'selectAccount', accountId: account.id } : { kind: 'signIn', accountId: account.id }) }
    const label = element('label', 'connection-field', 'ChatGPT account'); label.append(accounts); advanced.append(label, button('Sign in to another account', () => { void run({ kind: 'signIn', newAccount: true }) }))
  }
  fields.append(feedback)
}
