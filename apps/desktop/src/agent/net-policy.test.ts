import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type RequestListener } from 'node:http'
import { createServer as createTLSServer } from 'node:https'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, deflateSync, brotliCompressSync, constants as zlib } from 'node:zlib'
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

// Reviewed range edges, also tested fully expanded and uppercase.
const ipv6Boundaries = [
  // 2000::/3: immediately before, first, last, immediately after.
  ['1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '1FFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['2000::', '2000:0000:0000:0000:0000:0000:0000:0000', true],
  ['3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3FFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', true],
  ['4000::', '4000:0000:0000:0000:0000:0000:0000:0000', false],
  // 2001::/23: immediately before, first, last, immediately after.
  ['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2000:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', true],
  ['2001::', '2001:0000:0000:0000:0000:0000:0000:0000', false],
  ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:01FF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['2001:200::', '2001:0200:0000:0000:0000:0000:0000:0000', true],
  // 2001:db8::/32: immediately before, first, last, immediately after.
  ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', '2001:0DB7:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', true],
  ['2001:db8::', '2001:0DB8:0000:0000:0000:0000:0000:0000', false],
  ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', '2001:0DB8:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['2001:db9::', '2001:0DB9:0000:0000:0000:0000:0000:0000', true],
  // 2002::/16: immediately before, first, last, immediately after.
  ['2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', true],
  ['2002::', '2002:0000:0000:0000:0000:0000:0000:0000', false],
  ['2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2002:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['2003::', '2003:0000:0000:0000:0000:0000:0000:0000', true],
  // 3fff::/20: immediately before, first, last, immediately after.
  ['3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3FFE:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', true],
  ['3fff::', '3FFF:0000:0000:0000:0000:0000:0000:0000', false],
  ['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3FFF:0FFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['3fff:1000::', '3FFF:1000:0000:0000:0000:0000:0000:0000', true],
  // 64:ff9b::/96: immediately before, first, last, immediately after.
  ['64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff', '0064:FF9A:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['64:ff9b::', '0064:FF9B:0000:0000:0000:0000:0000:0000', false],
  ['64:ff9b::ffff:ffff', '0064:FF9B:0000:0000:0000:0000:FFFF:FFFF', false],
  ['64:ff9b::1:0:0', '0064:FF9B:0000:0000:0000:0001:0000:0000', false],
  // 64:ff9b:1::/48: immediately before, first, last, immediately after.
  ['64:ff9b:0:ffff:ffff:ffff:ffff:ffff', '0064:FF9B:0000:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['64:ff9b:1::', '0064:FF9B:0001:0000:0000:0000:0000:0000', false],
  ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '0064:FF9B:0001:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['64:ff9b:2::', '0064:FF9B:0002:0000:0000:0000:0000:0000', false],
  // fec0::/10: immediately before, first, last, immediately after.
  ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'FEBF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['fec0::', 'FEC0:0000:0000:0000:0000:0000:0000:0000', false],
  ['feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'FEFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF', false],
  ['ff00::', 'FF00:0000:0000:0000:0000:0000:0000:0000', false],
] as const
it.each(ipv6Boundaries.flatMap(([canonical, expanded, publicAddress]) =>
  [canonical, expanded].map(ip => ({ ip, publicAddress }))))('classifies IPv6 boundary $ip as public=$publicAddress', ({ ip, publicAddress }) => {
  expect(isPublicAddress(ip)).toBe(publicAddress)
})

// These are policy-boundary tests, not claims about the host's IPv6 routing.
// A callback failure is deliberately distinguishable from policy denial, so a
// regression cannot accidentally open a socket to a real non-public service.
const deniedIPv6 = [...new Set(ipv6Boundaries.filter(([, , publicAddress]) => !publicAddress).flatMap(([canonical, expanded]) => [canonical, expanded]))]
it.each(deniedIPv6)('denies direct and mixed-DNS IPv6 target %s before the request boundary', async ip => {
  for (const mode of ['literal', 'dns'] as const) {
    const requested: string[] = []
    await expect(safeFetch(mode === 'literal' ? `http://[${ip}]/` : 'http://ipv6.test/', {
      ...opts, allowLoopbackForTests: false,
      resolver: async () => [{ address: '2606:4700:4700::1111', family: 6 }, { address: ip, family: 6 }],
      beforeRequest: url => { requested.push(url.href); throw new Error('Unexpected request boundary') },
    })).rejects.toThrow('Network request denied.')
    expect(requested).toEqual([])
  }
})

it.each(deniedIPv6)('denies redirect DNS target %s before a second request boundary', async ip => {
  let requests = 0
  const base = await serve((_req, res) => { requests++; res.writeHead(302, { location: 'http://ipv6.test/' }); res.end() })
  const requested: string[] = []
  await expect(safeFetch(base, {
    ...opts, resolver: async () => [{ address: ip, family: 6 }],
    beforeRequest: url => {
      requested.push(url.href)
      if (url.hostname === 'ipv6.test') throw new Error('Unexpected redirected request boundary')
    },
  })).rejects.toThrow('Network request denied.')
  expect(requests).toBe(1)
  expect(requested).toEqual([`${base}/`])
})

it.each(['2001:2::1', '2001:1::1', '2002:7f00:1::1', '2002:808:808::1', '64:ff9b:1::a00:1', '::ffff:0:7f00:1', '100::1', '5f00::1'])('denies special-purpose interior or embedded IPv4 address %s', ip => {
  expect(isPublicAddress(ip)).toBe(false)
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

// The property under test is the decompression cap, so compress quickly: brotli's
// default maximum quality takes seconds on 100 MB and made this test time out.
const fastBrotli = (input: Buffer) => brotliCompressSync(input, { params: { [zlib.BROTLI_PARAM_QUALITY]: 1 } })
it.each([
  ['gzip', (input: Buffer) => gzipSync(input, { level: 1 })], ['deflate', (input: Buffer) => deflateSync(input, { level: 1 })], ['br', fastBrotli],
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
