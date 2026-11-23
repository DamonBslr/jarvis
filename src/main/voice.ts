// Local speech: whisper.cpp for speech-to-text, Kokoro (neural) or macOS `say` for replies. Nothing leaves the machine.
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
  const [whisper, size, voices, neural] = await Promise.all([
    findWhisper(),
    stat(modelPath(settings.voiceModel)).then((s) => s.size, () => 0),
    listVoices(),
    neuralStatus()
  ])
  const mic = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
  return {
    whisper: { found: !!whisper, path: whisper ?? undefined },
    model: { name: settings.voiceModel, downloaded: size > 1_000_000, sizeMb: VOICE_MODELS[settings.voiceModel] },
    micAccess: mic as VoiceStatus['micAccess'],
    voices,
    neural
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

// ---- neural voice (Kokoro-82M, ONNX, on this Mac) ----------------------------------------
// A long-lived Python worker (run by uv) turns text into WAV files; afplay plays them.

const NEURAL_FILES = [
  { name: 'kokoro-v1.0.onnx', mb: 311 },
  { name: 'voices-v1.0.bin', mb: 27 }
]
const NEURAL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
const neuralDir = () => join(app.getPath('userData'), 'kokoro')

async function findUv(): Promise<string | null> {
  const env = await loadShellEnv()
  const dirs = [...(env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', join(app.getPath('home'), '.local', 'bin')]
  for (const dir of dirs) if (dir && (await exists(join(dir, 'uv')))) return join(dir, 'uv')
  return null
}

const neuralDownloaded = async () =>
  (await Promise.all(NEURAL_FILES.map((f) => stat(join(neuralDir(), f.name)).then((s) => s.size > 1_000_000, () => false)))).every(Boolean)

async function neuralStatus(): Promise<VoiceStatus['neural']> {
  const [uv, downloaded] = await Promise.all([findUv(), neuralDownloaded()])
  return { uv: !!uv, downloaded, sizeMb: NEURAL_FILES.reduce((n, f) => n + f.mb, 0) }
}

async function runWorker(args: string[], timeoutMs: number) {
  const uv = await findUv()
  if (!uv) throw new Error('uv is not installed (brew install uv)')
  await runOnce(uv, ['run', '--script', '--quiet', resourcePath('kokoro-worker.py'), neuralDir(), ...args], {
    timeoutMs,
    env: await loadShellEnv()
  })
}

/** Download the Kokoro model + voices, then let uv install the runtime once so the first reply is instant. */
export async function downloadNeural(onProgress: Progress) {
  await mkdir(neuralDir(), { recursive: true })
  const total = NEURAL_FILES.reduce((n, f) => n + f.mb, 0)
  let doneMb = 0
  try {
    for (const f of NEURAL_FILES) {
      const dest = join(neuralDir(), f.name)
      if (await stat(dest).then((s) => s.size > 1_000_000, () => false)) {
        doneMb += f.mb
        continue
      }
      const part = `${dest}.part`
      try {
        const res = await fetch(`${NEURAL_URL}/${f.name}`)
        if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
        let got = 0
        let lastPct = -1
        const body = Readable.fromWeb(res.body as any)
        body.on('data', (c: Buffer) => {
          got += c.length
          const pct = Math.floor(((doneMb + got / 1e6) / total) * 100)
          if (pct !== lastPct && pct < 100) {
            lastPct = pct
            onProgress({ task: 'neural', progress: pct / 100, step: 'Downloading voice model' })
          }
        })
        await pipeline(body, createWriteStream(part))
        await rename(part, dest)
      } finally {
        await rm(part, { force: true })
      }
      doneMb += f.mb
    }
    onProgress({ task: 'neural', progress: 1, step: 'Installing speech runtime (one time)…' })
    await runWorker(['--warmup'], 10 * 60_000)
    neuralBrokenUntil = 0
    onProgress({ task: 'neural', done: true })
  } catch (err) {
    onProgress({ task: 'neural', error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

let neuralBrokenUntil = 0
let neuralCheck: { at: number; ok: boolean } | null = null
async function neuralAvailable(): Promise<boolean> {
  if (Date.now() < neuralBrokenUntil) return false
  if (neuralCheck && Date.now() - neuralCheck.at < 30_000) return neuralCheck.ok
  const st = await neuralStatus()
  neuralCheck = { at: Date.now(), ok: st.uv && st.downloaded }
  return neuralCheck.ok
}

class NeuralWorker {
  private child: ChildProcess | null = null
  private waiting = new Map<string, (ok: boolean) => void>()
  private buf = ''
  private stderr = ''
  private idle: NodeJS.Timeout | null = null
  private startedAt = 0

  private async ensure(): Promise<ChildProcess> {
    if (this.child) return this.child
    const uv = await findUv()
    if (!uv) throw new Error('uv not found')
    if (this.child) return this.child // another call started it while we looked for uv
    const child = spawn(uv, ['run', '--script', '--quiet', resourcePath('kokoro-worker.py'), neuralDir()], {
      env: await loadShellEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.startedAt = Date.now()
    this.stderr = ''
    child.stdin!.on('error', () => {})
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        let msg: { id?: string; ok?: boolean; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.error) console.warn('[tts]', msg.error)
        if (msg.id) {
          this.waiting.get(msg.id)?.(!!msg.ok)
          this.waiting.delete(msg.id)
        }
      }
    })
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-2000)))
    const gone = (code: number | null) => {
      if (this.child !== child) return
      this.child = null
      this.buf = ''
      for (const done of this.waiting.values()) done(false)
      this.waiting.clear()
      // Died on its own soon after starting: broken setup. Use the system voice for a while instead of retrying per sentence.
      if (code !== 0 && code !== null && Date.now() - this.startedAt < 20_000) {
        neuralBrokenUntil = Date.now() + 60_000
        console.warn('[tts] neural voice failed to start:', this.stderr.trim().split('\n').pop())
      }
    }
    child.on('exit', gone)
    child.on('error', () => gone(1))
    return child
  }

  async synth(text: string, voice: string, speed: number): Promise<string | null> {
    if (this.idle) clearTimeout(this.idle)
    // Idle workers hold ~400 MB; let them go after 10 quiet minutes.
    this.idle = setTimeout(() => this.stop(), 10 * 60_000)
    let child: ChildProcess
    try {
      child = await this.ensure()
    } catch {
      return null
    }
    const id = randomUUID()
    const out = join(tmpdir(), `jarvis-tts-${id}.wav`)
    return new Promise((resolve) => {
      this.waiting.set(id, (ok) => {
        if (ok) resolve(out)
        else {
          void rm(out, { force: true })
          resolve(null)
        }
      })
      child.stdin!.write(JSON.stringify({ id, text, voice, speed, out }) + '\n')
    })
  }

  /** Drop everything not yet synthesized (they resolve to null). */
  cancel() {
    this.child?.stdin?.write('{"cancel": true}\n')
  }

  stop() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.child?.kill('SIGTERM')
  }
}
const worker = new NeuralWorker()

// Kokoro can't speak German; with "auto" language a German answer goes to the system voice instead of an English accent.
const GERMAN = /\b(und|der|die|das|ist|nicht|ich|ein|eine|mit|für|auf|den|dem|du|sie|wir|auch|noch|bitte|kann|habe|hast|wird|sind)\b/gi
function looksGerman(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length
  const hits = text.match(GERMAN)?.length ?? 0
  return words > 0 && hits / words > 0.12
}

const NEURAL_LANG: Record<string, string> = { a: 'en', b: 'en', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt', z: 'zh' }

type Engine = { kind: 'neural'; voice: string; speed: number; fallback: string } | { kind: 'system'; voice: string }

async function pickEngine(text: string, settings: Settings): Promise<Engine> {
  const system: Engine = { kind: 'system', voice: settings.ttsVoice }
  if (settings.ttsEngine !== 'neural' || !(await neuralAvailable())) return system
  const voice = settings.neuralVoice || 'bm_george'
  const lang = NEURAL_LANG[voice[0]] ?? 'en'
  const spoken = settings.voiceModel.endsWith('.en') ? 'en' : settings.voiceLanguage || 'auto'
  if (spoken !== 'auto' && spoken !== lang) return system
  if (lang === 'en' && looksGerman(text)) return system
  return { kind: 'neural', voice, speed: Math.min(1.6, Math.max(0.6, settings.ttsSpeed || 1)), fallback: settings.ttsVoice }
}

// Spoken output is a queue so live mode can stream an answer sentence by sentence.
// Neural chunks are synthesized as soon as they're queued (the next sentence renders while this one plays);
// system chunks queued together go out as one `say` process. Each promise resolves when its chunk ends or is cut off.
interface SayJob {
  text: string
  engine: Engine
  done: () => void
  wav?: Promise<string | null>
}
const queue: SayJob[] = []
let current: { child: ChildProcess; jobs: SayJob[] } | null = null
/** Neural job taken off the queue whose audio is still rendering. */
let rendering: SayJob | null = null
let generation = 0
let enqueueing: Promise<void> = Promise.resolve()
let speakingNow = false
let onSpeaking: (on: boolean) => void = () => {}
export function setSpeakingListener(fn: (on: boolean) => void) {
  onSpeaking = fn
}

function setSpeaking(on: boolean) {
  if (speakingNow === on) return
  speakingNow = on
  onSpeaking(on)
}

const sayProcess = (voice: string, text: string) => {
  const child = spawn('say', [...(voice ? ['-v', voice] : []), '-f', '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin!.on('error', () => {}) // killed before stdin drained
  child.stdin!.end(text)
  return child
}

function play(child: ChildProcess, jobs: SayJob[], file: string | null) {
  current = { child, jobs }
  const finish = () => {
    if (file) void rm(file, { force: true })
    if (current?.child !== child) return
    current = null
    for (const j of jobs) j.done()
    pump()
  }
  child.on('close', finish)
  child.on('error', finish)
}

function pump() {
  if (current || rendering) return
  if (!queue.length) return setSpeaking(false)
  setSpeaking(true)
  const head = queue[0]
  if (head.engine.kind === 'neural') {
    const fallback = head.engine.fallback
    queue.shift()
    rendering = head
    const gen = generation
    void head.wav!.then((file) => {
      if (gen !== generation) {
        if (file) void rm(file, { force: true })
        return
      }
      rendering = null
      // Rendering failed: say this chunk with the system voice rather than skipping it.
      if (!file) play(sayProcess(fallback, head.text), [head], null)
      else play(spawn('afplay', [file], { stdio: 'ignore' }), [head], file)
    })
    return
  }
  const voice = head.engine.voice
  const n = queue.findIndex((j) => j.engine.kind !== 'system' || j.engine.voice !== voice)
  const jobs = queue.splice(0, n < 0 ? queue.length : n)
  play(sayProcess(voice, jobs.map((j) => j.text).join('\n')), jobs, null)
}

export function stopSpeaking() {
  generation++
  worker.cancel()
  for (const job of queue.splice(0)) {
    void job.wav?.then((f) => {
      if (f) void rm(f, { force: true })
    })
    job.done()
  }
  if (rendering) {
    rendering.done()
    rendering = null
  }
  if (current) {
    const { child, jobs } = current
    current = null
    child.kill('SIGTERM')
    for (const j of jobs) j.done()
  }
  setSpeaking(false)
}

/** On quit: stop talking and shut the worker down. */
export function shutdownSpeech() {
  stopSpeaking()
  worker.stop()
}

/** Append to what's being said. Resolves when this chunk finished playing (or speech was stopped). */
export function say(text: string, settings: Settings): Promise<void> {
  return new Promise((resolve) => {
    if (!text.trim() || process.platform !== 'darwin') return resolve()
    const gen = generation
    // Engine choice is async (cached file checks); chain it so chunks keep their order.
    enqueueing = enqueueing.then(async () => {
      const engine = await pickEngine(text, settings)
      if (gen !== generation) return resolve() // stopped while we were choosing
      const job: SayJob = { text, engine, done: resolve }
      if (engine.kind === 'neural') job.wav = worker.synth(text, engine.voice, engine.speed)
      queue.push(job)
      pump()
    })
  })
}

/** Replace whatever is being said. */
export function speak(text: string, settings: Settings) {
  stopSpeaking()
  void say(text, settings)
}
