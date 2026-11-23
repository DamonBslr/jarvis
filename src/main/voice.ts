// Local speech: whisper.cpp for speech-to-text, macOS `say` for replies. Nothing leaves the machine.
import { app, systemPreferences } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Settings, VoiceProgress, VoiceStatus } from '@shared/types'
import { runOnce } from './providers/spawn'
import { loadShellEnv } from './shellEnv'

export const VOICE_MODELS: Record<string, number> = {
  'tiny.en': 75,
  tiny: 75,
  'base.en': 142,
  base: 142,
  'small.en': 466,
  small: 466,
  'large-v3-turbo-q5_0': 547
}

const whisperDir = () => join(app.getPath('userData'), 'whisper')
const modelPath = (name: string) => join(app.getPath('userData'), 'models', `ggml-${name}.bin`)

export function resourcePath(name: string) {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)
}

const exists = (p: string) => access(p, constants.X_OK).then(() => true, () => false)

/** Our own build first (userData/whisper/bin), then whatever is on the login-shell PATH. */
async function findWhisper(): Promise<string | null> {
  const own = join(whisperDir(), 'bin', 'whisper-cli')
  if (await exists(own)) return own
  const env = await loadShellEnv()
  for (const dir of (env.PATH ?? '').split(':')) {
    for (const name of ['whisper-cli', 'whisper-cpp']) {
      const p = join(dir, name)
      if (dir && (await exists(p))) return p
    }
  }
  return null
}

let voicesCache: string[] | null = null
async function listVoices(): Promise<string[]> {
  if (voicesCache) return voicesCache
  if (process.platform !== 'darwin') return []
  try {
    const out = await runOnce('say', ['-v', '?'], { timeoutMs: 5000 })
    voicesCache = out
      .split('\n')
      .map((l) => l.match(/^(.+?)\s{2,}[a-z]{2}[_-]/i)?.[1]?.trim())
      .filter((v): v is string => !!v)
    return voicesCache
  } catch {
    return []
  }
}

export async function voiceStatus(settings: Settings): Promise<VoiceStatus> {
  const [whisper, size, voices] = await Promise.all([
    findWhisper(),
    stat(modelPath(settings.voiceModel)).then((s) => s.size, () => 0),
    listVoices()
  ])
  const mic = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
  return {
    whisper: { found: !!whisper, path: whisper ?? undefined },
    model: { name: settings.voiceModel, downloaded: size > 1_000_000, sizeMb: VOICE_MODELS[settings.voiceModel] },
    micAccess: mic as VoiceStatus['micAccess'],
    voices
  }
}

export async function requestMic(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
  return systemPreferences.askForMediaAccess('microphone')
}

type Progress = (p: VoiceProgress) => void

export async function downloadModel(name: string, onProgress: Progress) {
  if (!(name in VOICE_MODELS)) throw new Error(`Unknown model ${name}`)
  const dest = modelPath(name)
  await mkdir(join(app.getPath('userData'), 'models'), { recursive: true })
  const part = `${dest}.part`
  try {
    const res = await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`)
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    let got = 0
    let lastPct = -1
    const body = Readable.fromWeb(res.body as any)
    body.on('data', (c: Buffer) => {
      got += c.length
      const pct = total ? Math.floor((got / total) * 100) : 0
      if (pct !== lastPct) {
        lastPct = pct
        onProgress({ task: 'model', progress: pct / 100 })
      }
    })
    await pipeline(body, createWriteStream(part))
    await rename(part, dest)
    onProgress({ task: 'model', done: true })
  } catch (err) {
    await rm(part, { force: true })
    onProgress({ task: 'model', error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/** Build whisper-cli from source into userData (works without a writable Homebrew). */
export async function installWhisper(onProgress: Progress) {
  const env = await loadShellEnv()
  return new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [resourcePath('install-whisper.sh'), whisperDir()], { env })
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      for (const line of d.split('\n')) if (line.startsWith('step: ')) onProgress({ task: 'whisper', step: line.slice(6) })
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-2000)))
    child.on('close', (code) => {
      if (code === 0) {
        onProgress({ task: 'whisper', done: true })
        resolve()
      } else {
        const msg = err.trim().split('\n').pop() || `installer exited with ${code}`
        onProgress({ task: 'whisper', error: msg })
        reject(new Error(msg))
      }
    })
  })
}

// Whisper hallucinates these on silence/noise.
const NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|thank you\.?|thanks for watching!?|you|\.)\s*$/i

export async function transcribe(wav: Uint8Array, settings: Settings): Promise<string> {
  const bin = await findWhisper()
  if (!bin) throw new Error('whisper.cpp is not installed (Settings → Voice → Install)')
  const model = modelPath(settings.voiceModel)
  if (!(await stat(model).then(() => true, () => false))) throw new Error(`Voice model ${settings.voiceModel} not downloaded`)
  const file = join(tmpdir(), `jarvis-${randomUUID()}.wav`)
  await writeFile(file, wav)
  try {
    const lang = settings.voiceModel.endsWith('.en') ? 'en' : settings.voiceLanguage || 'auto'
    // A short vocabulary prompt steers whisper toward the words Jarvis hears most.
    const vocab = 'Jarvis, pull request, PR, Linear, GitHub, commit, branch, merge, rebase, Claude, Codex, repo, ticket.'
    const out = await runOnce(bin, ['-m', model, '-f', file, '-l', lang, '-nt', '-np', '-t', '4', '--prompt', vocab], {
      timeoutMs: 60_000
    })
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !NOISE.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  } finally {
    await rm(file, { force: true })
  }
}

let speaking: ChildProcess | null = null
let onSpeaking: (on: boolean) => void = () => {}
export function setSpeakingListener(fn: (on: boolean) => void) {
  onSpeaking = fn
}

export function stopSpeaking() {
  if (!speaking) return
  speaking.kill('SIGTERM')
  speaking = null
  onSpeaking(false)
}

export function speak(text: string, settings: Settings) {
  stopSpeaking()
  if (!text.trim() || process.platform !== 'darwin') return
  const args = settings.ttsVoice ? ['-v', settings.ttsVoice] : []
  const child = spawn('say', [...args, '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.end(text)
  child.on('close', () => {
    if (speaking === child) {
      speaking = null
      onSpeaking(false)
    }
  })
  speaking = child
  onSpeaking(true)
}
