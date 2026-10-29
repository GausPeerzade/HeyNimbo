import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type RequestListener } from 'node:http'
import { createServer as createTLSServer } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { isPublicAddress, safeFetch } from './net-policy'
import type { Resolver } from './contracts'

const opts = { maxBytes: 1024, timeoutMs: 1000, signal: new AbortController().signal, allowLoopbackForTests: true }

const servers: Server[] = []
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

// Every input is an address, not a hostname or an alternate URL IPv4 encoding.
describe('isPublicAddress', () => {
  it.each(['0.1.2.3', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '64:ff9b::808:808', '::ffff:127.0.0.1', '::ffff:a00:1', '::169.254.169.254', '::7f00:1', 'localhost', '2130706433', '0x7f000001', '127.1', '[::1]', 'bad'])('denies non-public or invalid address %s', ip => {
    expect(isPublicAddress(ip)).toBe(false)
  })
  it.each(['1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '198.20.0.0', '223.255.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::808:808'])('accepts public resolved address %s', ip => {
    expect(isPublicAddress(ip)).toBe(true)
  })
})

it('stops a slow 50 MB response at the byte cap and closes the socket early', async () => {
  let sent = 0
  const total = 50 * 1024 * 1024
  const url = await serve((_req, res) => {
    const interval = setInterval(() => {
      if (sent >= total) { clearInterval(interval); res.end(); return }
      sent += 4096
      res.write(Buffer.alloc(4096, 65))
    }, 2)
    res.on('close', () => clearInterval(interval))
  })
  const result = await safeFetch(url, { ...opts, maxBytes: 8192 })
  expect(result.body.length).toBe(8192)
  expect(result.truncated).toBe(true)
  expect(sent).toBeLessThan(total / 10)
})

it.each([
  ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
] as const)('decodes %s with a decompressed-size cap against a 100 MB bomb', async (encoding, compress) => {
  const bomb = compress(Buffer.alloc(100 * 1024 * 1024))
  const url = await serve((_req, res) => {
    res.setHeader('Content-Encoding', encoding)
    res.end(bomb)
  })
  const result = await safeFetch(url, { ...opts, maxBytes: 4096 })
  expect(result.body).toEqual(Buffer.alloc(4096))
  expect(result.truncated).toBe(true)
})

it('times out a server that never sends headers', async () => {
  const url = await serve(() => {})
  await expect(safeFetch(url, { ...opts, timeoutMs: 25 })).rejects.toThrow('Network request timed out.')
})

it('revalidates every redirect and rejects private DNS answers on the next hop', async () => {
  const url = await serve((_req, res) => { res.writeHead(302, { location: 'http://private.test/' }); res.end() })
  await expect(safeFetch(url, { ...opts, resolver: async () => [{ address: '10.0.0.1', family: 4 }] })).rejects.toThrow('Network request denied.')
})

it('follows relative redirects but rejects chains over the configured maximum', async () => {
  const url = await serve((req, res) => {
    if (req.url === '/done') { res.end('arrived'); return }
    res.writeHead(302, { location: req.url === '/start' ? '/done' : '/forever' }); res.end()
  })
  expect(await safeFetch(`${url}/start`, opts)).toMatchObject({ finalUrl: `${url}/done`, body: Buffer.from('arrived') })
  await expect(safeFetch(`${url}/forever`, { ...opts, maxRedirects: 2 })).rejects.toThrow('Network request denied.')
})

it('sends explicit headers and method without cookies or user-agent overrides', async () => {
  const url = await serve((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => res.end(JSON.stringify({ headers: req.headers, method: req.method, body })))
  })
  const response = await safeFetch(url, { ...opts, method: 'POST', body: 'hello', headers: { Cookie: 'session=secret', 'User-Agent': 'evil', 'X-Subscription-Token': 'synthetic-token', Host: 'evil.test' } })
  const data = JSON.parse(Buffer.from(response.body).toString())
  expect(data).toMatchObject({ method: 'POST', body: 'hello', headers: { 'x-subscription-token': 'synthetic-token', 'user-agent': 'HeyNimbo/0.1 (+agent research)' } })
  expect(data.headers.cookie).toBeUndefined()
  expect(data.headers.host).toBe(new URL(url).host)
})

it('never forwards credentials or Set-Cookie across an origin redirect', async () => {
  const target = await serve((req, res) => res.end(JSON.stringify(req.headers)))
  const url = await serve((_req, res) => { res.writeHead(302, { location: target, 'set-cookie': 'session=secret' }); res.end() })
  const result = await safeFetch(url, { ...opts, headers: { 'X-Subscription-Token': 'synthetic-token' } })
  const headers = JSON.parse(Buffer.from(result.body).toString())
  expect(headers['x-subscription-token']).toBeUndefined()
  expect(headers.cookie).toBeUndefined()
})

it('pins the validated DNS answer through connect so rebinding cannot select a second private answer', async () => {
  let resolutions = 0, host = ''
  const base = await serve((req, res) => { host = req.headers.host ?? ''; res.end('pinned') })
  // Loopback stands in for a validated public IP only inside this opted-in fixture.
  const resolver: Resolver = async () => [{ address: ++resolutions === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }]
  const url = base.replace('127.0.0.1', 'rebind.test')
  const result = await safeFetch(url, { ...opts, resolver })
  expect(Buffer.from(result.body).toString()).toBe('pinned')
  expect(resolutions).toBe(1)
  expect(host).toBe(new URL(url).host)
})

