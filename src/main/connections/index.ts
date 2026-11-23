import type {
  ApprovalDecision,
  ApprovalRequest,
  Connection,
  ConnectionPolicy,
  ConnectionProbe,
  ConnectionStatus,
  NewConnection,
  RunRequest
} from '@shared/types'
import { McpAuthError, McpSessionExpired, listTools, openSession, type McpSession, type McpTool } from '../mcp/client'
import { bridgeLaunch } from '../mcp/server'
import type { ToolContext, ToolContribution } from '../tools'
import { openBrowserLogin } from './browserLogin'
import { accountOf, authorize, OAuthError, probe, refresh, revoke, type AuthServer } from './oauth'
import * as store from './store'

/**
 * Connections: services the user gave Jarvis lasting access to (see store.ts for what is kept where).
 *
 * Remote MCP connections are proxied. Agent CLIs get one stdio bridge per connection (server name = the
 * connection id, so tools read `mcp__shortlist__save_job_search_record`); each call comes back to this
 * main process, which holds the live MCP session, adds the credentials, refreshes OAuth tokens and enforces
 * the connection's policy. Tokens never appear in CLI arguments, environment variables or the agent's context.
 *
 * Policy, enforced here for every engine:
 *  - read:  only tools the server marks read-only (readOnlyHint) are listed or callable
 *  - ask:   other tools need an approval popup each time (denied in unattended routines)
 *  - auto:  other tools run on their own
 * "Ask" (read-only) runs only ever see read-only tools.
 */

const TOOLS_TTL_MS = 60_000
const CALL_TIMEOUT_MS = 5 * 60_000
const REFRESH_EARLY_MS = 60_000

type Ask = (toolName: string, input: unknown, connect?: ApprovalRequest['connect']) => Promise<ApprovalDecision>

let changed: () => void = () => {}
/** Called whenever connections or their state change (the UI refreshes). */
export function onConnectionsChanged(cb: () => void) {
  changed = cb
}

// ---- per-run access ------------------------------------------------------------------------------

const runAccess = new Map<string, { autonomy: RunRequest['autonomy']; interactive: boolean }>()
function setRunAccess(runId: string, access: { autonomy: RunRequest['autonomy']; interactive: boolean }) {
  runAccess.delete(runId)
  runAccess.set(runId, access)
  if (runAccess.size > 64) runAccess.delete(runAccess.keys().next().value as string)
}

// ---- credentials -----------------------------------------------------------------------------------

export class NeedsAuth extends Error {
  constructor(conn: Connection, why?: string) {
    super(
      `${conn.name} needs the user to sign in again${why ? ` (${why})` : ''}: Jarvis → Settings → Connections → Reconnect.`
    )
  }
}

const refreshing = new Map<string, Promise<string>>()

async function oauthAccessToken(conn: Connection, force: boolean): Promise<string> {
  const creds = await store.getCredentials(conn.id)
  if (!creds || creds.kind !== 'oauth') throw new NeedsAuth(conn, 'not signed in')
  const fresh = !creds.tokens.expiresAt || creds.tokens.expiresAt - Date.now() > REFRESH_EARLY_MS
  if (fresh && !force) return creds.tokens.accessToken
  let p = refreshing.get(conn.id)
  if (!p) {
    p = (async () => {
      try {
        const tokens = await refresh(creds.server, creds.client, creds.tokens)
        await store.setCredentials(conn.id, { ...creds, tokens, account: accountOf(tokens) ?? creds.account })
        return tokens.accessToken
      } catch (err) {
        if (err instanceof OAuthError) throw new NeedsAuth(conn, err.message)
        throw err
      }
    })().finally(() => refreshing.delete(conn.id))
    refreshing.set(conn.id, p)
  }
  return p
}

async function authHeaders(conn: Connection, force = false): Promise<Record<string, string>> {
  if (conn.kind === 'open') return {}
  if (conn.kind === 'oauth') return { authorization: `Bearer ${await oauthAccessToken(conn, force)}` }
  const creds = await store.getCredentials(conn.id)
  if (!creds || creds.kind !== 'token') throw new NeedsAuth(conn, 'no API key saved')
  return tokenHeader(conn.header, creds.token)
}

function tokenHeader(header: string | undefined, token: string): Record<string, string> {
  const name = (header || 'Authorization').trim()
  const value = name.toLowerCase() === 'authorization' && !/\s/.test(token.trim()) ? `Bearer ${token.trim()}` : token.trim()
  return { [name]: value }
}

