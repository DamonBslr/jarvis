import type { LinearIssue, LinearState } from '@shared/types'

const API = 'https://api.linear.app/graphql'

async function gql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    // Personal API keys go in Authorization as-is (no "Bearer").
    headers: { 'content-type': 'application/json', authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000)
  })
  const data = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] }
  if (!res.ok || data.errors?.length) {
    throw new Error(data.errors?.map((e) => e.message).join('; ') || `Linear HTTP ${res.status}`)
  }
  return data.data as T
}

const ISSUE_FIELDS = `
  id identifier title url priority priorityLabel branchName updatedAt
  state { id name type color }
  team { id key name }
  project { name }
`

type RawIssue = Omit<LinearIssue, 'teamKey' | 'teamId' | 'project'> & {
  team: { id: string; key: string; name: string }
  project: { name: string } | null
  description?: string | null
}

const toIssue = (r: RawIssue): LinearIssue => ({
  id: r.id,
  identifier: r.identifier,
  title: r.title,
  url: r.url,
  priority: r.priority,
  priorityLabel: r.priorityLabel,
  branchName: r.branchName,
  updatedAt: r.updatedAt,
  state: r.state,
  teamId: r.team.id,
  teamKey: r.team.key,
  project: r.project?.name,
  description: r.description ?? undefined
})

export async function viewer(key: string) {
  const d = await gql<{ viewer: { id: string; name: string; email: string } }>(key, '{ viewer { id name email } }')
  return d.viewer
}

export async function myIssues(key: string): Promise<LinearIssue[]> {
  const d = await gql<{ viewer: { assignedIssues: { nodes: RawIssue[] } } }>(
    key,
    `query {
      viewer {
        assignedIssues(first: 60, orderBy: updatedAt,
          filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
          nodes { ${ISSUE_FIELDS} }
        }
      }
    }`
  )
  return d.viewer.assignedIssues.nodes.map(toIssue)
}

export async function getIssue(key: string, idOrIdentifier: string) {
  const d = await gql<{
    issue: RawIssue & { description: string | null; comments: { nodes: { body: string; user: { name: string } | null; createdAt: string }[] } }
  }>(
    key,
    `query($id: String!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        description
        comments(first: 20) { nodes { body createdAt user { name } } }
      }
    }`,
    { id: idOrIdentifier }
  )
  return { ...toIssue(d.issue), comments: d.issue.comments.nodes }
}

export async function teamStates(key: string, teamId: string): Promise<LinearState[]> {
  const d = await gql<{ team: { states: { nodes: (LinearState & { position: number })[] } } }>(
    key,
    `query($id: String!) { team(id: $id) { states { nodes { id name type color position } } } }`,
    { id: teamId }
  )
  return d.team.states.nodes.sort((a, b) => a.position - b.position)
}

/**
 * Move an issue by state name (case-insensitive, fuzzy) or by type ('started', 'completed'...).
 * Returns the state it landed in.
 */
export async function setState(
  key: string,
  idOrIdentifier: string,
  target: { name?: string; type?: string }
): Promise<LinearState> {
  const issue = await getIssue(key, idOrIdentifier)
  const states = await teamStates(key, issue.teamId)
  const want = target.name?.toLowerCase().trim()
  const state =
    (want && states.find((s) => s.name.toLowerCase() === want)) ||
    (want && states.find((s) => s.name.toLowerCase().includes(want))) ||
    (target.type && states.find((s) => s.type === target.type))
  if (!state) {
    throw new Error(
      `No state matching "${target.name ?? target.type}" in team ${issue.teamKey}. Available: ${states.map((s) => s.name).join(', ')}`
    )
  }
  if (state.id !== issue.state.id) {
    await gql(key, 'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }', {
      id: issue.id,
      stateId: state.id
    })
  }
  return state
}

export async function comment(key: string, idOrIdentifier: string, body: string) {
  const issue = await getIssue(key, idOrIdentifier)
  await gql(key, 'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }', {
    issueId: issue.id,
    body
  })
  return { ok: true, issue: issue.identifier }
}

export async function attachUrl(key: string, idOrIdentifier: string, url: string, title: string) {
  const issue = await getIssue(key, idOrIdentifier)
  await gql(
    key,
    'mutation($issueId: String!, $url: String!, $title: String!) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }',
    { issueId: issue.id, url, title }
  )
}
