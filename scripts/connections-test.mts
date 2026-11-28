// npx tsx scripts/connections-test.mts          (mock OAuth server + MCP server, all local)
// npx tsx scripts/connections-test.mts --live <mcp-url>   (+ OAuth discovery against a real MCP server, no sign-in)
import { fakeBrowser as browser, startMock } from './lib/mock-oauth-mcp.mts'
import { authorize, parseWwwAuthenticate, probe, refresh, accountOf, OAuthError } from '../src/main/connections/oauth'
import { McpAuthError, listTools, openSession } from '../src/main/mcp/client'

let failed = 0
const ok = (c: unknown, m: string) => {
  if (!c) failed++
  console.log(c ? 'PASS' : 'FAIL', m)
}

const { origin, close } = await startMock()

ok(parseWwwAuthenticate('Bearer realm="x", resource_metadata="https://a/b", scope="a b"').resource_metadata === 'https://a/b', 'WWW-Authenticate parsed')

const p = await probe(`${origin}/mcp`)
ok(p.kind === 'oauth', `probe detects OAuth (${p.kind})`)
if (p.kind !== 'oauth') process.exit(1)
ok(p.server.resource === `${origin}/mcp` && p.server.resourceName === 'Mock Jobs', 'resource + name from protected-resource metadata')
ok(p.server.scopes.includes('offline_access'), `scopes ${p.server.scopes.join(' ')}`)
ok(p.server.registrationEndpoint?.endsWith('/register'), 'registration endpoint discovered (RFC 8414 path-aware well-known)')

const { client, tokens } = await authorize({ server: p.server, open: browser })
ok(client.clientId.startsWith('client_') && client.redirectUri.startsWith('http://127.0.0.1:'), 'dynamic client registration with loopback redirect')
ok(tokens.accessToken && tokens.refreshToken && tokens.expiresAt, 'code exchange with PKCE returned tokens')
ok(accountOf(tokens) === 'owner@example.com', 'account read from token')

const s = await openSession(`${origin}/mcp`, { headers: { authorization: `Bearer ${tokens.accessToken}` }, label: 'Mock' })
ok(s.info.instructions === 'Use list_jobs first.', 'server instructions carried through')
const tools = await listTools(s)
ok(tools.length === 2 && tools[0].annotations?.readOnlyHint === true, 'tools listed with annotations')
const called = await s.callTool('save_job', { title: 'x' })
ok(called.content?.[0]?.text === 'called save_job', 'tool call with bearer token')

// Reuse the client on a second sign-in (same port where free; better-auth matches loopback ignoring port).
const again = await authorize({ server: p.server, client, open: browser })
ok(again.client.clientId === client.clientId, 'second sign-in reuses the client registration')

await new Promise((r) => setTimeout(r, 2100))
try {
  await openSession(`${origin}/mcp`, { headers: { authorization: `Bearer ${tokens.accessToken}` } })
  ok(false, 'expired token rejected')
} catch (err) {
  ok(err instanceof McpAuthError && err.status === 401 && err.wwwAuthenticate?.includes('resource_metadata'), 'expired token -> McpAuthError with WWW-Authenticate')
}
const renewed = await refresh(p.server, client, tokens)
ok(renewed.accessToken !== tokens.accessToken && renewed.refreshToken !== tokens.refreshToken, 'refresh rotates tokens')
const s2 = await openSession(`${origin}/mcp`, { headers: { authorization: `Bearer ${renewed.accessToken}` } })
ok((await listTools(s2)).length === 2, 'refreshed token works')
try {
  await refresh(p.server, client, tokens) // old refresh token was rotated away
  ok(false, 'reused refresh token rejected')
} catch (err) {
  ok(err instanceof OAuthError && /invalid_grant/.test(err.message), `reused refresh token -> OAuthError (${(err as Error).message})`)
}

// A cancelled sign-in must not hang.
const ac = new AbortController()
const pending = authorize({ server: p.server, client, open: async () => {}, signal: ac.signal })
ac.abort()
await pending.then(
  () => ok(false, 'abort ends sign-in'),
  (err) => ok(err instanceof OAuthError, 'abort ends sign-in')
)
close()

const liveAt = process.argv.indexOf('--live')
if (liveAt !== -1) {
  const url = process.argv[liveAt + 1]
  if (!url) throw new Error('--live needs an MCP server URL')
  const live = await probe(url)
  ok(live.kind === 'oauth', `live: server offers OAuth (${live.kind})`)
  if (live.kind === 'oauth') {
    ok(live.server.resource === url, `live: resource ${live.server.resource}`)
    ok(!!live.server.issuer, `live: issuer ${live.server.issuer}`)
    ok(!!live.server.registrationEndpoint, 'live: dynamic registration available')
    ok(live.server.scopes.includes('offline_access'), `live: scopes ${live.server.scopes.join(' ')}`)
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
