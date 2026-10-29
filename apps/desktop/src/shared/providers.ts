export const PROVIDERS = ['chatgpt', 'openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'compatible'] as const
export type ProviderId = typeof PROVIDERS[number]
export type KeyProvider = Exclude<ProviderId, 'chatgpt'>
export type Preset = 'fast' | 'balanced' | 'best' | 'custom'
export interface ModelChoice { preset: Preset; customModel: string }
export interface ConnectionSettings { provider: ProviderId; models: Record<ProviderId, ModelChoice>; baseURL: string }
export interface ModelInfo { id: string; name: string; vision: boolean; tested: boolean }
export type VoiceSelection = { engine: 'openai' | 'builtin' } | { engine: 'unavailable'; reason: string; needsPermission?: boolean }
export interface ConnectionSnapshot {
  providers: Record<ProviderId, boolean>
  accounts: Array<{ id: string; name: string; email: string; connected: boolean; sharing: boolean }>
  activeAccount?: string
  compatibleKeyPresent?: boolean
  models: ModelInfo[]
  answerModel: string
  answerVision: boolean
  voice: 'OpenAI' | 'Built into your Mac' | 'unavailable'
  voiceReason?: string
  needsSpeechPermission?: boolean
}
/** Connection-only details, never broadcast: at most four key characters and no OAuth token hints. */
export interface KeyHint { suffix: string; savedAt?: number }
export type KeyHints = Partial<Record<KeyProvider, KeyHint>>
export type ConnectionRequest =
  | { kind: 'saveKey'; provider: KeyProvider; key: string }
  | { kind: 'removeKey'; provider: KeyProvider }
  | { kind: 'useForAnswers'; provider: ProviderId }
  | { kind: 'test' | 'models'; provider: ProviderId }
  | { kind: 'signIn'; accountId?: string; newAccount?: boolean }
  | { kind: 'signOut' | 'usage' | 'snapshot' | 'details' | 'settings' | 'allowSpeechRecognition' }
  | { kind: 'selectAccount'; accountId: string }
export interface ConnectionResult { ok: boolean; message: string; connection?: ConnectionSnapshot; keyHints?: KeyHints }
export const PROVIDER_NAMES: Record<ProviderId, string> = { chatgpt: 'ChatGPT', openai: 'OpenAI key', anthropic: 'Anthropic', google: 'Google Gemini', deepseek: 'DeepSeek', openrouter: 'OpenRouter', compatible: 'OpenAI-compatible' }
export const PRESETS: Record<ProviderId, Record<Exclude<Preset, 'custom'>, { model: string; effort?: 'low' | 'medium'; vision: boolean }>> = {
  chatgpt: { fast: { model: 'gpt-6.1-terra', effort: 'low', vision: true }, balanced: { model: 'gpt-6.1-terra', effort: 'medium', vision: true }, best: { model: 'gpt-6.1-sol', effort: 'medium', vision: true } },
  openai: { fast: { model: 'gpt-6.1-terra', effort: 'low', vision: true }, balanced: { model: 'gpt-6.1-terra', effort: 'medium', vision: true }, best: { model: 'gpt-6.1-sol', effort: 'medium', vision: true } },
  anthropic: { fast: { model: 'claude-haiku-5-5', effort: 'low', vision: true }, balanced: { model: 'claude-sonnet-5-5', effort: 'low', vision: true }, best: { model: 'claude-opus-5-5', effort: 'medium', vision: true } },
  google: { fast: { model: 'gemini-3.5-flash-lite', vision: true }, balanced: { model: 'gemini-3.8-flash', vision: true }, best: { model: 'gemini-4-argon', vision: true } },
  deepseek: { fast: { model: 'deepseek-flash', vision: true }, balanced: { model: 'deepseek-flash', vision: true }, best: { model: 'deepseek-v4-pro', vision: false } },
  openrouter: { fast: { model: 'google/gemini-3.5-flash-lite', vision: true }, balanced: { model: 'openai/gpt-6.1-terra', effort: 'medium', vision: true }, best: { model: 'anthropic/claude-opus-5.5', vision: true } },
  compatible: { fast: { model: '', vision: false }, balanced: { model: '', vision: false }, best: { model: '', vision: false } },
}
export function defaultConnectionSettings(): ConnectionSettings {
  return { provider: 'openai', baseURL: 'http://127.0.0.1:11434/v1', models: Object.fromEntries(PROVIDERS.map(p => [p, { preset: 'balanced', customModel: '' }])) as Record<ProviderId, ModelChoice> }
}
export function selectedModel(settings: ConnectionSettings): { model: string; effort?: 'low' | 'medium'; vision: boolean } {
  const choice = settings.models[settings.provider]
  return choice.preset === 'custom' ? { model: choice.customModel, vision: false } : PRESETS[settings.provider][choice.preset]
}
