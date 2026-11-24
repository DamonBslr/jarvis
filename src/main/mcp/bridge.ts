/**
 * Jarvis MCP bridge: a tiny stdio MCP server that agent CLIs (Claude Code, Codex) spawn.
 * It exposes Jarvis capabilities as tools and forwards every call to the running Jarvis app
 * over a loopback HTTP endpoint guarded by a per-launch token.
 *
 *  - approve:   permission prompt for Claude Code (--permission-prompt-tool) -> popup in Jarvis
 *  - memory_*:  read/write the user's long-term memory
 *  - knowledge: projects, briefs, open loops and activity search over everything Jarvis syncs
 *  - linear_*:  read/update Linear issues with the key stored in Jarvis
 *  - connections: list the services the user connected, and set up a new one with the user (popup, sign-in)
 *  - proxy mode (JARVIS_PROXY=<connection id>): this instance stands in for one remote MCP server the user
 *               connected. tools/list and tools/call go to Jarvis, which adds the credentials (they never
 *               reach this process or the agent), refreshes tokens and enforces the connection's policy.
 *  - computer:  screenshots + mouse/keyboard on the user's Mac. Its tool list comes from Jarvis
 *               (POST /tools) so it can depend on the run's policy, and so this file imports nothing
 *               from the app: shared modules would become a rollup chunk inside app.asar, which this
 *               unpacked script could not load.
 *
 * Runs under Electron-as-Node (ELECTRON_RUN_AS_NODE=1). No dependencies.
 */
import { createInterface } from 'node:readline'

const URL_ = process.env.JARVIS_BRIDGE_URL!
const TOKEN = process.env.JARVIS_BRIDGE_TOKEN!
const RUN_ID = process.env.JARVIS_RUN_ID ?? ''
const GROUPS = new Set((process.env.JARVIS_TOOLS ?? 'memory,linear').split(','))
const PROXY = process.env.JARVIS_PROXY ?? ''

