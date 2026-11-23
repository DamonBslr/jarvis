import type { Provider } from './types'
import { spawnLines, stderrSummary, version } from './spawn'

/** TOML inline table from a string map (JSON strings are valid TOML basic strings). */
const tomlTable = (m: Record<string, string>) =>
  `{${Object.entries(m)
    .map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`)
    .join(', ')}}`

const SANDBOX = { ask: 'read-only', edit: 'workspace-write', full: 'danger-full-access' } as const

/**
 * Codex CLI via `codex exec --json`. Uses your ChatGPT login / ~/.codex/config.toml as-is.
 */
export const codexProvider: Provider = {
  id: 'codex',

  async status({ env }) {
    const v = await version('codex', env)
    return v
      ? { id: 'codex', available: true, version: v, models: ['default'] }
      : { id: 'codex', available: false, detail: '`codex` not found on PATH' }
  },

  run(req, { env }, emit) {
    const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${SANDBOX[req.autonomy]}"`]
    if (req.model && req.model !== 'default') common.push('-m', req.model)
    if (req.mcp) {
      // TOML values: JSON strings/arrays are valid TOML; env needs an inline table.
      const env = Object.entries(req.mcp.env)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ')
      common.push(
        '-c',
        `mcp_servers.jarvis.command=${JSON.stringify(req.mcp.command)}`,
        '-c',
        `mcp_servers.jarvis.args=${JSON.stringify(req.mcp.args)}`,
        '-c',
        `mcp_servers.jarvis.env={${env}}`
      )
    }
    for (const [name, spec] of Object.entries(req.extraMcp ?? {})) {
      // Bare TOML keys only: a quoted key ends up as a server literally named with quotes, and Codex drops it.
      const key = /^[A-Za-z0-9_-]+$/.test(name) ? `mcp_servers.${name}` : `mcp_servers.${JSON.stringify(name)}`
      if ('url' in spec) {
        common.push('-c', `${key}.url=${JSON.stringify(spec.url)}`)
        if (spec.headers && Object.keys(spec.headers).length)
          common.push('-c', `${key}.http_headers=${tomlTable(spec.headers)}`)
      } else {
        common.push('-c', `${key}.command=${JSON.stringify(spec.command)}`, '-c', `${key}.args=${JSON.stringify(spec.args)}`)
        if (spec.env && Object.keys(spec.env).length) common.push('-c', `${key}.env=${tomlTable(spec.env)}`)
        if (spec.cwd) common.push('-c', `${key}.cwd=${JSON.stringify(spec.cwd)}`)
      }
    }
    for (const kv of req.codexConfig ?? []) common.push('-c', kv)

    // Codex has no system-prompt flag in exec mode; prefix the first turn instead.
    // Mode instructions go in once; memory context is per turn since it depends on the prompt.
    const prompt = [
      !req.sessionId && req.systemPrompt ? `<instructions>\n${req.systemPrompt}\n</instructions>` : '',
      req.context ?? '',
      req.prompt
    ]
      .filter(Boolean)
      .join('\n\n')

    const args = req.sessionId
      ? ['exec', 'resume', ...common, req.sessionId, '-']
      : ['exec', ...common, '-']

    let finished = false
    const started = Date.now()

    return spawnLines({
      cmd: 'codex',
      args,
      cwd: req.cwd,
      env,
      stdin: prompt,
      onLine(line) {
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          return // codex logs non-JSON noise on stdout occasionally
        }
        const item = msg.item
        switch (msg.type) {
          case 'thread.started':
            emit({ kind: 'session', sessionId: msg.thread_id })
            break
          case 'item.started':
            if (item?.type === 'command_execution') {
              emit({ kind: 'tool_start', id: item.id, name: 'shell', input: String(item.command ?? '') })
            } else if (item?.type === 'mcp_tool_call') {
              emit({
                kind: 'tool_start',
                id: item.id,
                name: `${item.server}.${item.tool}`,
                input: JSON.stringify(item.arguments ?? {}, null, 2)
              })
            }
            break
          case 'item.completed':
            switch (item?.type) {
              case 'agent_message':
                emit({ kind: 'text', delta: (item.text ?? '') + '\n\n' })
                break
              case 'reasoning':
                emit({ kind: 'thinking', delta: (item.text ?? '') + '\n' })
                break
              case 'command_execution':
                emit({
                  kind: 'tool_end',
                  id: item.id,
                  output: String(item.aggregated_output ?? '').slice(0, 20000),
                  isError: typeof item.exit_code === 'number' && item.exit_code !== 0
                })
                break
              case 'mcp_tool_call':
                emit({
                  kind: 'tool_end',
                  id: item.id,
                  output: JSON.stringify(item.result ?? item.error ?? {}, null, 2).slice(0, 20000),
                  isError: item.status === 'failed'
                })
                break
              case 'file_change': {
                const changes = (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join('\n')
                emit({ kind: 'tool_start', id: item.id, name: 'edit', input: changes })
                emit({ kind: 'tool_end', id: item.id, output: item.status ?? 'applied', isError: item.status === 'failed' })
                break
              }
              case 'web_search':
                emit({ kind: 'tool_start', id: item.id, name: 'web_search', input: String(item.query ?? '') })
                emit({ kind: 'tool_end', id: item.id, output: '' })
                break
              case 'error':
                emit({ kind: 'log', message: String(item.message ?? '') })
                break
            }
            break
          case 'turn.completed':
            finished = true
            emit({ kind: 'done', durationMs: Date.now() - started })
            break
          case 'turn.failed':
            finished = true
            emit({ kind: 'error', message: String(msg.error?.message ?? 'Codex turn failed') })
            emit({ kind: 'done', durationMs: Date.now() - started })
            break
          case 'error':
            emit({ kind: 'log', message: String(msg.message ?? '') })
            break
        }
      },
      onExit(code, stderr, cancelled) {
        if (finished) return
        if (!cancelled && code !== 0) emit({ kind: 'error', message: stderrSummary(stderr) })
        emit({ kind: 'done', durationMs: Date.now() - started })
      }
    })
  }
}
