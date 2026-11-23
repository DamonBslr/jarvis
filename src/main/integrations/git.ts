import { execFile } from 'node:child_process'
import type { GitStatus, PullRequest } from '@shared/types'

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 15_000,
  okCodes: number[] = [0]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? -1 : 0
      if (err && !okCodes.includes(code)) reject(new Error(stderr.trim() || err.message))
      else resolve(stdout)
    })
  })
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export async function status(cwd: string, env: NodeJS.ProcessEnv): Promise<GitStatus> {
  let root: string
  try {
    root = (await run('git', ['rev-parse', '--show-toplevel'], cwd, env)).trim()
  } catch {
    return { isRepo: false }
  }

  const raw = await run('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], root, env)
  const s: GitStatus = { isRepo: true, root, branch: '', ahead: 0, behind: 0, files: [] }
  const entries = raw.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    if (e.startsWith('# branch.head ')) s.branch = e.slice(14)
    else if (e.startsWith('# branch.upstream ')) s.upstream = e.slice(18)
    else if (e.startsWith('# branch.ab ')) {
      const m = e.match(/\+(\d+) -(\d+)/)
      if (m) {
        s.ahead = Number(m[1])
        s.behind = Number(m[2])
      }
    } else if (e.startsWith('1 ') || e.startsWith('2 ')) {
      const parts = e.split(' ')
      const xy = parts[1]
      const path = e.startsWith('1 ') ? parts.slice(8).join(' ') : parts.slice(9).join(' ')
      if (e.startsWith('2 ')) i++ // rename: next entry is the original path
      s.files!.push({ path, index: xy[0], worktree: xy[1] })
    } else if (e.startsWith('? ')) {
      s.files!.push({ path: e.slice(2), index: '?', worktree: '?' })
    } else if (e.startsWith('u ')) {
      s.files!.push({ path: e.split(' ').slice(10).join(' '), index: 'U', worktree: 'U' })
    }
  }

  const log = await run('git', ['log', '-n', '8', '--pretty=format:%h%x1f%s%x1f%ar%x1f%an'], root, env).catch(() => '')
  s.commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, when, author] = l.split('\x1f')
      return { hash, subject, when, author }
    })

  const remote = await run('git', ['remote', 'get-url', 'origin'], root, env).catch(() => '')
  s.remote = remote.trim() || undefined
  return s
}

export async function diff(cwd: string, path: string, env: NodeJS.ProcessEnv): Promise<string> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd, env)).trim()
  const [unstaged, staged] = await Promise.all([
    run('git', ['diff', '--', path], root, env).catch(() => ''),
    run('git', ['diff', '--cached', '--', path], root, env).catch(() => '')
  ])
  if (unstaged || staged) return [staged, unstaged].filter(Boolean).join('\n')
  // Untracked: show contents as an all-added diff.
  // --no-index exits 1 when the files differ, which is the expected case here.
  return run('git', ['diff', '--no-index', '--', '/dev/null', path], root, env, 15_000, [0, 1]).catch((e: Error) => e.message)
}

export async function currentPr(cwd: string, env: NodeJS.ProcessEnv): Promise<PullRequest | null> {
  try {
    const out = await run(
      'gh',
      ['pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup'],
      cwd,
      env,
      15_000
    )
    const pr = JSON.parse(out) as {
      number: number
      title: string
      url: string
      state: string
      isDraft: boolean
      reviewDecision: string
      statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[]
    }
    const checks = pr.statusCheckRollup ?? []
    const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion ?? c.state ?? ''))
    const pending = checks.filter((c) => c.status && c.status !== 'COMPLETED')
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision || undefined,
      checks: checks.length ? (failing.length ? 'failing' : pending.length ? 'pending' : 'passing') : undefined
    }
  } catch {
    return null
  }
}
