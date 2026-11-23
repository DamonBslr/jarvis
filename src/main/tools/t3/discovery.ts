import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Finding the user's running T3 Code server without talking to it.
 *
 * T3 Code (desktop app or `t3 serve`) records its live server in
 * `<T3CODE_HOME>/userdata/server-runtime.json`. T3's own `t3 thread` CLI reads the same
 * file and, like us, only trusts it while the recorded pid is alive (a killed server
 * leaves its record behind and another process may own the port by now).
 */

export interface T3Server {
  /** e.g. http://127.0.0.1:3773 — always a loopback origin. */
  origin: string
  /** Stable id of the T3 data directory; a stored token belongs to exactly one. */
  environmentId: string
  serverVersion?: string
}

export function t3Home(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.T3CODE_HOME?.trim()
  return fromEnv ? fromEnv.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), '.t3')
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone. EPERM: owned by another user — not this user's T3, don't trust it.
    return false
  }
}

/** The live, loopback T3 server for this data directory, or null (not running / not installed). */
export async function findLiveServer(env: NodeJS.ProcessEnv): Promise<T3Server | null> {
  const userdata = join(t3Home(env), 'userdata')
  let state: { pid?: unknown; origin?: unknown; serverVersion?: unknown }
  let environmentId: string
  try {
    state = JSON.parse(await readFile(join(userdata, 'server-runtime.json'), 'utf8'))
    environmentId = (await readFile(join(userdata, 'environment-id'), 'utf8')).trim()
  } catch {
    return null
  }
  if (!environmentId || typeof state.origin !== 'string' || !pidAlive(state.pid)) return null
  let origin: URL
  try {
    origin = new URL(state.origin)
  } catch {
    return null
  }
  // The bearer token only ever travels to this machine.
  if (origin.protocol !== 'http:' || !LOOPBACK.has(origin.hostname)) return null
  return {
    origin: origin.origin,
    environmentId,
    serverVersion: typeof state.serverVersion === 'string' ? state.serverVersion : undefined
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The `t3` CLI T3 Code installs (a launcher script written by the app into ~/.t3/bin),
 * falling back to a `t3` on PATH.
 */
export async function findCli(env: NodeJS.ProcessEnv): Promise<string | null> {
  const candidates = [env.T3CODE_CLI_PATH, join(t3Home(env), 'bin', 't3')]
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir) candidates.push(join(dir, 't3'))
  for (const c of candidates) if (c && (await executable(c))) return c
  return null
}
