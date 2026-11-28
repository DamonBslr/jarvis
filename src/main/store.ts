import { app } from 'electron'
import { mkdir, readdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Conversation, Settings } from '@shared/types'
import { DEFAULT_GERMAN_VOICE, languageOf } from '@shared/language'

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
  language: 'en',
  speakReplies: true,
  ttsVoice: '',
  ttsEngine: 'neural',
  neuralVoice: 'bm_george',
  germanVoice: DEFAULT_GERMAN_VOICE,
  ttsSpeed: 1.05,
  wakeWord: false,
  liveHotkey: 'Alt+Shift+L',
  liveBargeIn: false,
  liveAddressing: 'smart',
  menuBarOnly: false,
  autoUpdate: true,
  computerUse: false,
  browserTool: true,
  browserVisible: true,
  t3Tools: false,
  // Local readers default on once the user finishes setup; setup shows each one for consent.
  syncSources: {},
  syncIntervalMin: 20,
  projectBriefs: true,
  codeRoots: [],
  webhookRelayUrl: ''
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
      out.push(normalize(JSON.parse(await readFile(join(dir(), f), 'utf8'))))
    } catch {
      /* skip corrupt file */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Older builds called automations "routines". */
function normalize(c: Conversation & { routineId?: string }): Conversation {
  if (c.routineId && !c.automationId) c.automationId = c.routineId
  delete c.routineId
  return c
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  if (!SAFE_ID.test(id)) return null
  try {
    return normalize(JSON.parse(await readFile(join(dir(), `${id}.json`), 'utf8')))
  } catch {
    return null
  }
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
    const saved = JSON.parse(await readFile(settingsPath(), 'utf8'))
    // Older builds had a transcription-only "voiceLanguage" (often "auto"); only an explicit German choice carries over.
    if (saved.language === undefined && saved.voiceLanguage === 'de') saved.language = 'de'
    delete saved.voiceLanguage
    const s: Settings = { ...DEFAULT_SETTINGS, ...saved }
    return { ...s, language: languageOf(s.language) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(s: Settings) {
  await mkdir(app.getPath('userData'), { recursive: true })
  await atomicWrite(settingsPath(), JSON.stringify(s, null, 2))
}
