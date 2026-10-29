import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import { request as httpsRequest } from 'node:https'
import type { Resolver, ResolvedAddress } from './contracts'

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || ip.includes('%')) return false
  let value = ip.toLowerCase()
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':')
    const v4 = value.slice(colon + 1).split('.').map(Number)
    value = `${value.slice(0, colon)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`
  }
  const [left = '', right = ''] = value.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  const words = (value.includes('::') ? [...start, ...Array<string>(8 - start.length - end.length).fill('0'), ...end] : start).map(word => parseInt(word, 16))
  const [a = 0, b = 0] = words
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    const high = words[6]!, low = words[7]!
    return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return !((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && b === 0xdb8) || (a === 0x64 && b === 0xff9b && words.slice(2, 6).every(word => word === 0)))
}

interface FetchOptions {
  resolver?: Resolver
  signal: AbortSignal
  maxBytes: number
  timeoutMs: number
  maxRedirects?: number
  headers?: Record<string, string>
  method?: 'GET' | 'POST' | 'HEAD'
  body?: string | Uint8Array
  allowLoopbackForTests?: boolean
  /** Exact configured local SearXNG request, not a general loopback grant. */
  localSearchURL?: string
  /** Run-generation and redirect-egress fence at the actual request boundary. */
  beforeRequest?: (url: URL) => void
}
interface FetchResult { finalUrl: string; status: number; contentType: string; body: Uint8Array; truncated: boolean }
const denied = (): Error => new Error('Network request denied.')
const defaultResolver: Resolver = async hostname => (await lookup(hostname, { all: true })).map(answer => ({ address: answer.address, family: answer.family as 4 | 6 }))
function loopback(ip: string): boolean { return (isIP(ip) === 4 && ip.startsWith('127.')) || ip === '::1' }
function parseURL(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw denied() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw denied()
  return url
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('Network request cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

export async function safeFetch(value: string, options: FetchOptions): Promise<FetchResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw denied()
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs)
  try {
    return await abortable(fetchRedirects(value, { ...options, signal: controller.signal }), controller.signal)
  } catch (error) {
    if (options.signal.aborted) throw new Error('Network request cancelled.')
    if (timedOut) throw new Error('Network request timed out.')
    if (error instanceof Error && error.message === 'Network request denied.') throw error
    throw new Error('Network request failed.')
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}

async function fetchRedirects(value: string, options: FetchOptions): Promise<FetchResult> {
  let current = parseURL(value)
  const maximum = options.maxRedirects ?? 5
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 20) throw denied()
  for (let redirects = 0; ; redirects++) {
    const result = await fetchOnce(current.href, options)
    if (!('location' in result)) return result
    if (redirects >= maximum) throw denied()
    const next = parseURL(new URL(result.location, current).href)
    if (current.protocol === 'https:' && next.protocol === 'http:') throw denied()
    if (options.body !== undefined || (options.method && options.method !== 'GET' && options.method !== 'HEAD')) throw denied()
    if (current.origin !== next.origin) options = { ...options, headers: {} }
    current = next
  }
}

async function fetchOnce(value: string, options: FetchOptions): Promise<FetchResult | { location: string }> {
  options.signal.throwIfAborted()
  const url = parseURL(value)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const local = options.localSearchURL === url.href && ['localhost', '127.0.0.1'].includes(url.hostname)
  const allowLoopback = options.allowLoopbackForTests || local
  const answers: ResolvedAddress[] = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }] : await (options.resolver ?? defaultResolver)(hostname)
  if (!answers.length || answers.some(answer => isIP(answer.address) !== answer.family || (!isPublicAddress(answer.address) && !(allowLoopback && loopback(answer.address))))) throw denied()
  const pinned = answers[0]!
  if (url.port && !['80', '443'].includes(url.port) && !(allowLoopback && loopback(pinned.address))) throw denied()
  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (!['cookie', 'cookie2', 'host', 'connection', 'proxy-authorization', 'transfer-encoding', 'content-length', 'user-agent', 'accept-encoding'].includes(name.toLowerCase())) headers[name.toLowerCase()] = value
  }
  headers['user-agent'] = 'HeyNimbo/0.1 (+agent research)'
  headers['accept-encoding'] = 'gzip, deflate, br'
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted()
    options.beforeRequest?.(url)
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      agent: false,
      signal: options.signal,
      // Disable family racing: there is exactly one already-validated destination.
      family: pinned.family,
      lookup: (_name, _opts, callback) => callback(null, pinned.address, pinned.family),
      servername: isIP(hostname) ? undefined : hostname,
      headers,
      method: options.method ?? 'GET',
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location
        response.destroy()
        request.destroy()
        if (!location) reject(denied())
        else resolve({ location })
        return
      }
      const encoding = response.headers['content-encoding']?.toLowerCase().trim()
      if (encoding && !['identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
        response.destroy()
        request.destroy()
        reject(denied())
        return
      }
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined
      const stream = decoder ? response.pipe(decoder) : response
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        const remaining = options.maxBytes - size
        chunks.push(chunk.subarray(0, remaining))
        size += Math.min(chunk.length, remaining)
        if (chunk.length > remaining) {
          resolve({ finalUrl: url.href, status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? '', body: Buffer.concat(chunks), truncated: true })
          decoder?.destroy()
          response.destroy()
          request.destroy()
        }
      })
      stream.on('end', () => resolve({ finalUrl: url.href, status: response.statusCode ?? 0, contentType: response.headers['content-type'] ?? '', body: Buffer.concat(chunks), truncated: false }))
      const fail = (): void => {
        reject(new Error('Network request failed.'))
        decoder?.destroy()
        response.destroy()
        request.destroy()
      }
      stream.on('error', fail)
      response.on('error', fail)
    })
    request.on('error', () => reject(new Error('Network request failed.')))
    request.end(options.body)
  })
}
