import { getSecret, setSecret } from '../secrets'
import type { ToolContext, ToolContribution } from './index'
import { findCli, findLiveServer } from './t3/discovery'
import { probeTools, T3AuthError, type McpTool } from './t3/mcp'
import { revokeJarvisSessions, signIn, type T3Access, type T3Session } from './t3/signin'

/**
 * T3 Code as a tool for Jarvis's agents.
 *
 * T3 Code serves MCP at `<origin>/mcp` (streamable HTTP, bearer auth) for "outside
 * agents". Jarvis signs in once through T3's own OAuth flow (see t3/signin.ts), keeps
 * the 30-day token encrypted with the OS keychain, and hands the agent CLIs a plain
 * HTTP MCP server. The token is never written to the repo or logged.
 */

const SERVER = 't3'
const SECRET = 't3.mcpSession'
/** How long one answer (including "not available") is reused across runs. */
const CACHE_MS = 60_000
const CACHE_NULL_MS = 20_000
/** How often the token is re-checked against the server (initialize + tools/list, ~10 ms). */
const VALIDATE_MS = 10 * 60_000
/** Re-sign-in this long before the token expires. */
const RENEW_BEFORE_MS = 2 * 24 * 3600_000
/** After a failed sign-in, don't mint another pairing code for this long. */
const SIGNIN_BACKOFF_MS = 5 * 60_000
const DEFAULT_ACCESS: T3Access = 'approval-required'

/**
 * Pre-approved (read-only) tools. Only those the server actually lists and doesn't flag
 * destructive. Launching, sending, interrupting, configuring, deleting stay behind approval.
 * t3_thread_read is idempotent and non-destructive (T3 doesn't flag it read-only,
 * presumably because reading marks the thread as seen).
 */
const READ_ONLY = new Set([
  'orchestrator_capabilities',
  't3_project_list',
  't3_project_read',
  't3_thread_list',
  't3_thread_read',
  't3_thread_search',
  't3_thread_wait',
  't3_environment_read',
  't3_worktree_list',
  'list_scheduled_tasks',
  'list_thread_pull_requests',
  'read_pull_request_guide'
])

const HINT =
  "T3 Code tools (MCP server `t3`): the user's T3 Code app runs coding-agent threads per project. " +
  'Use t3_project_list, t3_thread_list, t3_thread_search and t3_thread_read to see what is going on there or check on a thread. ' +
  'When the user wants a substantial coding task handed off to T3, start it with t3_thread_launch in the right project ' +
  '(or t3_thread_send to an existing thread), then follow it with t3_thread_read / t3_thread_wait. ' +
  'You are not inside a T3 thread, so pass a projectId (from t3_project_list) or allProjects: true where a tool asks for a target. ' +
  "Only reach for these when the user mentions T3 or wants work delegated or checked there; don't launch threads unasked."

interface Connection {
  url: string
  token: string
  tools: McpTool[]
}

let cache: { at: number; value: Connection | null } | null = null
let inflight: Promise<Connection | null> | null = null
let session: T3Session | null = null
let validated: { at: number; origin: string; tools: McpTool[] } | null = null
let lastSignInFailure = 0

async function loadSession(): Promise<T3Session | null> {
  if (session) return session
  try {
    const raw = await getSecret(SECRET)
    if (raw) session = JSON.parse(raw) as T3Session
  } catch {
    session = null
  }
  return session
}

async function saveSession(next: T3Session | null, log: (m: string) => void) {
  session = next
  try {
    await setSecret(SECRET, next ? JSON.stringify(next) : null)
  } catch (err) {
    // No OS encryption: keep it in memory only (re-sign-in next launch revokes the old one).
    log(`T3 Code: token kept in memory only (${String(err)})`)
  }
}

