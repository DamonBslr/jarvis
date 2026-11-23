import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { AgentEvent, ProviderId, RunRequest, Settings } from '@shared/types'
import { loadShellEnv } from './shellEnv'
import { claudeProvider } from './providers/claude'
import { codexProvider } from './providers/codex'
import { ollamaProvider } from './providers/ollama'
import type { Provider, RunHandle } from './providers/types'
import * as store from './store'
import { MODES } from './modes'

const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  ollama: ollamaProvider
}

const runs = new Map<string, RunHandle>()
let win: BrowserWindow | null = null
let registeredHotkey: string | null = null

function childEnv(base: NodeJS.ProcessEnv, provider: ProviderId, settings: Settings): NodeJS.ProcessEnv {
  const env = { ...base }
  // If Jarvis itself is started from inside a Claude Code session, don't leak that into children.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  if (provider === 'claude' && settings.preferSubscription) {
    // An API key takes precedence over the subscription login and bills per token.
    delete env.ANTHROPIC_API_KEY
  }
  return env
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())

  // Dev aid: JARVIS_SCREENSHOT=/tmp/x.png captures the window after load and quits.
  const shot = process.env.JARVIS_SCREENSHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      const prompt = process.env.JARVIS_SCREENSHOT_PROMPT
      if (prompt) {
        setTimeout(() => {
          void win!.webContents.executeJavaScript(`(() => {
            const ta = document.querySelector('textarea')
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(prompt)})
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            setTimeout(() => document.querySelector('.send').click(), 100)
          })()`)
        }, 4000)
      }
      setTimeout(async () => {
        const img = await win!.webContents.capturePage()
        await import('node:fs/promises').then((fs) => fs.writeFile(shot, img.toPNG()))
        app.quit()
      }, Number(process.env.JARVIS_SCREENSHOT_DELAY ?? 2500))
    })
  }

  // Links from model output open in the real browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  win.on('closed', () => (win = null))
}

function registerHotkey(accel: string) {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = null
  try {
    const ok = globalShortcut.register(accel, () => {
      if (!win) return createWindow()
      if (win.isFocused()) win.hide()
      else {
        win.show()
        win.focus()
        win.webContents.send('jarvis:focus-input')
      }
    })
    if (ok) registeredHotkey = accel
  } catch {
    /* invalid accelerator string */
  }
}

function registerIpc() {
  ipcMain.handle('providers', async () => {
    const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
    return Promise.all(
      (Object.keys(providers) as ProviderId[]).map((id) =>
        providers[id].status({ env: childEnv(env, id, settings), settings })
      )
    )
  })

  ipcMain.handle('run', async (e, req: RunRequest) => {
    const provider = providers[req.provider]
    const send = (ev: AgentEvent) => {
      if (!e.sender.isDestroyed()) e.sender.send('jarvis:event', req.runId, ev)
    }
    if (!provider) return send({ kind: 'error', message: `Unknown provider ${req.provider}` })
    if (runs.has(req.runId)) return

    const dirOk = await stat(req.cwd).then((s) => s.isDirectory(), () => false)
    if (!dirOk) {
      send({ kind: 'error', message: `Workspace folder not found: ${req.cwd}` })
      return send({ kind: 'done' })
    }

    const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
    const handle = provider.run(req, { env: childEnv(env, req.provider, settings), settings }, send)
    runs.set(req.runId, handle)
    void handle.finished.finally(() => runs.delete(req.runId))
  })

  ipcMain.handle('cancel', (_e, runId: string) => runs.get(runId)?.cancel())

  ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('loadConversations', () => store.loadConversations())
  ipcMain.handle('saveConversation', (_e, c) => store.saveConversation(c))
  ipcMain.handle('deleteConversation', (_e, id: string) => store.deleteConversation(id))
  ipcMain.handle('getSettings', () => store.getSettings())
  ipcMain.handle('saveSettings', async (_e, s: Settings) => {
    await store.saveSettings(s)
    registerHotkey(s.hotkey)
  })
  ipcMain.handle('modes', () => MODES)
}

app.whenReady().then(async () => {
  void loadShellEnv() // warm up; first run spawns a login shell
  registerIpc()
  createWindow()
  registerHotkey((await store.getSettings()).hotkey)

  app.on('activate', () => {
    if (!win) createWindow()
    else win.show()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  for (const r of runs.values()) r.cancel()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
