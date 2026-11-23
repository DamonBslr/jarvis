import { bridgeLaunch } from '../mcp/server'
import { COMPUTER_SERVER, COMPUTER_TOOLS, type ComputerMode } from './computer/defs'
import { setComputerPolicy } from './computer/exec'
import type { ToolContext, ToolContribution } from './index'

/**
 * Computer use: the agent can see the screen and drive mouse/keyboard on the user's Mac.
 *
 * Same implementation for Claude and Codex: a second instance of the Jarvis MCP bridge
 * (server "computer", group "computer") whose calls run in the Jarvis main process, so the
 * Screen Recording / Accessibility grants belong to Jarvis. Neither CLI's own computer use is
 * usable here: Claude Code's built-in server is gated and interactive-only, and OpenAI's
 * SkyComputerUseClient only bootstraps for OpenAI-signed host apps.
 *
 * Safety: screenshots/window listing are pre-approved reads; every action needs approval in
 * "Edit" autonomy (Claude: its permission prompt; Codex: a Jarvis popup issued by the main
 * process), runs freely in "Full access", and is unavailable in "Ask" (read-only) runs.
 * Unattended runs only get computer use with "Full access".
 */
export function computerTools(ctx: ToolContext): ToolContribution | null {
  const { settings, req, interactive } = ctx
  if (!settings.computerUse || process.platform !== 'darwin') return null
  if (req.provider !== 'claude' && req.provider !== 'codex') return null
  if (!interactive && req.autonomy !== 'full') return null

  const mode: ComputerMode =
    req.autonomy === 'full' ? 'free' : req.autonomy === 'ask' ? 'read' : req.provider === 'claude' ? 'prompt' : 'confirm'
  setComputerPolicy(req.runId, mode)

  const launch = bridgeLaunch(req.runId, ['computer'])
  const readOnly = COMPUTER_TOOLS.filter((t) => t.readOnly).map((t) => `mcp__${COMPUTER_SERVER}__${t.name}`)
  return {
    servers: { [COMPUTER_SERVER]: launch },
    allowedTools: readOnly,
    hint:
      mode === 'read'
        ? `Computer use (read-only): the \`${COMPUTER_SERVER}\` MCP tools can take screenshots of the user's Mac and list its windows. You cannot click or type in this mode.`
        : `Computer use: the \`${COMPUTER_SERVER}\` MCP tools let you see and control the user's Mac (screenshot, list_windows, click, move, drag, scroll, type_text, key, open_app). ` +
          'Take a screenshot before acting and after each step to verify; coordinates are pixels of the latest screenshot. ' +
          'Prefer CLI tools, APIs, files or a browser tool when they can do the job — use the GUI only when nothing else works. ' +
          'The user may be using this computer: keep actions minimal, never enter passwords or payment details, and stop to ask if something unexpected appears.' +
          (mode === 'free' ? '' : ' Each action asks the user for approval first.')
  }
}
