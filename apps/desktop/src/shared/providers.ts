export const PROVIDERS = ['chatgpt', 'openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'compatible'] as const
export type ProviderId = typeof PROVIDERS[number]
export type KeyProvider = Exclude<ProviderId, 'chatgpt'>
export const EFFORTS = ['low', 'medium', 'high'] as const
/** How much the model thinks before answering; sent as the SDK's reasoning effort. */
export type Effort = typeof EFFORTS[number]
/** An absent effort sends none, so the provider's own default applies. */
export interface ModelChoice { model: string; effort?: Effort }
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
/** Providers whose SDK options carry a thinking level today. */
export const PROVIDER_EFFORTS: Record<ProviderId, readonly Effort[]> = { chatgpt: EFFORTS, openai: EFFORTS, anthropic: EFFORTS, google: [], deepseek: [], openrouter: [], compatible: [] }
/** Recommended models; the first is the provider default. `effort` is its default
 *  thinking level and `hint` comes from our own evals where we have them. */
export interface RecommendedModel { model: string; name: string; hint: string; vision: boolean; effort?: Effort; efforts: readonly Effort[] }
const thinking = (model: string, name: string, hint: string, effort: Effort): RecommendedModel => ({ model, name, hint, vision: true, effort, efforts: EFFORTS })
const plain = (model: string, name: string, hint: string, vision = true): RecommendedModel => ({ model, name, hint, vision, efforts: [] })
const openAIModels = [thinking('gpt-6.1-terra', 'GPT-6.1 Terra', 'Low thinking: median first 3D part 2.7 s in our 15-request test', 'low'), thinking('gpt-6.1-sol', 'GPT-6.1 Sol', 'Most capable; not yet measured in NimboGuide', 'medium')]
export const RECOMMENDED_MODELS: Record<ProviderId, readonly RecommendedModel[]> = {
  chatgpt: openAIModels,
  openai: openAIModels,
  anthropic: [thinking('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'Low thinking: median first 3D part 1.9 s in our 15-request test', 'low'), thinking('claude-haiku-5-5', 'Claude Haiku 5.5', 'Slower to start in our tests (about 8 s)', 'low'), thinking('claude-opus-5-5', 'Claude Opus 5.5', 'Most capable; not yet measured in NimboGuide', 'medium')],
  google: [plain('gemini-3.8-flash', 'Gemini 3.8 Flash', 'Balanced speed and detail'), plain('gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'Faster, less detail'), plain('gemini-4-argon', 'Gemini 4 Argon', 'Most capable, slower')],
  deepseek: [plain('deepseek-flash', 'DeepSeek Flash', 'Balanced speed and detail'), plain('deepseek-v4-pro', 'DeepSeek V4 Pro', 'Text only: cannot see your screen or draw', false)],
  openrouter: [plain('openai/gpt-6.1-terra', 'GPT-6.1 Terra', 'Balanced speed and detail'), plain('google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', 'Faster, less detail'), plain('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'Most capable, slower')],
  compatible: [],
}
export function recommendedModel(provider: ProviderId, model: string): RecommendedModel | undefined { return RECOMMENDED_MODELS[provider].find(entry => entry.model === model) }
/** Only expose thinking levels for model families whose SDK mapping is known. */
export function modelEfforts(provider: ProviderId, model: string): readonly Effort[] { return recommendedModel(provider, model)?.efforts.filter(effort => PROVIDER_EFFORTS[provider].includes(effort)) ?? [] }
export function defaultModelChoice(provider: ProviderId): ModelChoice {
  const first = RECOMMENDED_MODELS[provider][0]
  return first ? { model: first.model, ...(first.effort ? { effort: first.effort } : {}) } : { model: '' }
}
export function defaultConnectionSettings(): ConnectionSettings {
  return { provider: 'openai', baseURL: 'http://127.0.0.1:11434/v1', models: Object.fromEntries(PROVIDERS.map(p => [p, defaultModelChoice(p)])) as Record<ProviderId, ModelChoice> }
}
export function selectedModel(settings: ConnectionSettings): { model: string; effort?: Effort; vision: boolean } {
  const choice = settings.models[settings.provider]
  return { model: choice.model, ...(choice.effort && modelEfforts(settings.provider, choice.model).includes(choice.effort) ? { effort: choice.effort } : {}), vision: recommendedModel(settings.provider, choice.model)?.vision ?? false }
}