async function connect(env: NodeJS.ProcessEnv, access: T3Access, log: (m: string) => void): Promise<Connection | null> {
  const server = await findLiveServer(env)
  if (!server) return null
  const url = `${server.origin}/mcp`

  let current = await loadSession()
  if (current && (current.environmentId !== server.environmentId || current.access !== access || current.expiresAt - Date.now() < RENEW_BEFORE_MS)) {
    current = null
    validated = null
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!current) {
      if (Date.now() - lastSignInFailure < SIGNIN_BACKOFF_MS) return null
      const cli = await findCli(env)
      if (!cli) return null
      try {
        // Keep exactly one Jarvis session in T3: drop stale/rejected ones before minting a new one.
        await revokeJarvisSessions(cli, env).catch(() => 0)
        current = await signIn({ cli, env, origin: server.origin, environmentId: server.environmentId, access })
        await saveSession(current, log)
        validated = null
        log(`T3 Code: signed in to ${server.origin} as "Jarvis" (${access})`)
      } catch (err) {
        lastSignInFailure = Date.now()
        // Surfaces once in the run log (collectTools); the backoff keeps later runs quiet.
        throw new Error(`T3 Code sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (validated && validated.origin === server.origin && Date.now() - validated.at < VALIDATE_MS)
      return { url, token: current.token, tools: validated.tools }

    try {
      const tools = await probeTools(url, current.token)
      validated = { at: Date.now(), origin: server.origin, tools }
      return { url, token: current.token, tools }
    } catch (err) {
      if (err instanceof T3AuthError) {
        // Revoked in T3 or its data was reset: sign in again once.
        await saveSession(null, log)
        current = null
        validated = null
        continue
      }
      throw new Error(`T3 Code not reachable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return null
}

function contribution(conn: Connection): ToolContribution {
  const allowedTools = conn.tools
    .filter((t) => READ_ONLY.has(t.name) && t.annotations?.destructiveHint !== true)
    .map((t) => `mcp__${SERVER}__${t.name}`)
  return {
    servers: { [SERVER]: { type: 'http', url: conn.url, headers: { Authorization: `Bearer ${conn.token}` } } },
    allowedTools,
    hint: HINT
  }
}

export async function t3Tools(ctx: ToolContext): Promise<ToolContribution | null> {
  if (!ctx.settings.t3Tools || ctx.req.provider === 'ollama') return null
  const now = Date.now()
  if (cache && now - cache.at < (cache.value ? CACHE_MS : CACHE_NULL_MS)) return cache.value && contribution(cache.value)

  const access = (ctx.settings as { t3Access?: T3Access }).t3Access ?? DEFAULT_ACCESS
  inflight ??= connect(ctx.env, access, (m) => console.log(`[t3] ${m}`)).finally(() => {
    inflight = null
  })
  try {
    const value = await inflight
    cache = { at: Date.now(), value }
    return value && contribution(value)
  } catch (err) {
    cache = { at: Date.now(), value: null }
    throw err
  }
}

/**
 * The signed-in T3 MCP endpoint for Jarvis's own background reads (knowledge sync), sharing the
 * agents' session and cache. null when T3 tools are off or T3 isn't running.
 */
export async function t3Endpoint(env: NodeJS.ProcessEnv, settings: ToolContext['settings']): Promise<{ url: string; token: string } | null> {
  if (!settings.t3Tools) return null
  const now = Date.now()
  if (cache && now - cache.at < (cache.value ? CACHE_MS : CACHE_NULL_MS)) return cache.value && { url: cache.value.url, token: cache.value.token }
  const access = (settings as { t3Access?: T3Access }).t3Access ?? DEFAULT_ACCESS
  inflight ??= connect(env, access, (m) => console.log(`[t3] ${m}`)).finally(() => {
    inflight = null
  })
  try {
    const value = await inflight
    cache = { at: Date.now(), value }
    return value && { url: value.url, token: value.token }
  } catch (err) {
    cache = { at: Date.now(), value: null }
    throw err
  }
}

/** Revoke Jarvis's T3 session and forget the token (e.g. when the user turns `t3Tools` off). */
export async function disconnectT3(env: NodeJS.ProcessEnv): Promise<void> {
  cache = null
  validated = null
  await saveSession(null, () => {})
  const cli = await findCli(env)
  if (cli) await revokeJarvisSessions(cli, env).catch(() => 0)
}
