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
import { route } from './classify/router'
import { jevHealth } from './classify/jev'
import { buildContext } from './memory/context'
import { learnFromTurn } from './memory/learn'
import { probeEmbeddings } from './memory/embed'
import * as mem from './memory/memories'
import * as kb from './memory/knowledge'
import { bridgeLaunch, respondApproval, startBridge } from './mcp/server'
import * as git from './integrations/git'
import * as linear from './integrations/linear'
import { getSecret, setSecret } from './secrets'

const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  ollama: ollamaProvider
}

const runs = new Map<string, RunHandle>()
/** Open approval requests: requestId -> runId (so ending a run denies its pending prompts). */
const openApprovals = new Map<string, string>()
let win: BrowserWindow | null = null
let registeredHotkey: string | null = null

// Vars a parent Claude Code / agent session sets for itself; children must not inherit them.
const SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID'
]

function childEnv(base: NodeJS.ProcessEnv, provider: ProviderId, settings: Settings): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const k of SESSION_VARS) delete env[k]
  if (provider === 'claude' && settings.preferSubscription) {
    // Any of these take precedence over the subscription (OAuth) login and bill per token
    // or point at a different endpoint.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.ANTHROPIC_BASE_URL
  }
  return env
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 880,
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
      const autoclick = process.env.JARVIS_SCREENSHOT_AUTOCLICK
      if (autoclick) {
        setInterval(() => {
          void win?.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(autoclick)})?.click()`)
        }, 1500)
      }
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

    if (settings.useMemory) {
      try {
        const ctx = await buildContext(req.prompt, settings)
        if (ctx) {
          req = { ...req, context: ctx.text }
          send({ kind: 'context', items: ctx.refs })
        }
      } catch (err) {
        send({ kind: 'log', message: `memory lookup failed: ${String(err)}` })
      }
    }

    // Jarvis tools for the agent: memory + Linear always, approval popups for Claude.
    if (req.provider !== 'ollama') {
      const groups = ['memory', 'linear', ...(req.provider === 'claude' ? ['approve'] : [])]
      req = { ...req, mcp: bridgeLaunch(req.runId, groups) }
    }

    // Collect the answer so the learner can look at the whole turn afterwards.
    let answer = ''
    let failed = false
    const handle = provider.run(req, { env: childEnv(env, req.provider, settings), settings }, (ev) => {
      if (ev.kind === 'text') answer += ev.delta
      if (ev.kind === 'error') failed = true
      send(ev)
    })
    runs.set(req.runId, handle)
    void handle.finished.finally(() => {
      runs.delete(req.runId)
      for (const [reqId, rId] of openApprovals) {
        if (rId === req.runId) {
          openApprovals.delete(reqId)
          respondApproval(reqId, { behavior: 'deny', message: 'Run ended' })
        }
      }
      if (failed || !req.convId || !req.msgId) return
      learnFromTurn(
        { convId: req.convId, msgId: req.msgId, prompt: req.prompt, answer },
        settings,
        childEnv(env, 'claude', settings)
      )
        .then((learned) => {
          if (learned && !e.sender.isDestroyed()) e.sender.send('jarvis:learned', learned)
        })
        .catch((err) => console.warn('[jarvis] learning failed:', err))
    })
  })

  ipcMain.handle('route', async (_e, prompt: string, fallback: ProviderId) => {
    const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
    const statuses = await Promise.all(
      (Object.keys(providers) as ProviderId[]).map((id) =>
        providers[id].status({ env: childEnv(env, id, settings), settings })
      )
    )
    return route(
      prompt,
      MODES.filter((m) => m.id !== 'auto'),
      statuses,
      fallback,
      settings
    )
  })

  ipcMain.handle('approval:respond', (_e, requestId: string, decision) => {
    openApprovals.delete(requestId)
    respondApproval(requestId, decision)
  })
  ipcMain.handle('openExternal', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
  })

  // Git
  ipcMain.handle('git:status', async (_e, cwd: string) => git.status(cwd, await loadShellEnv()))
  ipcMain.handle('git:diff', async (_e, cwd: string, path: string) => git.diff(cwd, path, await loadShellEnv()))
  ipcMain.handle('git:pr', async (_e, cwd: string) => git.currentPr(cwd, await loadShellEnv()))

  // Linear (UI reads/updates directly with your personal API key, stored encrypted)
  const linearStatus = async () => {
    const key = await getSecret('linear')
    if (!key) return { connected: false }
    try {
      const v = await linear.viewer(key)
      return { connected: true, user: v.name }
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  const requireKey = async () => {
    const key = await getSecret('linear')
    if (!key) throw new Error('Linear not connected')
    return key
  }
  ipcMain.handle('linear:status', linearStatus)
  ipcMain.handle('linear:setKey', async (_e, key: string) => {
    const trimmed = key.trim()
    try {
      const v = await linear.viewer(trimmed)
      await setSecret('linear', trimmed)
      return { connected: true, user: v.name }
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('linear:clearKey', () => setSecret('linear', null))
  ipcMain.handle('linear:myIssues', async () => linear.myIssues(await requireKey()))
  ipcMain.handle('linear:startWork', async (_e, identifier: string) => {
    if (!(await store.getSettings()).linearAutoMove) return null
    return linear.setState(await requireKey(), identifier, { type: 'started' })
  })
  ipcMain.handle('linear:linkPr', async (_e, identifier: string, url: string) => {
    const key = await requireKey()
    await linear.attachUrl(key, identifier, url, `Pull request`).catch(() => {})
    await linear.comment(key, identifier, `Pull request opened: ${url}`)
    if (!(await store.getSettings()).linearAutoMove) return null
    return linear.setState(key, identifier, { name: 'review' }).catch(() => null)
  })

  // Memory + knowledge
  const notifySources = () => win?.webContents.send('jarvis:sources-changed')
  ipcMain.handle('memory:list', async (_e, query?: string) => {
    if (!query?.trim()) return mem.listMemories()
    const settings = await store.getSettings()
    return mem.searchMemories(query, null, settings, 50).map((r) => r.item)
  })
  ipcMain.handle('memory:add', async (_e, m) => mem.addMemory(m, await store.getSettings()))
  ipcMain.handle('memory:update', async (_e, id: number, patch) => mem.updateMemory(id, patch, await store.getSettings()))
  ipcMain.handle('memory:remove', (_e, id: number) => mem.removeMemory(id))
  ipcMain.handle('memory:sources', () => kb.listSources())
  ipcMain.handle('memory:addSource', async (_e, path: string) => {
    const ok = await stat(path).then(() => true, () => false)
    if (!ok) throw new Error(`Not found: ${path}`)
    const id = kb.addSource(path)
    notifySources()
    void kb.indexSource(id, await store.getSettings(), notifySources)
  })
  ipcMain.handle('memory:removeSource', (_e, id: number) => {
    kb.removeSource(id)
    notifySources()
  })
  ipcMain.handle('memory:reindex', async (_e, id: number) => {
    void kb.indexSource(id, await store.getSettings(), notifySources)
  })
  ipcMain.handle('memory:status', async () => {
    const settings = await store.getSettings()
    const [jev, embeddings] = await Promise.all([jevHealth(settings.jevUrl, true), probeEmbeddings(settings)])
    if (embeddings.online) {
      void mem.backfillMemoryEmbeddings(settings)
      void kb.backfillChunkEmbeddings(settings, notifySources)
    }
    return {
      memories: mem.countMemories(),
      chunks: kb.countChunks(),
      jev: { online: jev.online, url: settings.jevUrl, model: jev.model },
      embeddings,
      learner: {
        engine: settings.learnEngine,
        detail:
          settings.learnEngine === 'claude'
            ? 'Claude Haiku via your subscription (lean: no tools/MCP/hooks)'
            : settings.learnEngine === 'ollama'
              ? `Ollama ${settings.learnOllamaModel}`
              : 'Learning disabled'
      }
    }
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
  await startBridge({
    settings: () => store.getSettings(),
    requestApproval(req) {
      openApprovals.set(req.requestId, req.runId)
      if (!win) return respondApproval(req.requestId, { behavior: 'deny', message: 'Jarvis window closed' })
      win.webContents.send('jarvis:approval', req)
      // Pull attention if Jarvis is in the background.
      if (!win.isFocused()) {
        if (process.platform === 'darwin') app.dock?.bounce('informational')
        win.flashFrame(true)
      }
    }
  })
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