// ---- live MCP sessions -----------------------------------------------------------------------------

const sessions = new Map<string, Promise<McpSession>>()
const toolCache = new Map<string, { at: number; tools: McpTool[]; instructions?: string }>()

function dropSession(id: string) {
  const s = sessions.get(id)
  sessions.delete(id)
  void s?.then((x) => x.close()).catch(() => {})
}

function forget(id: string) {
  dropSession(id)
  toolCache.delete(id)
}

async function getSession(conn: Connection, force = false): Promise<McpSession> {
  let s = sessions.get(conn.id)
  if (!s) {
    s = authHeaders(conn, force).then((headers) => openSession(conn.url, { headers, label: conn.name }))
    sessions.set(conn.id, s)
    s.catch(() => {
      if (sessions.get(conn.id) === s) sessions.delete(conn.id)
    })
  }
  return s
}

/** Run against the connection's session, healing once: expired session, refreshed token, dropped socket. */
async function withSession<T>(conn: Connection, fn: (s: McpSession) => Promise<T>): Promise<T> {
  try {
    return await fn(await getSession(conn))
  } catch (err) {
    const auth = err instanceof McpAuthError
    const retry = auth || err instanceof McpSessionExpired || (err instanceof TypeError && /fetch/i.test(err.message))
    if (!retry) throw err
    dropSession(conn.id)
    if (auth && conn.kind !== 'oauth') throw new NeedsAuth(conn, conn.kind === 'token' ? 'the API key was rejected' : undefined)
    try {
      return await fn(await getSession(conn, auth))
    } catch (again) {
      dropSession(conn.id)
      if (again instanceof McpAuthError) throw new NeedsAuth(conn, 'access was rejected')
      throw again
    }
  }
}

async function remoteTools(conn: Connection, force = false) {
  const hit = toolCache.get(conn.id)
  if (hit && !force && Date.now() - hit.at < TOOLS_TTL_MS) return hit
  const result = await withSession(conn, async (s) => ({ at: Date.now(), tools: await listTools(s), instructions: s.info.instructions }))
  toolCache.set(conn.id, result)
  return result
}

const isReadOnly = (t: McpTool) => t.annotations?.readOnlyHint === true

function writesVisible(policy: ConnectionPolicy, autonomy: RunRequest['autonomy']) {
  return policy !== 'read' && autonomy !== 'ask'
}

// ---- bridge endpoints (agent side) --------------------------------------------------------------------

async function requireConn(runId: string, id: string) {
  const access = runAccess.get(runId)
  if (!access) throw new Error('Connections are not enabled for this run.')
  const conn = await store.getConnection(id)
  if (!conn || conn.kind === 'browser') throw new Error(`No connection "${id}". It may have been removed in Jarvis.`)
  return { conn, access }
}

/** Server instructions to forward in the bridge's `initialize` (best effort). */
export async function proxyInit(runId: string, id: string): Promise<{ instructions?: string }> {
  const { conn } = await requireConn(runId, id)
  try {
    return { instructions: (await remoteTools(conn)).instructions }
  } catch {
    return {}
  }
}

/** Tool definitions this run may see for a connection. */
export async function proxyList(runId: string, id: string) {
  const { conn, access } = await requireConn(runId, id)
  const { tools } = await remoteTools(conn)
  const writes = writesVisible(conn.policy, access.autonomy)
  return tools
    .filter((t) => writes || isReadOnly(t))
    .map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      ...(t.annotations ? { annotations: t.annotations } : {})
    }))
}

