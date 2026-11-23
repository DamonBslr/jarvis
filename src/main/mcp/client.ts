/**
 * Just enough of an MCP streamable-HTTP client for Jarvis's main process: T3 Code token checks and
 * the connection proxy (remote MCP servers the user connected). POSTs JSON-RPC, accepts JSON or SSE
 * replies, answers server pings, carries the mcp-session-id and DELETEs the session at the end.
 */

const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_TIMEOUT_MS = 15_000

/** The server rejected the credentials (HTTP 401/403). */
export class McpAuthError extends Error {
  constructor(
    readonly status: number,
    readonly label = 'MCP server',
    /** Raw WWW-Authenticate header, if any (carries resource_metadata / scope hints). */
    readonly wwwAuthenticate: string | null = null
  ) {
    super(`${label} rejected the credentials (HTTP ${status})`)
  }
}

/** The server forgot our session (HTTP 404 with an mcp-session-id): open a new one. */
export class McpSessionExpired extends Error {}

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: object
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string }
}

type Envelope = { jsonrpc?: string; id?: string | number; method?: string; result?: any; error?: any }

function parseBody(contentType: string, text: string): Envelope[] {
  if (!text.trim()) return []
  const out: Envelope[] = []
  const push = (value: unknown) => {
    for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === 'object') out.push(v as Envelope)
  }
  if (contentType.includes('text/event-stream')) {
    // SSE: events separated by blank lines; data lines concatenated.
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) {
        try {
          push(JSON.parse(data))
        } catch {
          /* ignore non-JSON events */
        }
      }
    }
  } else {
    push(JSON.parse(text))
  }
  return out
}

export interface McpSession {
  /** What the server said about itself in `initialize`. */
  readonly info: { name?: string; version?: string; instructions?: string }
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any>
  close(): Promise<void>
}

export interface OpenOptions {
  /** Extra request headers, e.g. `{ authorization: 'Bearer …' }`. */
  headers?: Record<string, string>
  clientName?: string
  /** Used in error messages ("T3 Code", "Shortlist"…). */
  label?: string
}

/** Opens (initialize + initialized) an MCP session; throws McpAuthError on 401/403. */
export async function openSession(endpoint: string, opts: OpenOptions = {}): Promise<McpSession> {
  const label = opts.label ?? 'MCP server'
  let sessionId: string | null = null
  let protocolVersion: string | null = null
  let nextId = 0

  const headers = () => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(opts.headers ?? {}),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
  })

  const send = async (message: Envelope, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Envelope[]> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(message),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const hadSession = !!sessionId
    sessionId = res.headers.get('mcp-session-id') ?? sessionId
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel()
      throw new McpAuthError(res.status, label, res.headers.get('www-authenticate'))
    }
    if (res.status === 404 && hadSession) {
      await res.body?.cancel()
      throw new McpSessionExpired(`${label}: session expired`)
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`${label} responded with HTTP ${res.status}`)
    }
    const payloads = parseBody(res.headers.get('content-type') ?? '', await res.text())
    const replies: Envelope[] = []
    for (const p of payloads) {
      // Server-to-client request mid-stream: answer pings, refuse the rest (no sampling/elicitation here).
      if (p.id !== undefined && typeof p.method === 'string') {
        await send(
          p.method === 'ping'
            ? { jsonrpc: '2.0', id: p.id, result: {} }
            : ({ jsonrpc: '2.0', id: p.id, error: { code: -32601, message: 'Method not found' } } as Envelope)
        )
      } else replies.push(p)
    }
    return replies
  }

  const request = async (method: string, params?: unknown, timeoutMs?: number) => {
    const id = `jarvis-${nextId++}`
    const reply = (
      await send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) } as Envelope, timeoutMs)
    ).find((e) => e.id === id)
    if (!reply) throw new Error(`${label} ${method}: no reply`)
    if (reply.error) throw new Error(`${label} ${method} failed: ${reply.error?.message ?? JSON.stringify(reply.error)}`)
    return reply.result
  }

  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: opts.clientName ?? 'jarvis', version: '0.0.0' }
  })
  if (typeof init?.protocolVersion === 'string') protocolVersion = init.protocolVersion
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    info: {
      name: typeof init?.serverInfo?.name === 'string' ? init.serverInfo.name : undefined,
      version: typeof init?.serverInfo?.version === 'string' ? init.serverInfo.version : undefined,
      instructions: typeof init?.instructions === 'string' ? init.instructions : undefined
    },
    request,
    callTool: (name, args, timeoutMs) => request('tools/call', { name, arguments: args }, timeoutMs),
    async close() {
      if (!sessionId) return
      try {
        const res = await fetch(endpoint, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(5000) })
        await res.body?.cancel()
      } catch {
        /* best effort */
      }
    }
  }
}

/** All tools the session can see (follows nextCursor). */
export async function listTools(session: McpSession): Promise<McpTool[]> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await session.request('tools/list', cursor ? { cursor } : {})
    tools.push(...((result?.tools ?? []) as McpTool[]))
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
    if (!cursor) break
  }
  return tools
}

/** One short-lived session: validates the credentials and returns the tool list. */
export async function probeTools(endpoint: string, opts: OpenOptions = {}): Promise<McpTool[]> {
  const session = await openSession(endpoint, opts)
  try {
    return await listTools(session)
  } finally {
    await session.close()
  }
}
