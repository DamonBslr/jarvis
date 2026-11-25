import { app, BrowserWindow, dialog, globalShortcut, ipcMain, session, shell, type WebContents } from 'electron'
import { stat, writeFile } from 'node:fs/promises'
import type { AgentEvent, ProviderId, Routine, RunRequest, Settings } from '@shared/types'
import { loadShellEnv } from './shellEnv'
import * as store from './store'
import { MODES } from './modes'
import { route } from './classify/router'
import { jevHealth } from './classify/jev'
import { probeEmbeddings } from './memory/embed'
import * as mem from './memory/memories'
import * as kb from './memory/knowledge'
import * as knowledge from './knowledge'
import * as kstore from './knowledge/store'
import { dismissLoop } from './knowledge/loops'
import { embed } from './memory/embed'
import { startBridge } from './mcp/server'
import { disconnectT3 } from './tools/t3'
import * as connections from './connections'
import * as git from './integrations/git'
import * as linear from './integrations/linear'
import { getSecret, setSecret } from './secrets'
import {
  activeRuns,
  answerApproval,
  cancelAll,
  cancelRun,
  onActiveRunsChanged,
  providerStatuses,
  requestApproval,
  startRun
} from './runner'
import {
  broadcast,
  createMain,
  createQuick,
  getMain,
  getQuick,
  hideQuick,
  isAppUrl,
  pinQuick,
  resizeQuick,
  setDockVisible,
  showMain,
  showQuick,
  toggleMain,
  toggleQuick
} from './windows'
import * as voice from './voice'
import * as routines from './routines'
import { checkForUpdates, initUpdater, installUpdate, updateState } from './updater'
import { createTray, refreshTray, setTrayBusy } from './tray'

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => showMain(true))

// ---- hotkeys --------------------------------------------------------------

const hotkeys = new Map<string, string>() // name -> registered accelerator
const hotkeyErrors: Record<string, string> = {}

function bind(name: string, accel: string, fn: () => void) {
  const prev = hotkeys.get(name)
  if (prev) globalShortcut.unregister(prev)
  hotkeys.delete(name)
  delete hotkeyErrors[name]
  if (!accel) return
  try {
    if (globalShortcut.register(accel, fn)) hotkeys.set(name, accel)
    else hotkeyErrors[name] = `${accel} is taken by another app`
  } catch {
    hotkeyErrors[name] = `${accel} is not a valid shortcut`
  }
}

function registerHotkeys(s: Settings) {
  bind('main', s.hotkey, toggleMain)
  bind('quick', s.quickHotkey, toggleQuick)
  bind('voice', s.voiceHotkey, () => showQuick({ voice: true }))
  bind('live', s.liveHotkey, () => toggleLive())
}

// ---- live mode ------------------------------------------------------------
// The loop itself runs in the main window's renderer (mic, VAD, streaming speech); main only routes
// the toggle and remembers whether it's on so the wake word pauses and the tray shows it.

let liveOn = false
const LIVE_PHRASE = /^(?:(?:start|enter|go|turn on|switch to)\s+)?(?:live|conversation)(?:\s+mode)?\W*$|^let'?s\s+(?:talk|chat)\W*$/i

function toggleLive(start?: boolean) {
  const want = start ?? !liveOn
  if (!want) return void getMain()?.webContents.send('jarvis:live-toggle', false)
  hideQuick()
  const w = showMain()
  const send = () => setTimeout(() => w.webContents.send('jarvis:live-toggle', true), 300)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}

async function applySettings(s: Settings) {
  registerHotkeys(s)
  setDockVisible(!s.menuBarOnly)
  getQuick()?.webContents.send('jarvis:settings-changed', s)
  void refreshTray()
}

function openConversation(convId: string) {
  hideQuick()
  const w = showMain()
  const send = () => setTimeout(() => w.webContents.send('jarvis:open-conversation', convId), 300)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}

function openPanel(panel: 'settings' | 'routines' | 'projects' | 'onboarding') {
  const w = showMain()
  const send = () => setTimeout(() => w.webContents.send('jarvis:open-panel', panel), 300)
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send)
  else send()
}

const routineHooks: routines.RoutineHooks = {
  conversationsChanged: () => broadcast('jarvis:conversations-changed'),
  openConversation
}