export async function proxyCall(runId: string, id: string, name: string, args: Record<string, unknown>, ask: Ask) {
  const { conn, access } = await requireConn(runId, id)
  let tool = (await remoteTools(conn)).tools.find((t) => t.name === name)
  if (!tool) tool = (await remoteTools(conn, true)).tools.find((t) => t.name === name)
  if (!tool) throw new Error(`${conn.name} has no tool "${name}"`)
  const entry = { at: Date.now(), connection: conn.id, tool: name, runId }

  if (!isReadOnly(tool)) {
    if (!writesVisible(conn.policy, access.autonomy)) {
      void store.audit({ ...entry, outcome: 'denied', detail: 'read-only' })
      throw new Error(
        conn.policy === 'read'
          ? `${conn.name} is read-only for agents (the user can change that in Jarvis → Settings → Connections).`
          : 'This run is read-only.'
      )
    }
    if (conn.policy === 'ask') {
      const decision = await ask(`mcp__${conn.id}__${name}`, args)
      if (decision.behavior !== 'allow') {
        void store.audit({ ...entry, outcome: 'denied', detail: decision.message })
        throw new Error(decision.message || 'The user denied this action.')
      }
    }
  }

  try {
    const result = await withSession(conn, (s) => s.callTool(name, args, CALL_TIMEOUT_MS))
    let content = Array.isArray(result?.content) ? result.content : []
    if (!content.length && result?.structuredContent !== undefined)
      content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }]
    void store.audit({ ...entry, outcome: result?.isError ? 'error' : 'ok' })
    void store.touch(conn.id).then(() => changed())
    return { mcpContent: content, isError: result?.isError === true }
  } catch (err) {
    void store.audit({ ...entry, outcome: 'error', detail: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    if (err instanceof NeedsAuth) changed()
    throw err
  }
}

// ---- status / management (UI side) ---------------------------------------------------------------------

async function statusOf(conn: Connection, force = false): Promise<ConnectionStatus> {
  if (conn.kind === 'browser') return { ...conn, state: 'connected', detail: "Logged in through Jarvis's browser" }
  const creds = await store.getCredentials(conn.id)
  const meta =
    creds?.kind === 'oauth'
      ? { account: creds.account, issuer: creds.server.issuer, expiresAt: creds.tokens.expiresAt }
      : {}
  try {
    const { tools } = await Promise.race([
      remoteTools(conn, force),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 12_000))
    ])
    return { ...conn, ...meta, state: 'connected', tools: tools.map((t) => ({ name: t.name, readOnly: isReadOnly(t) })) }
  } catch (err) {
    return {
      ...conn,
      ...meta,
      state: err instanceof NeedsAuth ? 'needs-auth' : 'error',
      detail: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function connectionStatuses(): Promise<ConnectionStatus[]> {
  return Promise.all((await store.listConnections()).map((c) => statusOf(c)))
}

function checkUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new Error('Enter a full URL, e.g. https://example.com/mcp')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('Use an https:// URL')
  u.hash = ''
  return u.toString()
}

export async function probeConnection(url: string): Promise<ConnectionProbe> {
  const r = await probe(checkUrl(url))
  if (r.kind === 'oauth') return { kind: 'oauth', name: r.server.resourceName, issuer: new URL(r.server.issuer).host }
  return { kind: r.kind, name: r.name }
}

type Opener = (url: string) => Promise<void>

/** Sign in with OAuth, reusing an earlier client registration for the same server. */
async function signIn(id: string, server: AuthServer, open: Opener) {
  const previous = await store.getCredentials(id)
  const client = previous?.kind === 'oauth' && previous.server.issuer === server.issuer ? previous.client : undefined
  const { client: c, tokens } = await authorize({ server, client, open })
  await store.setCredentials(id, { kind: 'oauth', server, client: c, tokens, account: accountOf(tokens) })
}

async function validateToken(url: string, header: string | undefined, token: string, label: string) {
  try {
    const s = await openSession(url, { headers: tokenHeader(header, token), label })
    await s.close()
  } catch (err) {
    if (err instanceof McpAuthError) throw new Error(`${label} rejected that key`)
    throw err
  }
}

export async function addConnection(input: NewConnection, open: Opener): Promise<ConnectionStatus> {
  const url = checkUrl(input.url)
  const policy: ConnectionPolicy = input.policy ?? 'ask'
  const all = await store.listConnections()

  if (input.kind === 'browser') {
    const name = input.name?.trim() || new URL(url).host.replace(/^www\./, '')
    const existing = all.find((c) => c.kind === 'browser' && c.url === url)
    const conn: Connection = existing ?? { id: await store.freeId(name), name, kind: 'browser', url, policy, notes: input.notes, createdAt: Date.now() }
    await store.saveConnection(conn)
    changed()
    return statusOf(conn)
  }

  const probed = input.kind && input.kind !== 'oauth' ? null : await probe(url)
  const kind = input.kind ?? probed!.kind
  const suggested = probed?.kind === 'oauth' ? probed.server.resourceName : probed?.name
  const name = input.name?.trim() || suggested || new URL(url).host.replace(/^www\./, '')
  const existing = all.find((c) => c.url === url && c.kind !== 'browser')
  const id = existing?.id ?? (await store.freeId(name))

  // Authenticate before saving anything, so a cancelled sign-in leaves no half-made connection.
  if (kind === 'oauth') {
    if (probed?.kind !== 'oauth') throw new Error('This server does not offer OAuth sign-in; add it with an API key')
    await signIn(id, probed.server, open)
  } else if (kind === 'token') {
    if (!input.token?.trim()) throw new Error('This server needs an API key or token')
    await validateToken(url, input.header, input.token, name)
    await store.setCredentials(id, { kind: 'token', token: input.token.trim() })
  }

  const conn: Connection = {
    ...(existing ?? { createdAt: Date.now() }),
    id,
    name: existing?.name ?? name,
    kind,
    url,
    policy: existing?.policy ?? policy,
    header: kind === 'token' ? input.header?.trim() || undefined : undefined,
    notes: input.notes ?? existing?.notes
  }
  await store.saveConnection(conn)
  forget(id)
  changed()
  return statusOf(conn, true)
}

export async function updateConnection(id: string, patch: Partial<Pick<Connection, 'name' | 'policy' | 'notes'>>) {
  const conn = await store.getConnection(id)
  if (!conn) throw new Error('Connection not found')
  const next = { ...conn }
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 60)
  if (patch.policy === 'read' || patch.policy === 'ask' || patch.policy === 'auto') next.policy = patch.policy
  if (typeof patch.notes === 'string') next.notes = patch.notes.slice(0, 500) || undefined
  await store.saveConnection(next)
  changed()
}

