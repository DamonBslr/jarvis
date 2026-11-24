// Claude Code and Codex history: what you asked your coding agents, where, and how they left it.
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { upsertItems, type ItemInput } from '../store'
import { pool, repoRoot } from '../repos'
import { clip, DAY, oneLine, type Connector, type RepoActivity, type SyncContext } from './types'

/** First sync looks back this far; later syncs read only files changed since. */
const FIRST_SYNC_DAYS = 120
const MAX_FILE_BYTES = 60 * 1024 * 1024

interface Session {
  id: string
  cwd?: string
  branch?: string
  title?: string
  prompts: string[]
  lastReply?: string
  lastRole?: 'user' | 'assistant'
  startedAt?: number
  endedAt?: number
  /** Who drove the session: claude-desktop, t3-code (a T3 thread), sdk-cli (Jarvis, scripts)… */
  via?: string
}

/** Prompts that are really harness plumbing (slash-command wrappers, reminders, injected docs). */
const NOISE = /^(<|#\s*AGENTS\.md|Caveat:|\[Request interrupted)/

async function files(dir: string, depth: number, sinceMs: number, out: { path: string; mtime: number }[] = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory() && depth > 0) await files(p, depth - 1, sinceMs, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      const s = await stat(p).catch(() => null)
      if (s && s.mtimeMs >= sinceMs && s.size < MAX_FILE_BYTES) out.push({ path: p, mtime: s.mtimeMs })
    }
  }
  return out
}

async function lines(path: string, fn: (obj: any) => void) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    try {
      fn(JSON.parse(line))
    } catch {
      /* partial line while a session is being written */
    }
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

async function parseClaude(path: string): Promise<Session | null> {
  const s: Session = { id: '', prompts: [] }
  let summary: string | undefined
  await lines(path, (d) => {
    if (d.type === 'custom-title' && d.customTitle) s.title = String(d.customTitle)
    if (d.type === 'summary' && d.summary) summary = String(d.summary)
    if (d.sessionId && !s.id) s.id = String(d.sessionId)
    if (d.entrypoint && !s.via) s.via = String(d.entrypoint)
    if (d.isSidechain) return
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN
    if (d.type === 'user' || d.type === 'assistant') {
      if (d.cwd && !s.cwd) s.cwd = String(d.cwd)
      if (d.gitBranch) s.branch = String(d.gitBranch)
      if (!Number.isNaN(ts)) {
        s.startedAt ??= ts
        s.endedAt = ts
      }
    }
    if (d.type === 'user' && !d.isMeta) {
      const t = textOf(d.message?.content).trim()
      if (t && !NOISE.test(t)) {
        s.prompts.push(t)
        s.lastRole = 'user'
      }
    } else if (d.type === 'assistant') {
      const t = textOf(d.message?.content).trim()
      if (t) {
        s.lastReply = t
        s.lastRole = 'assistant'
      }
    }
  })
  if (!s.id || !s.prompts.length) return null
  s.title ??= summary
  return s
}

async function parseCodex(path: string): Promise<Session | null> {
  const s: Session = { id: '', prompts: [] }
  let exec = false
  await lines(path, (d) => {
    const p = d.payload ?? {}
    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN
    if (!Number.isNaN(ts)) {
      s.startedAt ??= ts
      s.endedAt = ts
    }
    if (d.type === 'session_meta') {
      s.id = String(p.id ?? '')
      s.cwd = p.cwd ? String(p.cwd) : undefined
      s.branch = p.git?.branch
      exec = p.originator === 'codex_exec'
    } else if (d.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
      const t = p.message.trim()
      if (t && !NOISE.test(t)) {
        s.prompts.push(t)
        s.lastRole = 'user'
      }
    } else if (d.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') {
      s.lastReply = p.message.trim()
      s.lastRole = 'assistant'
    } else if (d.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const t = textOf(p.content).trim()
      if (t) {
        s.lastReply = t
        s.lastRole = 'assistant'
      }
    }
  })
  // `codex exec` runs without user_message events are automation (reviewers, Jarvis routines' judges).
  if (!s.id || !s.prompts.length) return null
  if (exec && s.prompts.length === 1 && s.prompts[0].length > 4000) return null
  return s
}