// ---- IPC ------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('providers', () => providerStatuses())

  ipcMain.handle('run', async (e, req: RunRequest) => {
    const sender = e.sender
    const send = (ev: AgentEvent) => {
      if (!sender.isDestroyed()) sender.send('jarvis:event', req.runId, ev)
    }
    await startRun(
      req,
      {
        emit: send,
        learned: (ev) => {
          if (!sender.isDestroyed()) sender.send('jarvis:learned', ev)
        }
      },
      sender
    )
  })
  ipcMain.handle('cancel', (_e, runId: string) => cancelRun(runId))

  ipcMain.handle('route', async (_e, prompt: string, fallback: ProviderId) => {
    const [statuses, settings] = await Promise.all([providerStatuses(), store.getSettings()])
    return route(
      prompt,
      MODES.filter((m) => m.id !== 'auto'),
      statuses,
      fallback,
      settings
    )
  })

  ipcMain.handle('approval:respond', (_e, requestId: string, decision) => answerApproval(requestId, decision))
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
  const notifySources = () => getMain()?.webContents.send('jarvis:sources-changed')
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

  ipcMain.handle('pickFolder', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const r = await (parent
      ? dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }))
    return r.canceled ? null : r.filePaths[0]
  })

  // Conversations: tell the other windows when one changes so lists stay in sync.
  const othersChanged = (sender: WebContents) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== sender && !w.webContents.isDestroyed()) w.webContents.send('jarvis:conversations-changed')
    }
  }
  ipcMain.handle('loadConversations', () => store.loadConversations())
  ipcMain.handle('saveConversation', async (e, c) => {
    await store.saveConversation(c)
    othersChanged(e.sender)
  })
  ipcMain.handle('deleteConversation', async (e, id: string) => {
    await store.deleteConversation(id)
    othersChanged(e.sender)
  })
  ipcMain.handle('getSettings', () => store.getSettings())
  ipcMain.handle('saveSettings', async (_e, s: Settings) => {
    const before = await store.getSettings()
    await store.saveSettings(s)
    // Turning T3 tools off revokes Jarvis's T3 session instead of leaving a 30-day token around.
    if (before.t3Tools && !s.t3Tools) void loadShellEnv().then(disconnectT3).catch(() => {})
    await applySettings(s)
    return { ...hotkeyErrors }
  })
  ipcMain.handle('hotkeyErrors', () => ({ ...hotkeyErrors }))
  ipcMain.handle('modes', () => MODES)

  // Quick bar
  ipcMain.handle('quick:hide', () => hideQuick())
  ipcMain.handle('quick:resize', (_e, h: number) => resizeQuick(h))
  ipcMain.handle('quick:pin', (_e, pinned: boolean) => pinQuick(pinned))
  ipcMain.handle('quick:openInMain', (_e, convId: string) => openConversation(convId))

  // Voice
  const voiceProgress = (p: unknown) => broadcast('jarvis:voice-progress', p)
  voice.setSpeakingListener((on) => broadcast('jarvis:speaking', on))
  ipcMain.handle('voice:status', async (_e, model?: string) => {
    const s = await store.getSettings()
    return voice.voiceStatus(model ? { ...s, voiceModel: model } : s)
  })
  ipcMain.handle('voice:requestMic', () => voice.requestMic())
  ipcMain.handle('voice:transcribe', async (_e, wav: ArrayBuffer) =>
    voice.transcribe(new Uint8Array(wav), await store.getSettings())
  )
  ipcMain.handle('voice:speak', async (_e, text: string) => voice.speak(text, await store.getSettings()))
  ipcMain.handle('voice:stopSpeaking', () => voice.stopSpeaking())
  ipcMain.handle('voice:downloadModel', (_e, name: string) => voice.downloadModel(name, voiceProgress))
  ipcMain.handle('voice:installWhisper', () => voice.installWhisper(voiceProgress))
  ipcMain.handle('voice:downloadNeural', () => voice.downloadNeural(voiceProgress))
  ipcMain.handle('voice:downloadGermanVoice', (_e, id: string) => voice.downloadGermanVoice(id, voiceProgress))
  ipcMain.handle('voice:say', async (_e, text: string) => voice.say(text, await store.getSettings()))
  ipcMain.handle('voice:wake', (_e, rest: string) => {
    if (LIVE_PHRASE.test(rest.trim())) return toggleLive(true)
    showQuick({ voice: !rest.trim(), prompt: rest.trim() || undefined })
  })
  ipcMain.handle('voice:setLive', (_e, on: boolean) => {
    liveOn = on
    broadcast('jarvis:live', on)
    void refreshTray()
  })

  // Routines
  ipcMain.handle('routines:list', async () =>
    (await routines.listRoutines()).map((r) => ({ ...r, running: routines.isRunning(r.id) }))
  )
  ipcMain.handle('routines:save', (_e, r: Routine) => routines.saveRoutine(r))
  ipcMain.handle('routines:remove', (_e, id: string) => routines.removeRoutine(id))
  ipcMain.handle('routines:runNow', (_e, id: string) => {
    void routines.runRoutine(id, routineHooks).finally(() => broadcast('jarvis:routines-changed'))
    setTimeout(() => broadcast('jarvis:routines-changed'), 50)
  })

  // Connections: services agents use with your access (OAuth sign-in opens your browser).
  const openSignIn = async (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error('refusing to open a non-http URL')
    await shell.openExternal(url)
  }
  ipcMain.handle('connections:list', () => connections.connectionStatuses())
  ipcMain.handle('connections:probe', (_e, url: string) => connections.probeConnection(String(url)))
  ipcMain.handle('connections:add', (_e, input) => connections.addConnection(input, openSignIn))
  ipcMain.handle('connections:update', (_e, id: string, patch) => connections.updateConnection(String(id), patch ?? {}))
  ipcMain.handle('connections:reconnect', (_e, id: string, token?: string) =>
    connections.reconnect(String(id), openSignIn, typeof token === 'string' ? token : undefined)
  )
  ipcMain.handle('connections:remove', (_e, id: string) => connections.removeConnection(String(id)))
  ipcMain.handle('connections:openBrowser', async (_e, id: string) =>
    connections.openConnectionBrowser(String(id), await loadShellEnv())
  )
  ipcMain.handle('connections:audit', (_e, limit?: number) => connections.readAudit(Math.min(Math.max(Number(limit) || 50, 1), 500)))

  // Knowledge: connectors, focus projects, sync, briefs, overview
  ipcMain.handle('knowledge:connectors', () => knowledge.connectorInfos())
  ipcMain.handle('knowledge:setSource', async (_e, id, enabled: boolean) => {
    if (!knowledge.connector(id)) throw new Error(`unknown source ${String(id)}`)
    const s = await knowledge.setSource(id, !!enabled)
    broadcast('jarvis:settings-changed', s)
    if (enabled) void knowledge.sync({ only: id, briefs: false })
  })
  ipcMain.handle('knowledge:discover', () => knowledge.discover())
  ipcMain.handle('knowledge:projects', () => kstore.listProjects())
  ipcMain.handle('knowledge:setFocus', (_e, paths: unknown) =>
    knowledge.setFocus(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string').slice(0, 12) : [])
  )
  ipcMain.handle('knowledge:updateProject', (_e, id: string, patch) => {
    const { name, focus, notes, github, linearTeam, linearProject } = (patch ?? {}) as Record<string, unknown>
    kstore.updateProject(String(id), {
      name: typeof name === 'string' ? name : undefined,
      focus: typeof focus === 'boolean' ? focus : undefined,
      notes: typeof notes === 'string' ? notes : undefined,
      github: typeof github === 'string' ? github : undefined,
      linearTeam: typeof linearTeam === 'string' ? linearTeam : undefined,
      linearProject: typeof linearProject === 'string' ? linearProject : undefined
    })
    broadcast('jarvis:knowledge-changed')
  })
  ipcMain.handle('knowledge:removeProject', (_e, id: string) => {
    kstore.removeProject(String(id))
    broadcast('jarvis:knowledge-changed')
  })
  ipcMain.handle('knowledge:sync', (_e, id?: string) =>
    knowledge.sync(id && knowledge.connector(id as never) ? { only: id as never, briefs: false } : { briefs: true })
  )
  ipcMain.handle('knowledge:brief', (_e, projectId?: string) => knowledge.refreshBriefs(typeof projectId === 'string' ? projectId : undefined))
  ipcMain.handle('knowledge:overview', () => knowledge.overview())
  ipcMain.handle('knowledge:timeline', (_e, projectId: string, limit?: number) =>
    kstore.recentItems({ projectId: String(projectId), limit: Math.min(Math.max(Number(limit) || 60, 1), 300) })
  )
  ipcMain.handle('knowledge:search', async (_e, query: string, projectId?: string) => {
    const settings = await store.getSettings()
    const q = String(query ?? '')
    const vec = (await embed([q], settings))?.[0] ?? null
    return kstore.searchItems(q, vec, settings, { projectId: projectId || undefined, limit: 30 }).map((h) => h.item)
  })
  ipcMain.handle('knowledge:dismissLoop', (_e, key: string) => {
    dismissLoop(String(key))
    broadcast('jarvis:knowledge-changed')
  })
  ipcMain.handle('knowledge:markSeen', () => knowledge.markSeen())

  // Updates
  ipcMain.handle('updates:state', () => updateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:install', () => installUpdate())
}

// ---- permissions ----------------------------------------------------------

function lockDownPermissions() {
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'notifications'])
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (!isAppUrl(wc.getURL()) || !allowed.has(permission)) return cb(false)
    if (permission === 'media') {
      // Microphone only; never the camera or screen.
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      return cb(types.length > 0 && types.every((t) => t === 'audio'))
    }
    cb(true)
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) => !!wc && isAppUrl(wc.getURL()) && allowed.has(permission))
}

