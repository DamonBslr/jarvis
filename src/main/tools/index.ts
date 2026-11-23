import type { McpServerSpec, RunRequest, Settings } from '@shared/types'
import { browserTools } from './browser'
import { computerTools } from './computer'
import { t3Tools } from './t3'
import { connectionTools } from '../connections'

/** What one capability contributes to an agent run. */
export interface ToolContribution {
  /** MCP servers keyed by server name (tool names become mcp__<name>__<tool> in Claude). */
  servers: Record<string, McpServerSpec>
  /** Claude tool names that never need an approval prompt (read-only ones). */
  allowedTools?: string[]
  /** Codex `-c key=value` overrides (e.g. enabling a server already in ~/.codex/config.toml). */
  codexConfig?: string[]
  /** One-line hint appended to the system prompt so the agent knows the capability exists. */
  hint?: string
}

export interface ToolContext {
  settings: Settings
  req: RunRequest
  env: NodeJS.ProcessEnv
  /** True when a Jarvis window can answer approval prompts (false for unattended routines). */
  interactive: boolean
}

type Capability = (ctx: ToolContext) => Promise<ToolContribution | null> | ToolContribution | null

const CAPABILITIES: Capability[] = [browserTools, computerTools, t3Tools, connectionTools]

/** Collect the extra MCP servers / allowed tools / hints for a run. Failing capabilities are skipped, not fatal. */
export async function collectTools(ctx: ToolContext, log: (msg: string) => void) {
  const servers: Record<string, McpServerSpec> = {}
  const allowedTools: string[] = []
  const codexConfig: string[] = []
  const hints: string[] = []
  for (const cap of CAPABILITIES) {
    try {
      const c = await cap(ctx)
      if (!c) continue
      Object.assign(servers, c.servers)
      allowedTools.push(...(c.allowedTools ?? []))
      codexConfig.push(...(c.codexConfig ?? []))
      if (c.hint) hints.push(c.hint)
    } catch (err) {
      log(`tool setup failed: ${String(err)}`)
    }
  }
  return { servers, allowedTools, codexConfig, hints }
}