it.each(([
  [{ address: '10.0.0.1', family: 4 }],
  [{ address: '::ffff:127.0.0.1', family: 6 }],
  [{ address: '169.254.169.254', family: 4 }],
  [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
  [{ address: '8.8.8.8', family: 6 }], [], [{ address: 'not-an-ip', family: 4 }],
] satisfies Awaited<ReturnType<Resolver>>[]).map(answers => ({ answers })))('rejects the entire DNS set when any answer is private, malformed or family-mismatched (%#)', async ({ answers }) => {
  await expect(safeFetch('http://fixture.test/', { ...opts, allowLoopbackForTests: false, resolver: async () => answers })).rejects.toThrow('Network request denied.')
})

it.each(['file:///etc/passwd', 'ftp://example.com', 'http://u:p@example.com', 'not-a-url', 'http://8.8.8.8:8080', 'http://[::1]/', 'http://2130706433/', 'http://0x7f000001/', 'http://localhost/'])('denies unsafe URL %s without opening a connection', async url => {
  await expect(safeFetch(url, { ...opts, allowLoopbackForTests: false })).rejects.toThrow('Network request denied.')
})

it('rejects pre-aborted requests and aborts an in-flight response', async () => {
  const controller = new AbortController()
  const base = await serve((_req, res) => { res.write('start'); controller.abort() })
  await expect(safeFetch(base, { ...opts, signal: controller.signal })).rejects.toThrow('Network request cancelled.')
  await expect(safeFetch(base, { ...opts, signal: controller.signal })).rejects.toThrow('Network request cancelled.')
})

it('bounds DNS resolution time even if the resolver never settles', async () => {
  await expect(safeFetch('http://fixture.test/', { ...opts, timeoutMs: 15, resolver: () => new Promise(() => {}) })).rejects.toThrow('Network request timed out.')
})

it('rejects invalid compressed streams without returning provider or socket errors', async () => {
  const base = await serve((_req, res) => { res.setHeader('content-encoding', 'gzip'); res.end('not gzip') })
  await expect(safeFetch(base, opts)).rejects.toThrow('Network request failed.')
})

it('verifies the original TLS hostname with SNI and refuses HTTPS-to-HTTP redirects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heynimbo-net-tls-'))
  const originalCA = getCACertificates()
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=fixture.test', '-addext', 'subjectAltName=DNS:fixture.test'], { stdio: 'ignore' })
    const cert = readFileSync(join(dir, 'cert.pem'))
    setDefaultCACertificates([...originalCA, cert.toString()])
    let downgraded = 0, sni = ''
    const target = await serve((_req, res) => { downgraded++; res.end('must not arrive') })
    const server = createTLSServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (req, res) => {
      if (req.url === '/downgrade') res.writeHead(302, { location: target })
      res.end('secure')
    })
    server.on('secureConnection', socket => { sni = socket.servername || '' })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No TLS port')
    const url = `https://fixture.test:${address.port}`
    const resolver: Resolver = async () => [{ address: '127.0.0.1', family: 4 }]
    const result = await safeFetch(url, { ...opts, resolver })
    expect(Buffer.from(result.body).toString()).toBe('secure')
    expect(sni).toBe('fixture.test')
    await expect(safeFetch(`${url}/downgrade`, { ...opts, resolver })).rejects.toThrow('Network request denied.')
    expect(downgraded).toBe(0)
    await expect(safeFetch(url.replace('fixture.test', 'wrong.test'), { ...opts, resolver })).rejects.toThrow('Network request failed.')
  } finally { setDefaultCACertificates(originalCA); rmSync(dir, { recursive: true, force: true }) }
})

it('rejects unknown content encodings instead of treating encoded data as text', async () => {
  const base = await serve((_req, res) => { res.setHeader('content-encoding', 'gzip, br'); res.end('opaque') })
  await expect(safeFetch(base, opts)).rejects.toThrow('Network request denied.')
})

it('does not resolve DNS after cancellation or connect when timed-out DNS completes late', async () => {
  let requests = 0, resolved = false
  const base = await serve((_req, res) => { requests++; res.end('late') })
  const controller = new AbortController()
  controller.abort()
  const url = base.replace('127.0.0.1', 'fixture.test')
  await expect(safeFetch(url, { ...opts, signal: controller.signal, resolver: async () => { resolved = true; return [{ address: '127.0.0.1', family: 4 }] } })).rejects.toThrow('Network request cancelled.')
  expect(resolved).toBe(false)
  let resolveDNS!: (answers: Awaited<ReturnType<Resolver>>) => void
  const dns = new Promise<Awaited<ReturnType<Resolver>>>(resolve => { resolveDNS = resolve })
  await expect(safeFetch(url, { ...opts, timeoutMs: 15, resolver: () => dns })).rejects.toThrow('Network request timed out.')
  resolveDNS([{ address: '127.0.0.1', family: 4 }])
  await new Promise(resolve => setImmediate(resolve))
  expect(requests).toBe(0)
})

it('fetches a real server only with the explicit loopback test opt-in', async () => {
  const url = await serve((_req, res) => res.end('public fixture'))
  const result = await safeFetch(url, { signal: new AbortController().signal, maxBytes: 1024, timeoutMs: 1000, allowLoopbackForTests: true })
  expect(Buffer.from(result.body).toString()).toBe('public fixture')
  expect(result).toMatchObject({ finalUrl: `${url}/`, status: 200, truncated: false })
  await expect(safeFetch(url, { signal: new AbortController().signal, maxBytes: 1024, timeoutMs: 1000 })).rejects.toThrow('Network request denied.')
})
