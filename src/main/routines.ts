// Scheduled routines: a prompt + fresh data (Linear, PRs, repos) on a timer, answered into a new chat.
import { app, Notification, powerMonitor } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, Conversation, Routine } from '@shared/types'
import { applyEvent, speakable, uid } from '@shared/chat'
import * as store from './store'
import { MODES } from './modes'
import { loadShellEnv } from './shellEnv'
import { getSecret } from './secrets'
import * as linear from './integrations/linear'
import * as git from './integrations/git'
import { runOnce } from './providers/spawn'
import { startRun } from './runner'
import { speak } from './voice'

const file = () => join(app.getPath('userData'), 'routines.json')

export const BRIEFING_PROMPT = `Good morning. Give me my briefing for {{date}}.

My Linear issues:
{{linear}}

My open pull requests and review requests:
{{prs}}

Local repos:
{{repos}}

Write a short briefing: what needs me first (reviews blocking others, failing or stale PRs, tickets already In Progress), then a suggested order for today. At most 12 lines, no preamble.`

function defaults(): Routine[] {
  return [
    {
      id: 'morning-briefing',
      name: 'Morning briefing',
      prompt: BRIEFING_PROMPT,
      schedule: { kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] },
      provider: 'claude',
      cwd: app.getPath('home'),
      enabled: false,
      notify: true,
      speak: false,
      armedAt: Date.now()
    }
  ]
}

let cache: Routine[] | null = null
const running = new Set<string>()
let onChange: () => void = () => {}

export async function listRoutines(): Promise<Routine[]> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(file(), 'utf8')) as Routine[]
  } catch {
    cache = defaults()
    await persist()
  }
  return cache
}

async function persist() {
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(cache, null, 2))
  await rename(tmp, file())
  onChange()
}

export async function saveRoutine(r: Routine) {
  const list = await listRoutines()
  const i = list.findIndex((x) => x.id === r.id)
  const prev = i >= 0 ? list[i] : undefined
  const scheduleChanged = !prev || JSON.stringify(prev.schedule) !== JSON.stringify(r.schedule) || (!prev.enabled && r.enabled)
  const next = { ...r, armedAt: scheduleChanged ? Date.now() : (r.armedAt ?? Date.now()) }
  cache = i >= 0 ? list.map((x) => (x.id === r.id ? next : x)) : [...list, next]
  await persist()
}

export async function removeRoutine(id: string) {
  cache = (await listRoutines()).filter((r) => r.id !== id)
  await persist()
}

async function patch(id: string, p: Partial<Routine>) {
  cache = (await listRoutines()).map((r) => (r.id === id ? { ...r, ...p } : r))
  await persist()
}

// ---- data gatherers -------------------------------------------------------

async function gatherLinear(): Promise<string> {
  const key = await getSecret('linear')
  if (!key) return '(Linear not connected)'
  const issues = await linear.myIssues(key)
  if (!issues.length) return '(no open issues assigned)'
  return issues
    .map((i) => `- ${i.identifier} [${i.state.name}] ${i.priorityLabel}: ${i.title} (updated ${i.updatedAt.slice(0, 10)})`)
    .join('\n')
}

async function gatherPrs(): Promise<string> {
  const env = await loadShellEnv()
  const fields = 'number,title,url,repository,isDraft,updatedAt'
  const search = async (filter: string) => {
    const out = await runOnce('gh', ['search', 'prs', filter, '--state=open', '--json', fields, '--limit', '20'], { env, timeoutMs: 20_000 })
    return JSON.parse(out) as { number: number; title: string; url: string; repository: { nameWithOwner: string }; isDraft: boolean; updatedAt: string }[]
  }
  try {
    const [mine, review] = await Promise.all([search('--author=@me'), search('--review-requested=@me')])
    const fmt = (p: (typeof mine)[number]) =>
      `- ${p.repository.nameWithOwner}#${p.number}${p.isDraft ? ' (draft)' : ''}: ${p.title} (updated ${p.updatedAt.slice(0, 10)})`
    return [
      'Mine:',
      mine.length ? mine.map(fmt).join('\n') : '- none',
      'Waiting for my review:',
      review.length ? review.map(fmt).join('\n') : '- none'
    ].join('\n')
  } catch (err) {
    return `(GitHub unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)})`
  }
}

async function gatherRepos(extra: string[]): Promise<string> {
  const settings = await store.getSettings()
  const env = await loadShellEnv()
  const paths = [...new Set([...Object.values(settings.linearRepoMap), ...extra])]
  const lines: string[] = []
  for (const p of paths) {
    const s = await git.status(p, env).catch(() => null)
    if (!s?.isRepo) continue
    const bits = [`branch ${s.branch}`]
    if (s.files?.length) bits.push(`${s.files.length} uncommitted`)
    if (s.ahead) bits.push(`${s.ahead} unpushed`)
    if (s.behind) bits.push(`${s.behind} behind`)
    lines.push(`- ${s.root?.split('/').pop()}: ${bits.join(', ')}`)
  }
  return lines.join('\n') || '(no known repos yet — start a Linear ticket from the workbench to map one)'
}

