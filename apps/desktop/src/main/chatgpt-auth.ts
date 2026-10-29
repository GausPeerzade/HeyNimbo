import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { loadSecret, saveSecret } from './secrets'
import { noRedirectFetch } from './provider-settings'

export const ISSUER = 'https://auth.openai.com'
export const AUTHORIZE = `${ISSUER}/api/accounts/authorize`
export const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`
export const RESOURCE = 'https://api.openai.com/v1'
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export interface Identity { subject: string; name: string; email: string }
interface Tokens { access: string; refresh: string; id: string; expires: number; scopes: string[] }
export interface Profile { id: string; clientId: string; identity?: Identity; tokens?: Tokens }
interface AuthStore { hostId: string; profiles: Profile[]; active?: string }
export function createAttempt(): { verifier: string; challenge: string; state: string; nonce: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') }
}
export function matchesState(actual: string | null, expected: string): boolean {
  return actual !== null && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}
export function authorizeURL(attempt: ReturnType<typeof createAttempt>, redirectURI: string, hostId: string, profile?: Profile): URL {
  const url = new URL(AUTHORIZE)
  url.search = new URLSearchParams({ client_id: profile?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectURI, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: attempt.challenge }).toString()
  if (!profile) url.searchParams.set('agent_name_hint', 'HeyNimbo')
  if (profile?.tokens?.id) url.searchParams.set('id_token_hint', profile.tokens.id)
  if (profile?.identity?.email) url.searchParams.set('login_hint', profile.identity.email)
  if (profile?.identity && !profile.tokens?.scopes.includes('chatgpt.tokens.use.direct')) url.searchParams.set('prompt', 'consent')
  return url
}
export function validateAuthorizeURL(url: URL): string {
  if (url.origin !== ISSUER || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash) throw new Error('Invalid authorization URL.')
  return url.href
}
export function parseCallback(url: URL, state: string, clientId?: string): { code: string; clientId: string } {
  if (!matchesState(url.searchParams.get('state'), state) || url.searchParams.getAll('state').length !== 1) throw new Error('Sign-in state did not match. Try again.')
  if (url.searchParams.has('error')) throw new Error(url.searchParams.get('error') === 'access_denied' ? 'ChatGPT sign-in was declined. You can try again or add an API key.' : 'ChatGPT sign-in failed. Try again.')
  const issued = url.searchParams.get('client_id') ?? clientId
  if (!issued || issued === 'dynamic_agent_client' || (clientId && issued !== clientId) || !/^[\w-]{1,200}$/.test(issued)) throw new Error('ChatGPT registration was incomplete or did not match.')
  const code = url.searchParams.get('code')
  if (!code || code.length > 8192 || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1) throw new Error('Missing or invalid authorization code.')
  return { code, clientId: issued }
}
export async function startCallback(state: string, clientId?: string, timeoutMs = 180_000): Promise<{ redirectURI: string; result: Promise<{ code: string; clientId: string }>; cancel(): void }> {
  let resolve!: (value: { code: string; clientId: string }) => void, reject!: (error: Error) => void
  const result = new Promise<{ code: string; clientId: string }>((yes, no) => { resolve = yes; reject = no })
  // Browser launch can fail before the caller starts awaiting this promise.
  void result.catch(() => {})
  let used = false, timer: NodeJS.Timeout | undefined
  const close = (force = true): void => { clearTimeout(timer); server.close(); if (force) server.closeAllConnections() }
  const server = createServer((request, response) => {
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://127.0.0.1') } catch { response.writeHead(400); response.end('Invalid callback.'); return }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET' || url.pathname !== '/auth/callback' || used) { response.writeHead(404); response.end('Not found.'); return }
    used = true
    try { const callback = parseCallback(url, state, clientId); response.end('Return to HeyNimbo to finish connecting.'); resolve(callback) }
    catch (error) { response.writeHead(400); response.end('Sign-in was not accepted. Return to HeyNimbo.'); reject(error as Error) }
    finally { close(false) }
  })
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  server.on('error', () => { reject(new Error('Could not receive ChatGPT sign-in.')); close() })
  const address = server.address()
  if (!address || typeof address === 'string') { close(); throw new Error('Could not start sign-in listener.') }
  timer = setTimeout(() => { used = true; reject(new Error('ChatGPT sign-in timed out. Try again.')); close() }, timeoutMs)
  return { redirectURI: `http://127.0.0.1:${address.port}/auth/callback`, result, cancel: () => { used = true; reject(new Error('Sign-in cancelled.')); close() } }
}
export async function verifyIdentity(idToken: string, clientId: string, nonce: string | undefined, jwks: JWTVerifyGetKey): Promise<Identity> {
  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 })
  if ((nonce !== undefined && payload.nonce !== nonce) || !payload.sub || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error('ChatGPT identity did not match this sign-in.')
  return { subject: payload.sub, name: typeof payload.name === 'string' ? payload.name : '', email: typeof payload.email === 'string' ? payload.email : '' }
}
export async function tokenRequest(fields: Record<string, string>, transport = noRedirectFetch): Promise<Record<string, unknown>> {
  let response: Response
  try { response = await transport(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, resource: RESOURCE }), signal: AbortSignal.timeout(15_000) }) }
  catch { throw new Error('Could not reach ChatGPT. Check your connection and try again.') }
  let body: Record<string, unknown>
  try { body = await response.json() as Record<string, unknown> } catch { throw new Error('ChatGPT returned an invalid authorization response.') }
  if (!response.ok) {
    const error = new Error('ChatGPT could not renew this grant. Sign in again.') as Error & { terminal?: boolean }
    error.terminal = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(String(body.error))
    if (!error.terminal) error.message = 'ChatGPT authorization is temporarily unavailable. Try again later.'
    throw error
  }
  return body
}
export function parseTokens(body: Record<string, unknown>, previous?: Tokens): Tokens {
  if (typeof body.access_token !== 'string' || !body.access_token || String(body.token_type).toLowerCase() !== 'bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error('ChatGPT returned invalid credentials.')
  if (body.scope !== undefined && typeof body.scope !== 'string') throw new Error('ChatGPT returned invalid permissions.')
  const refresh = typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refresh
  const id = typeof body.id_token === 'string' ? body.id_token : previous?.id
  if (!refresh || !id || (body.scope === undefined && !previous)) throw new Error('ChatGPT returned incomplete credentials.')
  return { access: body.access_token, refresh, id, expires: Date.now() + body.expires_in * 1000, scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/) : previous?.scopes ?? [] }
}
export function requirePlanPermission(profile: Profile | undefined): asserts profile is Profile & { tokens: Tokens } {
  if (!profile?.tokens) throw new Error('Sign in with ChatGPT again; this grant has expired or been disconnected.')
  if (!profile.tokens.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan usage is not enabled. Enable it with Continue with ChatGPT or add an API key; an eligible Plus or Pro plan is required.')
}
function authEndpoint(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Invalid ChatGPT discovery response.')
  const url = new URL(value)
  if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) throw new Error('Invalid ChatGPT endpoint.')
  return url
}
export class ChatGPTAuth {
  private store: AuthStore = { hostId: `urn:uuid:${randomUUID()}`, profiles: [] }
  private renewal?: Promise<string>
  private signingIn = false
  private jwks?: JWTVerifyGetKey
  private revocation?: URL
  constructor(private readonly openBrowser: (url: string) => Promise<unknown>, private readonly transport = noRedirectFetch) {}
  async load(): Promise<void> {
    const saved = await loadSecret('chatgpt-auth')
    if (saved) {
      const value = JSON.parse(saved) as AuthStore
      if (!value.hostId?.startsWith('urn:uuid:') || !Array.isArray(value.profiles)) throw new Error('ChatGPT storage could not be read.')
      this.store = value
    }
  }
  get profiles(): readonly Profile[] { return this.store.profiles }
  get active(): Profile | undefined { return this.store.profiles.find(p => p.id === this.store.active) }
  private save(): Promise<void> { return saveSecret('chatgpt-auth', JSON.stringify(this.store)) }
  private async discovery(): Promise<void> {
    const response = await this.transport(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error('ChatGPT discovery is unavailable.')
    const config = await response.json() as Record<string, unknown>
    if (config.issuer !== ISSUER || authEndpoint(config.authorization_endpoint).href !== AUTHORIZE || authEndpoint(config.token_endpoint).href !== TOKEN_ENDPOINT) throw new Error('Invalid ChatGPT issuer configuration.')
    this.jwks = createRemoteJWKSet(authEndpoint(config.jwks_uri), { [customFetch]: this.transport })
    this.revocation = config.revocation_endpoint ? authEndpoint(config.revocation_endpoint) : undefined
  }
  async signIn(accountId?: string, newAccount = false): Promise<void> {
    if (this.signingIn || this.renewal) throw new Error('Finish the current ChatGPT connection attempt first.')
    const profile = accountId ? this.store.profiles.find(p => p.id === accountId) : newAccount ? undefined : this.active ?? this.store.profiles.at(-1)
    if (accountId && !profile) throw new Error('Unknown ChatGPT account.')
    this.signingIn = true
    try {
      await this.save(); await this.discovery()
      const attempt = createAttempt(), listener = await startCallback(attempt.state, profile?.clientId)
      try {
        await this.openBrowser(validateAuthorizeURL(authorizeURL(attempt, listener.redirectURI, this.store.hostId, profile)))
        const callback = await listener.result
        const registration = profile ?? { id: randomUUID(), clientId: callback.clientId }
        if (!profile) this.store.profiles.push(registration)
        await this.save()
        const body = await tokenRequest({ grant_type: 'authorization_code', client_id: registration.clientId, code: callback.code, code_verifier: attempt.verifier, redirect_uri: listener.redirectURI }, this.transport)
        if (typeof body.id_token !== 'string') throw new Error('ChatGPT did not return an ID token.')
        const identity = await verifyIdentity(body.id_token, registration.clientId, attempt.nonce, this.jwks!)
        if (profile?.identity && profile.identity.subject !== identity.subject) throw new Error('Choose the ChatGPT account associated with this registration.')
        registration.identity = identity; registration.tokens = parseTokens(body); this.store.active = registration.id
        await this.save()
      } finally { listener.cancel() }
    } finally { this.signingIn = false }
  }
  async select(accountId: string): Promise<void> {
    if (this.signingIn || this.renewal) throw new Error('Finish the current ChatGPT connection attempt first.')
    if (!this.store.profiles.some(p => p.id === accountId && p.identity)) throw new Error('Unknown ChatGPT account.')
    this.store.active = accountId; await this.save()
  }
  async credential(): Promise<string> {
    const profile = this.active; requirePlanPermission(profile)
    if (profile.tokens.expires > Date.now() + 60_000) return profile.tokens.access
    this.renewal ??= this.refresh(profile).finally(() => { this.renewal = undefined })
    return this.renewal
  }
  private async refresh(profile: Profile & { tokens: Tokens }): Promise<string> {
    try {
      const body = await tokenRequest({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.tokens.refresh }, this.transport)
      if (typeof body.id_token === 'string') {
        if (!this.jwks) await this.discovery()
        const identity = await verifyIdentity(body.id_token, profile.clientId, undefined, this.jwks!)
        if (identity.subject !== profile.identity?.subject) throw new Error('ChatGPT refreshed a different identity.')
      }
      profile.tokens = parseTokens(body, profile.tokens); await this.save(); requirePlanPermission(profile)
      return profile.tokens.access
    } catch (error) {
      if ((error as { terminal?: boolean }).terminal) { delete (profile as Profile).tokens; await this.save() }
      throw error
    }
  }
  async signOut(): Promise<string> {
    if (this.signingIn) throw new Error('Finish the current sign-in attempt first.')
    await this.renewal?.catch(() => {})
    const profile = this.active
    if (!profile?.tokens) return 'Signed out.'
    let confirmed = false
    try {
      if (!this.jwks) await this.discovery()
      if (this.revocation) for (let i = 0; i < 2; i++) {
        try {
          const response = await this.transport(this.revocation, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: profile.tokens.refresh, token_type_hint: 'refresh_token', client_id: profile.clientId }), signal: AbortSignal.timeout(10_000) })
          confirmed = response.status === 200
          if (confirmed || response.status < 500) break
        } catch { /* Local sign-out still removes every token. */ }
        if (i === 0) await new Promise(resolve => setTimeout(resolve, 300))
      }
    } catch { confirmed = false }
    finally { delete profile.tokens; await this.save() }
    return confirmed ? 'Signed out.' : 'Signed out locally. Remote revocation was not confirmed; disconnect HeyNimbo in ChatGPT Settings.'
  }
}
