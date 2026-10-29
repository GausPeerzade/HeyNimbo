import { shell } from 'electron'
import { PROVIDERS, RECOMMENDED_MODELS, defaultConnectionSettings, recommendedModel, selectedModel, type ConnectionRequest, type ConnectionResult, type ConnectionSettings, type ConnectionSnapshot, type Effort, type KeyProvider, type KeyHints, type ModelInfo, type ProviderId } from '../shared/providers'
import { ChatGPTAuth } from './chatgpt-auth'
import { loadSecret, removeSecret, saveSecret, secretSavedAt } from './secrets'
import { validateBaseURL } from './provider-settings'
import { listProviderModels } from './model-catalog'
import type { AnswerConnection } from './answer-provider'
import type { SettingsStore } from './settings'
import { allowSpeechRecognition, selectVoiceEngine } from './voice/engine'

export class Connections {
  readonly auth = new ChatGPTAuth(url => shell.openExternal(url))
  private keys = new Map<KeyProvider, string>()
  private compatibleKey?: { baseURL: string; key: string }
  private catalogs = new Map<string, ModelInfo[]>()
  private savedAt = new Map<KeyProvider, number>()
  private mutating = false
  constructor(private readonly settings: Pick<SettingsStore, 'get' | 'set'>, private readonly changed: () => void, private readonly openSettings: () => void = () => {}) {}
  async load(): Promise<void> {
    for (const provider of PROVIDERS) if (provider !== 'chatgpt') {
      const date = await secretSavedAt(`${provider}-key`)
      if (date !== undefined) this.savedAt.set(provider, date)
      const key = await loadSecret(`${provider}-key`)
      if (provider === 'compatible') {
        this.compatibleKey = undefined
        // A stored compatible credential is valid only with its explicit endpoint binding.
        try {
          const saved = JSON.parse(key ?? '') as { baseURL?: unknown; key?: unknown }
          if (typeof saved.key === 'string' && saved.key) this.compatibleKey = { baseURL: validateBaseURL(saved.baseURL), key: saved.key }
        } catch { /* Re-enter a key to bind it to an endpoint. */ }
      } else if (key) this.keys.set(provider, key)
    }
    await this.auth.load()
  }
  get config(): ConnectionSettings { return this.settings.get().connection ?? defaultConnectionSettings() }
  get voiceKey(): string | undefined { return this.keys.get('openai') }
  get voiceEngine(): ReturnType<typeof selectVoiceEngine> { return selectVoiceEngine(this.voiceKey) }
  private catalogKey(provider: ProviderId, config = this.config): string { return provider === 'compatible' ? `${provider}:${config.baseURL}` : provider === 'chatgpt' ? `${provider}:${this.auth.active?.id}` : provider }
  snapshot(): ConnectionSnapshot {
    const config = this.config, selected = selectedModel(config), voice = this.voiceEngine
    const catalog = this.catalogs.get(this.catalogKey(config.provider))
    const models = catalog ?? RECOMMENDED_MODELS[config.provider].map(entry => ({ id: entry.model, name: entry.name, vision: entry.vision, tested: false }))
    return {
      providers: Object.fromEntries(PROVIDERS.map(p => [p, p === 'chatgpt' ? Boolean(this.auth.active?.tokens?.scopes.includes('chatgpt.tokens.use.direct')) : p === 'compatible' ? Boolean(config.models.compatible.model) : this.keys.has(p)])) as Record<ProviderId, boolean>,
      accounts: this.auth.profiles.map(p => ({ id: p.id, name: p.identity?.name ?? 'Finish sign-in', email: p.identity?.email ?? '', connected: Boolean(p.tokens), sharing: Boolean(p.tokens?.scopes.includes('chatgpt.tokens.use.direct')) })), activeAccount: this.auth.active?.id,
      compatibleKeyPresent: Boolean(this.compatibleKey?.baseURL === config.baseURL),
      models, answerModel: selected.model, answerVision: catalog?.find(m => m.id === selected.model)?.vision ?? selected.vision,
      voice: voice.engine === 'openai' ? 'OpenAI' : voice.engine === 'builtin' ? 'Built into your Mac' : 'unavailable',
      ...(voice.engine === 'unavailable' ? { voiceReason: voice.reason, needsSpeechPermission: voice.needsPermission } : {}),
    }
  }
  private keyHints(): KeyHints {
    const hints: KeyHints = {}
    for (const provider of PROVIDERS) if (provider !== 'chatgpt') {
      const value = provider === 'compatible' ? (this.compatibleKey?.baseURL === this.config.baseURL ? this.compatibleKey.key : undefined) : this.keys.get(provider)
      if (value) hints[provider] = { suffix: value.length > 4 ? value.slice(-4) : '', savedAt: this.savedAt.get(provider) }
    }
    return hints
  }
  get answerReady(): boolean {
    const config = this.config
    return Boolean(selectedModel(config).model && this.snapshot().providers[config.provider])
  }
  private async credential(provider: ProviderId, config = this.config): Promise<string> {
    if (provider === 'chatgpt') return this.auth.credential()
    if (provider === 'compatible') return this.compatibleKey?.baseURL === config.baseURL ? this.compatibleKey.key : ''
    const key = this.keys.get(provider)
    if (!key) throw new Error('Add a key for the selected answer provider in Settings → Connection.')
    return key ?? ''
  }
  private async discover(provider: ProviderId, key?: string, config = this.config): Promise<ModelInfo[]> {
    const models = await listProviderModels(provider, key ?? await this.credential(provider, config), config.baseURL)
    this.catalogs.set(this.catalogKey(provider, config), models)
    return models
  }
  async validateSettings(candidate: ConnectionSettings | undefined): Promise<ConnectionSettings | undefined> {
    if (!candidate) return
    const config = structuredClone(candidate)
    if (config.baseURL !== this.config.baseURL) config.models.compatible = { model: '' }
    const choice = config.models[config.provider]
    if (!choice.model || recommendedModel(config.provider, choice.model)) return config
    if (config.provider !== 'compatible' && !this.snapshot().providers[config.provider]) return config
    try {
      const models = await this.discover(config.provider, undefined, config)
      if (models.length && !models.some(m => m.id === choice.model)) throw new Error('That model is not available for this connection. Refresh the model list or choose another model.')
    } catch (error) { throw new Error(publicConnectionError(error)) }
    return config
  }
  answer(): AnswerConnection {
    const config = structuredClone(this.config)
    return this.connection(config, selectedModel(config))
  }
  /** An explicit provider and model on the saved credentials, for development
   *  evaluation. Settings supply only the compatible endpoint and are never
   *  written. Without an effort, a recommended model uses its default thinking level. */
  answerFor(provider: ProviderId, model: string, effort?: Effort): AnswerConnection {
    const config = { ...structuredClone(this.config), provider }
    const recommended = recommendedModel(provider, model)
    return this.connection(config, { model, effort: effort ?? recommended?.effort, vision: recommended?.vision ?? false })
  }
  private connection(config: ConnectionSettings, selected: { model: string; effort?: Effort; vision: boolean }): AnswerConnection {
    const catalog = this.catalogs.get(this.catalogKey(config.provider, config))
    return {
      provider: config.provider, ...selected, vision: catalog?.find(m => m.id === selected.model)?.vision ?? selected.vision, baseURL: config.baseURL,
      credential: async () => {
        const key = await this.credential(config.provider, config)
        const models = this.catalogs.get(this.catalogKey(config.provider, config)) ?? await this.discover(config.provider, key, config)
        if ((config.provider === 'chatgpt' || models.length > 0) && !models.some(m => m.id === selected.model)) throw new Error('The selected model is not available for this connection. Choose one in Settings → Connection.')
        return key
      },
    }
  }
  async request(request: ConnectionRequest, options: { selectSavedProvider?: boolean } = {}): Promise<ConnectionResult> {
    if (request.kind === 'details') return { ok: true, message: '', keyHints: this.keyHints() }
    if (request.kind === 'snapshot') return { ok: true, message: '', connection: this.snapshot() }
    if (this.mutating) return { ok: false, message: 'Finish the current connection action first.' }
    this.mutating = true
    try {
      let message = 'Connection updated.'
      switch (request.kind) {
        case 'saveKey': {
          const config = this.config
          await this.discover(request.provider, request.key, config)
          if (request.provider === 'compatible') {
            const credential = { baseURL: config.baseURL, key: request.key }
            await saveSecret('compatible-key', JSON.stringify(credential))
            this.compatibleKey = credential
          } else {
            await saveSecret(`${request.provider}-key`, request.key)
            this.keys.set(request.provider, request.key)
          }
          this.savedAt.set(request.provider, await secretSavedAt(`${request.provider}-key`) ?? Date.now())
          // Saving a key must not change the answer's billing path.
          if (options.selectSavedProvider) this.settings.set({ ...this.settings.get(), connection: { ...config, provider: request.provider } })
          message = 'Key tested and stored securely on this Mac.'; break
        }
        case 'removeKey': await removeSecret(`${request.provider}-key`); if (request.provider === 'compatible') this.compatibleKey = undefined; this.keys.delete(request.provider); this.savedAt.delete(request.provider); this.catalogs.delete(this.catalogKey(request.provider)); message = 'Key removed.'; break
        case 'useForAnswers': this.settings.set({ ...this.settings.get(), connection: { ...this.config, provider: request.provider } }); break
        case 'test': case 'models': await this.discover(request.provider); message = 'Connection tested; model list refreshed.'; break
        case 'signIn':
          await this.auth.signIn(request.accountId, request.newAccount)
          if (this.auth.active?.tokens?.scopes.includes('chatgpt.tokens.use.direct')) {
            if (options.selectSavedProvider) this.settings.set({ ...this.settings.get(), connection: { ...this.config, provider: 'chatgpt' } })
            await this.discover('chatgpt'); message = this.config.provider === 'chatgpt' ? 'Using ChatGPT plan. Voice is selected automatically.' : 'ChatGPT connected. Choose it as your provider to use plan answers.'
          } else message = 'Signed in, but ChatGPT plan usage is disabled. Enable it with Continue with ChatGPT, or use an API key. An eligible Plus or Pro plan is required.'
          break
        case 'selectAccount': await this.auth.select(request.accountId); if (options.selectSavedProvider) this.settings.set({ ...this.settings.get(), connection: { ...this.config, provider: 'chatgpt' } }); if (this.auth.active?.tokens) await this.discover('chatgpt'); break
        case 'signOut': message = await this.auth.signOut(); break
        case 'allowSpeechRecognition': await allowSpeechRecognition(); message = this.voiceEngine.engine === 'builtin' ? 'Built-in speech recognition is ready.' : 'Speech recognition is not available. See the voice summary.'; break
        case 'settings': this.openSettings(); message = 'Choose a connection in Settings.'; break
        case 'usage': await shell.openExternal('https://chatgpt.com/settings/usage'); message = 'Opened ChatGPT usage settings.'; break
      }
      this.changed()
      return { ok: true, message, connection: this.snapshot() }
    } catch (error) {
      this.changed()
      // All auth/catalog errors are deliberately credential-free; transport errors are not.
      const message = publicConnectionError(error)
      return { ok: false, message, connection: this.snapshot() }
    } finally { this.mutating = false }
  }
}