async function expand(r: Routine): Promise<{ full: string; short: string }> {
  const tokens: Record<string, () => Promise<string>> = {
    linear: gatherLinear,
    prs: gatherPrs,
    repos: () => gatherRepos([r.cwd]),
    date: async () => new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  }
  const found = [...new Set([...r.prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].filter((k) => k in tokens)
  const values = Object.fromEntries(
    await Promise.all(found.map(async (k) => [k, await tokens[k]().catch((e) => `(${k} failed: ${String(e)})`)] as const))
  )
  const fill = (short: boolean) =>
    r.prompt.replace(/\{\{(\w+)\}\}/g, (m, k: string) => {
      if (!(k in values)) return m
      const v = values[k]
      // Notes like "(Linear not connected)" are short and more useful than a count.
      if (!short || k === 'date' || v.startsWith('(')) return v
      return `[${k}: ${v.split('\n').filter((l) => l.startsWith('- ')).length} items attached]`
    })
  return { full: fill(false), short: fill(true) }
}

// ---- running --------------------------------------------------------------

export interface RoutineHooks {
  conversationsChanged(): void
  openConversation(convId: string): void
}

export async function runRoutine(id: string, hooks: RoutineHooks): Promise<string | null> {
  const r = (await listRoutines()).find((x) => x.id === id)
  if (!r || running.has(id)) return null
  running.add(id)
  try {
    const { full, short } = await expand(r)
    const now = Date.now()
    const user: ChatMessage = { id: uid(), role: 'user', parts: [{ type: 'text', text: short }], createdAt: now }
    let asst: ChatMessage = { id: uid(), role: 'assistant', parts: [], provider: r.provider, createdAt: now }
    let conv: Conversation = {
      id: uid(),
      title: `${r.name} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
      provider: r.provider,
      model: r.model,
      modeId: 'general',
      cwd: r.cwd,
      autonomy: 'ask',
      sessions: {},
      messages: [user, asst],
      updatedAt: now,
      routineId: r.id
    }
    await store.saveConversation(conv)
    hooks.conversationsChanged()

    const answer = await new Promise<{ text: string; failed: boolean }>((resolve) => {
      void startRun(
        {
          runId: uid(),
          convId: conv.id,
          msgId: asst.id,
          provider: r.provider,
          model: r.model,
          prompt: full,
          cwd: r.cwd,
          autonomy: 'ask',
          systemPrompt: MODES.find((m) => m.id === 'general')?.systemPrompt
        },
        {
          emit(ev) {
            asst = applyEvent(asst, ev)
            if (ev.kind === 'session') conv = { ...conv, sessions: { [r.provider]: ev.sessionId } }
          },
          finished: (text, failed) => resolve({ text, failed })
        },
        null
      )
    })
    conv = { ...conv, messages: [user, asst], updatedAt: Date.now() }
    await store.saveConversation(conv)
    hooks.conversationsChanged()
    await patch(r.id, { lastRunAt: now, lastConvId: conv.id, lastError: answer.failed ? (asst.error ?? 'failed') : undefined })

    if (r.notify && Notification.isSupported()) {
      const n = new Notification({
        title: answer.failed ? `${r.name} failed` : r.name,
        body: (answer.failed ? (asst.error ?? '') : speakable(answer.text, 220)).slice(0, 240),
        silent: r.speak
      })
      n.on('click', () => hooks.openConversation(conv.id))
      n.show()
    }
    if (r.speak && !answer.failed) speak(speakable(answer.text), await store.getSettings())
    return conv.id
  } catch (err) {
    await patch(r.id, { lastRunAt: Date.now(), lastError: err instanceof Error ? err.message : String(err) })
    return null
  } finally {
    running.delete(id)
  }
}

export const isRunning = (id: string) => running.has(id)

function dueAt(r: Routine, now: Date): boolean {
  const last = Math.max(r.lastRunAt ?? 0, r.armedAt ?? 0)
  if (r.schedule.kind === 'interval') return now.getTime() - last >= Math.max(5, r.schedule.minutes) * 60_000
  const [h, m] = r.schedule.time.split(':').map(Number)
  const slot = new Date(now)
  slot.setHours(h, m, 0, 0)
  if (!r.schedule.days.includes(now.getDay())) return false
  // Catch up after sleep, but don't fire a morning briefing in the evening.
  return now >= slot && last < slot.getTime() && now.getTime() - slot.getTime() < 6 * 3600_000
}

export function startScheduler(hooks: RoutineHooks, changed: () => void) {
  onChange = changed
  const tick = async () => {
    const now = new Date()
    for (const r of await listRoutines()) {
      if (r.enabled && !running.has(r.id) && dueAt(r, now)) void runRoutine(r.id, hooks)
    }
  }
  setInterval(() => void tick(), 30_000)
  powerMonitor.on('resume', () => setTimeout(() => void tick(), 15_000))
  setTimeout(() => void tick(), 10_000)
}
