import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { ToolContext, ToolContribution } from './index'
import { LAUNCHER_SOURCE } from './browser/launcher'

/**
 * Jarvis's own browser: Microsoft Playwright MCP (pinned in package.json, run from node_modules under
 * Electron-as-Node, never fetched with npx) driving a persistent Chrome profile in <userData>/browser-profile,
 * separate from the user's everyday browser. A small launcher in front of it handles concurrent runs (profile
 * lease, throwaway copy for the second run) and per-autonomy tool policy. See ./browser/launcher.ts.
 */

const SERVER = 'browser'

/** Tools annotated readOnlyHint by @playwright/mcp 0.0.85 (checked with tools/list). Pre-approved for Claude. */
const READ_ONLY = [
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_network_request',
  'browser_find',
  'browser_wait_for'
]

/** Executes arbitrary JS in the MCP server process (RCE-equivalent, outside any Codex sandbox). */
const NODE_CODE = ['browser_run_code_unsafe']

/** Tools that act on the page (submit forms, click buttons, run page JS). Hidden in read-only ("ask") runs. */
const PAGE_ACTIONS = [
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_file_upload',
  'browser_drag',
  'browser_drop',
  'browser_handle_dialog',
  'browser_evaluate'
]

function deniedTools(autonomy: ToolContext['req']['autonomy']): string[] {
  if (autonomy === 'full') return []
  if (autonomy === 'edit') return NODE_CODE
  return [...NODE_CODE, ...PAGE_ACTIONS]
}

/** Absolute path of @playwright/mcp's cli.js, outside the asar in packaged builds. */
function playwrightCli(): string {
  const require = createRequire(join(app.getAppPath(), 'package.json'))
  const cli = join(require.resolve('@playwright/mcp/package.json'), '..', 'cli.js')
  const unpacked = cli.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : cli
}

/** Prefer the installed Google Chrome, then Edge, then a Chrome for Testing that Playwright downloaded earlier. */
function browserArgs(env: NodeJS.ProcessEnv, cli: string): string[] {
  if (process.platform !== 'darwin') return ['--browser', 'chrome'] // Playwright knows where Chrome lives
  const appDirs = ['/Applications', join(homedir(), 'Applications')]
  const candidates: [channel: string, bundle: string][] = [
    ['chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['msedge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
  ]
  for (const [channel, bundle] of candidates)
    for (const dir of appDirs) {
      const exe = join(dir, bundle)
      if (existsSync(exe)) return ['--browser', channel, '--executable-path', exe]
    }

  const custom = env.PLAYWRIGHT_BROWSERS_PATH
  const registry = custom && custom !== '0' ? custom : join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const revisions = safeReaddir(registry)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const m of revisions) {
    const exe = join(
      registry,
      m[0],
      `chrome-mac-${arch}`,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    )
    if (existsSync(exe)) return ['--browser', 'chromium', '--executable-path', exe]
  }

  throw new Error(
    'Jarvis browser needs Google Chrome: install it from https://www.google.com/chrome/ ' +
      `(or download Playwright's Chromium: ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${cli}" install-browser chromium)`
  )
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Write the launcher next to the profile (atomically, only when it changed) and return its path. */
function launcherFile(dir: string): string {
  const file = join(dir, 'launcher.cjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    /* first run */
  }
  if (current !== LAUNCHER_SOURCE) {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, LAUNCHER_SOURCE)
    renameSync(tmp, file)
  }
  return file
}

/** Jarvis's persistent browser profile (logins agents reuse). */
export const browserProfileDir = () => join(app.getPath('userData'), 'browser-profile')

/** The Chrome binary agents' browser runs on, for opening the profile by hand (logging in). */
export function browserExecutable(env: NodeJS.ProcessEnv): string | null {
  try {
    const args = browserArgs(env, playwrightCli())
    const i = args.indexOf('--executable-path')
    return i >= 0 ? args[i + 1] : null
  } catch {
    return null
  }
}

export function browserTools(ctx: ToolContext): ToolContribution | null {
  if (!ctx.settings.browserTool) return null

  const cli = playwrightCli()
  const userData = app.getPath('userData')
  const profile = browserProfileDir()
  const outputDir = join(userData, 'browser-output')
  // Unattended automations stay headless: no Chrome window popping up while you work.
  const visible = ctx.settings.browserVisible && ctx.interactive
  const denied = deniedTools(ctx.req.autonomy)

  const playwrightArgs = [
    ...browserArgs(ctx.env, cli),
    ...(visible ? [] : ['--headless']),
    // Auto-named screenshots/traces go here instead of littering the repo with .playwright-mcp/.
    '--output-dir',
    outputDir,
    '--output-max-size',
    String(256 * 1024 * 1024),
    // Agent CLIs don't reliably answer roots/list; the server's cwd (the run's cwd) is the workspace root.
    '--ignore-roots',
    // Saved snapshots/screenshots live outside the repo, so give the agent absolute paths it can open.
    '--file-paths',
    'absolute',
    // Skip the generated Playwright code in every response: fewer tokens, nothing the agent needs.
    '--codegen',
    'none'
  ]

  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  if (ctx.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = ctx.env.PLAYWRIGHT_BROWSERS_PATH

  const allowedTools = READ_ONLY.filter((t) => !denied.includes(t)).map((t) => `mcp__${SERVER}__${t}`)

  const login = visible
    ? ' If a site needs a login, open it there and ask the user to sign in in the Jarvis browser window; it stays signed in for later runs.'
    : ''
  return {
    servers: {
      [SERVER]: {
        command: process.execPath,
        args: [launcherFile(join(userData, 'browser')), cli, profile, denied.join(',') || '-', ...playwrightArgs],
        env,
        cwd: ctx.req.cwd
      }
    },
    allowedTools,
    hint:
      "You can drive Jarvis's own browser through the `browser` MCP server (a persistent profile separate from the user's everyday browser). " +
      (ctx.req.autonomy === 'ask'
        ? 'In this read-only mode you can open and read pages but not click or type. Use it for pages that need JavaScript or a login, '
        : 'Use it for pages that need JavaScript, a login, or interaction (clicking, forms, screenshots), ') +
      'and prefer browser_snapshot for reading pages; for plain public pages, docs or APIs, your regular web fetch/search tools are faster.' +
      login
  }
}
