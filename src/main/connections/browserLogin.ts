import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { browserExecutable, browserProfileDir } from '../tools/browser'

/**
 * "Log in together": opens a site in Jarvis's own browser profile (the one agents' `browser` tool uses),
 * as a normal Chrome window, so the user signs in once and every later agent run is logged in.
 *
 * Shares the profile lease with the browser launcher (src/main/tools/browser/launcher.ts): the lease file
 * holds this Chrome's pid while it is open, so a run started meanwhile gets a throwaway copy of the profile
 * instead of fighting over Chrome's profile lock. When the window closes the lease goes away.
 */

let open: ChildProcess | null = null

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function openBrowserLogin(url: string, env: NodeJS.ProcessEnv): void {
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) sites can be opened')
  const exe = browserExecutable(env)
  if (!exe) throw new Error("Jarvis's browser needs Google Chrome (or Edge) installed")
  const profile = browserProfileDir()
  const leaseFile = profile + '.lease'

  const holder = (() => {
    try {
      return parseInt(readFileSync(leaseFile, 'utf8'), 10) || 0
    } catch {
      return 0
    }
  })()
  const ours = open && !open.killed && open.exitCode === null ? open.pid : undefined
  if (holder && holder !== ours && alive(holder))
    throw new Error('An agent is using the Jarvis browser right now. Try again when the run has finished.')

  mkdirSync(dirname(leaseFile), { recursive: true })
  // With our window already open, Chrome hands the URL to it and the new process exits right away.
  const child = spawn(exe, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', u.toString()], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  if (ours) return
  if (!child.pid) throw new Error('Could not start the browser')
  open = child
  writeFileSync(leaseFile, String(child.pid))
  child.once('exit', () => {
    try {
      if (parseInt(readFileSync(leaseFile, 'utf8'), 10) === child.pid) rmSync(leaseFile, { force: true })
    } catch {
      /* gone */
    }
    if (open === child) open = null
  })
}
