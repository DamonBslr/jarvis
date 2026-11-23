import { McpAuthError, probeTools as probe, type McpTool } from '../../mcp/client'

/** T3 Code rejected the token (HTTP 401/403). */
export { McpAuthError as T3AuthError, type McpTool }

/** One short-lived session: validates a T3 Code token and returns the tool list. */
export function probeTools(endpoint: string, token: string): Promise<McpTool[]> {
  return probe(endpoint, { headers: { authorization: `Bearer ${token}` }, label: 'T3 Code' })
}
