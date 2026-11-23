// Menu-bar icon: quick ask, voice, routines, wake-word toggle, updates.
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { Routine, Settings, UpdateState } from '@shared/types'
import { resourcePath } from './voice'

export interface TrayDeps {
  settings(): Promise<Settings>
  routines(): Promise<Routine[]>
  update(): UpdateState
  openMain(): void
  openQuick(voice: boolean): void
  live(): boolean
  toggleLive(): void
  openPanel(panel: 'settings' | 'routines'): void
  runRoutine(id: string): void
  setWakeWord(on: boolean): void
  installUpdate(): void
  quit(): void
}

let tray: Tray | null = null
let deps: TrayDeps
let busy = false

const pretty = (accel: string) =>
  accel
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, '⌘')
    .replace(/Control|Ctrl/g, '⌃')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '')

function icon(active: boolean) {
  const img = nativeImage.createFromPath(resourcePath(active ? 'trayActiveTemplate.png' : 'trayTemplate.png'))
  img.setTemplateImage(true)
  return img
}

export async function refreshTray() {
  if (!tray) return
  const [s, routines] = await Promise.all([deps.settings(), deps.routines()])
  const u = deps.update()
  const items: MenuItemConstructorOptions[] = [
    { label: `Ask Jarvis…    ${pretty(s.quickHotkey)}`, click: () => deps.openQuick(false) },
    { label: `Talk to Jarvis    ${pretty(s.voiceHotkey)}`, click: () => deps.openQuick(true) },
    {
      label: deps.live() ? 'End live conversation' : `Live conversation    ${pretty(s.liveHotkey)}`,
      click: () => deps.toggleLive()
    },
    { label: `Open Jarvis    ${pretty(s.hotkey)}`, click: () => deps.openMain() },
    { type: 'separator' },
    {
      label: 'Routines',
      submenu: [
        ...routines.map<MenuItemConstructorOptions>((r) => ({
          label: `Run “${r.name}” now`,
          click: () => deps.runRoutine(r.id)
        })),
        ...(routines.length ? [{ type: 'separator' } as const] : []),
        { label: 'Manage routines…', click: () => deps.openPanel('routines') }
      ]
    },
    {
      label: 'Listen for “Jarvis”',
      type: 'checkbox',
      checked: s.wakeWord,
      click: (item) => deps.setWakeWord(item.checked)
    },
    { type: 'separator' }
  ]
  if (u.status === 'ready') items.push({ label: `Restart to update to ${u.next}`, click: () => deps.installUpdate() })
  else if (u.status === 'available') items.push({ label: `Download update ${u.next}`, click: () => deps.installUpdate() })
  else if (u.status === 'downloading')
    items.push({ label: `Downloading update… ${Math.round((u.progress ?? 0) * 100)}%`, enabled: false })
  items.push(
    { label: 'Settings…', click: () => deps.openPanel('settings') },
    { label: 'Quit Jarvis', accelerator: 'CommandOrControl+Q', click: () => deps.quit() }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(busy ? 'Jarvis — working…' : 'Jarvis')
}

export function createTray(d: TrayDeps) {
  deps = d
  tray = new Tray(icon(false))
  void refreshTray()
}

/** Animated-looking icon while any agent run is in flight. */
export function setTrayBusy(active: boolean) {
  if (!tray || busy === active) return
  busy = active
  tray.setImage(icon(active))
  tray.setToolTip(active ? 'Jarvis — working…' : 'Jarvis')
}
