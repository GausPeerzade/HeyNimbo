import type { AppSettings, AppSnapshot } from '../shared/app'
import { PROVIDERS, PROVIDER_NAMES, RECOMMENDED_MODELS, defaultConnectionSettings, modelEfforts, modelSpeeds, recommendedModel, selectedModel, type ConnectionRequest, type ConnectionResult, type ConnectionSettings, type Effort, type KeyHints, type KeyProvider, type ProviderId, type Speed } from '../shared/providers'
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
  const accountAction = (label: string, value: ConnectionRequest): HTMLButtonElement => {
    const action = button(label, () => { void run(value) }); action.id = `chatgpt-${value.kind}`; return action
  }
  const change = async (patch: Partial<ConnectionSettings>): Promise<void> => update({ connection: { ...config, ...patch } })
  const chooseModel = (model: string): void => {
    const levels = modelEfforts(provider, model)
    const effort = choice.effort && levels.includes(choice.effort) ? choice.effort : undefined
    const speed = choice.speed && modelSpeeds(provider, model).includes(choice.speed) ? choice.speed : undefined
    void change({ models: { ...config.models, [provider]: { model, ...(effort ? { effort } : {}), ...(speed ? { speed } : {}) } } })
  }
  const saveEndpoint = (baseURL: string): void => { void change({ baseURL, models: { ...config.models, compatible: { model: '' } } }) }
  const currentModel = state?.answerModel ?? selectedModel(config).model
  const vision = state?.answerVision ?? selectedModel(config).vision
  const intro = element('p', 'settings-intro', 'One model explains, draws, builds 3D and does tasks. Choose how much it thinks before answering.'); fields.append(intro)
  const answer = element('section', 'connection-section settings-group'); answer.id = 'connection-answer'
  const sectionTitle = element('h2', 'section-title', 'Answer preferences'); fields.append(sectionTitle)
  const providerRow = element('label', 'row'), providerSelect = element('select')
  providerSelect.id = 'connection-provider'; providerSelect.setAttribute('aria-label', 'Answer provider')
  for (const p of PROVIDERS) { const option = element('option', '', `${providerName(p)}${state?.providers[p] ? ' · Connected' : ' · Set up'}`); option.value = p; option.selected = p === provider; providerSelect.append(option) }
  providerSelect.onchange = () => { void run({ kind: 'useForAnswers', provider: providerSelect.value as ProviderId }) }
  providerRow.append(element('span', '', 'Provider'), providerSelect); answer.append(providerRow); fields.append(answer)
  const model = element('div', 'model-preferences'); model.id = 'connection-model-section'
  const picker = element('select'); picker.id = 'connection-model-picker'; picker.setAttribute('aria-label', 'Model')
  const placeholder = element('option', '', 'Choose a model…'); placeholder.value = ''; picker.append(placeholder)
  const recommended = element('optgroup'); recommended.label = 'Recommended'
  for (const [index, entry] of RECOMMENDED_MODELS[provider].entries()) {
    const option = element('option', '', `${entry.name}${index === 0 ? ' (recommended)' : ''}`)
    option.value = entry.model; option.selected = choice.model === entry.model; recommended.append(option)
  }
  if (recommended.children.length) picker.append(recommended)
  const available = element('optgroup'); available.label = 'Available models'
  for (const entry of state?.models ?? []) {
    if (recommendedModel(provider, entry.id)) continue
    const option = element('option', '', `${entry.name}${entry.vision ? '' : ' · Text only'}`)
    option.value = entry.id; option.selected = choice.model === entry.id; available.append(option)
  }
  if (choice.model && !recommendedModel(provider, choice.model) && !state?.models.some(entry => entry.id === choice.model)) {
    const option = element('option', '', `${choice.model} · Custom`); option.value = choice.model; option.selected = true; available.append(option)
  }
  if (available.children.length) picker.append(available)
  if (!selectedModel(config).model) placeholder.selected = true
  picker.onchange = () => { if (picker.value) chooseModel(picker.value) }
  const modelLabel = element('label', 'row'); modelLabel.append(element('span', '', 'Model'), picker); model.append(modelLabel)
  const thinkingRow = element('label', 'row'), thinking = element('select'); thinking.id = 'connection-thinking'; thinking.setAttribute('aria-label', 'Thinking')
  const levels = modelEfforts(provider, choice.model)
  for (const level of [undefined, ...levels]) {
    const option = element('option', '', level ? level[0]!.toUpperCase() + level.slice(1) : levels.length ? 'Provider default' : 'Managed by provider')
    option.value = level ?? ''; option.selected = choice.effort === level; thinking.append(option)
  }
  thinking.disabled = !levels.length
  thinking.onchange = () => { void change({ models: { ...config.models, [provider]: { model: choice.model, ...(thinking.value ? { effort: thinking.value as Effort } : {}), ...(choice.speed ? { speed: choice.speed } : {}) } } }) }
  thinkingRow.append(element('span', '', 'Thinking'), thinking); model.append(thinkingRow)
  // OpenAI service tiers: faster answers at a higher price per token.
  const speeds = modelSpeeds(provider, choice.model)
  if (speeds.length) {
    const speedRow = element('label', 'row'), speed = element('select'); speed.id = 'connection-speed'; speed.setAttribute('aria-label', 'Speed')
    const labels: Record<Speed, string> = { standard: 'Standard', fast: 'Fast · about 2× price', ultrafast: 'Ultrafast · about 6× price' }
    for (const level of speeds) { const option = element('option', '', labels[level]); option.value = level; option.selected = (choice.speed ?? 'standard') === level; speed.append(option) }
    speed.onchange = () => { void change({ models: { ...config.models, [provider]: { model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), ...(speed.value !== 'standard' ? { speed: speed.value as Speed } : {}) } } }) }
    speedRow.append(element('span', '', 'Speed'), speed); model.append(speedRow)
  }
  answer.append(model)
  const summary = element('p', 'explanation', recommendedModel(provider, currentModel)?.hint ?? 'Custom model. Screen support is checked against the provider’s model list.')
  summary.id = 'connection-model-summary'; fields.append(summary, element('p', 'explanation', levels.length ? 'More thinking can improve accuracy, but may delay the first spoken words and drawings.' : 'Thinking controls are not available for this model through this connection.'))
  const screenSummary = element('p', 'capability-summary', `${vision && snapshot.keyPresent ? 'Screen context and drawings available' : 'Screen context and drawings unavailable'} · One model for the whole answer`); fields.append(screenSummary)

  const saved = element('section', 'connection-section'); saved.id = 'saved-connections'
  saved.append(element('h2', 'section-title', 'Saved connections'), element('p', 'explanation', 'Keys and sign-ins stay on this Mac. Connecting a provider doesn’t change which one answers.'))
  const list = element('ul', 'saved-connection-list'), editor = element('div', 'connection-key-editor')
  const showKeyEditor = (p: KeyProvider, automatic = false): void => {
    editor.replaceChildren()
    const input = element('input'); input.id = `connection-key-${p}`; input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false
    const label = element('label', 'connection-field', `${providerName(p)} API key`); input.setAttribute('aria-label', `${providerName(p)} API key`); label.append(input)
    const actions = element('div', 'connection-actions')
    actions.append(button('Test & save key', () => { const key = input.value; input.value = ''; void run({ kind: 'saveKey', provider: p, key }) }, 'primary'), button('Cancel', () => { input.value = ''; editor.remove(); document.getElementById(`replace-key-${p}`)?.focus() }))
    editor.append(label, actions)
    input.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); input.value = ''; editor.remove() } }
    if (automatic) answer.append(editor)
    else { document.getElementById(`saved-${p}`)?.append(editor); input.scrollIntoView({ block: 'nearest' }); input.focus() }
  }
  for (const p of PROVIDERS) {
    const row = element('li', 'saved-connection'); row.id = `saved-${p}`
    if (p === provider) row.classList.add('current-connection')
    const heading = element('div', 'saved-connection-heading'); heading.append(element('strong', '', providerName(p)))
    if (p === provider) heading.append(element('span', 'current-connection-label', 'Current answers'))
    const status = element('p', 'saved-connection-status'), actions = element('div', 'connection-actions')
    if (p !== provider && state?.providers[p]) {
      const use = button('Use', () => { void run({ kind: 'useForAnswers', provider: p }) }); use.id = `use-provider-${p}`; use.setAttribute('aria-label', `Use ${providerName(p)} for answers`); actions.append(use)
    }
    if (p === 'chatgpt') {
      const account = state?.accounts.find(account => account.id === state.activeAccount)
      status.textContent = account?.connected ? `Signed in as ${[account.name, account.email].filter(Boolean).join(' · ')}${account.sharing ? '' : ' · Plan usage disabled'}` : 'Not signed in'
      if (account?.connected) {
        if (!account.sharing) actions.append(accountAction('Enable plan usage', { kind: 'signIn', accountId: account.id }))
        actions.append(accountAction('Sign out', { kind: 'signOut' }), accountAction('Manage usage', { kind: 'usage' }))
      } else actions.append(accountAction('Sign in', { kind: 'signIn' }))
    } else {
      const present = p === 'compatible' ? state?.compatibleKeyPresent : state?.providers[p]
      const hint = present ? keyHints[p] : undefined
      const keyStatus = present ? `Key saved${hint?.suffix ? ` · ends in ••••${hint.suffix}` : ''}${hint?.savedAt !== undefined ? ` · Saved ${new Date(hint.savedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}` : 'Not set'
      status.textContent = p === 'compatible' ? `${new URL(config.baseURL).host} · ${present ? keyStatus : 'Key optional for local servers'}` : keyStatus
      const replace = button(present ? 'Replace key' : 'Add key', () => showKeyEditor(p)); replace.id = `replace-key-${p}`; replace.setAttribute('aria-label', `${present ? 'Replace' : 'Add'} ${providerName(p)} key`); actions.append(replace)
      if (present) { const remove = button('Remove', () => { void run({ kind: 'removeKey', provider: p }) }, 'danger'); remove.id = `remove-key-${p}`; remove.setAttribute('aria-label', `Remove ${providerName(p)} key`); actions.append(remove) }
    }
    const identity = element('div', 'saved-connection-identity'); identity.append(heading, status)
    const connected = p === 'chatgpt' ? state?.accounts.some(account => account.id === state.activeAccount && account.connected) : p === 'compatible' ? state?.compatibleKeyPresent : state?.providers[p]
    if (connected) {
      const manage = element('details', 'connection-manage'); manage.id = `manage-${p}`
      const disclosure = element('summary', '', 'Manage'); disclosure.id = `manage-toggle-${p}`; disclosure.setAttribute('aria-label', `Manage ${providerName(p)}`)
      manage.append(disclosure, actions); row.append(identity, manage)
    } else row.append(identity, actions)
    list.append(row)
  }
  saved.append(list); fields.append(saved)
  const advanced = element('details', 'connection-section'); advanced.id = 'connection-advanced'
  advanced.append(element('summary', '', 'Advanced'))
  advanced.append(button('Refresh model list', () => { void run({ kind: 'models', provider }) }))
  const modelInput = element('input'); modelInput.id = 'connection-model'; modelInput.value = choice.model; modelInput.placeholder = 'Provider model ID'; modelInput.setAttribute('aria-label', 'Custom model ID')
  const custom = element('label', 'connection-field', 'Custom model ID'); custom.append(modelInput, button('Use custom model', () => chooseModel(modelInput.value))); advanced.append(custom)
  if (provider === 'compatible') {
    const endpoints = element('div', 'connection-actions')
    for (const [name, baseURL] of [['Ollama', 'http://127.0.0.1:11434/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']]) endpoints.append(button(name!, () => saveEndpoint(baseURL!)))
    const label = element('label', 'connection-field', 'Endpoint'), input = element('input')
    input.id = 'connection-endpoint'; input.value = config.baseURL; input.type = 'url'; input.setAttribute('aria-label', 'OpenAI-compatible base URL')
    label.append(input, button('Save endpoint', () => saveEndpoint(input.value))); advanced.append(endpoints, label)
    advanced.append(element('p', 'explanation', 'Changing endpoints clears the model selection. Find models, then choose one. Enter a new key only if the new endpoint needs it. Use HTTPS, or HTTP on localhost or 127.0.0.1 for local servers.'))
  }
  advanced.append(element('p', 'explanation', 'Storage: keys and sign-in tokens are kept only on this Mac, in a credentials file only your user account can read, separate from settings and history. Background tasks cannot read it. Models remain Experimental until evaluated in HeyNimbo.'))
  fields.append(advanced)

  if (state?.accounts.length) {
    const accounts = element('select'); accounts.setAttribute('aria-label', 'ChatGPT account'); accounts.id = 'connection-account'
    for (const [index, account] of state.accounts.entries()) { const option = element('option', '', `Account ${index + 1} · ${[account.name, account.email].filter(Boolean).join(' · ') || 'ChatGPT account'}`); option.value = account.id; option.selected = account.id === state.activeAccount; accounts.append(option) }
    accounts.onchange = () => { const account = state.accounts.find(account => account.id === accounts.value); if (account) void run(account.connected ? { kind: 'selectAccount', accountId: account.id } : { kind: 'signIn', accountId: account.id }) }
    const label = element('label', 'connection-field', 'ChatGPT account'); label.append(accounts); advanced.append(label, button('Sign in to another account', () => { void run({ kind: 'signIn', newAccount: true }) }))
  }
  const voice = element('section', 'connection-section'); voice.id = 'connection-voice'
  voice.append(element('h2', 'section-title', 'Voice'))
  const voiceLine = state?.voice === 'OpenAI' || state?.voice === 'Built into your Mac' ? `Voice: ${state.voice}${snapshot.settings.muted ? ' · Muted' : ''}` : `Voice: not available. ${state?.voiceReason ?? 'Add an OpenAI key, or use built-in Mac speech.'}`
  voice.append(element('p', 'explanation', voiceLine))
  if (state?.needsSpeechPermission) voice.append(button('Allow speech recognition', () => { void run({ kind: 'allowSpeechRecognition' }) }))
  fields.append(voice, feedback)
  // Selecting an unconnected provider opens its setup without making a network request.
  if (provider === 'chatgpt' && !state?.providers.chatgpt) {
    const setup = element('div', 'row'); setup.append(element('span', '', 'Connect your ChatGPT account'), button('Sign in', () => { void run({ kind: 'signIn' }) })); answer.append(setup)
  }
  if (provider !== 'chatgpt' && provider !== 'compatible' && !state?.providers[provider]) showKeyEditor(provider, true)
}