// ---- dev screenshot hook --------------------------------------------------
// JARVIS_SCREENSHOT=/tmp/x.png captures a window after load and quits.
// JARVIS_SCREENSHOT_TARGET=quick shows the quick bar; JARVIS_SCREENSHOT_PROMPT types + sends a prompt;
// JARVIS_SCREENSHOT_EVAL runs JS in the target first; JARVIS_SCREENSHOT_AUTOCLICK clicks a selector repeatedly.

function devScreenshot() {
  const shot = process.env.JARVIS_SCREENSHOT
  if (!shot) return
  const quick = process.env.JARVIS_SCREENSHOT_TARGET === 'quick'
  if (quick) setTimeout(() => showQuick({ voice: false }), 1500)
  const target = () => (quick ? getQuick() : getMain())!
  setTimeout(() => {
    const wc = target().webContents
    const js = process.env.JARVIS_SCREENSHOT_EVAL
    if (js) void wc.executeJavaScript(js)
    const autoclick = process.env.JARVIS_SCREENSHOT_AUTOCLICK
    if (autoclick) {
      setInterval(() => void target().webContents.executeJavaScript(`document.querySelector(${JSON.stringify(autoclick)})?.click()`), 1500)
    }
    const prompt = process.env.JARVIS_SCREENSHOT_PROMPT
    if (prompt) {
      void wc.executeJavaScript(`(() => {
        const ta = document.querySelector('textarea, input.quick-input')
        const proto = ta instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, ${JSON.stringify(prompt)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        setTimeout(() => (document.querySelector('.send') ?? ta).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 100)
        setTimeout(() => document.querySelector('.send')?.click(), 150)
      })()`)
    }
  }, 4000)
  setTimeout(async () => {
    const img = await target().webContents.capturePage()
    await writeFile(shot, img.toPNG())
    app.quit()
  }, Number(process.env.JARVIS_SCREENSHOT_DELAY ?? 6000))
}

