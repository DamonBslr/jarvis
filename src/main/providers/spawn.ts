import { spawn, execFile } from 'node:child_process'
import type { RunHandle } from './types'

export interface SpawnLinesOpts {
  cmd: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin?: string
  onLine(line: string): void
  /** Called once at exit with exit code and the stderr tail. */
  onExit(code: number | null, stderrTail: string, cancelled: boolean): void
}

/** Spawn a CLI, feed stdin, and deliver stdout line by line (for JSONL protocols). */
export function spawnLines(o: SpawnLinesOpts): RunHandle {
  const child = spawn(o.cmd, o.args, {
    cwd: o.cwd,
    env: o.env,
    detached: true, // own process group so cancel kills tool subprocesses too
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let cancelled = false
  let buf = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) o.onLine(line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-8000)
  })

  const finished = new Promise<void>((resolve) => {
    child.on('error', (err) => {
      o.onExit(-1, String(err.message), cancelled)
      resolve()
    })
    child.on('close', (code) => {
      if (buf.trim()) o.onLine(buf.trim())
      o.onExit(code, stderr, cancelled)
      resolve()
    })
  })

  if (o.stdin !== undefined) child.stdin.end(o.stdin)
  else child.stdin.end()

  return {
    finished,
    cancel() {
      if (child.exitCode !== null || !child.pid) return
      cancelled = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }, 3000)
    }
  }
}

export function version(cmd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { env, timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim().split('\n')[0])
    })
  })
}

/** Keep the meaningful tail of stderr (CLIs often log noise before the real error). */
export function stderrSummary(tail: string): string {
  const lines = tail.trim().split('\n').filter(Boolean)
  return lines.slice(-6).join('\n') || 'process exited with an error'
}

function jsonError(out: string): string {
  const last = out.trim().split('\n').pop() ?? ''
  try {
    const d = JSON.parse(last) as { result?: unknown; error?: unknown }
    return String(d.result ?? d.error ?? '').slice(0, 300)
  } catch {
    return last.slice(0, 300)
  }
}

/** Run a command to completion with stdin, returning stdout (rejects on non-zero exit or timeout). */
export function runOnce(
  cmd: string,
  args: string[],
  opts: { stdin?: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out`))
    }, opts.timeoutMs)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err = (err + c).slice(-4000)))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      // CLIs in JSON mode (claude -p) put the error in stdout and leave stderr empty.
      else reject(new Error(err.trim() ? stderrSummary(err) : jsonError(out) || `${cmd} exited ${code}`))
    })
    child.stdin.end(opts.stdin ?? '')
  })
}
