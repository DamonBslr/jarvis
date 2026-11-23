// Main window + floating quick bar.
import { app, BrowserWindow, screen, shell, type WebPreferences } from 'electron'
import { join } from 'node:path'

let main: BrowserWindow | null = null
let quick: BrowserWindow | null = null
/** Keep the quick bar up while something inside it needs attention (approval, recording). */
let quickPinned = false

const QUICK_WIDTH = 720
const QUICK_MIN = 76
const QUICK_MAX = 560

const prefs = (extra: WebPreferences = {}): WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  ...extra
})

function load(win: BrowserWindow, hash = '') {
  // Links from model output open in the real browser; app windows never navigate away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace(/^#/, '') })
}

export function isAppUrl(url: string) {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? url.startsWith(dev) : url.startsWith('file://')
}

export function getMain() {
  return main
}

export function createMain() {
  main = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 760,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    webPreferences: prefs()
  })
  main.once('ready-to-show', () => {
    if (!process.env.JARVIS_HIDDEN) main?.show()
  })
  load(main)
  main.on('closed', () => (main = null))
  return main
}

export function showMain(focusInput = false) {
  if (!main) createMain()
  const w = main!
  const reveal = () => {
    w.show()
    w.focus()
    if (focusInput) w.webContents.send('jarvis:focus-input')
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal)
  else reveal()
  return w
}

export function toggleMain() {
  if (main?.isFocused()) main.hide()
  else showMain(true)
}

export function getQuick() {
  return quick
}

/** Created hidden at startup so it opens instantly and can listen for the wake word. */
export function createQuick() {
  quick = new BrowserWindow({
    width: QUICK_WIDTH,
    height: QUICK_MIN,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: prefs({ backgroundThrottling: false })
  })
  quick.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  quick.setAlwaysOnTop(true, 'floating')
  quick.on('blur', () => {
    if (!quickPinned && !process.env.JARVIS_SCREENSHOT) quick?.hide()
  })
  quick.on('closed', () => (quick = null))
  load(quick, '#quick')
  return quick
}

function placeQuick(w: BrowserWindow) {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const [, h] = w.getSize()
  w.setBounds({
    x: Math.round(workArea.x + (workArea.width - QUICK_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height * 0.2),
    width: QUICK_WIDTH,
    height: h
  })
}

export function showQuick(opts: { voice: boolean; prompt?: string } = { voice: false }) {
  if (!quick) createQuick()
  const w = quick!
  const reveal = () => {
    if (!w.isVisible()) placeQuick(w)
    w.show()
    w.focus()
    w.webContents.send('jarvis:quick-show', opts)
  }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal)
  else reveal()
}

export function toggleQuick() {
  if (quick?.isVisible() && quick.isFocused()) quick.hide()
  else showQuick({ voice: false })
}

export function hideQuick() {
  quick?.hide()
}

export function pinQuick(pinned: boolean) {
  quickPinned = pinned
}

export function resizeQuick(height: number) {
  if (!quick) return
  const h = Math.max(QUICK_MIN, Math.min(QUICK_MAX, Math.round(height)))
  const b = quick.getBounds()
  if (b.height !== h) quick.setBounds({ ...b, height: h })
}

export function broadcast(channel: string, ...args: unknown[]) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

export function setDockVisible(visible: boolean) {
  if (process.platform !== 'darwin' || !app.dock) return
  if (visible) void app.dock.show()
  else app.dock.hide()
}
