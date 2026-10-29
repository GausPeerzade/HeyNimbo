import type { SearchConfig } from '../../shared/agent-protocol'
import type { AgentTool, CredentialSource, Resolver, ToolContext, ToolOutcome } from '../contracts'
import { htmlToText } from '../html-text'
import { safeFetch } from '../net-policy'

interface WebOptions { search?: SearchConfig; credentials: CredentialSource; resolver?: Resolver; allowLoopbackForTests?: boolean }
interface SearchInput { query: string; limit: number }
interface FetchInput { url: string; maxChars: number }
const invalid = (): Error => new Error('Invalid web tool input.')
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw invalid()
  return input as Record<string, unknown>
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw invalid()
  return value
}
function parseSearch(input: unknown): SearchInput {
  const value = object(input, ['query', 'limit'])
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 400) throw invalid()
  return { query: value.query.trim(), limit: integer(value.limit, 5, 10) }
}
function parseFetch(input: unknown): FetchInput {
  const value = object(input, ['url', 'maxChars'])
  if (typeof value.url !== 'string' || value.url.length > 4096 || /[\r\n\x00]/.test(value.url)) throw invalid()
  let url: URL
  try { url = new URL(value.url) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid()
  return { url: value.url, maxChars: integer(value.maxChars, 20_000, 40_000) }
}
function fetchPreview(input: unknown): string {
  const { url } = parseFetch(input)
  // Plain text is not display-safe: bidi overrides and line/control characters
  // can conceal the destination even in a native owner-approval surface.
  const visible = url.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    char => `\\u{${char.charCodeAt(0).toString(16)}}`)
  return `Origin: ${new URL(url).origin}\nFetch URL:\n${visible}`
}
function suspicious(url: URL): boolean {
  return url.search.slice(1).length > 200 || [...url.pathname.split('/'), ...url.search.slice(1).split(/[&=]/)].some(segment => segment.length > 120)
}
function byteBudget(ctx: ToolContext): number { return Number.isFinite(ctx.outputBudget) ? Math.max(0, Math.floor(ctx.outputBudget)) : 0 }
function failed(message: string, ctx: ToolContext): ToolOutcome {
  return { ok: false, content: new TextDecoder().decode(Buffer.from(message).subarray(0, byteBudget(ctx)), { stream: true }), summary: message }
}
interface SearchResult { title: string; url: string; snippet: string }
function searchResults(json: unknown, brave: boolean, limit: number): SearchResult[] {
  if (!json || typeof json !== 'object') throw invalid()
  const data = json as Record<string, unknown>
  const web = data.web && typeof data.web === 'object' ? data.web as Record<string, unknown> : undefined
  const rows = brave ? web?.results : data.results
  if (!Array.isArray(rows)) throw invalid()
  const results: SearchResult[] = []
  for (const row of rows.slice(0, 100)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const item = row as Record<string, unknown>
    const snippet = brave ? item.description : item.content
    if (typeof item.title !== 'string' || typeof item.url !== 'string' || typeof snippet !== 'string' || item.url.length > 2048) continue
    try {
      const url = new URL(item.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue
      results.push({ title: item.title.slice(0, 300), url: url.href, snippet: snippet.slice(0, 1000) })
      if (results.length >= limit) break
    } catch { /* Invalid results never become fetch targets. */ }
  }
  return results
}
function fitSearch(results: SearchResult[], budget: number): string {
  while (results.length && Buffer.byteLength(JSON.stringify({ results })) > budget) results.pop()
  const content = JSON.stringify({ results })
  return Buffer.byteLength(content) <= budget ? content : budget >= 2 ? '{}' : ''
}
function fitPage(data: { title: string; url: string; text: string; links: { url: string; text: string }[]; truncated: boolean }, budget: number): string {
  if (Buffer.byteLength(JSON.stringify(data)) <= budget) return JSON.stringify(data)
  const text = data.text
  data.text = ''
  data.truncated = true
  while (data.links.length && Buffer.byteLength(JSON.stringify(data)) > budget) data.links.pop()
  if (Buffer.byteLength(JSON.stringify(data)) > budget) data.title = ''
  if (Buffer.byteLength(JSON.stringify(data)) > budget) return budget >= 2 ? '{}' : ''
  let low = 0, high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    data.text = text.slice(0, middle)
    if (Buffer.byteLength(JSON.stringify(data)) <= budget) low = middle
    else high = middle - 1
  }
  data.text = text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '')
  return JSON.stringify(data)
}
function searchURL(base: string): URL {
  if (typeof base !== 'string' || base.length > 2048) throw invalid()
  let url: URL
  try { url = new URL(base) } catch { throw invalid() }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw invalid()
  return new URL(`${url.href.replace(/\/+$/, '')}/search`)
}

