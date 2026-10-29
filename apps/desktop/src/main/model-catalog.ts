import { PRESETS, type KeyProvider, type ModelInfo, type ProviderId } from '../shared/providers'
import { noRedirectFetch } from './provider-settings'

export const API_BASES: Record<KeyProvider, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', google: 'https://generativelanguage.googleapis.com/v1beta', deepseek: 'https://api.deepseek.com', openrouter: 'https://openrouter.ai/api/v1', compatible: '' }
export function providerHeaders(provider: ProviderId, key: string): Record<string, string> {
  if (provider === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  if (provider === 'google') return { 'x-goog-api-key': key }
  return key ? { Authorization: `Bearer ${key}` } : {}
}
function knownVision(provider: ProviderId, id: string): boolean { return Object.values(PRESETS[provider]).some(p => p.model === id && p.vision) }
export function catalogModels(provider: ProviderId, body: Record<string, unknown>): ModelInfo[] {
  const rows = (provider === 'chatgpt' || provider === 'google' ? body.models : body.data)
  if (!Array.isArray(rows)) throw new Error('The provider returned an invalid model catalog.')
  return rows.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return []
    const row = value as Record<string, unknown>
    if (provider === 'chatgpt' && row.visibility !== 'list') return []
    if (provider === 'google' && !(row.supportedGenerationMethods as string[] | undefined)?.includes('generateContent')) return []
    const id = String(provider === 'chatgpt' ? row.slug ?? '' : provider === 'google' ? String(row.name ?? '').replace(/^models\//, '') : row.id ?? '')
    if (!id || id.length > 200) return []
    const modalities = (row.architecture as { input_modalities?: string[] } | undefined)?.input_modalities ?? row.input_modalities as string[] | undefined
    return [{ id, name: String(row.display_name ?? row.displayName ?? row.name ?? id), vision: modalities ? modalities.includes('image') : knownVision(provider, id), tested: false }]
  })
}
export async function listProviderModels(provider: ProviderId, key: string, baseURL: string, transport = noRedirectFetch): Promise<ModelInfo[]> {
  const base = provider === 'chatgpt' ? API_BASES.openai : provider === 'compatible' ? baseURL : API_BASES[provider]
  const headers = providerHeaders(provider, key)
  if (provider === 'openrouter') {
    const validation = await transport(`${base}/key`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!validation.ok) throw new Error(`Provider model discovery failed (${validation.status}). Check your connection, key and plan eligibility.`)
  }
  const endpoint = new URL(base)
  if (provider === 'compatible' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname) && endpoint.port === '11434' && endpoint.pathname === '/v1') {
    const response = await transport(`${endpoint.origin}/api/tags`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status}). Start Ollama and pull a model.`)
    const body = await response.json() as { models?: Array<{ name: string }> }
    if (!Array.isArray(body.models)) throw new Error('Invalid Ollama model catalog.')
    return Promise.all(body.models.map(async row => {
      const show = await transport(`${endpoint.origin}/api/show`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: row.name }), signal: AbortSignal.timeout(10_000) })
      const capabilities = show.ok ? (await show.json() as { capabilities?: string[] }).capabilities : []
      return { id: row.name, name: row.name, vision: capabilities?.includes('vision') ?? false, tested: false }
    }))
  }
  const models: ModelInfo[] = []
  let cursor = ''
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${base}/models`)
    if (cursor) url.searchParams.set(provider === 'google' ? 'pageToken' : 'after_id', cursor)
    const response = await transport(url, { headers, signal: AbortSignal.timeout(10_000) })
    if (provider === 'compatible' && [404, 405].includes(response.status)) return []
    if (!response.ok) throw new Error(`${provider === 'chatgpt' ? 'ChatGPT plan' : 'Provider'} model discovery failed (${response.status}). Check your connection, key and plan eligibility.`)
    const body = await response.json() as Record<string, unknown>
    models.push(...catalogModels(provider, body))
    cursor = provider === 'google' ? String(body.nextPageToken ?? '') : provider === 'anthropic' && body.has_more ? String(body.last_id ?? '') : ''
    if (!cursor) return models
  }
  throw new Error('The provider model catalog has too many pages. Try a narrower endpoint.')
}
