// One run pipeline for every entry point: main window, quick bar, voice and routines.
import { app, BrowserWindow, type WebContents } from 'electron'
import { stat } from 'node:fs/promises'
import type { AgentEvent, ApprovalRequest, LearnedEvent, ProviderId, RunRequest, Settings } from '@shared/types'
import { loadShellEnv } from './shellEnv'
import { claudeProvider } from './providers/claude'
import { codexProvider } from './providers/codex'
import { ollamaProvider } from './providers/ollama'
import type { Provider, RunHandle } from './providers/types'
import * as store from './store'
import { buildContext } from './memory/context'
import { learnFromTurn } from './memory/learn'
import { bridgeLaunch, respondApproval } from './mcp/server'

export const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  ollama: ollamaProvider
}

// Vars a parent Claude Code / agent session sets for itself; children must not inherit them.
const SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID'
]

export function childEnv(base: NodeJS.ProcessEnv, provider: ProviderId, settings: Settings): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const k of SESSION_VARS) delete env[k]
  if (provider === 'claude' && settings.preferSubscription) {
    // Any of these take precedence over the subscription (OAuth) login and bill per token
    // or point at a different endpoint.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_BASE_URL
  }
  return env
}

export async function providerStatuses() {
  const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
  return Promise.all(
    (Object.keys(providers) as ProviderId[]).map((id) => providers[id].status({ env: childEnv(env, id, settings), settings }))
  )
}

const runs = new Map<string, RunHandle>()
/** Who sees approval popups for a run. null = nobody (routines), so prompts are denied. */
const owners = new Map<string, WebContents | null>()
/** Open approval requests: requestId -> runId (so ending a run denies its pending prompts). */
const openApprovals = new Map<string, string>()
const listeners = new Set<(active: number) => void>()

export const activeRuns = () => runs.size
export function onActiveRunsChanged(cb: (active: number) => void) {
  listeners.add(cb)
}
const notify = () => listeners.forEach((cb) => cb(runs.size))

export interface RunSink {
  emit(ev: AgentEvent): void
  learned?(ev: LearnedEvent): void
  /** Called once with the full answer text after the run ends. */
  finished?(answer: string, failed: boolean): void
}

export async function startRun(req: RunRequest, sink: RunSink, owner: WebContents | null): Promise<void> {
  const provider = providers[req.provider]
  const send = sink.emit
  if (!provider) {
    send({ kind: 'error', message: `Unknown provider ${req.provider}` })
    send({ kind: 'done' })
    return sink.finished?.('', true)
  }
  if (runs.has(req.runId)) return

  const dirOk = await stat(req.cwd).then((s) => s.isDirectory(), () => false)
  if (!dirOk) {
    send({ kind: 'error', message: `Workspace folder not found: ${req.cwd}` })
    send({ kind: 'done' })
    return sink.finished?.('', true)
  }

  const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])

  if (settings.useMemory) {
    try {
      const ctx = await buildContext(req.prompt, settings)
      if (ctx) {
        req = { ...req, context: [req.context, ctx.text].filter(Boolean).join('\n\n') }
        send({ kind: 'context', items: ctx.refs })
      }
    } catch (err) {
      send({ kind: 'log', message: `memory lookup failed: ${String(err)}` })
    }
  }

  // Jarvis tools for the agent: memory + Linear always, approval popups for Claude when someone can answer.
  if (req.provider !== 'ollama') {
    const groups = ['memory', 'linear', ...(req.provider === 'claude' && owner ? ['approve'] : [])]
    req = { ...req, mcp: bridgeLaunch(req.runId, groups) }
  }

  // Collect the answer so the learner can look at the whole turn afterwards.
  let answer = ''
  let failed = false
  owners.set(req.runId, owner)
  const handle = provider.run(req, { env: childEnv(env, req.provider, settings), settings }, (ev) => {
    if (ev.kind === 'text') answer += ev.delta
    if (ev.kind === 'error') failed = true
    send(ev)
  })
  runs.set(req.runId, handle)
  notify()
  void handle.finished.finally(() => {
    runs.delete(req.runId)
    owners.delete(req.runId)
    notify()
    for (const [reqId, rId] of openApprovals) {
      if (rId === req.runId) {
        openApprovals.delete(reqId)
        respondApproval(reqId, { behavior: 'deny', message: 'Run ended' })
      }
    }
    sink.finished?.(answer, failed)
    if (failed || !req.convId || !req.msgId) return
    learnFromTurn({ convId: req.convId, msgId: req.msgId, prompt: req.prompt, answer }, settings, childEnv(env, 'claude', settings))
      .then((learned) => {
        if (learned) sink.learned?.(learned)
      })
      .catch((err) => console.warn('[jarvis] learning failed:', err))
  })
}

export function cancelRun(runId: string) {
  runs.get(runId)?.cancel()
}

export function cancelAll() {
  for (const r of runs.values()) r.cancel()
}

/** Bridge callback: show the popup in whichever window started the run. */
export function requestApproval(req: ApprovalRequest) {
  const owner = owners.get(req.runId)
  if (!owner || owner.isDestroyed()) {
    return respondApproval(req.requestId, { behavior: 'deny', message: 'Nobody is around to approve this' })
  }
  openApprovals.set(req.requestId, req.runId)
  owner.send('jarvis:approval', req)
  const win = BrowserWindow.fromWebContents(owner)
  if (win && !win.isVisible()) win.show()
  if (win && !win.isFocused()) {
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    win.flashFrame(true)
  }
}

export function answerApproval(requestId: string, decision: Parameters<typeof respondApproval>[1]) {
  openApprovals.delete(requestId)
  respondApproval(requestId, decision)
}
