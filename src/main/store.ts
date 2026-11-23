import { app } from 'electron'
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Conversation, Settings } from '@shared/types'

const dir = () => join(app.getPath('userData'), 'conversations')
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export const DEFAULT_SETTINGS: Settings = {
  preferSubscription: true,
  ollamaUrl: 'http://127.0.0.1:11434',
  defaultCwd: homedir(),
  hotkey: 'CommandOrControl+Shift+Space',
  jevUrl: 'http://127.0.0.1:8765',
  embedModel: 'embeddinggemma',
  learnEngine: 'claude',
  learnOllamaModel: 'gemma3',
  useMemory: true,
  linearRepoMap: {},
  linearAutoMove: true,
  quickHotkey: 'Alt+Space',
  voiceHotkey: 'Alt+Shift+Space',
  voiceModel: 'base',
  voiceLanguage: 'auto',
  speakReplies: true,
  ttsVoice: '',
  wakeWord: false,
  liveHotkey: 'Alt+Shift+L',
  liveBargeIn: false,
  menuBarOnly: false,
  autoUpdate: true
}

async function atomicWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data, 'utf8')
  await rename(tmp, path)
}

export async function loadConversations(): Promise<Conversation[]> {
  await mkdir(dir(), { recursive: true })
  const files = (await readdir(dir())).filter((f) => f.endsWith('.json'))
  const out: Conversation[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(await readFile(join(dir(), f), 'utf8')))
    } catch {
      /* skip corrupt file */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveConversation(c: Conversation) {
  if (!SAFE_ID.test(c.id)) throw new Error('invalid conversation id')
  await mkdir(dir(), { recursive: true })
  await atomicWrite(join(dir(), `${c.id}.json`), JSON.stringify(c))
}

export async function deleteConversation(id: string) {
  if (!SAFE_ID.test(id)) throw new Error('invalid conversation id')
  await rm(join(dir(), `${id}.json`), { force: true })
}

export async function getSettings(): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(settingsPath(), 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(s: Settings) {
  await mkdir(app.getPath('userData'), { recursive: true })
  await atomicWrite(settingsPath(), JSON.stringify(s, null, 2))
}
