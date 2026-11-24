// Linear with the API key already in Jarvis: issues you own, created or follow, and focus teams' issues.
import { getSecret } from '../../secrets'
import * as linear from '../../integrations/linear'
import { focusProjects, upsertItems, type ItemInput } from '../store'
import { clip, DAY, type Connector } from './types'

const FIRST_SYNC_DAYS = 60

interface RawIssue {
  id: string
  identifier: string
  title: string
  url: string
  description?: string | null
  priorityLabel: string
  branchName: string
  updatedAt: string
  createdAt: string
  state: { name: string; type: string }
  team: { key: string; name: string }
  project: { name: string } | null
  assignee: { name: string; isMe: boolean } | null
  creator: { name: string; isMe: boolean } | null
  comments: { nodes: { body: string; createdAt: string; user: { name: string; isMe: boolean } | null }[] }
}

const FIELDS = `
  id identifier title url description priorityLabel branchName updatedAt createdAt
  state { name type } team { key name } project { name }
  assignee { name isMe } creator { name isMe }
  comments(first: 8) { nodes { body createdAt user { name isMe } } }
`

async function gql<T>(key: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000)
  })
  const data = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] }
  if (!res.ok || data.errors?.length) throw new Error(data.errors?.map((e) => e.message).join('; ') || `Linear HTTP ${res.status}`)
  return data.data as T
}

export const linearConnector: Connector = {
  id: 'linear',
  name: 'Linear',
  reads: 'Issues assigned to you, created by you or that you follow, plus your focus teams’ issues',
  async detect() {
    const key = await getSecret('linear')
    if (!key) return { available: false, detail: 'no API key yet', setup: { kind: 'key', hint: 'https://linear.app/settings/account/security' } }
    try {
      const v = await linear.viewer(key)
      return { available: true, account: v.name, detail: `signed in as ${v.name}` }
    } catch (err) {
      return { available: false, detail: err instanceof Error ? err.message : String(err), setup: { kind: 'key', hint: 'https://linear.app/settings/account/security' } }
    }
  },
  async sync(ctx) {
    const key = await getSecret('linear')
    if (!key) throw new Error('Linear is not connected')
    const since = new Date(ctx.since ? ctx.since - DAY : Date.now() - FIRST_SYNC_DAYS * DAY).toISOString()
    const mine = await gql<{ issues: { nodes: RawIssue[] } }>(
      key,
      `query($since: DateTimeOrDuration!) {
        issues(first: 150, orderBy: updatedAt, filter: {
          updatedAt: { gte: $since },
          or: [{ assignee: { isMe: { eq: true } } }, { creator: { isMe: { eq: true } } }, { subscribers: { isMe: { eq: true } } }]
        }) { nodes { ${FIELDS} } }
      }`,
      { since }
    )
    const teams = [...new Set(focusProjects().map((p) => p.linearTeam).filter((t): t is string => !!t))]
    const team = teams.length
      ? await gql<{ issues: { nodes: RawIssue[] } }>(
          key,
          `query($since: DateTimeOrDuration!, $teams: [String!]) {
            issues(first: 150, orderBy: updatedAt, filter: { updatedAt: { gte: $since }, team: { key: { in: $teams } } }) { nodes { ${FIELDS} } }
          }`,
          { since, teams }
        ).catch((err) => {
          ctx.log(`Linear teams: ${String(err)}`)
          return { issues: { nodes: [] as RawIssue[] } }
        })
      : { issues: { nodes: [] as RawIssue[] } }

    const repoMap = ctx.settings.linearRepoMap ?? {}
    const seen = new Set<string>()
    const items: ItemInput[] = []
    for (const i of [...mine.issues.nodes, ...team.issues.nodes]) {
      if (seen.has(i.id)) continue
      seen.add(i.id)
      const comments = [...i.comments.nodes].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      const last = comments.at(-1)
      const projectId = ctx.projects.linear(i.project?.name, i.team.key) ?? ctx.projects.repo(repoMap[i.team.key])
      items.push({
        uid: `linear:${i.id}`,
        source: 'linear',
        kind: 'issue',
        projectId,
        title: `${i.identifier} ${i.title}`,
        body: [
          `${i.state.name} · ${i.priorityLabel} · ${i.team.name}${i.project ? ` / ${i.project.name}` : ''}${i.assignee ? ` · assignee ${i.assignee.isMe ? 'you' : i.assignee.name}` : ''}`,
          clip(i.description ?? '', 2000),
          ...comments.slice(-4).map((c) => `— ${c.user?.isMe ? 'You' : (c.user?.name ?? 'someone')}: ${clip(c.body, 400)}`)
        ]
          .filter(Boolean)
          .join('\n'),
        url: i.url,
        state: i.state.type,
        author: i.creator?.name,
        at: Date.parse(i.updatedAt),
        meta: {
          identifier: i.identifier,
          stateName: i.state.name,
          team: i.team.key,
          project: i.project?.name,
          branch: i.branchName,
          assignedToMe: !!i.assignee?.isMe,
          // Someone else had the last word on your issue.
          awaitingMe: !!last && !last.user?.isMe && !!(i.assignee?.isMe || i.creator?.isMe),
          lastCommentAt: last ? Date.parse(last.createdAt) : undefined
        }
      })
    }
    return upsertItems(items)
  }
}