function toItem(source: 'claude' | 'codex', s: Session, root: string | null, ctx: SyncContext): ItemInput {
  const projectId = ctx.projects.repo(root)
  const deep = ctx.projects.isFocus(projectId)
  const nPrompts = deep ? 12 : 3
  const promptLen = deep ? 500 : 200
  const prompts = s.prompts.length > nPrompts ? [...s.prompts.slice(0, 2), '…', ...s.prompts.slice(-(nPrompts - 2))] : s.prompts
  const body = [
    s.cwd ? `Folder: ${s.cwd}${s.branch && s.branch !== 'HEAD' ? ` (branch ${s.branch})` : ''}` : '',
    'You asked:',
    ...prompts.map((p) => (p === '…' ? '  …' : `- ${oneLine(p, promptLen)}`)),
    s.lastReply ? `\nLast reply:\n${clip(s.lastReply, deep ? 1500 : 400)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const label = source === 'claude' ? 'Claude Code' : 'Codex'
  return {
    uid: `${source}:${s.id}`,
    source,
    kind: 'session',
    projectId,
    repo: root ?? undefined,
    title: oneLine(s.title || s.prompts[0], 120),
    body,
    author: label,
    at: s.endedAt ?? Date.now(),
    meta: {
      cwd: s.cwd,
      branch: s.branch,
      prompts: s.prompts.length,
      via: s.via,
      startedAt: s.startedAt,
      lastRole: s.lastRole,
      // The agent ended on a question to you and you never answered.
      awaitingUser: s.lastRole === 'assistant' && /\?\s*$/.test((s.lastReply ?? '').trim().split('\n').pop() ?? '')
    }
  }
}

function agentConnector(source: 'claude' | 'codex'): Connector {
  const dir = source === 'claude' ? join(homedir(), '.claude', 'projects') : join(homedir(), '.codex', 'sessions')
  const depth = source === 'claude' ? 1 : 3
  const parse = source === 'claude' ? parseClaude : parseCodex

  const scan = async (env: NodeJS.ProcessEnv, sinceMs: number) => {
    const list = await files(dir, depth, sinceMs)
    const parsed = await pool(list, 6, async (f) => {
      const s = await parse(f.path).catch(() => null)
      if (!s) return null
      return { s, root: s.cwd ? await repoRoot(s.cwd, env) : null }
    })
    return parsed.filter((x): x is { s: Session; root: string | null } => !!x)
  }

  return {
    id: source,
    name: source === 'claude' ? 'Claude Code history' : 'Codex history',
    reads:
      source === 'claude'
        ? 'Your Claude Code sessions: what you asked, in which repo, how it ended'
        : 'Your Codex sessions: what you asked, in which repo, how it ended',
    async detect() {
      const s = await stat(dir).catch(() => null)
      if (!s?.isDirectory()) return { available: false, detail: `${dir} not found`, setup: { kind: 'app', hint: `Install ${source === 'claude' ? 'Claude Code' : 'Codex CLI'}` } }
      const recent = await files(dir, depth, Date.now() - 30 * DAY)
      return { available: true, detail: `${recent.length} sessions in the last 30 days` }
    },
    async sync(ctx) {
      // Re-read files touched since the last sync (minus a margin for sessions still being written).
      const since = ctx.since ? ctx.since - 10 * 60_000 : Date.now() - FIRST_SYNC_DAYS * DAY
      const found = await scan(ctx.env, since)
      return upsertItems(found.map(({ s, root }) => toItem(source, s, root, ctx)))
    },
    async activity(env, _settings, sinceMs) {
      const by = new Map<string, RepoActivity>()
      for (const { s, root } of await scan(env, sinceMs)) {
        if (!root) continue
        const a = by.get(root) ?? { root, sessions: 0, lastAt: 0 }
        a.sessions++
        a.lastAt = Math.max(a.lastAt, s.endedAt ?? 0)
        by.set(root, a)
      }
      return [...by.values()]
    }
  }
}

export const claudeHistory = agentConnector('claude')
export const codexHistory = agentConnector('codex')