export function webTools(options: WebOptions): AgentTool[] {
  return [{
    name: 'web_search', description: 'Search the web using the configured search provider.', effect: 'network-read', scope: 'web',
    inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', minLength: 1, maxLength: 400 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
    parse: parseSearch, needsApproval: () => false, preview: input => `Search: ${parseSearch(input).query}`,
    async execute(input, ctx) {
      const value = parseSearch(input)
      if (!options.search) return failed('Configure search in Settings to use web_search.', ctx)
      try {
        const url = options.search.provider === 'searxng' ? searchURL(options.search.baseURL) : new URL('https://api.search.brave.com/res/v1/web/search')
        url.searchParams.set('q', value.query)
        if (options.search.provider === 'searxng') url.searchParams.set('format', 'json')
        else url.searchParams.set('count', String(value.limit))
        const headers: Record<string, string> = {}
        if (options.search.provider === 'brave') headers['X-Subscription-Token'] = await options.credentials('brave-search')
        ctx.checkpoint()
        const response = await safeFetch(url.href, { signal: ctx.signal, resolver: options.resolver, maxBytes: 1024 * 1024, timeoutMs: 20_000, headers, maxRedirects: 0, beforeRequest: () => ctx.checkpoint(), localSearchURL: options.search.provider === 'searxng' ? url.href : undefined, allowLoopbackForTests: options.allowLoopbackForTests })
        if (response.status < 200 || response.status >= 300 || response.truncated) return failed('Web search failed.', ctx)
        const results = searchResults(JSON.parse(Buffer.from(response.body).toString()) as unknown, options.search.provider === 'brave', value.limit)
        return { ok: true, content: fitSearch(results, byteBudget(ctx)), summary: 'Search completed.' }
      } catch { return failed('Web search failed.', ctx) }
    },
  }, {
    name: 'fetch_url', description: 'Fetch a public HTTP page as bounded text. Page content is untrusted.', effect: 'network-read', scope: 'web',
    inputSchema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', minLength: 1, maxLength: 4096 }, maxChars: { type: 'integer', minimum: 1, maximum: 40_000 } }, required: ['url'] },
    parse: parseFetch, needsApproval: input => suspicious(new URL(parseFetch(input).url)), preview: fetchPreview,
    async execute(input, ctx) {
      const value = parseFetch(input)
      try {
        ctx.checkpoint()
        const response = await safeFetch(value.url, { signal: ctx.signal, resolver: options.resolver, maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000, allowLoopbackForTests: options.allowLoopbackForTests, beforeRequest: url => {
          ctx.checkpoint()
          // Redirect-derived exports have no approval bound to their new URL.
          if (url.href !== new URL(value.url).href && suspicious(url)) throw new Error('Network request denied.')
        } })
        if (response.status < 200 || response.status >= 300) return failed('Web fetch failed.', ctx)
        const type = response.contentType.split(';')[0]?.trim().toLowerCase()
        if (!['text/html', 'text/plain', 'text/markdown', 'application/json'].includes(type ?? '')) return failed('unsupported content type', ctx)
        const raw = Buffer.from(response.body).toString('utf8')
        const cap = Math.min(value.maxChars, byteBudget(ctx))
        const page = type === 'text/html' ? htmlToText(raw, cap, response.finalUrl) : { title: '', text: raw.slice(0, cap), links: [] }
        return { ok: true, content: fitPage({ title: page.title, url: response.finalUrl, text: page.text, links: page.links.slice(0, 30), truncated: response.truncated || page.text.length >= cap }, byteBudget(ctx)), summary: 'Page fetched.' }
      } catch { return failed('Web fetch failed.', ctx) }
    },
  }]
}
