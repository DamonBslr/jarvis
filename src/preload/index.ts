import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, JarvisApi, LearnedEvent } from '@shared/types'

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
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  loadConversations: () => ipcRenderer.invoke('loadConversations'),
  saveConversation: (c) => ipcRenderer.invoke('saveConversation', c),
  deleteConversation: (id) => ipcRenderer.invoke('deleteConversation', id),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('saveSettings', s),
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
  }
}

contextBridge.exposeInMainWorld('jarvis', api)
contextBridge.exposeInMainWorld('jarvisFocus', (cb: () => void) => {
  ipcRenderer.on('jarvis:focus-input', cb)
})
