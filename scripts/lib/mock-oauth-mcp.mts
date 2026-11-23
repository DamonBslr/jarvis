// Local OAuth 2.1 authorization server + protected MCP resource on one origin, for connection tests.
// Approves every authorization instantly; access tokens live 2 s so refresh paths get exercised.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export async function startMock() {
  const body = async (req: IncomingMessage) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw
  }
  const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(data))

  // ---- mock authorization server + protected MCP resource on one origin --------------------------------
  const clients = new Map<string, { redirect: string }>()
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string; resource: string }>()
  const access = new Map<string, { exp: number }>()
  const refreshTokens = new Set<string>()
  let origin = ''
  let issued = 0
  const jwt = (email: string) =>
    `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ email, n: issued++ })).toString('base64url')}.sig`

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin)
    const issuer = `${origin}/api/auth`
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [issuer], scopes_supported: ['openid', 'email', 'offline_access'], resource_name: 'Mock Jobs' })
    if (url.pathname === '/.well-known/oauth-authorization-server/api/auth')
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        scopes_supported: ['openid', 'email', 'offline_access'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true
      })
    if (url.pathname === '/api/auth/register') {
      const b = JSON.parse(await body(req))
      const id = 'client_' + randomBytes(4).toString('hex')
      clients.set(id, { redirect: b.redirect_uris[0] })
      return json(res, 201, { client_id: id, client_name: b.client_name })
    }
    if (url.pathname === '/api/auth/authorize') {
      // The "user" approves instantly: redirect back with a code.
      const p = url.searchParams
      const client = clients.get(p.get('client_id')!)
      const redirect = p.get('redirect_uri')!
      const sameLoopback = client && new URL(client.redirect).pathname === new URL(redirect).pathname
      if (!sameLoopback || p.get('code_challenge_method') !== 'S256' || p.get('resource') !== `${origin}/mcp`)
        return json(res, 400, { error: 'invalid_request' })
      const code = randomBytes(8).toString('hex')
      codes.set(code, { clientId: p.get('client_id')!, challenge: p.get('code_challenge')!, redirect, resource: p.get('resource')! })
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', p.get('state')!)
      back.searchParams.set('iss', issuer)
      return res.writeHead(302, { location: back.toString() }).end()
    }
    if (url.pathname === '/api/auth/token') {
      const f = new URLSearchParams(await body(req))
      const mint = () => {
        const token = jwt('owner@example.com')
        access.set(token, { exp: Date.now() + 2000 })
        const rt = 'rt_' + randomBytes(6).toString('hex')
        refreshTokens.add(rt)
        return { access_token: token, token_type: 'Bearer', expires_in: 2, refresh_token: rt, scope: 'openid email offline_access' }
      }
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code')!)
        codes.delete(f.get('code')!)
        const challenge = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url')
        if (!c || c.challenge !== challenge || c.redirect !== f.get('redirect_uri') || c.clientId !== f.get('client_id'))
          return json(res, 400, { error: 'invalid_grant' })
        return json(res, 200, mint())
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (!refreshTokens.delete(f.get('refresh_token')!)) return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' })
        return json(res, 200, mint())
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (url.pathname === '/mcp') {
      const token = req.headers.authorization?.replace(/^Bearer /, '')
      const a = token && access.get(token)
      if (!a || a.exp < Date.now())
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` })
      const msg = JSON.parse(await body(req))
      if (msg.id === undefined) return res.writeHead(202).end()
      if (msg.method === 'initialize')
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-jobs' }, instructions: 'Use list_jobs first.' } })
      if (msg.method === 'tools/list')
        return json(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              { name: 'list_jobs', description: 'list', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
              { name: 'save_job', description: 'save', inputSchema: { type: 'object' } }
            ]
          }
        })
      if (msg.method === 'tools/call') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `called ${msg.params.name}` }] } })
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, close: () => server.close(), stats: () => ({ issued, clients: clients.size }) }
}

/** Plays the user's browser: follows the authorization URL and its redirect to the loopback listener. */
export async function fakeBrowser(u: string) {
  const r = await fetch(u, { redirect: 'manual' })
  const loc = r.headers.get('location')
  if (!loc) throw new Error(`authorize returned ${r.status}`)
  void fetch(loc).then((x) => x.text())
}
