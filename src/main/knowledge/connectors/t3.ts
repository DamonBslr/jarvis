// T3 Code over its MCP endpoint (Jarvis's own signed-in session): threads per project, their status, recent messages.
import { findLiveServer } from '../../tools/t3/discovery'
import { t3Endpoint } from '../../tools/t3'
import { openSession, type McpSession } from '../../mcp/client'
import { listProjects, ProjectIndex, updateProject, upsertItems, type ItemInput } from '../store'
import { repoRoot } from '../repos'
import { clip, DAY, oneLine, type Connector, type RepoActivity, type SyncContext } from './types'

const FIRST_SYNC_DAYS = 60
/** Threads whose messages get read per sync (focus projects, most recent first). */
const READS_PER_SYNC = 30
const MAX_THREADS = 800

interface T3Project {
  id: string
  title: string
  workspaceRoot: string
  repositoryIdentity?: { owner?: string; name?: string; provider?: string }
}

interface T3Thread {
  threadId: string
  projectId: string
  title: string
  link?: string
  status: string
  settled: boolean
  snoozed: boolean
  pinned?: boolean
  relationshipToParent: string | null
  openPullRequestCount?: number
  pullRequests?: { url?: string; number?: number; state?: string }[]
  blockedOnThreadWait?: boolean
  createdAt: string
  updatedAt: string
}

async function call<T>(s: McpSession, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await s.callTool(name, args, 30_000)
  if (r?.isError) throw new Error(`${name}: ${r.content?.[0]?.text ?? 'failed'}`)
  if (r?.structuredContent) return r.structuredContent as T
  const text = r?.content?.find((c: { type: string }) => c.type === 'text')?.text
  return JSON.parse(text ?? '{}') as T
}

async function withSession<T>(env: NodeJS.ProcessEnv, settings: SyncContext['settings'], fn: (s: McpSession) => Promise<T>): Promise<T> {
  const ep = await t3Endpoint(env, settings)
  if (!ep) throw new Error('T3 Code is not running or Jarvis is not signed in to it')
  const s = await openSession(ep.url, { headers: { authorization: `Bearer ${ep.token}` }, label: 'T3 Code' })
  try {
    return await fn(s)
  } finally {
    await s.close()
  }
}

async function allProjects(s: McpSession): Promise<T3Project[]> {
  const out: T3Project[] = []
  for (let cursor: number | undefined = 0; cursor !== undefined && out.length < 500; ) {
    const page: { projects: T3Project[]; nextCursor?: number | null } = await call(s, 't3_project_list', { limit: 100, cursor })
    out.push(...page.projects)
    cursor = page.nextCursor ?? undefined
  }
  return out
}

async function threadsSince(s: McpSession, sinceMs: number): Promise<T3Thread[]> {
  const out: T3Thread[] = []
  for (let cursor: number | undefined = 0; cursor !== undefined && out.length < MAX_THREADS; ) {
    const page: { threads: T3Thread[]; nextCursor?: number | null } = await call(s, 't3_thread_list', { allProjects: true, limit: 100, cursor })
    const fresh = page.threads.filter((t) => Date.parse(t.updatedAt) >= sinceMs)
    out.push(...fresh)
    // Newest first: once a page runs past the cutoff there's nothing newer behind it.
    if (fresh.length < page.threads.length) break
    cursor = page.nextCursor ?? undefined
  }
  return out
}

interface ReadItem {
  type: string
  createdBy?: string
  text?: string | null
}

async function lastMessages(s: McpSession, threadId: string): Promise<string> {
  const r: { items?: ReadItem[] } = await call(s, 't3_thread_read', { threadId, view: 'messages', limit: 6, maxCharsPerItem: 1500 })
  return (r.items ?? [])
    .filter((i) => i.text)
    .map((i) => `${i.createdBy === 'user' || i.type.startsWith('user') ? 'You' : 'Agent'}: ${clip(i.text ?? '', 1500)}`)
    .join('\n\n')
}

