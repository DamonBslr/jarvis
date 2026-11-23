// Auto-update via electron-updater (GitHub Releases feed from electron-builder.yml `publish`).
import { app } from 'electron'
import type { UpdateState } from '@shared/types'

let state: UpdateState = { version: app.getVersion(), packaged: app.isPackaged, status: app.isPackaged ? 'idle' : 'disabled' }
let listener: (s: UpdateState) => void = () => {}
let updater: typeof import('electron-updater').autoUpdater | null = null

const set = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch }
  listener(state)
}

export const updateState = () => state

export async function initUpdater(opts: { auto: boolean; onState: (s: UpdateState) => void }) {
  listener = opts.onState
  // Dev builds have no feed or signature to check against.
  if (!app.isPackaged) return
  // CJS module: the named export can land on .default depending on interop.
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: typeof import('electron-updater').autoUpdater
    default?: { autoUpdater: typeof import('electron-updater').autoUpdater }
  }
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!autoUpdater) return set({ status: 'error', error: 'electron-updater failed to load' })
  updater = autoUpdater
  autoUpdater.autoDownload = opts.auto
  autoUpdater.autoInstallOnAppQuit = opts.auto
  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (i) => set({ status: opts.auto ? 'downloading' : 'available', next: i.version }))
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: p.percent / 100 }))
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', next: i.version, progress: 1 }))
  autoUpdater.on('error', (err) => set({ status: 'error', error: err.message.split('\n')[0] }))
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 20_000)
  setInterval(check, 6 * 3600_000)
}

export async function checkForUpdates() {
  if (!updater) return set({ status: 'disabled' })
  await updater.checkForUpdates().catch((err: Error) => set({ status: 'error', error: err.message }))
}

export async function installUpdate() {
  if (!updater) return
  if (state.status === 'available') {
    set({ status: 'downloading' })
    await updater.downloadUpdate()
    return
  }
  if (state.status === 'ready') updater.quitAndInstall()
}
