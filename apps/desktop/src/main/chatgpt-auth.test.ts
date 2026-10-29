import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { AUTHORIZE, ChatGPTAuth, ISSUER, RESOURCE, SCOPES, TOKEN_ENDPOINT, authorizeURL, createAttempt, matchesState, parseCallback, parseTokens, requirePlanPermission, startCallback, tokenRequest, validateAuthorizeURL, verifyIdentity, type Profile } from './chatgpt-auth'
const mocks = vi.hoisted(() => ({ handler: undefined as undefined | ((request: { method: string; url: string }, response: { setHeader: (...args: string[]) => void; writeHead: (code: number) => void; end: (text: string) => void }) => void), bind: vi.fn(), close: vi.fn(), saved: undefined as string | undefined, writes: [] as string[] }))
vi.mock('node:http', () => ({ createServer: (handler: typeof mocks.handler) => {
  mocks.handler = handler
  return Object.assign(new EventEmitter(), { listen: (port: number, host: string, ready: () => void) => { mocks.bind(port, host); ready() }, address: () => ({ port: 54321, address: '127.0.0.1' }), close: mocks.close, closeAllConnections: vi.fn() })
} }))
vi.mock('./secrets', () => ({ loadSecret: async () => mocks.saved, saveSecret: async (_name: string, value: string) => { mocks.saved = value; mocks.writes.push(value) } }))
let privateKey: CryptoKey, publicJwk: Awaited<ReturnType<typeof exportJWK>>
beforeAll(async () => { const keys = await generateKeyPair('RS256'); privateKey = keys.privateKey; publicJwk = { ...await exportJWK(keys.publicKey), kid: 'test-key' } })
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden') })); mocks.saved = undefined; mocks.writes = []; mocks.bind.mockClear(); mocks.close.mockClear() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
async function idToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ sub: 'subject-test', name: 'Test User', email: 'test@example.invalid', nonce: 'nonce-test', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(String(claims.iss ?? ISSUER)).setAudience(claims.aud as string ?? 'oaiapp_test').setIssuedAt().setExpirationTime(claims.exp as number ?? Math.floor(Date.now() / 1000) + 600).sign(privateKey)
}
function respond(url: string): { status: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  const status = vi.fn(), end = vi.fn()
  mocks.handler!({ method: 'GET', url }, { setHeader: vi.fn(), writeHead: status, end })
  return { status, end }
}
it('creates independent PKCE S256, state and nonce values for every authorization attempt', () => {
  const a = createAttempt(), b = createAttempt()
  expect(a.verifier).toMatch(/^[\w-]{43,128}$/)
  expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'))
  for (const key of ['verifier', 'state', 'nonce'] as const) expect(a[key]).not.toBe(b[key])
  expect(matchesState(a.state, a.state)).toBe(true); expect(matchesState(null, a.state)).toBe(false); expect(matchesState('bad', a.state)).toBe(false)
})
it('builds the documented authorization URL with scopes, resource, host and exact callback; reuses issued registration without agent name', () => {
  const attempt = createAttempt(), redirect = 'http://127.0.0.1:54321/auth/callback', url = authorizeURL(attempt, redirect, 'urn:uuid:test')
  expect(url.origin + url.pathname).toBe(AUTHORIZE)
  expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'])
  for (const [name, value] of Object.entries({ client_id: 'dynamic_agent_client', agent_name_hint: 'NimboGuide', scope: SCOPES, resource: RESOURCE, redirect_uri: redirect, nonce: attempt.nonce, state: attempt.state, code_challenge: attempt.challenge, code_challenge_method: 'S256', ext_agent_host_id: 'urn:uuid:test' })) expect(url.searchParams.get(name)).toBe(value)
  const returning = authorizeURL(attempt, redirect, 'urn:uuid:test', { id: 'p', clientId: 'oaiapp_test' })
  expect(returning.searchParams.get('client_id')).toBe('oaiapp_test'); expect(returning.searchParams.has('agent_name_hint')).toBe(false)
  expect(validateAuthorizeURL(url)).toBe(url.href)
  expect(() => validateAuthorizeURL(new URL('https://auth.openai.com.evil.invalid/api/accounts/authorize'))).toThrow()
})
it('binds only the loopback address, accepts the callback once and closes on success', async () => {
  const listener = await startCallback('state-test')
  expect(mocks.bind).toHaveBeenCalledWith(0, '127.0.0.1')
  expect(listener.redirectURI).toBe('http://127.0.0.1:54321/auth/callback')
  expect(respond('/unrelated').status).toHaveBeenCalledWith(404)
  respond('/auth/callback?state=state-test&code=code-test&client_id=oaiapp_test')
  expect(await listener.result).toEqual({ code: 'code-test', clientId: 'oaiapp_test' })
  expect(mocks.close).toHaveBeenCalled()
  expect(respond('/auth/callback?state=state-test&code=again&client_id=oaiapp_test').status).toHaveBeenCalledWith(404)
})
it('rejects a mismatched callback state, closes on denial, and expires unused listeners', async () => {
  const mismatch = await startCallback('right')
  expect(respond('/auth/callback?state=wrong&code=code&client_id=oaiapp_test').status).toHaveBeenCalledWith(400)
  await expect(mismatch.result).rejects.toThrow('state')
  const denied = await startCallback('right')
  respond('/auth/callback?state=right&error=access_denied'); await expect(denied.result).rejects.toThrow('declined')
  vi.useFakeTimers()
  const timeout = await startCallback('right', undefined, 500)
  const rejected = expect(timeout.result).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(500); await rejected
  expect(respond('/auth/callback?state=right&code=late&client_id=oaiapp_test').status).toHaveBeenCalledWith(404)
})
it('rejects missing/dynamic/different client IDs, duplicate fields and error callbacks before exchanging a code', () => {
  for (const query of ['state=s&code=c', 'state=s&code=c&client_id=dynamic_agent_client', 'state=s&code=c&client_id=other', 'state=s&state=s&code=c', 'state=s&code=c&code=d', 'state=s&error=access_denied']) expect(() => parseCallback(new URL(`http://127.0.0.1/auth/callback?${query}`), 's', query.includes('other') ? 'oaiapp_test' : undefined)).toThrow()
  expect(parseCallback(new URL('http://127.0.0.1/auth/callback?state=s&code=c'), 's', 'oaiapp_test')).toEqual({ code: 'c', clientId: 'oaiapp_test' })
})
it('exchanges authorization and refresh grants as form data with resource and no client secret or scope override', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ access_token: 'access-test' }))
  await tokenRequest({ grant_type: 'authorization_code', client_id: 'oaiapp_test', code: 'code-test', code_verifier: 'verifier-test', redirect_uri: 'http://127.0.0.1:54321/auth/callback' }, transport)
  await tokenRequest({ grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'refresh-test' }, transport)
  for (const [url, init] of transport.mock.calls) {
    expect(url).toBe(TOKEN_ENDPOINT); expect(init?.method).toBe('POST'); expect(init?.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' })
    const body = init!.body as URLSearchParams
    expect(body.get('resource')).toBe(RESOURCE); expect(body.has('client_secret')).toBe(false); expect(body.has('scope')).toBe(false)
  }
  expect(Object.fromEntries(transport.mock.calls[0]![1]!.body as URLSearchParams)).toMatchObject({ code_verifier: 'verifier-test', redirect_uri: 'http://127.0.0.1:54321/auth/callback' })
  expect(Object.fromEntries(transport.mock.calls[1]![1]!.body as URLSearchParams)).toMatchObject({ grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'refresh-test' })
})
it('verifies the ID signature and rejects wrong audience, issuer, nonce or expiry', async () => {
  const jwks = createLocalJWKSet({ keys: [publicJwk] })
  expect(await verifyIdentity(await idToken(), 'oaiapp_test', 'nonce-test', jwks)).toEqual({ subject: 'subject-test', name: 'Test User', email: 'test@example.invalid' })
  for (const claim of [{ aud: 'another-app' }, { iss: 'https://wrong.invalid' }, { nonce: 'wrong' }, { exp: Math.floor(Date.now() / 1000) - 60 }]) await expect(verifyIdentity(await idToken(claim), 'oaiapp_test', 'nonce-test', jwks)).rejects.toThrow()
  const badKey = await generateKeyPair('RS256')
  await expect(verifyIdentity(await idToken(), 'oaiapp_test', 'nonce-test', createLocalJWKSet({ keys: [{ ...await exportJWK(badKey.publicKey), kid: 'test-key' }] }))).rejects.toThrow()
})
it('refuses inference without the actually granted direct scope and rejects incomplete token sets', () => {
  const tokens = parseTokens({ access_token: 'access-test', refresh_token: 'refresh-test', id_token: 'id-test', token_type: 'Bearer', expires_in: 3600, scope: 'openid email' })
  expect(() => requirePlanPermission({ id: 'p', clientId: 'oaiapp_test', tokens })).toThrow('not enabled')
  expect(() => requirePlanPermission(undefined)).toThrow('Sign in')
  expect(() => parseTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 100, scope: SCOPES })).toThrow('incomplete')
  expect(() => parseTokens({ access_token: 'a', token_type: 'Bearer', expires_in: -1 })).toThrow('invalid')
  tokens.scopes.push('chatgpt.tokens.use.direct'); expect(() => requirePlanPermission({ id: 'p', clientId: 'oaiapp_test', tokens })).not.toThrow()
})
function savedProfile(): Profile {
  return { id: 'p', clientId: 'oaiapp_test', identity: { subject: 'subject-test', name: 'Test', email: 'test@example.invalid' }, tokens: { access: 'old-access', refresh: 'old-refresh', id: 'old-id', expires: 1, scopes: SCOPES.split(' ') } }
}
it('serializes refresh rotation, replaces credentials together and retains granted scopes if refresh omits them', async () => {
  mocks.saved = JSON.stringify({ hostId: 'urn:uuid:test', active: 'p', profiles: [savedProfile()] })
  const transport = vi.fn<typeof fetch>(async () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 }))
  const auth = new ChatGPTAuth(vi.fn(), transport); await auth.load()
  expect(await Promise.all([auth.credential(), auth.credential()])).toEqual(['new-access', 'new-access'])
  expect(transport).toHaveBeenCalledOnce()
  expect(JSON.parse(mocks.saved!).profiles[0].tokens).toMatchObject({ access: 'new-access', refresh: 'new-refresh', scopes: SCOPES.split(' ') })
})
it('clears unusable refresh grants without losing registration, but preserves tokens after transient failures', async () => {
  for (const [code, status, cleared] of [['invalid_grant', 400, true], ['temporarily_unavailable', 503, false]] as const) {
    mocks.saved = JSON.stringify({ hostId: 'urn:uuid:test', active: 'p', profiles: [savedProfile()] })
    const auth = new ChatGPTAuth(vi.fn(), vi.fn(async () => Response.json({ error: code }, { status })))
    await auth.load(); await expect(auth.credential()).rejects.toThrow()
    expect(auth.active?.clientId).toBe('oaiapp_test'); expect(Boolean(auth.active?.tokens)).toBe(!cleared)
  }
})
it('starts the listener before browser launch, persists the issued ID before exchange and verifies identity before activating', async () => {
  let nonce = ''
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN_ENDPOINT, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` })
    if (String(url).endsWith('jwks.json')) return Response.json({ keys: [publicJwk] })
    expect(JSON.parse(mocks.saved!).profiles[0].clientId).toBe('oaiapp_test')
    return Response.json({ access_token: 'access-test', refresh_token: 'refresh-test', id_token: await idToken({ nonce }), token_type: 'Bearer', expires_in: 3600, scope: SCOPES })
  })
  const browser = vi.fn(async (value: string) => {
    expect(mocks.bind).toHaveBeenCalledWith(0, '127.0.0.1')
    const url = new URL(value); nonce = url.searchParams.get('nonce')!
    respond(`/auth/callback?state=${url.searchParams.get('state')}&code=code-test&client_id=oaiapp_test`)
  })
  const auth = new ChatGPTAuth(browser, transport); await auth.load(); await auth.signIn()
  expect(auth.active?.identity?.subject).toBe('subject-test'); expect(await auth.credential()).toBe('access-test')
  expect(JSON.parse(mocks.saved!).hostId).toMatch(/^urn:uuid:/)
})
it('revokes the renewable grant on sign-out and deletes tokens while retaining host and registration', async () => {
  mocks.saved = JSON.stringify({ hostId: 'urn:uuid:test', active: 'p', profiles: [savedProfile()] })
  const transport = vi.fn<typeof fetch>(async url => String(url).endsWith('openid-configuration') ? Response.json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN_ENDPOINT, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/oauth/revoke` }) : new Response('', { status: 200 }))
  const auth = new ChatGPTAuth(vi.fn(), transport); await auth.load(); expect(await auth.signOut()).toBe('Signed out.')
  const [url, init] = transport.mock.calls.at(-1)!
  expect(String(url)).toBe(`${ISSUER}/oauth/revoke`)
  expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({ token: 'old-refresh', token_type_hint: 'refresh_token', client_id: 'oaiapp_test' })
  expect(auth.active?.tokens).toBeUndefined(); expect(auth.active?.clientId).toBe('oaiapp_test')
  expect(mocks.saved).not.toContain('old-access'); expect(mocks.saved).not.toContain('old-refresh'); expect(mocks.saved).not.toContain('old-id')
})
it('clears local tokens and reports remote revocation uncertainty if discovery is unavailable', async () => {
  mocks.saved = JSON.stringify({ hostId: 'urn:uuid:test', active: 'p', profiles: [savedProfile()] })
  const auth = new ChatGPTAuth(vi.fn(), vi.fn(async () => { throw new Error('offline') })); await auth.load()
  expect(await auth.signOut()).toContain('not confirmed'); expect(auth.active?.tokens).toBeUndefined()
})

it('retains and reuses the issued registration after a code exchange expires', async () => {
  let callbackClient = ''
  const transport = vi.fn<typeof fetch>(async url => String(url).endsWith('openid-configuration') ? Response.json({ issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN_ENDPOINT, jwks_uri: `${ISSUER}/.well-known/jwks.json` }) : Response.json({ error: 'invalid_grant' }, { status: 400 }))
  const browser = vi.fn(async (value: string) => {
    const url = new URL(value); callbackClient = url.searchParams.get('client_id')!
    respond(`/auth/callback?state=${url.searchParams.get('state')}&code=expired&client_id=oaiapp_test`)
  })
  const auth = new ChatGPTAuth(browser, transport); await auth.load()
  await expect(auth.signIn()).rejects.toThrow('renew'); expect(callbackClient).toBe('dynamic_agent_client')
  await expect(auth.signIn()).rejects.toThrow('renew'); expect(callbackClient).toBe('oaiapp_test')
  expect(auth.profiles).toHaveLength(1); expect(auth.active).toBeUndefined()
})
