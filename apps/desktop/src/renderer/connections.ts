import type { AppSettings, AppSnapshot } from '../shared/app'
import { PROVIDERS, PROVIDER_NAMES, PRESETS, defaultConnectionSettings, type ConnectionRequest, type ConnectionResult, type ConnectionSettings, type KeyProvider, type Preset } from '../shared/providers'
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
  fields.append(element('p', 'connection-state', `Answers use: ${PROVIDER_NAMES[provider]} · ${state?.answerModel || 'Choose a model'}`))
  fields.append(element('p', 'explanation', `Voice uses: ${state?.voice ?? (snapshot.keyPresent ? 'OpenAI key' : 'unavailable')}. ChatGPT plan tokens cannot power realtime voice or transcription. Add an OpenAI key for voice with any answer provider.`))
  const providerRow = element('label', 'row'), providerSelect = element('select')
  providerSelect.id = 'connection-provider'; providerSelect.setAttribute('aria-label', 'Answer provider')
  for (const p of PROVIDERS) { const option = element('option', '', PROVIDER_NAMES[p]); option.value = p; option.selected = p === provider; providerSelect.append(option) }
  providerSelect.onchange = () => { void change({ provider: providerSelect.value as ConnectionSettings['provider'] }) }
  providerRow.append(element('span', '', 'Answer provider'), providerSelect); fields.append(providerRow)
  if (provider === 'chatgpt') {
    const accounts = state?.accounts ?? []
    for (const account of accounts) {
      const row = element('div', 'permission'), text = element('span')
      text.append(element('strong', '', account.name || 'ChatGPT account'), element('small', '', `${account.email} · Registration ${account.id.slice(0, 8)} · ${account.sharing ? 'Using ChatGPT plan' : account.connected ? 'Plan usage disabled' : 'Signed out'}`))
      row.append(text, button(account.id === state?.activeAccount ? 'Continue with ChatGPT' : 'Use account', () => { void run(account.id === state?.activeAccount || !account.connected ? { kind: 'signIn', accountId: account.id } : { kind: 'selectAccount', accountId: account.id }) }))
      fields.append(row)
    }
    const actions = element('div', 'connection-actions')
    actions.append(button(accounts.length ? 'Add ChatGPT account' : 'Continue with ChatGPT', () => { void run({ kind: 'signIn', newAccount: accounts.length > 0 }) }, 'primary'))
    if (state?.activeAccount) actions.append(button('Sign out', () => { void run({ kind: 'signOut' }) }))
    actions.append(button('Refresh models', () => { void run({ kind: 'models', provider: 'chatgpt' }) }))
    actions.append(button('Manage usage', () => { void run({ kind: 'usage' }) })); fields.append(actions)
    fields.append(element('p', 'explanation', 'Use your eligible Plus or Pro plan for NimboGuide answers, at no charge from NimboGuide. Requests run only when you ask; no ChatGPT conversations are accessed.'))
  } else {
    if (provider === 'compatible') {
      const endpoints = element('div', 'connection-actions')
      for (const [name, baseURL] of [['Ollama', 'http://127.0.0.1:11434/v1'], ['LM Studio', 'http://127.0.0.1:1234/v1']]) endpoints.append(button(name!, () => { void change({ baseURL: baseURL! }) }))
      const label = element('label', 'connection-field', 'Base URL'), input = element('input')
      input.id = 'connection-endpoint'; input.value = config.baseURL; input.type = 'url'; input.setAttribute('aria-label', 'OpenAI-compatible base URL')
      label.append(input, button('Save endpoint', () => { void change({ baseURL: input.value }) })); fields.append(endpoints, label)
      fields.append(element('p', 'explanation', 'HTTPS endpoints only, except HTTP on 127.0.0.1 or localhost. Local servers need no key. Groq, Together and vLLM work through this connection. Unknown model capabilities default to text-only.'))
    }
    const label = element('label', 'connection-field', `${PROVIDER_NAMES[provider]} API key${provider === 'compatible' ? ' (optional)' : ''}`), input = element('input')
    input.id = 'connection-key'; input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = state?.providers[provider] ? 'Enter a replacement key' : 'Paste API key'; input.setAttribute('aria-label', label.textContent!)
    const actions = element('div', 'connection-actions')
    actions.append(button('Test & save key', () => { const key = input.value; input.value = ''; void run({ kind: 'saveKey', provider: provider as KeyProvider, key }) }, 'primary'), button('Test / refresh models', () => { void run({ kind: 'models', provider: provider as KeyProvider }) }), button('Remove key', () => { input.value = ''; void run({ kind: 'removeKey', provider: provider as KeyProvider }) }))
    label.append(input); fields.append(label, actions)
    fields.append(element('p', 'explanation', 'Keys are encrypted locally with safeStorage / macOS Keychain. Saved credentials are never returned to this window, logged, or stored with conversations. API providers bill your account. You may keep keys for several providers at once.'))
  }
  if (provider !== 'openai') {
    const voice = element('details'), summary = element('summary', '', 'Voice key · OpenAI API key only'), voiceKey = element('input')
    voiceKey.id = 'voice-key'; voiceKey.type = 'password'; voiceKey.autocomplete = 'off'; voiceKey.spellcheck = false; voiceKey.setAttribute('aria-label', 'OpenAI API key for voice')
    const voiceLabel = element('label', 'connection-field', 'A separate OpenAI key enables ears and mouth without changing your answer provider.')
    voiceLabel.append(voiceKey)
    const actions = element('div', 'connection-actions')
    actions.append(button('Test & save voice key', () => { const key = voiceKey.value; voiceKey.value = ''; void run({ kind: 'saveKey', provider: 'openai', key }) }))
    if (state?.providers.openai) actions.append(button('Remove voice key', () => { void run({ kind: 'removeKey', provider: 'openai' }) }))
    voice.append(summary, voiceLabel, actions); fields.append(voice)
  }
  fields.append(element('h2', '', 'Model'))
  const presetRow = element('label', 'connection-field'), presets = element('select')
  presets.id = 'connection-preset'; presets.setAttribute('aria-label', 'Model preset')
  for (const p of ['fast', 'balanced', 'best', 'custom'] as const) {
    if (provider === 'compatible' && p !== 'custom') continue
    const option = element('option', '', p === 'custom' ? 'Advanced / custom model' : `${p === 'balanced' ? 'Balanced (default)' : p === 'fast' ? 'Fast' : 'Best'} · ${PRESETS[provider][p].model}`)
    option.value = p; option.selected = p === choice.preset || (provider === 'compatible' && p === 'custom'); presets.append(option)
  }
  const chooseModel = (preset: Preset, customModel = choice.customModel): void => { void change({ models: { ...config.models, [provider]: { preset, customModel } } }) }
  presets.onchange = () => { if (presets.value !== 'custom' || choice.customModel) chooseModel(presets.value as Preset); else document.getElementById('connection-model')?.focus() }
  presetRow.append(element('span', '', 'Recommended preset'), presets); fields.append(presetRow)
  const modelLabel = element('label', 'connection-field', 'Advanced: custom model ID'), modelInput = element('input')
  modelInput.id = 'connection-model'; modelInput.value = choice.customModel; modelInput.placeholder = 'Provider model ID'; modelInput.setAttribute('aria-label', 'Custom model ID')
  modelLabel.append(modelInput, button('Use custom model', () => chooseModel('custom', modelInput.value))); fields.append(modelLabel)
  if (state?.models.length) {
    const modelList = element('select'); modelList.id = 'connection-model-list'; modelList.setAttribute('aria-label', 'Available models')
    modelList.append(element('option', '', 'Choose an available model…'))
    for (const model of state.models) {
      const recommended = Object.values(PRESETS[provider]).some(p => p.model === model.id)
      const option = element('option', '', `${model.name} · ${model.tested ? 'Tested' : 'Experimental'}${recommended ? ' · Recommended' : ''}${model.vision ? ' · Screen input' : ' · Text-only'}`)
      option.value = model.id; modelList.append(option)
    }
    modelList.onchange = () => {
      if (!modelList.value) return
      const preset = (['balanced', 'fast', 'best'] as const).find(p => PRESETS[provider][p].model === modelList.value)
      chooseModel(preset ?? 'custom', modelList.value)
    }; fields.append(modelList)
  }
  fields.append(element('p', 'explanation', state?.answerVision ? 'Answers can include screen context and coordinate drawings. Models are Experimental until evaluated on this app; recommended IDs and parameters are documentation-verified.' : 'Text-only model: no screenshot is sent, and screen-coordinate drawing is disabled. You can still ask fully typed questions.'))
  fields.append(feedback)
}