// ---- boot -----------------------------------------------------------------

let quitting = false

app.whenReady().then(async () => {
  void loadShellEnv() // warm up; first run spawns a login shell
  lockDownPermissions()
  await startBridge({ settings: () => store.getSettings(), requestApproval })
  connections.onConnectionsChanged(() => broadcast('jarvis:connections-changed'))
  knowledge.onKnowledgeEvents({
    progress: (p) => broadcast('jarvis:knowledge-progress', p),
    changed: () => broadcast('jarvis:knowledge-changed')
  })
  registerIpc()

  const settings = await store.getSettings()
  setDockVisible(!settings.menuBarOnly)
  if (!settings.menuBarOnly || process.env.JARVIS_SCREENSHOT) createMain()
  createQuick()
  registerHotkeys(settings)

  createTray({
    settings: () => store.getSettings(),
    routines: () => routines.listRoutines(),
    update: updateState,
    openMain: () => showMain(true),
    openQuick: (v) => showQuick({ voice: v }),
    live: () => liveOn,
    toggleLive: () => toggleLive(),
    openPanel,
    runRoutine: (id) => void routines.runRoutine(id, routineHooks).finally(() => broadcast('jarvis:routines-changed')),
    setWakeWord: async (on) => {
      const s = { ...(await store.getSettings()), wakeWord: on }
      await store.saveSettings(s)
      await applySettings(s)
      broadcast('jarvis:settings-changed', s)
    },
    installUpdate: () => void installUpdate(),
    quit: () => app.quit()
  })
  onActiveRunsChanged((n) => setTrayBusy(n > 0))

  knowledge.startKnowledgeScheduler()
  routines.startScheduler(routineHooks, () => {
    broadcast('jarvis:routines-changed')
    void refreshTray()
  })
  void initUpdater({
    auto: settings.autoUpdate,
    onState: (s) => {
      broadcast('jarvis:update-state', s)
      void refreshTray()
    }
  })
  devScreenshot()

  app.on('activate', () => showMain())
})

app.on('before-quit', (e) => {
  if (quitting || activeRuns() === 0 || process.env.JARVIS_SCREENSHOT) return
  // Don't silently kill agents mid-edit.
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Quit and stop agents', 'Cancel'],
    defaultId: 1,
    message: `${activeRuns()} agent run(s) still working. Quit anyway?`
  })
  if (choice !== 0) e.preventDefault()
  else quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  voice.shutdownSpeech()
  cancelAll()
})

// Jarvis lives in the menu bar: closing windows never quits (Quit from the tray or ⌘Q).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
