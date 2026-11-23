import { execFile } from 'node:child_process'

let cached: NodeJS.ProcessEnv | null = null

/**
 * macOS GUI apps launched from Finder/Dock don't inherit your shell PATH or exported vars,
 * so `claude`/`codex` (and API keys exported in your shell profile) would be missing. Load them once
 * from an interactive login shell.
 */
export async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cached) return cached
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = '__JARVIS_ENV__'
  const env = await new Promise<NodeJS.ProcessEnv>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${marker}'; env -0; printf '${marker}'`],
      { timeout: 8000, maxBuffer: 10 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err || !stdout.includes(marker)) return resolve({ ...process.env })
        const body = stdout.split(marker)[1] ?? ''
        const out: NodeJS.ProcessEnv = {}
        for (const entry of body.split('\0')) {
          const i = entry.indexOf('=')
          if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1)
        }
        resolve({ ...process.env, ...out })
      }
    )
  })
  cached = env
  return env
}
