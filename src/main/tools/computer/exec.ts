/**
 * Computer-use execution in the Jarvis main process (so macOS Screen Recording / Accessibility
 * grants belong to Jarvis). Called from the MCP bridge server for tools in defs.ts.
 *
 * The privileged side validates everything: run policy (set when the run starts), the
 * `computerUse` setting, OS permissions, argument types and ranges.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, screen, systemPreferences, type Display } from 'electron'
import { COMPUTER_TOOLS, computerTool, type ComputerMode } from './defs'
import { parseKeys, parseModifiers } from './keys'
import { runInput } from './input'

/** MCP content blocks returned as-is by the bridge (lets tools return images). */
export interface McpContentResult {
  mcpContent: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
}

// Fit screenshots in WXGA-ish bounds: big enough to read UI text, small enough for accurate
// coordinates and cheap image tokens.
const MAX_W = 1280
const MAX_H = 800

interface Geometry {
  displayId: number
  /** Display bounds in global screen points. */
  bounds: { x: number; y: number; width: number; height: number }
  /** Size of the image the agent saw. */
  imgW: number
  imgH: number
}

// ---- per-run state (bounded; runs are short-lived) ----
const policies = new Map<string, ComputerMode>()
const geometry = new Map<string, Geometry>()
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size > 64) map.delete(map.keys().next().value as string)
}

/** Called when a run is set up: decides what computer actions this run may perform. */
export function setComputerPolicy(runId: string, mode: ComputerMode) {
  remember(policies, runId, mode)
}

/** MCP tool definitions this run may see: none without a policy, only reads in read mode. */
export function computerToolList(runId: string) {
  const mode = policies.get(runId)
  if (!mode) return []
  return COMPUTER_TOOLS.filter((t) => mode !== 'read' || t.readOnly).map((t) => ({
    name: t.name,
    group: 'computer',
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.readOnly
      ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }))
}

// ---- permissions ----
const appLabel = () =>
  app.isPackaged ? app.getName() : `the app that launched Jarvis in dev (Electron, or your terminal app)`

function checkScreenPermission() {
  if (process.platform !== 'darwin') throw new Error('Computer use is only supported on macOS.')
  const status = systemPreferences.getMediaAccessStatus('screen')
  // not-determined: the first capture makes macOS show its permission prompt.
  if (status === 'granted' || status === 'not-determined') return
  throw new Error(
    `Jarvis does not have Screen Recording permission (status: ${status}). Ask the user to enable ${appLabel()} in ` +
      'System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen Jarvis. Do not retry until they confirm.'
  )
}

let promptedAccessibility = false
function checkInputPermission() {
  if (process.platform !== 'darwin') throw new Error('Computer use is only supported on macOS.')
  if (systemPreferences.isTrustedAccessibilityClient(false)) return
  // Show the macOS "grant Accessibility" prompt once per launch; it adds Jarvis to the list.
  if (!promptedAccessibility) {
    promptedAccessibility = true
    systemPreferences.isTrustedAccessibilityClient(true)
  }
  throw new Error(
    `Jarvis does not have Accessibility permission, which it needs to control the mouse and keyboard. Ask the user to enable ${appLabel()} in ` +
      'System Settings → Privacy & Security → Accessibility (macOS may have just shown a prompt), then try again. Do not retry until they confirm.'
  )
}

// ---- displays & coordinates ----
function displays(): Display[] {
  const primary = screen.getPrimaryDisplay()
  return screen.getAllDisplays().sort((a, b) => (a.id === primary.id ? -1 : b.id === primary.id ? 1 : a.bounds.x - b.bounds.x))
}

