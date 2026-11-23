import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * OAuth 2.1 for remote MCP servers, done the way the MCP authorization spec describes and the way
 * Claude / ChatGPT connectors do it:
 *
 *  1. Probe the MCP endpoint. A 401 carries `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728).
 *  2. Protected-resource metadata names the authorization server; its RFC 8414 metadata has the endpoints.
 *  3. Jarvis registers itself as a public client (RFC 7591 dynamic registration, client name "Jarvis").
 *  4. Authorization code + PKCE (S256) in your default browser; a one-shot listener on 127.0.0.1 takes the
 *     redirect (RFC 8252 loopback, any port). `resource` (RFC 8707) binds the token to this MCP server.
 *  5. Tokens are refreshed with the refresh token (offline_access) before they expire.
 *
 * Nothing here logs tokens, codes or verifiers; errors carry only endpoint paths and server error codes.
 */

const HTTP_TIMEOUT_MS = 10_000
const SIGNIN_TIMEOUT_MS = 5 * 60_000
const CALLBACK_PATH = '/callback'
const CLIENT_NAME = 'Jarvis'
const CLIENT_URI = 'https://github.com/DamonBslr/jarvis'

export interface AuthServer {
  /** RFC 8707 resource indicator (the protected resource's canonical URL). */
  resource: string
  resourceName?: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  scopes: string[]
  issParameter: boolean
}

export interface OAuthClient {
  clientId: string
  clientSecret?: string
  /** Redirect URI used at registration (loopback; the port may differ later where the server allows). */
  redirectUri: string
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. */
  expiresAt?: number
  scope?: string
  idToken?: string
}

export type ProbeResult =
  | { kind: 'open'; name?: string }
  | { kind: 'oauth'; server: AuthServer }
  /** Needs credentials but publishes no OAuth metadata: an API key / bearer token. */
  | { kind: 'token'; name?: string }

export class OAuthError extends Error {}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    return await res.json()
  } catch {
    return null
  }
}

/** Parse `Bearer realm="x", resource_metadata="…", scope="a b"` into a lowercase-keyed map. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const m of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g))
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')
  return out
}

/** `https://a.b/x/y` + `oauth-authorization-server` -> `https://a.b/.well-known/oauth-authorization-server/x/y` (RFC 8414 §3). */
function wellKnown(base: string, suffix: string): string {
  const u = new URL(base)
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.origin}/.well-known/${suffix}${path}`
}

async function authServerMetadata(issuer: string): Promise<any | null> {
  const candidates = [
    wellKnown(issuer, 'oauth-authorization-server'),
    wellKnown(issuer, 'openid-configuration'),
    `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
  ]
  for (const url of [...new Set(candidates)]) {
    const meta = await getJson(url)
    if (meta?.authorization_endpoint && meta?.token_endpoint) return meta
  }
  return null
}

function httpsOrLoopback(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new OAuthError(`${what} missing from the server metadata`)
  const u = new URL(raw)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new OAuthError(`${what} must use https`)
  return u.toString()
}

