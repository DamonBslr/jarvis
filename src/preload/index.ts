import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, ApprovalRequest, AutomationRunEvent, JarvisApi, LearnedEvent, PanelId, Settings, SyncProgress, UpdateState, VoiceProgress, WebhookRelayStatus } from '@shared/types'

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
  onOpenPanel: (cb) => subscribe<[PanelId, string | undefined]>('jarvis:open-panel', cb),
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
    render: (t) => ipcRenderer.invoke('voice:render', t),
    stopSpeaking: () => ipcRenderer.invoke('voice:stopSpeaking'),
    onSpeaking: (cb) => subscribe<[boolean]>('jarvis:speaking', cb),
    downloadModel: (name) => ipcRenderer.invoke('voice:downloadModel', name),
    installWhisper: () => ipcRenderer.invoke('voice:installWhisper'),
    downloadNeural: () => ipcRenderer.invoke('voice:downloadNeural'),
    downloadGermanVoice: (id) => ipcRenderer.invoke('voice:downloadGermanVoice', id),
    onProgress: (cb) => subscribe<[VoiceProgress]>('jarvis:voice-progress', cb),
    addressed: (req) => ipcRenderer.invoke('voice:addressed', req),
    wake: (rest) => ipcRenderer.invoke('voice:wake', rest),
    setLive: (on) => ipcRenderer.invoke('voice:setLive', on),
    onLive: (cb) => subscribe<[boolean]>('jarvis:live', cb),
    onLiveToggle: (cb) => subscribe<[boolean | undefined]>('jarvis:live-toggle', cb)
  },
  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    save: (a) => ipcRenderer.invoke('automations:save', a),
    remove: (id) => ipcRenderer.invoke('automations:remove', id),
    runNow: (id) => ipcRenderer.invoke('automations:runNow', id),
    onChanged: (cb) => subscribe<[]>('jarvis:automations-changed', cb),
    onRun: (cb) => subscribe<[AutomationRunEvent]>('jarvis:automation-run', cb),
    regenerateToken: (id) => ipcRenderer.invoke('automations:regenerateToken', id),
    setSignatureSecret: (id, secret) => ipcRenderer.invoke('automations:setSignatureSecret', id, secret)
  },
  webhooks: {
    status: () => ipcRenderer.invoke('webhooks:status'),
    setRelaySecret: (secret) => ipcRenderer.invoke('webhooks:setRelaySecret', secret),
    reconnect: () => ipcRenderer.invoke('webhooks:reconnect'),
    onStatus: (cb) => subscribe<[WebhookRelayStatus]>('jarvis:webhook-status', cb)
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
  knowledge: {
    connectors: () => ipcRenderer.invoke('knowledge:connectors'),
    setSource: (id, enabled) => ipcRenderer.invoke('knowledge:setSource', id, enabled),
    discover: () => ipcRenderer.invoke('knowledge:discover'),
    projects: () => ipcRenderer.invoke('knowledge:projects'),
    setFocus: (paths) => ipcRenderer.invoke('knowledge:setFocus', paths),
    updateProject: (id, patch) => ipcRenderer.invoke('knowledge:updateProject', id, patch),
    removeProject: (id) => ipcRenderer.invoke('knowledge:removeProject', id),
    sync: (id) => ipcRenderer.invoke('knowledge:sync', id),
    brief: (projectId) => ipcRenderer.invoke('knowledge:brief', projectId),
    overview: () => ipcRenderer.invoke('knowledge:overview'),
    timeline: (projectId, limit) => ipcRenderer.invoke('knowledge:timeline', projectId, limit),
    search: (q, projectId) => ipcRenderer.invoke('knowledge:search', q, projectId),
    dismissLoop: (key) => ipcRenderer.invoke('knowledge:dismissLoop', key),
    markSeen: () => ipcRenderer.invoke('knowledge:markSeen'),
    onProgress: (cb) => subscribe<[SyncProgress]>('jarvis:knowledge-progress', cb),
    onChanged: (cb) => subscribe<[]>('jarvis:knowledge-changed', cb)
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
