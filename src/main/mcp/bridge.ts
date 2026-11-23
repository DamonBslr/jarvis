/**
 * Jarvis MCP bridge: a tiny stdio MCP server that agent CLIs (Claude Code, Codex) spawn.
 * It exposes Jarvis capabilities as tools and forwards every call to the running Jarvis app
 * over a loopback HTTP endpoint guarded by a per-launch token.
 *
 *  - approve:   permission prompt for Claude Code (--permission-prompt-tool) -> popup in Jarvis
 *  - memory_*:  read/write the user's long-term memory
 *  - linear_*:  read/update Linear issues with the key stored in Jarvis
 *
 * Runs under Electron-as-Node (ELECTRON_RUN_AS_NODE=1). No dependencies.
 */
import { createInterface } from 'node:readline'

const URL_ = process.env.JARVIS_BRIDGE_URL!
const TOKEN = process.env.JARVIS_BRIDGE_TOKEN!
const RUN_ID = process.env.JARVIS_RUN_ID ?? ''
const GROUPS = new Set((process.env.JARVIS_TOOLS ?? 'memory,linear').split(','))

type Tool = { name: string; group: string; description: string; inputSchema: object }

const str = (description: string) => ({ type: 'string', description })

const TOOLS: Tool[] = [
  {
    name: 'approve',
    group: 'approve',
    description: 'Ask the Jarvis user to approve a tool call.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input']
    }
  },
  {
    name: 'memory_search',
    group: 'memory',
    description:
      "Search the user's long-term memory (preferences, projects, people, workflows) and indexed knowledge folders. Use when you need context about the user or their projects.",
    inputSchema: { type: 'object', properties: { query: str('What to look up') }, required: ['query'] }
  },
  {
    name: 'remember',
    group: 'memory',
    description:
      'Save a durable fact about the user to long-term memory (only lasting preferences, rules, project facts — not task details).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['profile', 'preference', 'workflow', 'project', 'person', 'fact'] },
        content: str('One standalone sentence, third person, e.g. "User prefers squash merges."')
      },
      required: ['type', 'content']
    }
  },
  {
    name: 'linear_my_issues',
    group: 'linear',
    description: 'List open Linear issues assigned to the user.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'linear_get_issue',
    group: 'linear',
    description: 'Get a Linear issue with description, state, branch name, comments.',
    inputSchema: { type: 'object', properties: { id: str('Identifier like ENG-123') }, required: ['id'] }
  },
  {
    name: 'linear_set_state',
    group: 'linear',
    description: 'Move a Linear issue to a workflow state by name (e.g. "In Progress", "In Review", "Done").',
    inputSchema: {
      type: 'object',
      properties: { id: str('Identifier like ENG-123'), state: str('Target state name') },
      required: ['id', 'state']
    }
  },
  {
    name: 'linear_comment',
    group: 'linear',
    description: 'Post a markdown comment on a Linear issue.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Identifier like ENG-123'), body: str('Markdown comment') },
      required: ['id', 'body']
    }
  }
]

const enabled = TOOLS.filter((t) => GROUPS.has(t.group))

async function call(name: string, args: unknown): Promise<string> {
  const res = await fetch(`${URL_}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': TOKEN },
    body: JSON.stringify({ runId: RUN_ID, name, args })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
  return text
}

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let msg: { id?: number | string; method?: string; params?: any }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg
  if (id === undefined) return // notification

  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'jarvis', version: '0.1.0' }
          }
        })
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} })
      case 'tools/list':
        return send({
          jsonrpc: '2.0',
          id,
          result: { tools: enabled.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
        })
      case 'tools/call': {
        const name = params?.name
        if (!enabled.some((t) => t.name === name)) throw new Error(`unknown tool ${name}`)
        const text = await call(name, params?.arguments ?? {})
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (err) {
    if (method === 'tools/call') {
      // Tool errors are results, so the agent sees them and can recover.
      return send({
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] }
      })
    }
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err) } })
  }
})
