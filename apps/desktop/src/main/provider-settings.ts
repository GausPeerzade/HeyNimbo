import { PROVIDERS, modelEfforts, defaultConnectionSettings, type ConnectionRequest, type ConnectionSettings, type Effort, type KeyProvider, type ModelChoice, type ProviderId } from '../shared/providers'

export function validateBaseURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid endpoint URL.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid endpoint URL.') }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Use HTTPS, or HTTP on 127.0.0.1 or localhost only. No credentials, query or fragment in endpoint URLs.')
  return url.href.replace(/\/+$/, '')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection.')
  return value as Record<string, unknown>
}
function shape(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unknown connection field.')
}
/** The speed presets each provider stored before thinking became its own choice; read only to migrate saved settings. */
const LEGACY_PRESETS: Record<ProviderId, Record<'fast' | 'balanced' | 'best', ModelChoice>> = {
  chatgpt: { fast: { model: 'gpt-6.1-terra', effort: 'low' }, balanced: { model: 'gpt-6.1-terra', effort: 'medium' }, best: { model: 'gpt-6.1-sol', effort: 'medium' } },
  openai: { fast: { model: 'gpt-6.1-terra', effort: 'low' }, balanced: { model: 'gpt-6.1-terra', effort: 'medium' }, best: { model: 'gpt-6.1-sol', effort: 'medium' } },
  anthropic: { fast: { model: 'claude-haiku-5-5', effort: 'low' }, balanced: { model: 'claude-sonnet-5-5', effort: 'low' }, best: { model: 'claude-opus-5-5', effort: 'medium' } },
  google: { fast: { model: 'gemini-3.5-flash-lite' }, balanced: { model: 'gemini-3.8-flash' }, best: { model: 'gemini-4-argon' } },
  deepseek: { fast: { model: 'deepseek-flash' }, balanced: { model: 'deepseek-flash' }, best: { model: 'deepseek-v4-pro' } },
  // The OpenRouter preset named an effort, but its SDK options never carried one.
  openrouter: { fast: { model: 'google/gemini-3.5-flash-lite' }, balanced: { model: 'openai/gpt-6.1-terra' }, best: { model: 'anthropic/claude-opus-5.5' } },
  compatible: { fast: { model: '' }, balanced: { model: '' }, best: { model: '' } },
}
function modelChoice(provider: ProviderId, model: unknown, effort: unknown): ModelChoice {
  if (typeof model !== 'string' || model.length > 200 || (model !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(model))) throw new Error('Invalid model choice.')
  if (!model && provider !== 'compatible') throw new Error('Choose a model.')
  if (effort !== undefined && !modelEfforts(provider, model).includes(effort as Effort)) throw new Error('Invalid thinking level.')
  return effort === undefined ? { model } : { model, effort: effort as Effort }
}
/** Saved `{ preset, customModel }` becomes the preset's model and thinking level; a custom model keeps its ID and sends no thinking level. */
export function migrateModelChoice(provider: ProviderId, value: Record<string, unknown>): ModelChoice {
  shape(value, ['preset', 'customModel'])
  if (value.preset === 'custom') return modelChoice(provider, value.customModel, undefined)
  if (value.preset !== 'fast' && value.preset !== 'balanced' && value.preset !== 'best') throw new Error('Invalid model choice.')
  return structuredClone(LEGACY_PRESETS[provider][value.preset])
}
/** `saved` accepts the older preset shape and missing providers, which keep their defaults. */
export function parseConnectionSettings(value: unknown, saved = false): ConnectionSettings {
  const input = object(value); shape(input, ['provider', 'models', 'baseURL'])
  if (!PROVIDERS.includes(input.provider as ProviderId)) throw new Error('Invalid answer provider.')
  const models = object(input.models); shape(models, [...PROVIDERS])
  const result = defaultConnectionSettings()
  result.provider = input.provider as ProviderId
  result.baseURL = validateBaseURL(input.baseURL)
  for (const provider of PROVIDERS) {
    if (saved && models[provider] === undefined) continue
    const choice = object(models[provider])
    if (saved && 'preset' in choice) { result.models[provider] = migrateModelChoice(provider, choice); continue }
    shape(choice, ['model', 'effort'])
    result.models[provider] = modelChoice(provider, choice.model, choice.effort)
  }
  return result
}
export function parseConnectionRequest(value: unknown): ConnectionRequest {
  const input = object(value)
  switch (input.kind) {
    case 'snapshot': case 'signOut': case 'usage': case 'details': case 'settings': case 'allowSpeechRecognition': shape(input, ['kind']); return { kind: input.kind }
    case 'signIn': case 'selectAccount': {
      shape(input, input.kind === 'signIn' ? ['kind', 'accountId', 'newAccount'] : ['kind', 'accountId'])
      if (input.newAccount !== undefined && (typeof input.newAccount !== 'boolean' || input.accountId !== undefined)) throw new Error('Invalid account choice.')
      if ((input.kind === 'selectAccount' || input.accountId !== undefined) && (typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 200)) throw new Error('Invalid account.')
      return input as unknown as ConnectionRequest
    }
    case 'useForAnswers':
      shape(input, ['kind', 'provider'])
      if (!PROVIDERS.includes(input.provider as ProviderId)) throw new Error('Invalid answer provider.')
      return { kind: 'useForAnswers', provider: input.provider as ProviderId }
    case 'saveKey': case 'removeKey': case 'test': case 'models':
      shape(input, input.kind === 'saveKey' ? ['kind', 'provider', 'key'] : ['kind', 'provider'])
      if ((!['test', 'models'].includes(String(input.kind)) && input.provider === 'chatgpt') || !PROVIDERS.includes(input.provider as ProviderId)) throw new Error('Invalid key provider.')
      if (input.kind === 'saveKey') {
        if (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 4096 || /[\r\n\x00]/.test(input.key)) throw new Error('Invalid API key.')
        return { kind: 'saveKey', provider: input.provider as KeyProvider, key: input.key.trim() }
      }
      return input as unknown as ConnectionRequest
    default: throw new Error('Unknown connection request.')
  }
}

/** Never forward credentials through a redirect, including SDK-managed requests. */
export const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' })
