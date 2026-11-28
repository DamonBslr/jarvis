// One run pipeline for every entry point: main window, quick bar, voice and automations.
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
import { collectTools } from './tools'
import { languageInstruction, languageOf } from '@shared/language'
import { VOICE_REPLY_STYLE } from '@shared/chat'

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
/** Every run from the moment it is requested until it ends (incl. setup), so callers can see which chats are busy. */
const requests = new Map<string, RunRequest>()
/** Who sees approval popups for a run. null = nobody (automations), so prompts are denied. */
const owners = new Map<string, WebContents | null>()
/** Open approval requests: requestId -> runId (so ending a run denies its pending prompts). */
const openApprovals = new Map<string, string>()
const listeners = new Set<(active: number) => void>()

export const activeRuns = () => runs.size
/** The request behind a live run (the agent's chat, workspace and autonomy), for tools acting on its behalf. */
export const runRequest = (runId: string) => requests.get(runId)
/** True while any run (window, quick bar or automation) is working in this chat. */
export const convBusy = (convId: string) => [...requests.values()].some((r) => r.convId === convId)
/** True when a Jarvis window can answer this run's approval prompts. */
export const runAttended = (runId: string) => !!owners.get(runId)
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

/** Everything before the CLI starts: workspace check, memory, language, tools. Throws to fail the run. */
async function prepare(req: RunRequest, send: (ev: AgentEvent) => void, owner: WebContents | null) {
  const dirOk = await stat(req.cwd).then((s) => s.isDirectory(), () => false)
  if (!dirOk) throw new Error(`Workspace folder not found: ${req.cwd}`)

  const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])

  if (settings.useMemory) {
    try {
      const ctx = await buildContext(req.prompt, settings, { cwd: req.cwd, env })
      if (ctx) {
        req = { ...req, context: [req.context, ctx.text].filter(Boolean).join('\n\n') }
        send({ kind: 'context', items: ctx.refs })
      }
    } catch (err) {
      send({ kind: 'log', message: `memory lookup failed: ${String(err)}` })
    }
  }

  // Every turn, every provider: answer in the language the user picked, not one guessed from the input.
  // Spoken turns: answer the way people talk. In context (sent every turn) rather than the system prompt,
  // which Codex only gets on a thread's first turn, so a typed chat that goes live still sounds spoken.
  req = {
    ...req,
    context: [req.context, languageInstruction(languageOf(settings.language)), req.voice ? VOICE_REPLY_STYLE : '']
      .filter(Boolean)
      .join('\n\n')
  }

  // Jarvis tools for the agent: memory + Linear always, approval popups for Claude when someone can answer.
  // Automation tools only in chats someone is in: an unattended run never schedules more runs.
  if (req.provider !== 'ollama') {
    const groups = [
      'memory',
      'knowledge',
      'linear',
      'connections',
      ...(owner && req.convId ? ['automations'] : []),
      ...(req.provider === 'claude' && owner ? ['approve'] : [])
    ]
    req = { ...req, mcp: bridgeLaunch(req.runId, groups) }
    // Optional capabilities (browser, computer use, T3 Code behind settings; connected services always).
    const tools = await collectTools({ settings, req, env, interactive: !!owner }, (message) =>
      send({ kind: 'log', message })
    )
    req = {
      ...req,
      extraMcp: tools.servers,
      extraAllowedTools: tools.allowedTools,
      codexConfig: tools.codexConfig,
      systemPrompt: [req.systemPrompt, ...tools.hints].filter(Boolean).join('\n\n') || undefined
    }
  }

  return { req, env, settings }
}

export async function startRun(req: RunRequest, sink: RunSink, owner: WebContents | null): Promise<void> {
  const provider = providers[req.provider]
  const send = sink.emit
  if (!provider) {
    send({ kind: 'error', message: `Unknown provider ${req.provider}` })
    send({ kind: 'done' })
    return sink.finished?.('', true)
  }
  if (runs.has(req.runId) || requests.has(req.runId)) return
  requests.set(req.runId, req)
  const bail = () => {
    requests.delete(req.runId)
    return sink.finished?.('', true)
  }

  let env: NodeJS.ProcessEnv
  let settings: Settings
  try {
    ;({ req, env, settings } = await prepare(req, send, owner))
  } catch (err) {
    send({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    send({ kind: 'done' })
    return bail()
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
    requests.delete(req.runId)
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