/** Only our own fixed messages may leave a credential-bearing operation. */
function publicConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const allowed = new Set([
    'Secure storage is not available on this system.', 'Finish the current ChatGPT connection attempt first.', 'Unknown ChatGPT account.',
    'Sign-in state did not match. Try again.', 'ChatGPT sign-in was declined. You can try again or add an API key.', 'ChatGPT sign-in failed. Try again.',
    'ChatGPT registration was incomplete or did not match.', 'Missing or invalid authorization code.', 'ChatGPT sign-in timed out. Try again.',
    'Could not receive ChatGPT sign-in.', 'Could not start sign-in listener.', 'Could not reach ChatGPT. Check your connection and try again.',
    'ChatGPT could not renew this grant. Sign in again.', 'ChatGPT authorization is temporarily unavailable. Try again later.',
    'ChatGPT returned invalid credentials.', 'ChatGPT returned incomplete credentials.', 'ChatGPT did not return an ID token.',
    'ChatGPT identity did not match this sign-in.', 'Choose the ChatGPT account associated with this registration.',
    'Sign in with ChatGPT again; this grant has expired or been disconnected.',
    'ChatGPT plan usage is not enabled. Enable it with Continue with ChatGPT or add an API key; an eligible Plus or Pro plan is required.',
    'That model is not available for this connection. Refresh the model list or choose another model.',
  ])
  return allowed.has(message) || /^(Provider|ChatGPT plan) model discovery failed \(\d{3}\)\. Check your connection, key and plan eligibility\.$/.test(message) ? message : 'Could not complete the connection. Check your endpoint, key, plan and network; try again.'
}
