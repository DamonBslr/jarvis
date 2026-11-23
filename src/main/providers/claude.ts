import type { AgentEvent } from '@shared/types'
import type { Provider } from './types'
import { spawnLines, stderrSummary, version } from './spawn'

const PERMISSION_MODE = { ask: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' } as const

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : stringify(c)))
      .join('\n')
  }
  return stringify(content)
}

/**
 * Claude Code via `claude -p --output-format stream-json`.
 * Uses whatever auth the CLI has (your Pro/Max login), as long as no API key overrides it.
 */
export const claudeProvider: Provider = {
  id: 'claude',

  async status({ env }) {
    const v = await version('claude', env)
    return v
      ? {
          id: 'claude',
          available: true,
          version: v,
          models: ['default', 'opus', 'sonnet', 'haiku'],
          detail: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY is set in your shell' : undefined
        }
      : { id: 'claude', available: false, detail: '`claude` not found on PATH' }
  },

  run(req, { env }, emit) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      PERMISSION_MODE[req.autonomy]
    ]
    if (req.sessionId) args.push('--resume', req.sessionId)
    if (req.model && req.model !== 'default') args.push('--model', req.model)
    if (req.mcp) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: { jarvis: req.mcp } }))
      // Read-only Jarvis tools never need a prompt; Linear writes still ask in "Edit files" mode.
      args.push(
        '--allowedTools',
        'mcp__jarvis__memory_search',
        'mcp__jarvis__remember',
        'mcp__jarvis__linear_my_issues',
        'mcp__jarvis__linear_get_issue'
      )
      // In "Edit files" mode, anything beyond file edits (shell, git, network) asks you in Jarvis.
      if (req.autonomy === 'edit') args.push('--permission-prompt-tool', 'mcp__jarvis__approve')
    }
    const extra = [req.systemPrompt, req.context].filter(Boolean).join('\n\n')
    if (extra) args.push('--append-system-prompt', extra)

    let sawResult = false

    return spawnLines({
      cmd: 'claude',
      args,
      cwd: req.cwd,
      env,
      stdin: req.prompt, // via stdin: no arg-length limits, no flag injection from prompts starting with "-"
      onLine(line) {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        // Subagent traffic carries parent_tool_use_id; keep the main transcript clean.
        const topLevel = !msg.parent_tool_use_id

        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init' && msg.session_id) emit({ kind: 'session', sessionId: msg.session_id })
            break
          case 'stream_event': {
            const e = msg.event
            if (!topLevel || e?.type !== 'content_block_delta') break
            if (e.delta?.type === 'text_delta' && e.delta.text) emit({ kind: 'text', delta: e.delta.text })
            else if (e.delta?.type === 'thinking_delta' && e.delta.thinking)
              emit({ kind: 'thinking', delta: e.delta.thinking })
            break
          }
          case 'assistant':
            if (!topLevel) break
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                emit({ kind: 'tool_start', id: block.id, name: block.name, input: stringify(block.input) })
              }
            }
            break
          case 'user':
            for (const block of msg.message?.content ?? []) {
              if (block?.type === 'tool_result') {
                emit({
                  kind: 'tool_end',
                  id: block.tool_use_id,
                  output: toolResultText(block.content).slice(0, 20000),
                  isError: !!block.is_error
                })
              }
            }
            break
          case 'result': {
            sawResult = true
            if (msg.is_error || msg.subtype !== 'success') {
              emit({ kind: 'error', message: String(msg.result ?? msg.subtype ?? 'Claude run failed') })
            }
            const ev: AgentEvent = { kind: 'done', costUsd: msg.total_cost_usd, durationMs: msg.duration_ms }
            emit(ev)
            break
          }
        }
      },
      onExit(code, stderr, cancelled) {
        if (sawResult) return
        if (cancelled) emit({ kind: 'done' })
        else if (code !== 0) emit({ kind: 'error', message: stderrSummary(stderr) })
        else emit({ kind: 'done' })
      }
    })
  }
}