/** Look at an MCP endpoint: open, OAuth (with discovered endpoints), or "needs a token". */
export async function probe(endpoint: string): Promise<ProbeResult> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'jarvis-probe',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jarvis', version: '0.0.0' } }
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const sessionId = res.headers.get('mcp-session-id')
  const www = res.headers.get('www-authenticate')
  let serverName: string | undefined
  if (res.ok) {
    const text = await res.text().catch(() => '')
    serverName = /"serverInfo"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/.exec(text)?.[1]
    if (sessionId) void fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => {})
    return { kind: 'open', name: serverName }
  }
  await res.body?.cancel()
  if (res.status !== 401 && res.status !== 403) throw new OAuthError(`The server answered HTTP ${res.status}; is this an MCP endpoint?`)

  // RFC 9728: header first, then the well-known locations for this path and the origin.
  const params = parseWwwAuthenticate(www)
  const prmUrls = [params.resource_metadata, wellKnown(endpoint, 'oauth-protected-resource'), `${new URL(endpoint).origin}/.well-known/oauth-protected-resource`]
  let prm: any = null
  for (const url of prmUrls) {
    if (!url) continue
    prm = await getJson(url)
    if (prm?.authorization_servers?.length) break
    prm = null
  }

  // Older MCP servers (2025-03-26 spec) act as their own authorization server.
  const issuer: string | undefined = prm?.authorization_servers?.[0] ?? new URL(endpoint).origin
  const meta = issuer ? await authServerMetadata(issuer) : null
  if (!meta) return { kind: 'token', name: prm?.resource_name }

  const resource = typeof prm?.resource === 'string' ? prm.resource : endpoint
  const supported: string[] = Array.isArray(meta.scopes_supported) ? meta.scopes_supported : []
  const fromHeader = params.scope ? params.scope.split(/\s+/) : []
  const fromResource: string[] = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported : []
  const scopes = [...new Set([...(fromHeader.length ? fromHeader : fromResource)])]
  // Ask for a refresh token where the server offers one, so Jarvis keeps access without new sign-ins.
  if (supported.includes('offline_access') && !scopes.includes('offline_access')) scopes.push('offline_access')

  return {
    kind: 'oauth',
    server: {
      resource,
      resourceName: typeof prm?.resource_name === 'string' ? prm.resource_name : undefined,
      issuer: typeof meta.issuer === 'string' ? meta.issuer : issuer!,
      authorizationEndpoint: httpsOrLoopback(meta.authorization_endpoint, 'authorization_endpoint'),
      tokenEndpoint: httpsOrLoopback(meta.token_endpoint, 'token_endpoint'),
      registrationEndpoint: meta.registration_endpoint ? httpsOrLoopback(meta.registration_endpoint, 'registration_endpoint') : undefined,
      revocationEndpoint: meta.revocation_endpoint ? httpsOrLoopback(meta.revocation_endpoint, 'revocation_endpoint') : undefined,
      scopes,
      issParameter: meta.authorization_response_iss_parameter_supported === true
    }
  }
}

