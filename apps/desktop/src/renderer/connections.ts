import type { AppSettings, AppSnapshot } from '../shared/app'
import { PROVIDERS, PROVIDER_NAMES, PRESETS, defaultConnectionSettings, selectedModel, type ConnectionRequest, type ConnectionResult, type ConnectionSettings, type KeyProvider, type Preset } from '../shared/providers'
import { button, element, request } from './app-dom'

export function renderConnections(fields: HTMLElement, snapshot: AppSnapshot, update: (patch: Partial<AppSettings>) => Promise<void>): void {
  const config = snapshot.settings.connection ?? defaultConnectionSettings(), state = snapshot.connection
  const provider = config.provider, choice = config.models[provider]
  const feedback = element('p', 'explanation'); feedback.id = 'connection-feedback'; feedback.role = 'status'
  const run = async (value: ConnectionRequest): Promise<void> => {
    feedback.textContent = value.kind === 'signIn' ? 'Finish signing in in your browser…' : 'Checking connection…'
    fields.querySelectorAll('button').forEach(node => { node.disabled = true })
    const result = await request({ kind: 'connection', request: value }) as ConnectionResult | undefined
    feedback.textContent = result?.message ?? 'Could not update the connection.'
    fields.querySelectorAll('button').forEach(node => { node.disabled = false })
    // Snapshot publishing can replace these nodes; keep the status discoverable.
    const live = document.getElementById('connection-feedback'); if (live) live.textContent = feedback.textContent
  }
  const change = async (patch: Partial<ConnectionSettings>): Promise<void> => update({ connection: { ...config, ...patch } })
  const chooseModel = (preset: Preset, customModel = choice.customModel): void => { void change({ models: { ...config.models, [provider]: { preset, customModel } } }) }
  const saveEndpoint = (baseURL: string): void => { void change({ baseURL, models: { ...config.models, compatible: { preset: 'custom', customModel: '' } } }) }
  const answer = element('section', 'connection-section'); answer.id = 'connection-answer'
  const providerRow = element('label', 'row'), providerSelect = element('select')
  providerSelect.id = 'connection-provider'; providerSelect.setAttribute('aria-label', 'Answer provider')
  for (const p of PROVIDERS) { const option = element('option', '', PROVIDER_NAMES[p]); option.value = p; option.selected = p === provider; providerSelect.append(option) }
  providerSelect.onchange = () => { void change({ provider: providerSelect.value as ConnectionSettings['provider'] }) }
  providerRow.append(element('span', '', 'Answer provider'), providerSelect); answer.append(providerRow)
  if (provider === 'chatgpt') {
    const accounts = state?.accounts ?? []
    for (const account of accounts) {
      const row = element('div', 'permission'), text = element('span')
      text.append(element('strong', '', account.name || 'ChatGPT account'), element('small', '', `${account.email} · Registration ${account.id.slice(0, 8)} · ${account.sharing ? 'Using ChatGPT plan' : account.connected ? 'Plan usage disabled' : 'Signed out'}`))
      row.append(text, button(account.id === state?.activeAccount ? 'Continue with ChatGPT' : 'Use account', () => { void run(account.id === state?.activeAccount || !account.connected ? { kind: 'signIn', accountId: account.id } : { kind: 'selectAccount', accountId: account.id }) }))
      answer.append(row)
    }
    const actions = element('div', 'connection-actions')
    actions.append(button(accounts.length ? 'Add ChatGPT account' : 'Continue with ChatGPT', () => { void run({ kind: 'signIn', newAccount: accounts.length > 0 }) }, 'primary'))
    if (state?.activeAccount) actions.append(button('Sign out', () => { void run({ kind: 'signOut' }) }))
    actions.append(button('Manage usage', () => { void run({ kind: 'usage' }) })); answer.append(actions)
    answer.append(element('p', 'explanation', 'Use your eligible Plus or Pro plan for answers. NimboGuide does not charge for plan usage or access your ChatGPT conversations.'))
  } else {
    const keyPresent = provider === 'compatible' ? state?.compatibleKeyPresent : state?.providers[provider]
    const label = element('label', 'connection-field', `${PROVIDER_NAMES[provider]} API key${provider === 'compatible' ? ' (optional)' : ''}`), input = element('input')
    input.id = 'connection-key'; input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = keyPresent ? 'Enter a replacement key' : 'Paste API key'; input.setAttribute('aria-label', label.textContent!)
    const actions = element('div', 'connection-actions')
    actions.append(button('Test & save key', () => { const key = input.value; input.value = ''; void run({ kind: 'saveKey', provider: provider as KeyProvider, key }) }, 'primary'))
    if (keyPresent) actions.append(button('Remove key', () => { input.value = ''; void run({ kind: 'removeKey', provider: provider as KeyProvider }) }))
    label.append(input); answer.append(label, actions)
    answer.append(element('p', 'explanation', provider === 'compatible' ? 'Local servers usually need no key. Keys are used only with the endpoint where you saved them.' : 'Your API provider bills your account. Keys stay on this Mac.'))
  }
  fields.append(answer)

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
  const modelId = state?.answerModel ?? selectedModel(config).model, vision = state?.answerVision ?? selectedModel(config).vision
  const capabilities = vision ? 'Sees your screen · Draws on screen' : 'Text only · Does not see or draw on your screen'
  const summary = element('p', 'explanation', modelId ? `${modelId} · ${capabilities}${state?.voice === 'OpenAI key' ? ' · Reads answers aloud' : ''} · ${state?.models.find(entry => entry.id === modelId)?.tested ? 'Tested' : 'Experimental'}` : 'Choose a model to start.')
  summary.id = 'connection-model-summary'; model.append(summary, button(state?.models.length ? 'Refresh models' : 'Find models', () => { void run({ kind: 'models', provider }) }))
  fields.append(model)

  const advanced = element('details', 'connection-section'); advanced.id = 'connection-advanced'
  advanced.append(element('summary', '', 'Advanced'))
  const modelInput = element('input'); modelInput.id = 'connection-model'; modelInput.value = choice.customModel; modelInput.placeholder = 'Provider model ID'; modelInput.setAttribute('aria-label', 'Custom model ID')
  const custom = element('label', 'connection-field', 'Custom model ID'); custom.append(modelInput, button('Use custom model', () => chooseModel('custom', modelInput.value))); advanced.append(custom)
  if (provider === 'compatible') {
    const endpoints = element('div', 'connection-actions')
    for (const [name, baseURL] of [['Ollama', 'http://127.0.0.1:11434/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']]) endpoints.append(button(name!, () => saveEndpoint(baseURL!)))
    const label = element('label', 'connection-field', 'Endpoint'), input = element('input')
    input.id = 'connection-endpoint'; input.value = config.baseURL; input.type = 'url'; input.setAttribute('aria-label', 'OpenAI-compatible base URL')
    label.append(input, button('Save endpoint', () => saveEndpoint(input.value))); advanced.append(endpoints, label)
    advanced.append(element('p', 'explanation', 'Changing endpoints clears the model selection. Find models, then choose one. Enter a new key only if the new endpoint needs it. Use HTTPS, or HTTP on localhost or 127.0.0.1 for local servers.'))
  }
  advanced.append(element('p', 'explanation', 'Storage: keys and sign-in tokens are encrypted and kept only on this Mac, separate from settings and history. Models remain Experimental until evaluated in NimboGuide.'))
  fields.append(advanced)

  const voice = element('details', 'connection-section'); voice.id = 'connection-voice'
  voice.append(element('summary', '', 'Voice (optional)'))
  voice.append(element('p', 'explanation', `${state?.voice === 'OpenAI key' ? 'On: reads answers aloud and lets you ask by speaking.' : 'Off: add an OpenAI API key to read answers aloud and ask by speaking.'} ChatGPT plan sign-in powers answers only.`))
  if (provider !== 'openai') {
    const voiceKey = element('input'); voiceKey.id = 'voice-key'; voiceKey.type = 'password'; voiceKey.autocomplete = 'off'; voiceKey.spellcheck = false; voiceKey.setAttribute('aria-label', 'OpenAI API key for voice')
    const label = element('label', 'connection-field', 'OpenAI API key'); label.append(voiceKey)
    const actions = element('div', 'connection-actions')
    actions.append(button('Test & save voice key', () => { const key = voiceKey.value; voiceKey.value = ''; void run({ kind: 'saveKey', provider: 'openai', key }) }, 'primary'))
    if (state?.providers.openai) actions.append(button('Remove voice key', () => { void run({ kind: 'removeKey', provider: 'openai' }) }))
    voice.append(label, actions, element('p', 'explanation', 'This does not change your answer provider. OpenAI bills audio usage to this API key.'))
  } else voice.append(element('p', 'explanation', 'The OpenAI key above also powers voice.'))
  fields.append(voice, feedback)
}
