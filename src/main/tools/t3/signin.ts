import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

/**
 * Signing Jarvis in to T3 Code's `/mcp` endpoint as an "outside agent".
 *
 * T3 Code's supported route for outside agents is MCP OAuth 2.1 (dynamic client
 * registration + PKCE) against its own server, approved with a pairing code. T3 links
 * its own environments to each other the same way, headlessly: register -> post a
 * "pairing-code" decision -> exchange the code. We do exactly that, minting the
 * one-time pairing code through the local `t3 auth pairing create` admin command
 * (the user's own CLI acting on the user's own T3 data directory).
 *
 * The result is a normal T3 MCP client session: labelled "Jarvis" in T3's session list
 * (`t3 auth session list`), revocable there, valid for T3's MCP client TTL (30 days),
 * and limited to `access` (runtime-mode ceiling for anything it starts).
 */

/** T3's MCP access levels; scopes per level come from T3 (read-only => orchestration:read only). */
export type T3Access = 'read-only' | 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'

export const CLIENT_NAME = 'Jarvis'
/** Never actually served: the decision endpoint hands the redirect back to us as JSON. */
const REDIRECT_URI = 'http://127.0.0.1/jarvis-t3-signin'
const HTTP_TIMEOUT_MS = 8000
const CLI_TIMEOUT_MS = 20000

export interface T3Session {
  token: string
  /** Epoch ms. */
  expiresAt: number
  origin: string
  environmentId: string
  access: T3Access
}

function pairingScopes(access: T3Access): string[] {
  if (access === 'read-only') return ['orchestration:read']
  if (access === 'full-access') return ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write']
  return ['orchestration:read', 'orchestration:operate']
}

/** A one-time pairing code (2-minute TTL) carrying only the scopes `access` needs. */
async function mintPairingCode(cli: string, env: NodeJS.ProcessEnv, access: T3Access): Promise<string> {
  const args = ['auth', 'pairing', 'create', '--ttl', '2m', '--label', `${CLIENT_NAME} sign-in`, '--json']
  for (const scope of pairingScopes(access)) args.push('--scope', scope)
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(cli, args, { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, out, errOut) => {
      if (err) reject(new Error(`t3 auth pairing create failed: ${String(errOut || err.message).trim().slice(0, 300)}`))
      else resolve(out)
    })
  })
  const start = stdout.indexOf('{')
  const parsed = start >= 0 ? JSON.parse(stdout.slice(start)) : null
  if (typeof parsed?.credential !== 'string' || !parsed.credential) throw new Error('t3 auth pairing create: no credential in output')
  return parsed.credential
}

const b64url = (buf: Buffer) => buf.toString('base64url')

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* fall through */
  }
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status} ${json?.error_description ?? json?.message ?? ''}`.trim())
  return json
}

/** Full headless sign-in. Throws with a short, secret-free message on failure. */
export async function signIn(opts: {
  cli: string
  env: NodeJS.ProcessEnv
  origin: string
  environmentId: string
  access: T3Access
}): Promise<T3Session> {
  const { origin, access } = opts
  const resource = `${origin}/mcp`

  const registered = await postJson(`${origin}/oauth/mcp/register`, {
    client_name: CLIENT_NAME,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'none'
  })
  const clientId: unknown = registered?.client_id
  if (typeof clientId !== 'string') throw new Error('T3 Code did not register Jarvis as an MCP client')

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const code = await mintPairingCode(opts.cli, opts.env, access)

  const decided = await postJson(`${origin}/oauth/mcp/decision`, {
    authorization: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource
    },
    decision: { _tag: 'pairing-code', access, code }
  })
  const redirect = typeof decided?.redirectTo === 'string' ? URL.parse(decided.redirectTo) : null
  const authCode = redirect?.searchParams.get('code')
  if (!redirect || !authCode || redirect.searchParams.get('state') !== state)
    throw new Error(`T3 Code did not approve the sign-in: ${redirect?.searchParams.get('error_description') ?? 'unknown reason'}`)

  const res = await fetch(`${origin}/oauth/mcp/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const token = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error_description?: string } | null
  if (!res.ok || typeof token?.access_token !== 'string')
    throw new Error(`T3 Code refused the token exchange: HTTP ${res.status} ${token?.error_description ?? ''}`.trim())

  const ttlSec = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 30 * 24 * 3600
  return {
    token: token.access_token,
    expiresAt: Date.now() + ttlSec * 1000,
    origin,
    environmentId: opts.environmentId,
    access
  }
}

/**
 * Revokes Jarvis's T3 sessions (all MCP-client sessions labelled "Jarvis") through the
 * local `t3 auth session` admin commands. Best effort; returns how many were revoked.
 */
export async function revokeJarvisSessions(cli: string, env: NodeJS.ProcessEnv): Promise<number> {
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(cli, args, { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, out) => (err ? reject(err) : resolve(out)))
    )
  const out = await run(['auth', 'session', 'list', '--json'])
  const start = out.indexOf('[')
  const sessions = start >= 0 ? (JSON.parse(out.slice(start)) as Array<{ sessionId?: string; subject?: string; client?: { label?: string } }>) : []
  let n = 0
  for (const s of sessions) {
    if (s.subject !== 'mcp-client' || s.client?.label !== CLIENT_NAME || !s.sessionId) continue
    await run(['auth', 'session', 'revoke', s.sessionId]).then(() => n++, () => {})
  }
  return n
}