async function postForm(url: string, body: Record<string, string | undefined>, client?: OAuthClient): Promise<any> {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== '') form.set(k, v)
  if (client) {
    form.set('client_id', client.clientId)
    if (client.clientSecret) form.set('client_secret', client.clientSecret)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`
    const desc = typeof json?.error_description === 'string' ? `: ${json.error_description.slice(0, 200)}` : ''
    throw new OAuthError(`${new URL(url).pathname} ${code}${desc}`)
  }
  return json
}

function toTokenSet(json: any, previous?: TokenSet): TokenSet {
  if (typeof json?.access_token !== 'string' || !json.access_token) throw new OAuthError('token endpoint returned no access_token')
  const expiresIn = Number(json.expires_in)
  return {
    accessToken: json.access_token,
    // Servers that don't rotate refresh tokens leave it out of refresh responses.
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : previous?.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof json.scope === 'string' ? json.scope : previous?.scope,
    idToken: typeof json.id_token === 'string' ? json.id_token : previous?.idToken
  }
}

async function register(server: AuthServer, redirectUri: string): Promise<OAuthClient> {
  if (!server.registrationEndpoint)
    throw new OAuthError(`${new URL(server.issuer).host} does not allow apps to register themselves (no dynamic client registration)`)
  const res = await fetch(server.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: CLIENT_URI,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(server.scopes.length ? { scope: server.scopes.join(' ') } : {})
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const json: any = await res.json().catch(() => null)
  if (!res.ok || typeof json?.client_id !== 'string')
    throw new OAuthError(`client registration failed: ${json?.error ?? `HTTP ${res.status}`}${json?.error_description ? ` (${String(json.error_description).slice(0, 200)})` : ''}`)
  return { clientId: json.client_id, clientSecret: typeof json.client_secret === 'string' ? json.client_secret : undefined, redirectUri }
}

const b64url = (buf: Buffer) => buf.toString('base64url')

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0d0f12;color:#e8eaed">' +
  `<div style="text-align:center;max-width:28rem"><h1 style="font-weight:600;font-size:22px">${title}</h1><p style="color:#9aa0a6">${body}</p></div>`

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

export interface AuthorizeOptions {
  server: AuthServer
  /** Client from an earlier sign-in, reused when its redirect still fits. */
  client?: OAuthClient
  /** Opens the authorization URL in the user's browser. */
  open(url: string): Promise<void>
  signal?: AbortSignal
}

/** Full interactive sign-in. Resolves once the user approved in the browser and tokens are issued. */
export async function authorize(opts: AuthorizeOptions): Promise<{ client: OAuthClient; tokens: TokenSet }> {
  const { server } = opts
  // Reuse the registered port where possible; servers that match loopback redirects exactly need it.
  let preferredPort = 0
  if (opts.client) {
    try {
      preferredPort = Number(new URL(opts.client.redirectUri).port) || 0
    } catch {
      /* re-register */
    }
  }
  let http: Server
  try {
    http = await listen(preferredPort)
  } catch {
    http = await listen(0)
  }
  try {
    const port = (http.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    const client = opts.client && opts.client.redirectUri === redirectUri ? opts.client : await register(server, redirectUri)

    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))
    const url = new URL(server.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', client.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)
    url.searchParams.set('resource', server.resource)
    if (server.scopes.length) url.searchParams.set('scope', server.scopes.join(' '))
    // OIDC servers only issue refresh tokens for offline_access after an explicit consent prompt.
    if (server.scopes.includes('offline_access')) url.searchParams.set('prompt', 'consent')

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new OAuthError('Sign-in timed out (5 minutes)')), SIGNIN_TIMEOUT_MS)
      const abort = () => {
        clearTimeout(timer)
        reject(new OAuthError('Sign-in cancelled'))
      }
      if (opts.signal?.aborted) return abort()
      opts.signal?.addEventListener('abort', abort, { once: true })
      const done = () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', abort)
      }
      http.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri)
        if (u.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end()
          return
        }
        const html = (status: number, title: string, body: string) =>
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(title, body))
        // A stray request (favicon, a second tab) must not end the flow; only a matching state does.
        if (u.searchParams.get('state') !== state) return html(400, 'Unexpected sign-in response', 'This tab can be closed.')
        const iss = u.searchParams.get('iss')
        if ((iss || server.issParameter) && iss !== server.issuer) {
          done()
          html(400, 'Sign-in rejected', 'The response came from an unexpected server. Nothing was saved.')
          return reject(new OAuthError('Authorization response from an unexpected issuer'))
        }
        const error = u.searchParams.get('error')
        if (error) {
          done()
          html(400, 'Not connected', 'You can close this tab and try again from Jarvis.')
          return reject(new OAuthError(error === 'access_denied' ? 'Access was denied on the sign-in page' : `Sign-in failed: ${error}`))
        }
        const c = u.searchParams.get('code')
        if (!c) return html(400, 'Not connected', 'No authorization code. You can close this tab.')
        done()
        html(200, 'Jarvis is connected', 'You can close this tab and go back to Jarvis.')
        resolve(c)
      })
      opts.open(url.toString()).catch((err) => {
        done()
        reject(err)
      })
    })

    const tokens = toTokenSet(
      await postForm(
        server.tokenEndpoint,
        { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, resource: server.resource },
        client
      )
    )
    return { client, tokens }
  } finally {
    http.close()
  }
}

/** New access token from the refresh token. Throws OAuthError (e.g. invalid_grant) when a new sign-in is needed. */
export async function refresh(server: AuthServer, client: OAuthClient, tokens: TokenSet): Promise<TokenSet> {
  if (!tokens.refreshToken) throw new OAuthError('No refresh token; sign in again')
  const json = await postForm(
    server.tokenEndpoint,
    { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, resource: server.resource },
    client
  )
  return toTokenSet(json, tokens)
}

/** Best effort: tell the server to forget the refresh token (servers may require client auth and refuse). */
export async function revoke(server: AuthServer, client: OAuthClient, tokens: TokenSet): Promise<void> {
  if (!server.revocationEndpoint) return
  const token = tokens.refreshToken ?? tokens.accessToken
  await postForm(server.revocationEndpoint, { token, token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token' }, client).catch(() => {})
}

/** Display-only: who the token is for (unverified JWT payload of the access or id token). */
export function accountOf(tokens: TokenSet): string | undefined {
  for (const jwt of [tokens.idToken, tokens.accessToken]) {
    const part = jwt?.split('.')[1]
    if (!part || jwt!.split('.').length !== 3) continue
    try {
      const p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
      const who = p.email ?? p.preferred_username ?? p.name
      if (typeof who === 'string' && who) return who
    } catch {
      /* not a JWT */
    }
  }
  return undefined
}
