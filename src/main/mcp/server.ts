import { createServer, type IncomingMessage } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { join, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { shell } from 'electron'
import type { ApprovalDecision, ApprovalRequest, Settings } from '@shared/types'
import { agentConnect, agentListConnections, proxyCall, proxyInit, proxyList } from '../connections'
import { loadShellEnv } from '../shellEnv'
import { embed } from '../memory/embed'
import { addMemory, searchMemories } from '../memory/memories'
import { searchChunks } from '../memory/knowledge'
import * as linear from '../integrations/linear'
import { getSecret } from '../secrets'
import { computerTool } from '../tools/computer/defs'
import { computerToolList, runComputerTool, type McpContentResult } from '../tools/computer/exec'

export interface BridgeDeps {
  settings(): Promise<Settings>
  /** Show an approval popup in the window that owns this run. */
  requestApproval(req: ApprovalRequest): void
}

const token = randomBytes(24).toString('hex')
let baseUrl = ''
const pending = new Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>()

export function respondApproval(requestId: string, decision: ApprovalDecision) {
  const p = pending.get(requestId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(requestId)
  p.resolve(decision)
}

/** Deny everything still waiting for a run that ended or was cancelled. */

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 2_000_000) throw new Error('body too large')
  }
  return JSON.parse(raw || '{}')
}

async function linearKey(): Promise<string> {
  const key = await getSecret('linear')
  if (!key) throw new Error('Linear is not connected. Ask the user to add a Linear API key in Jarvis → Settings.')
  return key
}

/** Show an approval popup in the run's window and wait for the answer. */
function askUser(
  deps: BridgeDeps,
  runId: string,
  toolName: string,
  input: unknown,
  connect?: ApprovalRequest['connect']
): Promise<ApprovalDecision> {
  const requestId = randomUUID()
  return new Promise<ApprovalDecision>((resolve) => {
    // Unanswered prompts deny after 10 minutes so the CLI never hangs forever.
    const timer = setTimeout(() => respondApproval(requestId, { behavior: 'deny', message: 'No answer from user' }), 600_000)
    pending.set(requestId, { resolve, timer })
    deps.requestApproval({ requestId, runId, toolName, input, ...(connect ? { connect } : {}) })
  })
}

const isMcpContent = (v: unknown): v is McpContentResult & { isError?: boolean } =>
  typeof v === 'object' && v !== null && Array.isArray((v as McpContentResult).mcpContent)

const openInBrowser = async (url: string) => {
  if (!/^https?:\/\//.test(url)) throw new Error('refusing to open a non-http URL')
  await shell.openExternal(url)
}

async function handleTool(name: string, args: any, runId: string, deps: BridgeDeps): Promise<unknown> {
  const settings = await deps.settings()
  // Computer use runs here in the main process; policy/permission checks live in runComputerTool.
  if (computerTool(name))
    return runComputerTool(runId, name, args, {
      enabled: settings.computerUse,
      ask: async (toolName, input) => (await askUser(deps, runId, toolName, input)).behavior === 'allow'
    })
  switch (name) {
    case 'approve': {
      const decision = await askUser(deps, runId, String(args.tool_name), args.input)
      // Claude Code's permission-prompt contract.
      return decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: args.input }
        : { behavior: 'deny', message: decision.message || 'The user denied this action.' }
    }
    case 'memory_search': {
      const q = String(args.query ?? '')
      const vec = (await embed([q], settings))?.[0] ?? null
      const mems = searchMemories(q, vec, settings, 10).map((r) => `[${r.item.type}] ${r.item.content}`)
      const docs = searchChunks(q, vec, settings, 4).map((c) => `--- ${c.source}/${c.path}\n${c.text.slice(0, 1500)}`)
      return [mems.length ? 'Memories:\n' + mems.join('\n') : 'No matching memories.', docs.join('\n\n')]
        .filter(Boolean)
        .join('\n\n')
    }
    case 'remember': {
      const m = addMemory({ type: args.type, content: String(args.content ?? ''), source: 'agent' }, settings)
      return `Saved memory #${m.id}`
    }
    case 'linear_my_issues': {
      const issues = await linear.myIssues(await linearKey())
      return issues.map((i) => `${i.identifier} [${i.state.name}] ${i.priorityLabel} — ${i.title}`).join('\n') || 'No open issues.'
    }
    case 'linear_get_issue':
      return linear.getIssue(await linearKey(), String(args.id))
    case 'linear_set_state': {
      const s = await linear.setState(await linearKey(), String(args.id), { name: String(args.state) })
      return `Moved ${args.id} to ${s.name}`
    }
    case 'linear_comment':
      return linear.comment(await linearKey(), String(args.id), String(args.body))
    case 'connections_list':
      return agentListConnections()
    case 'connect_service':
      return agentConnect(args, {
        runId,
        ask: (toolName, input, connect) => askUser(deps, runId, toolName, input, connect),
        open: openInBrowser,
        env: await loadShellEnv()
      })
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

export async function startBridge(deps: BridgeDeps) {
  const server = createServer(async (req, res) => {
    try {
      // Loopback + token: other local processes/websites can't drive Jarvis tools.
      if (req.headers['x-jarvis-token'] !== token || req.method !== 'POST' || !['/tool', '/tools', '/proxy'].includes(req.url ?? '')) {
        res.writeHead(403).end('forbidden')
        return
      }
      if (req.url === '/proxy') {
        // A connected remote MCP server, proxied with the credentials only this process holds.
        const { runId, connection, op, name, args } = await readBody(req)
        const run = String(runId ?? '')
        const conn = String(connection ?? '')
        if (op === 'init' || op === 'list') {
          const body = op === 'init' ? await proxyInit(run, conn) : await proxyList(run, conn)
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
          return
        }
        if (op !== 'call') throw new Error(`unknown proxy op ${op}`)
        const args_ = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
        const result = await proxyCall(run, conn, String(name), args_, (toolName, input) => askUser(deps, run, toolName, input))
        res
          .writeHead(200, {
            'content-type': 'application/json',
            'x-jarvis-content': 'mcp',
            ...(result.isError ? { 'x-jarvis-error': '1' } : {})
          })
          .end(JSON.stringify(result.mcpContent))
        return
      }
      if (req.url === '/tools') {
        // Tool definitions the bridge does not carry itself (they depend on the run's policy).
        const { runId, groups } = await readBody(req)
        const list = Array.isArray(groups) && groups.includes('computer') ? computerToolList(String(runId ?? '')) : []
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list))
        return
      }
      const { runId, name, args } = await readBody(req)
      const result = await handleTool(String(name), args ?? {}, String(runId ?? ''), deps)
      if (isMcpContent(result)) {
        // Rich result (e.g. a screenshot): the bridge passes these MCP content blocks through as-is.
        res.writeHead(200, { 'content-type': 'application/json', 'x-jarvis-content': 'mcp' }).end(JSON.stringify(result.mcpContent))
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(err instanceof Error ? err.message : String(err))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return server
}

/** How a CLI should launch the bridge for a given run. */
export function bridgeLaunch(runId: string, groups: string[], proxy?: string) {
  return {
    command: process.execPath,
    // Packaged builds unpack bridge.js next to the asar (see electron-builder.yml asarUnpack).
    args: [join(__dirname, 'bridge.js').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      JARVIS_BRIDGE_URL: baseUrl,
      JARVIS_BRIDGE_TOKEN: token,
      JARVIS_RUN_ID: runId,
      JARVIS_TOOLS: groups.join(','),
      ...(proxy ? { JARVIS_PROXY: proxy } : {})
    }
  }
}
