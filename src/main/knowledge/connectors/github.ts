// GitHub through your `gh` login: your PRs, reviews waiting on you, assigned issues, and focus repos' PRs.
import { focusProjects, kvSet, upsertItems, type ItemInput } from '../store'
import { sh } from '../repos'
import { DAY, oneLine, type Connector } from './types'

const FIRST_SYNC_DAYS = 60

interface SearchPr {
  number: number
  title: string
  url: string
  state: string
  isDraft?: boolean
  body?: string
  updatedAt: string
  createdAt?: string
  repository: { nameWithOwner: string }
  author?: { login: string }
}

interface RepoPr {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  body?: string
  updatedAt: string
  author?: { login: string }
  headRefName?: string
  reviewDecision?: string
  statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]
}

const gh = async <T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> => JSON.parse(await sh('gh', args, { env, timeout: 30_000 })) as T

function checks(rollup?: RepoPr['statusCheckRollup']) {
  if (!rollup?.length) return undefined
  if (rollup.some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? c.state ?? ''))) return 'failing'
  if (rollup.some((c) => c.status && c.status !== 'COMPLETED')) return 'pending'
  return 'passing'
}

export const githubConnector: Connector = {
  id: 'github',
  name: 'GitHub',
  reads: 'Your pull requests, reviews waiting on you and assigned issues (via your gh login)',
  async detect(env) {
    try {
      const login = (await sh('gh', ['api', 'user', '--jq', '.login'], { env, timeout: 10_000 })).trim()
      return { available: true, account: login, detail: `signed in as ${login}` }
    } catch (err) {
      const missing = /ENOENT|not found/i.test(String(err))
      return {
        available: false,
        detail: missing ? 'GitHub CLI not installed' : 'gh is not signed in',
        setup: { kind: 'command', hint: missing ? 'brew install gh && gh auth login' : 'gh auth login' }
      }
    }
  },
  async sync(ctx) {
    const since = new Date(ctx.since ? ctx.since - DAY : Date.now() - FIRST_SYNC_DAYS * DAY).toISOString().slice(0, 10)
    const fields = 'number,title,url,state,isDraft,body,updatedAt,createdAt,repository,author'
    const search = (q: string[]) => gh<SearchPr[]>(['search', 'prs', ...q, '--json', fields, '--limit', '100'], ctx.env)
    const [mine, reviews, issues] = await Promise.all([
      search(['--author=@me', `--updated=>=${since}`]),
      search(['--review-requested=@me', '--state=open']),
      gh<SearchPr[]>(
        ['search', 'issues', '--assignee=@me', '--state=open', '--json', 'number,title,url,state,body,updatedAt,repository,author', '--limit', '50'],
        ctx.env
      ).catch(() => [] as SearchPr[])
    ])

    const items = new Map<string, ItemInput>()
    const put = (it: ItemInput) => {
      const prev = items.get(it.uid)
      items.set(it.uid, prev ? { ...prev, ...it, meta: { ...prev.meta, ...it.meta } } : it)
    }
    const fromSearch = (p: SearchPr, kind: 'pr' | 'issue', meta: Record<string, unknown>): ItemInput => {
      const slug = p.repository.nameWithOwner
      return {
        uid: `github:${kind}:${slug}#${p.number}`,
        source: 'github',
        kind,
        projectId: ctx.projects.github(slug),
        title: `${slug}#${p.number} ${p.title}`,
        body: oneLine(p.body, 1500) || undefined,
        url: p.url,
        state: p.isDraft ? 'draft' : p.state.toLowerCase(),
        author: p.author?.login,
        at: Date.parse(p.updatedAt),
        meta: { repo: slug, ...meta }
      }
    }
    for (const p of mine) put(fromSearch(p, 'pr', { mine: true }))
    for (const p of reviews) put(fromSearch(p, 'pr', { reviewRequested: true }))
    for (const i of issues) put(fromSearch(i, 'issue', { assigned: true }))

    // Focus repos: every recent PR (teammates' too), with review + CI state.
    for (const p of focusProjects().filter((x) => x.github)) {
      const prs = await gh<RepoPr[]>(
        [
          'pr', 'list', '-R', p.github!, '--state', 'all', '--limit', '30',
          '--search', `updated:>=${since}`,
          '--json', 'number,title,url,state,isDraft,body,updatedAt,author,headRefName,reviewDecision,statusCheckRollup'
        ],
        ctx.env
      ).catch((err) => {
        ctx.log(`GitHub ${p.github}: ${String(err)}`)
        return [] as RepoPr[]
      })
      for (const pr of prs) {
        put({
          uid: `github:pr:${p.github}#${pr.number}`,
          source: 'github',
          kind: 'pr',
          projectId: p.id,
          title: `${p.github}#${pr.number} ${pr.title}`,
          body: [pr.headRefName ? `branch ${pr.headRefName}` : '', oneLine(pr.body, 1500)].filter(Boolean).join('\n') || undefined,
          url: pr.url,
          state: pr.isDraft ? 'draft' : pr.state.toLowerCase(),
          author: pr.author?.login,
          at: Date.parse(pr.updatedAt),
          meta: { repo: p.github, reviewDecision: pr.reviewDecision || undefined, checks: checks(pr.statusCheckRollup), branch: pr.headRefName }
        })
      }
    }
    // The live set of reviews waiting on you; a stale flag on an item's meta must not count as one.
    kvSet('github:reviewRequests', JSON.stringify(reviews.map((p) => `github:pr:${p.repository.nameWithOwner}#${p.number}`)))
    return upsertItems([...items.values()])
  }
}
