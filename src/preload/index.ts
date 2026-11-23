import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, ApprovalRequest, JarvisApi, LearnedEvent, Settings, UpdateState, VoiceProgress } from '@shared/types'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void) {
  const listener = (_: unknown, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: JarvisApi = {
  providers: () => ipcRenderer.invoke('providers'),
  run: (req) => ipcRenderer.invoke('run', req),
  cancel: (runId) => ipcRenderer.invoke('cancel', runId),
  onEvent: (cb) => subscribe<[string, AgentEvent]>('jarvis:event', cb),
  onLearned: (cb) => subscribe<[LearnedEvent]>('jarvis:learned', cb),
  route: (prompt, fallback) => ipcRenderer.invoke('route', prompt, fallback),
  onApproval: (cb) => subscribe<[ApprovalRequest]>('jarvis:approval', cb),
  respondApproval: (id, decision) => ipcRenderer.invoke('approval:respond', id, decision),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  git: {
    status: (cwd) => ipcRenderer.invoke('git:status', cwd),
    diff: (cwd, path) => ipcRenderer.invoke('git:diff', cwd, path),
    pr: (cwd) => ipcRenderer.invoke('git:pr', cwd)
  },
  linear: {
    status: () => ipcRenderer.invoke('linear:status'),
    setKey: (key) => ipcRenderer.invoke('linear:setKey', key),
    clearKey: () => ipcRenderer.invoke('linear:clearKey'),
    myIssues: () => ipcRenderer.invoke('linear:myIssues'),
    startWork: (id) => ipcRenderer.invoke('linear:startWork', id),
    linkPr: (id, url) => ipcRenderer.invoke('linear:linkPr', id, url)
  },
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  loadConversations: () => ipcRenderer.invoke('loadConversations'),
  saveConversation: (c) => ipcRenderer.invoke('saveConversation', c),
  deleteConversation: (id) => ipcRenderer.invoke('deleteConversation', id),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('saveSettings', s),
  hotkeyErrors: () => ipcRenderer.invoke('hotkeyErrors'),
  onSettingsChanged: (cb) => subscribe<[Settings]>('jarvis:settings-changed', cb),
  modes: () => ipcRenderer.invoke('modes'),
  memory: {
    list: (q) => ipcRenderer.invoke('memory:list', q),
    add: (m) => ipcRenderer.invoke('memory:add', m),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    remove: (id) => ipcRenderer.invoke('memory:remove', id),
    sources: () => ipcRenderer.invoke('memory:sources'),
    addSource: (p) => ipcRenderer.invoke('memory:addSource', p),
    removeSource: (id) => ipcRenderer.invoke('memory:removeSource', id),
    reindex: (id) => ipcRenderer.invoke('memory:reindex', id),
    status: () => ipcRenderer.invoke('memory:status'),
    onSourcesChanged: (cb) => subscribe<[]>('jarvis:sources-changed', cb)
  },
  onConversationsChanged: (cb) => subscribe<[]>('jarvis:conversations-changed', cb),
  onOpenConversation: (cb) => subscribe<[string]>('jarvis:open-conversation', cb),
  onOpenPanel: (cb) => subscribe<['settings' | 'routines']>('jarvis:open-panel', cb),
  quick: {
    hide: () => ipcRenderer.invoke('quick:hide'),
    resize: (h) => ipcRenderer.invoke('quick:resize', h),
    pin: (p) => ipcRenderer.invoke('quick:pin', p),
    openInMain: (id) => ipcRenderer.invoke('quick:openInMain', id),
    onShow: (cb) => subscribe<[{ voice: boolean; prompt?: string }]>('jarvis:quick-show', cb)
  },
  voice: {
    status: (m) => ipcRenderer.invoke('voice:status', m),
    requestMic: () => ipcRenderer.invoke('voice:requestMic'),
    transcribe: (wav) => ipcRenderer.invoke('voice:transcribe', wav),
    speak: (t) => ipcRenderer.invoke('voice:speak', t),
    say: (t) => ipcRenderer.invoke('voice:say', t),
    stopSpeaking: () => ipcRenderer.invoke('voice:stopSpeaking'),
    onSpeaking: (cb) => subscribe<[boolean]>('jarvis:speaking', cb),
    downloadModel: (name) => ipcRenderer.invoke('voice:downloadModel', name),
    installWhisper: () => ipcRenderer.invoke('voice:installWhisper'),
    downloadNeural: () => ipcRenderer.invoke('voice:downloadNeural'),
    onProgress: (cb) => subscribe<[VoiceProgress]>('jarvis:voice-progress', cb),
    wake: (rest) => ipcRenderer.invoke('voice:wake', rest),
    setLive: (on) => ipcRenderer.invoke('voice:setLive', on),
    onLive: (cb) => subscribe<[boolean]>('jarvis:live', cb),
    onLiveToggle: (cb) => subscribe<[boolean | undefined]>('jarvis:live-toggle', cb)
  },
  routines: {
    list: () => ipcRenderer.invoke('routines:list'),
    save: (r) => ipcRenderer.invoke('routines:save', r),
    remove: (id) => ipcRenderer.invoke('routines:remove', id),
    runNow: (id) => ipcRenderer.invoke('routines:runNow', id),
    onChanged: (cb) => subscribe<[]>('jarvis:routines-changed', cb)
  },
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    probe: (url) => ipcRenderer.invoke('connections:probe', url),
    add: (input) => ipcRenderer.invoke('connections:add', input),
    update: (id, patch) => ipcRenderer.invoke('connections:update', id, patch),
    reconnect: (id, token) => ipcRenderer.invoke('connections:reconnect', id, token),
    remove: (id) => ipcRenderer.invoke('connections:remove', id),
    openBrowser: (id) => ipcRenderer.invoke('connections:openBrowser', id),
    audit: (limit) => ipcRenderer.invoke('connections:audit', limit),
    onChanged: (cb) => subscribe<[]>('jarvis:connections-changed', cb)
  },
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onState: (cb) => subscribe<[UpdateState]>('jarvis:update-state', cb)
  }
}

contextBridge.exposeInMainWorld('jarvis', api)
contextBridge.exposeInMainWorld('jarvisFocus', (cb: () => void) => {
  ipcRenderer.on('jarvis:focus-input', cb)
})