export async function reconnect(id: string, open: Opener, token?: string): Promise<ConnectionStatus> {
  const conn = await store.getConnection(id)
  if (!conn) throw new Error('Connection not found')
  forget(id)
  if (conn.kind === 'oauth') {
    const r = await probe(conn.url)
    if (r.kind !== 'oauth') throw new Error('The server no longer offers OAuth sign-in')
    await signIn(id, r.server, open)
  } else if (conn.kind === 'token') {
    if (!token?.trim()) throw new Error('Enter the new API key')
    await validateToken(conn.url, conn.header, token, conn.name)
    await store.setCredentials(id, { kind: 'token', token: token.trim() })
  }
  changed()
  return statusOf(conn, true)
}

export async function removeConnection(id: string) {
  const creds = await store.getCredentials(id)
  forget(id)
  if (creds?.kind === 'oauth') await revoke(creds.server, creds.client, creds.tokens)
  await store.deleteConnection(id)
  changed()
}

export async function openConnectionBrowser(id: string, env: NodeJS.ProcessEnv) {
  const conn = await store.getConnection(id)
  if (!conn) throw new Error('Connection not found')
  openBrowserLogin(conn.url, env)
}

export const readAudit = store.readAudit

// ---- jarvis bridge tools: the agent sets up access with the user -----------------------------------------

export async function agentListConnections(): Promise<string> {
  const all = await connectionStatuses()
  if (!all.length) return 'No connections yet. Use connect_service to set one up with the user.'
  return all
    .map((c) =>
      c.kind === 'browser'
        ? `- ${c.name}: browser login at ${c.url} (use the \`browser\` tool; it is signed in there)`
        : `- ${c.name}: MCP server \`${c.id}\` at ${c.url} — ${c.state}${c.account ? `, acting as ${c.account}` : ''}, policy ${c.policy}` +
          (c.tools ? `, ${c.tools.length} tools` : '') +
          (c.state !== 'connected' && c.detail ? ` (${c.detail})` : '')
    )
    .join('\n')
}

