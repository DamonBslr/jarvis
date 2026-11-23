/**
 * Just enough of an MCP streamable-HTTP client to check a T3 Code token and read the
 * tool list (the agent CLIs do the real MCP work). Mirrors what T3's own `t3 thread`
 * CLI does: POST JSON-RPC, accept JSON or SSE replies, answer server pings, carry the
 * mcp-session-id, DELETE the session at the end.
 */

const PROTOCOL_VERSION = '2025-06-18'
const TIMEOUT_MS = 5000

export class T3AuthError extends Error {
  constructor(readonly status: number) {
    super(`T3 Code rejected the token (HTTP ${status})`)
  }
}

export interface McpTool {
  name: string
  description?: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
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
  request(method: string, params?: unknown): Promise<any>
  callTool(name: string, args: Record<string, unknown>): Promise<any>
  close(): Promise<void>
}

/** Opens (initialize + initialized) an MCP session; throws T3AuthError on 401/403. */
export async function openSession(endpoint: string, token: string, clientName = 'jarvis'): Promise<McpSession> {
  let sessionId: string | null = null
  let protocolVersion: string | null = null
  let nextId = 0

  const headers = () => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
  })

  const send = async (message: Envelope): Promise<Envelope[]> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    sessionId = res.headers.get('mcp-session-id') ?? sessionId
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel()
      throw new T3AuthError(res.status)
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`T3 Code MCP endpoint responded with HTTP ${res.status}`)
    }
    const payloads = parseBody(res.headers.get('content-type') ?? '', await res.text())
    const replies: Envelope[] = []
    for (const p of payloads) {
      // Server-to-client request mid-stream: answer pings, refuse the rest.
      if (p.id !== undefined && typeof p.method === 'string') {
        await send(
          p.method === 'ping'
            ? { jsonrpc: '2.0', id: p.id, result: {} }
            : { jsonrpc: '2.0', id: p.id, error: { code: -32601, message: 'Method not found' } } as Envelope
        )
      } else replies.push(p)
    }
    return replies
  }

  const request = async (method: string, params?: unknown) => {
    const id = `jarvis-${nextId++}`
    const reply = (await send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) } as Envelope)).find(
      (e) => e.id === id
    )
    if (!reply) throw new Error(`T3 Code MCP ${method}: no reply`)
    if (reply.error) throw new Error(`T3 Code MCP ${method} failed: ${JSON.stringify(reply.error)}`)
    return reply.result
  }

  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: clientName, version: '0.0.0' }
  })
  if (typeof init?.protocolVersion === 'string') protocolVersion = init.protocolVersion
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    request,
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    async close() {
      if (!sessionId) return
      try {
        const res = await fetch(endpoint, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) })
        await res.body?.cancel()
      } catch {
        /* best effort */
      }
    }
  }
}

/** All tools the token can see (follows nextCursor). */
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

/** One short-lived session: validates the token and returns the tool list. */
export async function probeTools(endpoint: string, token: string): Promise<McpTool[]> {
  const session = await openSession(endpoint, token)
  try {
    return await listTools(session)
  } finally {
    await session.close()
  }
}