function finite(v: unknown, name: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} must be a number`)
  return n
}

/** Screenshot pixels -> global screen points, using the run's last full screenshot. */
function toScreen(runId: string, xv: unknown, yv: unknown, label = ''): { x: number; y: number } {
  const g = geometry.get(runId)
  if (!g) throw new Error('Take a screenshot first: coordinates refer to pixels in the most recent screenshot.')
  const x = finite(xv, `${label}x`)
  const y = finite(yv, `${label}y`)
  if (x < 0 || y < 0 || x > g.imgW || y > g.imgH)
    throw new Error(`(${x}, ${y}) is outside the last screenshot (${g.imgW}x${g.imgH}).`)
  return {
    x: g.bounds.x + (Math.min(x, g.imgW - 0.5) * g.bounds.width) / g.imgW,
    y: g.bounds.y + (Math.min(y, g.imgH - 0.5) * g.bounds.height) / g.imgH
  }
}

/** Global screen points -> screenshot pixels on the run's current display (null if elsewhere). */
function toImage(g: Geometry | undefined, x: number, y: number) {
  if (!g) return null
  const ix = ((x - g.bounds.x) * g.imgW) / g.bounds.width
  const iy = ((y - g.bounds.y) * g.imgH) / g.bounds.height
  return ix >= 0 && iy >= 0 && ix <= g.imgW && iy <= g.imgH ? { x: Math.round(ix), y: Math.round(iy) } : null
}

// ---- screenshot ----
function screencapture(rect: { x: number; y: number; width: number; height: number }): Promise<Electron.NativeImage> {
  const file = join(tmpdir(), `jarvis-shot-${randomBytes(6).toString('hex')}.png`)
  const r = [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n)).join(',')
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', r, file], { timeout: 15_000 }, async (err, _o, stderr) => {
      try {
        if (err) throw new Error(`screencapture failed: ${(stderr || err.message).trim()}`)
        const img = nativeImage.createFromBuffer(await readFile(file))
        if (img.isEmpty()) throw new Error('screencapture produced no image (is Screen Recording allowed for Jarvis?)')
        resolve(img)
      } catch (e) {
        reject(e)
      } finally {
        void rm(file, { force: true })
      }
    })
  })
}

function fit(img: Electron.NativeImage) {
  const { width, height } = img.getSize()
  const scale = Math.min(1, MAX_W / width, MAX_H / height)
  const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img
  return { out, ...out.getSize() }
}

async function screenshot(runId: string, args: any): Promise<McpContentResult> {
  checkScreenPermission()
  const all = displays()
  const prev = geometry.get(runId)
  let display: Display
  if (args.display !== undefined && args.display !== null) {
    const n = finite(args.display, 'display')
    display = all[n - 1]
    if (!display) throw new Error(`There is no display ${n}; this Mac has ${all.length}.`)
  } else {
    display = all.find((d) => d.id === prev?.displayId) ?? all[0]
  }
  const index = all.indexOf(display) + 1

  // Zoomed view: a crop of the current screenshot's display, coordinates unchanged.
  if (args.region) {
    if (!prev || prev.displayId !== display.id) throw new Error('Take a full screenshot of this display before zooming.')
    const tl = toScreen(runId, args.region.x, args.region.y, 'region.')
    const br = toScreen(
      runId,
      Math.min(finite(args.region.x, 'region.x') + finite(args.region.width, 'region.width'), prev.imgW),
      Math.min(finite(args.region.y, 'region.y') + finite(args.region.height, 'region.height'), prev.imgH),
      'region.'
    )
    if (br.x - tl.x < 4 || br.y - tl.y < 4) throw new Error('region is too small')
    const { out, width, height } = fit(await screencapture({ x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }))
    return {
      mcpContent: [
        {
          type: 'text',
          text: `Zoomed view of region (${args.region.x}, ${args.region.y}, ${args.region.width}x${args.region.height}) of the last screenshot, shown at ${width}x${height}. View only: keep using full-screenshot coordinates for actions.`
        },
        { type: 'image', data: out.toJPEG(85).toString('base64'), mimeType: 'image/jpeg' }
      ]
    }
  }

  const [img, info] = await Promise.all([
    screencapture(display.bounds),
    runInput<{ frontmost: string | null; cursor: { x: number; y: number } }>({ op: 'info' }).catch(() => null)
  ])
  const { out, width, height } = fit(img)
  const g: Geometry = { displayId: display.id, bounds: { ...display.bounds }, imgW: width, imgH: height }
  remember(geometry, runId, g)

  const pointer = info?.cursor ?? screen.getCursorScreenPoint()
  const cursor = toImage(g, pointer.x, pointer.y)
  const lines = [
    `Display ${index} of ${all.length}${all.length > 1 ? ' (pass display=N to switch)' : ''}: ${display.bounds.width}x${display.bounds.height} points, image ${width}x${height} px.`,
    'Use x/y in these image pixels for click, move, drag and scroll.',
    info?.frontmost ? `Frontmost app: ${info.frontmost}.` : '',
    cursor ? `Mouse pointer at (${cursor.x}, ${cursor.y}).` : 'Mouse pointer is on another display.'
  ]
  return {
    mcpContent: [
      { type: 'text', text: lines.filter(Boolean).join(' ') },
      { type: 'image', data: out.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' }
    ]
  }
}

// ---- input actions ----
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Keyboard input goes to the focused app and clicks go to whatever window is on top. After an
 * approval popup Jarvis is usually focused, so step aside (like Claude Code hides its terminal)
 * when a Jarvis window is focused or covers the target point.
 */
async function getJarvisOutOfTheWay(point?: { x: number; y: number }) {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
  const covers = point
    ? wins.some((w) => {
        const b = w.getBounds()
        return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
      })
    : false
  if (!BrowserWindow.getFocusedWindow() && !covers) return
  if (process.platform === 'darwin') app.hide()
  else wins.forEach((w) => w.minimize())
  await delay(350) // let the previous app take focus back
}

const BUTTONS = ['left', 'right', 'middle'] as const

async function act(runId: string, name: string, args: any): Promise<string> {
  switch (name) {
    case 'click': {
      const p = toScreen(runId, args.x, args.y)
      const button = args.button ?? 'left'
      if (!BUTTONS.includes(button)) throw new Error('button must be left, right or middle')
      const clicks = args.clicks === undefined ? 1 : finite(args.clicks, 'clicks')
      if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) throw new Error('clicks must be 1, 2 or 3')
      const flags = parseModifiers(args.modifiers)
      await getJarvisOutOfTheWay(p)
      await runInput({ op: 'click', ...p, button, clicks, flags })
      return `${clicks === 2 ? 'Double-clicked' : clicks === 3 ? 'Triple-clicked' : 'Clicked'}${button === 'left' ? '' : ` (${button})`} at (${args.x}, ${args.y})${args.modifiers ? ` with ${args.modifiers}` : ''}.`
    }
    case 'move': {
      const p = toScreen(runId, args.x, args.y)
      await runInput({ op: 'move', ...p })
      return `Moved the pointer to (${args.x}, ${args.y}).`
    }
    case 'drag': {
      const a = toScreen(runId, args.from_x, args.from_y, 'from_')
      const b = toScreen(runId, args.to_x, args.to_y, 'to_')
      const flags = parseModifiers(args.modifiers)
      await getJarvisOutOfTheWay(a)
      await runInput({ op: 'drag', x1: a.x, y1: a.y, x2: b.x, y2: b.y, flags })
      return `Dragged from (${args.from_x}, ${args.from_y}) to (${args.to_x}, ${args.to_y}).`
    }
    case 'scroll': {
      const p = toScreen(runId, args.x, args.y)
      const amount = args.amount === undefined ? 5 : finite(args.amount, 'amount')
      if (!Number.isInteger(amount) || amount < 1 || amount > 50) throw new Error('amount must be an integer from 1 to 50')
      const dir = String(args.direction)
      const d = { up: [0, amount], down: [0, -amount], left: [amount, 0], right: [-amount, 0] }[dir]
      if (!d) throw new Error('direction must be up, down, left or right')
      await getJarvisOutOfTheWay(p)
      await runInput({ op: 'scroll', ...p, dx: d[0], dy: d[1] })
      return `Scrolled ${dir} ${amount} at (${args.x}, ${args.y}).`
    }
    case 'type_text': {
      if (typeof args.text !== 'string' || !args.text) throw new Error('text must be a non-empty string')
      if (args.text.length > 10_000) throw new Error('text is too long (max 10000 characters per call)')
      await getJarvisOutOfTheWay()
      await runInput({ op: 'type', text: args.text }, 20_000 + args.text.length * 15)
      return `Typed ${[...args.text].length} characters.`
    }
    case 'key': {
      if (typeof args.keys !== 'string' || args.keys.length > 200) throw new Error('keys must be a short string like "cmd+c"')
      const presses = parseKeys(args.keys)
      const repeat = args.repeat === undefined ? 1 : finite(args.repeat, 'repeat')
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) throw new Error('repeat must be an integer from 1 to 50')
      await getJarvisOutOfTheWay()
      await runInput({ op: 'keys', presses: presses.map(({ code, flags }) => ({ code, flags })), repeat }, 30_000)
      return `Pressed ${args.keys}${repeat > 1 ? ` ×${repeat}` : ''}.`
    }
    case 'open_app':
      return openApp(args.app)
    default:
      throw new Error(`unknown computer tool ${name}`)
  }
}

function openApp(value: unknown): Promise<string> {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 200 || /[\u0000-\u001f]/.test(name)) throw new Error('app must be an app name or bundle id')
  // Bundle ids (com.apple.Safari) use -b, names/paths use -a. Values are separate argv entries: no shell.
  const args = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(name) ? ['-b', name] : ['-a', name]
  return new Promise((resolve, reject) =>
    execFile('/usr/bin/open', args, { timeout: 30_000 }, (err, _o, stderr) =>
      err ? reject(new Error(`Could not open "${name}": ${(stderr || err.message).trim()}`)) : resolve(`Opened ${name}. Take a screenshot to see it.`)
    )
  )
}

async function listWindows(runId: string): Promise<string> {
  checkScreenPermission() // window titles need Screen Recording
  const { frontmost, windows } = await runInput<{
    frontmost: string | null
    windows: { app: string; title: string; x: number; y: number; width: number; height: number }[]
  }>({ op: 'windows' })
  const g = geometry.get(runId)
  const rows = windows.slice(0, 60).map((w) => {
    const tl = toImage(g, w.x, w.y)
    const br = toImage(g, w.x + w.width, w.y + w.height)
    const where =
      tl && br ? `at (${tl.x}, ${tl.y}) size ${br.x - tl.x}x${br.y - tl.y} px` : `${w.width}x${w.height} pt, not on the current screenshot`
    return `- ${w.app}${w.title ? ` — "${w.title}"` : ''} ${where}`
  })
  return [
    `Frontmost app: ${frontmost ?? 'unknown'}.`,
    g ? 'Positions are in pixels of the last screenshot.' : 'Take a screenshot to get positions in screenshot pixels.',
    'Windows (front to back):',
    ...rows
  ].join('\n')
}

/**
 * Entry point from the bridge server. `ask` shows a Jarvis approval popup and resolves to
 * whether the user allowed it (used for agents without their own permission prompt).
 */
export async function runComputerTool(
  runId: string,
  name: string,
  args: any,
  opts: { enabled: boolean; ask: (toolName: string, input: unknown) => Promise<boolean> }
): Promise<string | McpContentResult> {
  const def = computerTool(name)
  if (!def) throw new Error(`unknown computer tool ${name}`)
  if (!opts.enabled) throw new Error('Computer use is turned off in Jarvis settings.')
  const mode = policies.get(runId)
  if (!mode) throw new Error('Computer use is not enabled for this run.')
  args = args && typeof args === 'object' ? args : {}

  if (name === 'screenshot') return screenshot(runId, args)
  if (name === 'list_windows') return listWindows(runId)

  if (mode === 'read') throw new Error('This run may only look at the screen (switch Jarvis to "Edit" or "Full access" to let it act).')
  if (name !== 'open_app') checkInputPermission() // before any popup, so a missing grant fails fast
  if (mode === 'confirm' && !(await opts.ask(`mcp__computer__${name}`, args))) throw new Error('The user denied this action.')
  return act(runId, name, args)
}
