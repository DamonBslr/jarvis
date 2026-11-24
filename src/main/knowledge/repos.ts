// Small git helpers shared by connectors: repo roots (worktrees resolved), GitHub slugs, identity.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export function sh(cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeout?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]))
      else resolve(stdout)
    })
  })
}

const rootCache = new Map<string, Promise<string | null>>()

/**
 * The main checkout a folder belongs to. Worktrees (Claude's .claude/worktrees, T3's ~/.t3/worktrees,
 * Codex's) resolve to the repo they were made from, via the shared git dir.
 */
export function repoRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!cwd) return Promise.resolve(null)
  let p = rootCache.get(cwd)
  if (!p) {
    p = (async () => {
      const exists = await stat(cwd).then((s) => s.isDirectory(), () => false)
      if (!exists) return null
      try {
        const common = (await sh('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, env, timeout: 5000 })).trim()
        if (!common) return null
        // <repo>/.git -> <repo>; bare repos keep their path.
        return common.endsWith('/.git') ? dirname(common) : common
      } catch {
        return null
      }
    })()
    rootCache.set(cwd, p)
  }
  return p
}

const slugCache = new Map<string, Promise<string | undefined>>()

/** owner/name of the origin remote when it's on GitHub. */
export function githubSlug(root: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let p = slugCache.get(root)
  if (!p) {
    p = sh('git', ['remote', 'get-url', 'origin'], { cwd: root, env, timeout: 5000 })
      .then((u) => parseGithub(u.trim()))
      .catch(() => undefined)
    slugCache.set(root, p)
  }
  return p
}

export function parseGithub(url: string): string | undefined {
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : undefined
}

let identity: Promise<{ name?: string; email?: string }> | null = null
export function gitIdentity(env: NodeJS.ProcessEnv) {
  identity ??= (async () => {
    const get = (k: string) =>
      sh('git', ['config', '--global', k], { env, timeout: 3000 })
        .then((s) => s.trim() || undefined)
        .catch(() => undefined)
    return { name: await get('user.name'), email: await get('user.email') }
  })()
  return identity
}

/** Run async work over a list with bounded concurrency. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await fn(items[k])
      }
    })
  )
  return out
}
