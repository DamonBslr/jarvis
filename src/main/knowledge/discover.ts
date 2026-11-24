// Which of your many repos are you actually working on? Scores repos by your commits + agent sessions.
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ProjectCandidate, Settings } from '@shared/types'
import { listProjects } from './store'
import { githubSlug, gitIdentity, pool, repoRoot, sh } from './repos'
import type { Connector, RepoActivity } from './connectors/types'

const DAY = 86_400_000
const SKIP = new Set(['node_modules', 'Library', '.Trash', 'Applications', 'Pictures', 'Music', 'Movies', '.cache', 'dist', 'build'])

/** Git repos up to `depth` levels under a folder. */
async function findRepos(root: string, depth: number, out: Set<string>) {
  if (await stat(join(root, '.git')).catch(() => null)) {
    out.add(root)
    return
  }
  if (depth <= 0) return
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue
    await findRepos(join(root, e.name), depth - 1, out)
  }
}

/** Where agent tools keep worktrees and scratch checkouts: never a "code folder". */
const TOOL_DIRS = ['.t3', '.claude', '.codex', '.cursor', 'Library'].map((d) => join(homedir(), d)).concat(['/tmp', '/private'])

/** Folders that hold several active repos (e.g. ~/code), guessed from where agent sessions ran. */
export function guessCodeRoots(roots: string[]): string[] {
  const counts = new Map<string, number>()
  for (const r of roots) {
    const parent = dirname(r)
    if (parent === homedir() || parent === '/' || TOOL_DIRS.some((d) => parent.startsWith(d))) continue
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p]) => p)
}

export async function discoverProjects(
  env: NodeJS.ProcessEnv,
  settings: Settings,
  sources: Connector[],
  log: (m: string) => void
): Promise<{ candidates: ProjectCandidate[]; codeRoots: string[] }> {
  const since = Date.now() - 30 * DAY
  const activity = new Map<string, RepoActivity>()
  for (const c of sources) {
    if (!c.activity) continue
    try {
      for (const a of await c.activity(env, settings, since)) {
        const cur = activity.get(a.root) ?? { root: a.root, sessions: 0, lastAt: 0 }
        cur.sessions += a.sessions
        cur.lastAt = Math.max(cur.lastAt, a.lastAt)
        cur.t3ProjectId ??= a.t3ProjectId
        activity.set(a.root, cur)
      }
    } catch (err) {
      log(`${c.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const codeRoots = settings.codeRoots.length ? settings.codeRoots : guessCodeRoots([...activity.keys()])
  const repos = new Set<string>(activity.keys())
  for (const r of codeRoots) await findRepos(r, 2, repos)
  const known = new Map(listProjects().filter((p) => p.path).map((p) => [p.path!, p]))
  for (const p of known.keys()) repos.add(p)
  for (const p of Object.values(settings.linearRepoMap ?? {})) {
    const root = await repoRoot(p, env)
    if (root) repos.add(root)
  }

  const me = await gitIdentity(env)
  const sinceSec = Math.floor(since / 1000)
  const candidates = await pool([...repos], 6, async (root): Promise<ProjectCandidate | null> => {
    const real = (await repoRoot(root, env)) ?? root
    if (real !== root && repos.has(real)) return null // a worktree of a repo we list anyway
    // Agent scratch checkouts (~/.t3/scratch, ~/.claude/worktrees…) aren't projects of their own.
    if (!known.has(root) && TOOL_DIRS.some((d) => root.startsWith(d + '/'))) return null
    const [mine, last, github] = await Promise.all([
      me.email
        ? sh('git', ['rev-list', '--branches', '--remotes', '--count', `--since=${sinceSec}`, `--author=${me.email}`], { cwd: root, env, timeout: 8000 })
            .then((s) => Number(s.trim()) || 0)
            .catch(() => 0)
        : Promise.resolve(0),
      sh('git', ['log', '-1', '--branches', '--remotes', '--format=%ct'], { cwd: root, env, timeout: 8000 })
        .then((s) => Number(s.trim()) * 1000 || 0)
        .catch(() => 0),
      githubSlug(root, env)
    ])
    const a = activity.get(root)
    const lastAt = Math.max(last, a?.lastAt ?? 0) || undefined
    const recency = lastAt ? Math.max(0, 1 - (Date.now() - lastAt) / (30 * DAY)) : 0
    const score = Math.round(mine * 1 + (a?.sessions ?? 0) * 3 + recency * 20)
    const p = known.get(root)
    return {
      path: root,
      name: p?.name ?? basename(root),
      github,
      t3ProjectId: a?.t3ProjectId ?? p?.t3ProjectId,
      commits30d: mine,
      sessions30d: a?.sessions ?? 0,
      lastActivityAt: lastAt,
      score,
      known: !!p,
      focus: p?.focus
    }
  })
  return {
    candidates: candidates
      .filter((c): c is ProjectCandidate => !!c && (c.score > 0 || !!c.known))
      .sort((a, b) => Number(!!b.focus) - Number(!!a.focus) || b.score - a.score)
      .slice(0, 60),
    codeRoots
  }
}