/** T3 project id -> repo root, linking T3 projects onto Jarvis projects as a side effect. */
async function mapProjects(projects: T3Project[], env: NodeJS.ProcessEnv) {
  const roots = new Map<string, string>()
  const jarvis = listProjects()
  for (const p of projects) {
    const root = (await repoRoot(p.workspaceRoot, env)) ?? p.workspaceRoot
    roots.set(p.id, root)
    const match = jarvis.find((j) => j.path === root)
    if (match && match.t3ProjectId !== p.id) updateProject(match.id, { t3ProjectId: p.id })
  }
  return roots
}

export const t3Connector: Connector = {
  id: 't3',
  name: 'T3 Code',
  reads: 'Your T3 threads per project: what each agent worked on, whether it is done, waiting or failed',
  async detect(env, settings) {
    const server = await findLiveServer(env)
    if (!server) return { available: false, detail: 'T3 Code is not running', setup: { kind: 'app', hint: 'Open T3 Code' } }
    if (!settings.t3Tools)
      return { available: true, detail: `running at ${server.origin}; Jarvis signs in when you turn this on`, setup: { kind: 'toggle', hint: 'Signs Jarvis in to T3 Code' } }
    return { available: true, detail: `running at ${server.origin}` }
  },
  async sync(ctx) {
    return withSession(ctx.env, ctx.settings, async (s) => {
      const roots = await mapProjects(await allProjects(s), ctx.env)
      const since = ctx.since ? ctx.since - 30 * 60_000 : Date.now() - FIRST_SYNC_DAYS * DAY
      const threads = (await threadsSince(s, since)).filter((t) => t.relationshipToParent !== 'subagent')
      // Fresh index: mapProjects may have just linked T3 ids.
      const index = new ProjectIndex()
      let reads = 0
      const items: ItemInput[] = []
      for (const t of threads) {
        const root = roots.get(t.projectId)
        const projectId = index.t3(t.projectId) ?? index.repo(root)
        let body = `Status: ${t.status}${t.settled ? ' (settled)' : ''}${t.snoozed ? ' (snoozed)' : ''}`
        if (index.isFocus(projectId) && reads < READS_PER_SYNC) {
          reads++
          const msgs = await lastMessages(s, t.threadId).catch(() => '')
          if (msgs) body += `\n\n${msgs}`
        }
        const prs = (t.pullRequests ?? []).map((p) => p.url).filter(Boolean)
        items.push({
          uid: `t3:${t.threadId}`,
          source: 't3',
          kind: 'thread',
          projectId,
          repo: root,
          title: oneLine(t.title, 140),
          body: prs.length ? `${body}\n\nPull requests: ${prs.join(', ')}` : body,
          url: t.link?.match(/\((t3-thread:[^)]+)\)/)?.[1],
          state: t.status,
          author: 'T3 Code',
          at: Date.parse(t.updatedAt),
          meta: { threadId: t.threadId, t3ProjectId: t.projectId, settled: t.settled, snoozed: t.snoozed, status: t.status, link: t.link, openPrs: t.openPullRequestCount ?? 0 }
        })
      }
      return upsertItems(items)
    })
  },
  async activity(env, settings, sinceMs) {
    return withSession(env, settings, async (s) => {
      const roots = await mapProjects(await allProjects(s), env)
      const by = new Map<string, RepoActivity>()
      for (const t of await threadsSince(s, sinceMs)) {
        if (t.relationshipToParent === 'subagent') continue
        const root = roots.get(t.projectId)
        if (!root) continue
        const a = by.get(root) ?? { root, sessions: 0, lastAt: 0, t3ProjectId: t.projectId }
        a.sessions++
        a.lastAt = Math.max(a.lastAt, Date.parse(t.updatedAt))
        by.set(root, a)
      }
      return [...by.values()]
    })
  }
}
