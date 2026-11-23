import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, JarvisApi } from '@shared/types'

const api: JarvisApi = {
  providers: () => ipcRenderer.invoke('providers'),
  run: (req) => ipcRenderer.invoke('run', req),
  cancel: (runId) => ipcRenderer.invoke('cancel', runId),
  onEvent(cb) {
    const listener = (_: unknown, runId: string, ev: AgentEvent) => cb(runId, ev)
    ipcRenderer.on('jarvis:event', listener)
    return () => ipcRenderer.removeListener('jarvis:event', listener)
  },
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  loadConversations: () => ipcRenderer.invoke('loadConversations'),
  saveConversation: (c) => ipcRenderer.invoke('saveConversation', c),
  deleteConversation: (id) => ipcRenderer.invoke('deleteConversation', id),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('saveSettings', s),
  modes: () => ipcRenderer.invoke('modes')
}

contextBridge.exposeInMainWorld('jarvis', api)
contextBridge.exposeInMainWorld('jarvisFocus', (cb: () => void) => {
  ipcRenderer.on('jarvis:focus-input', cb)
})