export async function agentConnect(
  args: { url?: unknown; name?: unknown; kind?: unknown; reason?: unknown },
  ctx: { runId: string; ask: Ask; open: Opener; env: NodeJS.ProcessEnv }
): Promise<string> {
  if (!runAccess.get(ctx.runId)?.interactive) throw new Error('Connecting a service needs the user at the Jarvis window; ask them later.')
  const url = checkUrl(String(args.url ?? ''))
  const givenName = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : undefined
  const input = { url, name: givenName, reason: typeof args.reason === 'string' ? args.reason.slice(0, 300) : undefined }

  if (args.kind === 'browser') {
    const name = givenName ?? new URL(url).host.replace(/^www\./, '')
    const d = await ctx.ask('mcp__jarvis__connect_service', input, {
      name,
      url,
      kind: 'browser',
      action: "Opens the site in Jarvis's browser so you can log in. Agents reuse that login later."
    })
    if (d.behavior !== 'allow') throw new Error(d.message || 'The user declined.')
    const status = await addConnection({ url, name, kind: 'browser' }, ctx.open)
    openBrowserLogin(url, ctx.env)
    return (
      `Opened ${url} in the Jarvis browser and saved "${status.name}" as a browser login. ` +
      'The user is logging in there now; wait for them to confirm. Afterwards your `browser` tool (in this and later runs) is signed in.'
    )
  }

  const r = await probe(url)
  const suggested = r.kind === 'oauth' ? r.server.resourceName : r.name
  const name = givenName ?? suggested ?? new URL(url).host.replace(/^www\./, '')

  let decision: ApprovalDecision
  if (r.kind === 'oauth') {
    decision = await ctx.ask('mcp__jarvis__connect_service', input, {
      name,
      url,
      kind: 'oauth',
      action: `Your browser opens to sign in on ${new URL(r.server.issuer).host} and approve "Jarvis". Tokens are kept in the macOS keychain.`
    })
  } else if (r.kind === 'token') {
    decision = await ctx.ask('mcp__jarvis__connect_service', input, {
      name,
      url,
      kind: 'token',
      action: 'This server needs an API key or token. It goes into the keychain vault; the agent never sees it.',
      secretLabel: 'API key or token'
    })
  } else {
    decision = await ctx.ask('mcp__jarvis__connect_service', input, {
      name,
      url,
      kind: 'open',
      action: 'This MCP server needs no sign-in.'
    })
  }
  if (decision.behavior !== 'allow') throw new Error(decision.message || 'The user declined.')

  const status = await addConnection(
    { url, name, kind: r.kind, token: decision.secret },
    ctx.open
  )
  if (status.state !== 'connected') throw new Error(`Saved, but it does not work yet: ${status.detail ?? status.state}`)
  const tools = status.tools ?? []
  return (
    `Connected "${status.name}" as MCP server \`${status.id}\`${status.account ? `, acting as ${status.account}` : ''}. ` +
    `${tools.length} tools: ${tools.map((t) => t.name).join(', ') || 'none'}. Policy: ${status.policy} (writes ${status.policy === 'auto' ? 'run without asking' : status.policy === 'ask' ? 'ask the user first' : 'are blocked'}). ` +
    'The tools become available to you from the user\'s next message (this run started before the connection existed).'
  )
}

// ---- capability: what a run gets ------------------------------------------------------------------------

const CONNECT_HINT =
  'Connections: to get lasting access to a service the user uses (their own apps, a SaaS with an MCP endpoint, or a website without an API), ' +
  'call `connect_service` (jarvis MCP server) with its MCP URL, or kind "browser" with the site URL; the user approves and signs in, and the vault keeps the access. ' +
  'Never ask the user to paste passwords, API keys or tokens into the chat.'

export async function connectionTools(ctx: ToolContext): Promise<ToolContribution | null> {
  if (ctx.req.provider === 'ollama') return null
  const conns = await store.listConnections()
  setRunAccess(ctx.req.runId, { autonomy: ctx.req.autonomy, interactive: ctx.interactive })

  const mcp = conns.filter((c) => c.kind !== 'browser')
  const sites = conns.filter((c) => c.kind === 'browser')
  const lines: string[] = []
  for (const c of mcp) {
    const creds = c.kind === 'oauth' ? await store.getCredentials(c.id).catch(() => null) : null
    const account = creds?.kind === 'oauth' && creds.account ? `, acting as the user's account ${creds.account}` : ''
    const writes = !writesVisible(c.policy, ctx.req.autonomy)
      ? 'read-only here'
      : c.policy === 'ask'
        ? 'writes ask the user first'
        : 'writes allowed'
    lines.push(`- \`${c.id}\`: ${c.name} (${c.url}${account}; ${writes})${c.notes ? ` — ${c.notes}` : ''}`)
  }
  if (sites.length && ctx.settings.browserTool)
    lines.push(`- Jarvis's browser is logged in to: ${sites.map((s) => `${s.name} (${s.url})`).join(', ')}`)

  const hint = [
    lines.length
      ? "Connected services you can use with the user's access (MCP servers named after the connection; use them when relevant):\n" + lines.join('\n')
      : '',
    ctx.interactive ? CONNECT_HINT : ''
  ]
    .filter(Boolean)
    .join('\n')

  return {
    servers: Object.fromEntries(mcp.map((c) => [c.id, bridgeLaunch(ctx.req.runId, [], c.id)])),
    // Policy is enforced in the main process (proxyCall), so Claude must not prompt a second time.
    allowedTools: mcp.map((c) => `mcp__${c.id}`),
    hint: hint || undefined
  }
}
