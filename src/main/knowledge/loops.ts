// Open loops: things that wait on the user, derived from synced items. Deterministic, no model calls.
import type { OpenLoop } from '@shared/types'
import { focusProjects, itemsWithMeta, kvGet, kvSet } from './store'

const DAY = 86_400_000

function dismissed(): Record<string, number> {
  try {
    return JSON.parse(kvGet('loops:dismissed') ?? '{}')
  } catch {
    return {}
  }
}

/** Hide a loop until its item changes again. */
export function dismissLoop(key: string) {
  const d = dismissed()
  d[key] = Date.now()
  // Forget dismissals older than 60 days so the map can't grow forever.
  for (const [k, at] of Object.entries(d)) if (Date.now() - at > 60 * DAY) delete d[k]
  kvSet('loops:dismissed', JSON.stringify(d))
}

export function openLoops(opts: { projectId?: string } = {}): OpenLoop[] {
  const now = Date.now()
  const focus = new Set(focusProjects().map((p) => p.id))
  const loops: OpenLoop[] = []
  const add = (l: OpenLoop) => loops.push(l)

  // GitHub: reviews others wait on, and your PRs that need you.
  let reviews: string[] = []
  try {
    reviews = JSON.parse(kvGet('github:reviewRequests') ?? '[]')
  } catch {
    /* ignore */
  }
  const reviewSet = new Set(reviews)
  for (const it of itemsWithMeta("source = 'github' AND kind = 'pr' AND state IN ('open', 'draft')")) {
    const uid = it.uid
    if (reviewSet.has(uid)) {
      add({ key: uid, projectId: it.projectId, source: 'github', kind: 'review', title: `Review requested: ${it.title}`, detail: it.author ? `by ${it.author}` : undefined, url: it.url, at: it.at })
      continue
    }
    if (!it.meta.mine && !(it.projectId && focus.has(it.projectId) && it.meta.checks === 'failing')) continue
    if (it.meta.reviewDecision === 'CHANGES_REQUESTED')
      add({ key: uid, projectId: it.projectId, source: 'github', kind: 'attention', title: `Changes requested: ${it.title}`, url: it.url, at: it.at })
    else if (it.meta.checks === 'failing')
      add({ key: uid, projectId: it.projectId, source: 'github', kind: 'attention', title: `Checks failing: ${it.title}`, url: it.url, at: it.at })
    else if (it.meta.mine && now - it.at > 5 * DAY)
      add({ key: uid, projectId: it.projectId, source: 'github', kind: 'stalled', title: `Open ${Math.floor((now - it.at) / DAY)}d without movement: ${it.title}`, url: it.url, at: it.at })
  }

  // Linear: someone answered on your issue; started issues that went quiet.
  for (const it of itemsWithMeta("source = 'linear' AND state NOT IN ('completed', 'canceled')")) {
    const lastComment = Number(it.meta.lastCommentAt ?? 0)
    if (it.meta.awaitingMe && now - lastComment < 14 * DAY)
      add({ key: `linear:${it.meta.identifier}`, projectId: it.projectId, source: 'linear', kind: 'review', title: `Reply waiting on ${it.title}`, detail: String(it.meta.stateName ?? ''), url: it.url, at: lastComment || it.at })
    else if (it.meta.assignedToMe && it.state === 'started' && now - it.at > 5 * DAY)
      add({ key: `linear:${it.meta.identifier}`, projectId: it.projectId, source: 'linear', kind: 'stalled', title: `In progress but quiet ${Math.floor((now - it.at) / DAY)}d: ${it.title}`, url: it.url, at: it.at })
  }

  // T3: threads that finished, failed or wait for input and that you never settled.
  for (const it of itemsWithMeta("source = 't3' AND at >= ?", now - 14 * DAY)) {
    if (it.meta.settled || it.meta.snoozed) continue
    const status = String(it.meta.status ?? it.state)
    const inFocus = !!it.projectId && focus.has(it.projectId)
    const label =
      status === 'waiting' ? 'Waiting for you' : status === 'failed' ? 'Failed' : status === 'interrupted' ? 'Interrupted' : status === 'completed' && inFocus ? 'Done, not reviewed' : null
    if (!label) continue
    if (status === 'completed' && now - it.at > 7 * DAY) continue
    add({ key: `t3:${it.meta.threadId}`, projectId: it.projectId, source: 't3', kind: status === 'waiting' ? 'review' : 'attention', title: `${label}: ${it.title}`, detail: 'T3 thread', url: it.url, at: it.at })
  }

  // Claude Code / Codex sessions that ended on a question to you, recently. T3- and Jarvis-driven
  // sessions are covered by their thread/chat. At most two per project: the latest are what matter.
  const asked = new Map<string, number>()
  for (const it of itemsWithMeta("source IN ('claude', 'codex') AND at >= ? ORDER BY at DESC", now - 3 * DAY)) {
    if (!it.meta.awaitingUser || !it.projectId || it.meta.via === 't3-code' || it.meta.via === 'sdk-cli') continue
    const n = asked.get(it.projectId) ?? 0
    if (n >= 2) continue
    asked.set(it.projectId, n + 1)
    add({ key: it.uid, projectId: it.projectId, source: it.source, kind: 'attention', title: `Agent asked you something: ${it.title}`, detail: it.source === 'claude' ? 'Claude Code session' : 'Codex session', at: it.at })
  }

  // Git: work that exists only on this Mac.
  for (const it of itemsWithMeta("source = 'git' AND kind = 'worktree' AND state = 'dirty'")) {
    if (!it.projectId || !focus.has(it.projectId)) continue
    const bits: string[] = []
    if (Number(it.meta.uncommitted)) bits.push(`${it.meta.uncommitted} uncommitted file(s) on ${it.meta.branch}`)
    if (Number(it.meta.ahead)) bits.push(`${it.meta.ahead} unpushed commit(s)`)
    const unpushed = (it.meta.unpushed as string[] | undefined) ?? []
    if (unpushed.length) bits.push(`${unpushed.length} branch(es) with commits only on this Mac`)
    add({ key: `git:${it.projectId}:${bits.join('|')}`, projectId: it.projectId, source: 'git', kind: 'uncommitted', title: bits.join(', '), detail: unpushed.slice(0, 4).join(', ') || undefined, at: it.at })
  }

  const d = dismissed()
  const order: Record<OpenLoop['kind'], number> = { review: 0, attention: 1, stalled: 2, uncommitted: 3 }
  return loops
    .filter((l) => !(d[l.key] && d[l.key] >= l.at))
    .filter((l) => !opts.projectId || l.projectId === opts.projectId)
    .sort((a, b) => order[a.kind] - order[b.kind] || b.at - a.at)
}