type Tool = { name: string; group: string; description: string; inputSchema: object; annotations?: object }

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
    name: 'projects_overview',
    group: 'knowledge',
    description:
      "The user's focus projects (the few they actively work on) with each one's current state and open loops (reviews waiting, failing checks, stalled tickets, unfinished agent threads, uncommitted work). Start here for 'what's going on', 'what did I miss', planning the day.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'project_brief',
    group: 'knowledge',
    description:
      "Everything Jarvis knows about one project: its living brief (what it is, current state, recent work, conventions), open loops and latest activity across git, GitHub, Linear, T3 threads and Claude Code/Codex sessions.",
    inputSchema: { type: 'object', properties: { project: str('Project name, repo name or id') }, required: ['project'] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'knowledge_search',
    group: 'knowledge',
    description:
      "Search the user's activity history: commits, pull requests, Linear issues, T3 threads, Claude Code and Codex sessions, Jarvis chats and project docs. Ranked by relevance, focus projects and recency. Use to find past work, decisions, 'when did I…', 'where did we leave…'.",
    inputSchema: {
      type: 'object',
      properties: {
        query: str('What to look for'),
        project: str('Optional: limit to one project'),
        source: { type: 'string', enum: ['git', 'github', 'linear', 't3', 'claude', 'codex', 'jarvis', 'docs'], description: 'Optional: one source' },
        days: { type: 'number', description: 'Optional: only the last N days' }
      },
      required: ['query']
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'recent_activity',
    group: 'knowledge',
    description: 'Chronological activity (newest first) for one project or all focus projects: commits, PRs, issues, agent sessions and threads.',
    inputSchema: {
      type: 'object',
      properties: { project: str('Optional project; omit for all focus projects'), days: { type: 'number', description: 'Default 7' } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'open_loops',
    group: 'knowledge',
    description: 'Things waiting on the user: review requests, PRs with failing checks or requested changes, quiet in-progress tickets, replies on their issues, T3 threads done/failed/waiting but not settled, agent sessions that ended on a question, uncommitted or unpushed work.',
    inputSchema: { type: 'object', properties: { project: str('Optional: one project') } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
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
    name: 'connections_list',
    group: 'connections',
    description: 'List the services the user connected to Jarvis (MCP servers and browser logins), their status and policy.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'connect_service',
    group: 'connections',
    description:
      "Set up lasting access to a service together with the user. For a service with an MCP endpoint, pass its MCP URL: Jarvis detects OAuth (the user's browser opens to sign in and approve) or asks the user for an API key in a secure dialog. For a website without an API, pass kind \"browser\" and the site URL: it opens in Jarvis's browser so the user can log in once. Credentials go into the macOS keychain vault; you never see them. New MCP tools are available from the user's next message.",
    inputSchema: {
      type: 'object',
      properties: {
        url: str('MCP endpoint URL (e.g. https://jobs.example.com/mcp), or the site URL for kind "browser"'),
        name: str('Short display name, e.g. "Shortlist"'),
        kind: { type: 'string', enum: ['mcp', 'browser'], description: 'mcp (default) or browser' },
        reason: str('One sentence for the user: why you need this access')
      },
      required: ['url']
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

/** Groups whose tools are defined by the Jarvis main process rather than in this file. */
const REMOTE_GROUPS = ['computer'].filter((g) => GROUPS.has(g))
let remoteTools: Promise<Tool[]> | null = null

async function post(path: string, body: object): Promise<Response> {
  return fetch(`${URL_}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': TOKEN },
    body: JSON.stringify({ runId: RUN_ID, ...body })
  })
}

async function proxyJson(op: 'init' | 'list'): Promise<any> {
  const res = await post('/proxy', { connection: PROXY, op })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
  return JSON.parse(text)
}

async function listTools(): Promise<Tool[]> {
  if (PROXY) return ((await proxyJson('list')) as Omit<Tool, 'group'>[]).map((t) => ({ ...t, group: 'proxy' }))
  const local = TOOLS.filter((t) => GROUPS.has(t.group))
  if (!REMOTE_GROUPS.length) return local
  remoteTools ??= fetch(`${URL_}/tools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-token': TOKEN },
    body: JSON.stringify({ runId: RUN_ID, groups: REMOTE_GROUPS })
  }).then(async (res) => {
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`)
    return (await res.json()) as Tool[]
  })
  try {
    return [...local, ...(await remoteTools)]
  } catch (err) {
    remoteTools = null // retry on the next list
    throw err
  }
}

/** Tool output: plain text, or raw MCP content blocks (e.g. screenshots) when Jarvis marks them. */
type Content = { type: string; [k: string]: unknown }[]

async function call(name: string, args: unknown): Promise<{ content: Content; isError?: boolean }> {
  const res = PROXY ? await post('/proxy', { connection: PROXY, op: 'call', name, args }) : await post('/tool', { name, args })
  const text = await res.text()
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`)
  const isError = res.headers.get('x-jarvis-error') === '1'
  if (res.headers.get('x-jarvis-content') === 'mcp') return { content: JSON.parse(text) as Content, ...(isError ? { isError } : {}) }
  return { content: [{ type: 'text', text }] }
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
      case 'initialize': {
        // Proxied servers keep their own instructions (how to use their tools); best effort.
        const instructions = PROXY ? await proxyJson('init').then((r) => r?.instructions, () => undefined) : undefined
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: PROXY || 'jarvis', version: '0.1.0' },
            ...(typeof instructions === 'string' && instructions ? { instructions } : {})
          }
        })
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} })
      case 'tools/list':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: (await listTools()).map(({ name, description, inputSchema, annotations }) => ({
              name,
              description,
              inputSchema,
              ...(annotations ? { annotations } : {})
            }))
          }
        })
      case 'tools/call': {
        const name = params?.name
        // Proxied servers are checked in Jarvis (it knows the run's policy); local tools here.
        if (!PROXY && !(await listTools()).some((t) => t.name === name)) throw new Error(`unknown tool ${name}`)
        return send({ jsonrpc: '2.0', id, result: await call(name, params?.arguments ?? {}) })
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
