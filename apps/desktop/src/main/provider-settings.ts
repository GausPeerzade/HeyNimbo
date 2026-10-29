import { PROVIDERS, defaultConnectionSettings, type ConnectionRequest, type ConnectionSettings, type KeyProvider, type ModelChoice, type ProviderId } from '../shared/providers'

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
export function parseConnectionSettings(value: unknown): ConnectionSettings {
  const input = object(value); shape(input, ['provider', 'models', 'baseURL'])
  if (!PROVIDERS.includes(input.provider as ProviderId)) throw new Error('Invalid answer provider.')
  const models = object(input.models); shape(models, [...PROVIDERS])
  const result = defaultConnectionSettings()
  result.provider = input.provider as ProviderId
  result.baseURL = validateBaseURL(input.baseURL)
  for (const provider of PROVIDERS) {
    const choice = object(models[provider]); shape(choice, ['preset', 'customModel'])
    if (typeof choice.preset !== 'string' || !['fast', 'balanced', 'best', 'custom'].includes(choice.preset) || typeof choice.customModel !== 'string' || choice.customModel.length > 200 || (choice.customModel !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(choice.customModel))) throw new Error('Invalid model choice.')
    if (choice.preset === 'custom' && !choice.customModel && provider !== 'compatible') throw new Error('Enter a custom model ID.')
    result.models[provider] = choice as unknown as ModelChoice
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
