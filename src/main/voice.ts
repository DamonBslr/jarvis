// Local speech: whisper.cpp for speech-to-text; Kokoro (English) or Piper (German) neural voices, or macOS `say`,
// for replies. Nothing leaves the machine.
import { app, systemPreferences } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AppLanguage, Settings, VoiceProgress, VoiceStatus } from '@shared/types'
import { DEFAULT_GERMAN_VOICE, GERMAN_VOICES, LANGUAGES, languageOf } from '@shared/language'
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

/** macOS voices with their locale ("Anna" -> "de_DE"). */
let voicesCache: { name: string; locale: string }[] | null = null
async function systemVoices(): Promise<{ name: string; locale: string }[]> {
  if (voicesCache) return voicesCache
  if (process.platform !== 'darwin') return []
  try {
    const out = await runOnce('say', ['-v', '?'], { timeoutMs: 5000 })
    voicesCache = out
      .split('\n')
      .map((l) => l.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Za-z0-9]+)/i))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ name: m[1].trim(), locale: m[2] }))
    return voicesCache
  } catch {
    return []
  }
}
const listVoices = async () => (await systemVoices()).map((v) => v.name)

/** The user's macOS voice if it speaks `lang`, else the first installed voice that does. */
async function systemVoiceFor(lang: AppLanguage, preferred: string): Promise<string> {
  const voices = await systemVoices()
  const speaks = (v: { locale: string }) => v.locale.toLowerCase().startsWith(lang)
  const mine = voices.find((v) => v.name === preferred)
  if (mine && speaks(mine)) return preferred
  // '' = system default, which follows the macOS language; only guess when the user picked a foreign voice or none.
  if (lang === 'en' && !preferred) return ''
  return voices.find(speaks)?.name ?? preferred
}

export async function voiceStatus(settings: Settings): Promise<VoiceStatus> {
  const [whisper, size, voices, neural, german] = await Promise.all([
    findWhisper(),
    stat(modelPath(settings.voiceModel)).then((s) => s.size, () => 0),
    listVoices(),
    neuralStatus(),
    Promise.all(GERMAN_VOICES.map(async (v) => ((await piperDownloaded(v.id)) ? v.id : null)))
  ])
  const mic = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
  return {
    whisper: { found: !!whisper, path: whisper ?? undefined },
    model: { name: settings.voiceModel, downloaded: size > 1_000_000, sizeMb: VOICE_MODELS[settings.voiceModel] },
    micAccess: mic as VoiceStatus['micAccess'],
    voices,
    neural,
    german: { downloaded: german.filter((v): v is string => !!v) }
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
    // Pinned to Jarvis's language: "auto" on small models mis-detects accents and short clips.
    const lang = settings.voiceModel.endsWith('.en') ? 'en' : LANGUAGES[languageOf(settings.language)].whisper
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

// ---- neural voices (on this Mac) -----------------------------------------------------------
// Kokoro-82M speaks English; Piper speaks German (Kokoro has none). Each runs as a long-lived Python
// worker (run by uv) that turns text into WAV files; afplay plays them.

const NEURAL_FILES = [
  { name: 'kokoro-v1.0.onnx', mb: 311 },
  { name: 'voices-v1.0.bin', mb: 27 }
]
const NEURAL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
const neuralDir = () => join(app.getPath('userData'), 'kokoro')

const PIPER_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
const piperDir = () => join(app.getPath('userData'), 'piper')
const isGermanVoice = (id: string) => GERMAN_VOICES.some((v) => v.id === id)
/** "de_DE-thorsten-high" -> de/de_DE/thorsten/high/de_DE-thorsten-high */
function piperRemote(id: string) {
  const [locale, speaker, quality] = id.split('-')
  return `${PIPER_URL}/${locale.split('_')[0]}/${locale}/${speaker}/${quality}/${id}`
}
const piperDownloaded = async (id: string) =>
  isGermanVoice(id) &&
  (await stat(join(piperDir(), `${id}.onnx`)).then((s) => s.size > 1_000_000, () => false)) &&
  (await stat(join(piperDir(), `${id}.onnx.json`)).then(() => true, () => false))

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

async function runWorker(script: string, dir: string, args: string[], timeoutMs: number) {
  const uv = await findUv()
  if (!uv) throw new Error('uv is not installed (brew install uv)')
  await runOnce(uv, ['run', '--script', '--quiet', resourcePath(script), dir, ...args], {
    timeoutMs,
    env: await loadShellEnv()
  })
}

/** Stream `url` into `dest` (via .part), reporting bytes as they arrive. */
async function fetchTo(url: string, dest: string, onBytes: (n: number) => void) {
  const part = `${dest}.part`
  try {
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
    const body = Readable.fromWeb(res.body as any)
    body.on('data', (c: Buffer) => onBytes(c.length))
    await pipeline(body, createWriteStream(part))
    await rename(part, dest)
  } finally {
    await rm(part, { force: true })
  }
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
      let got = 0
      let lastPct = -1
      await fetchTo(`${NEURAL_URL}/${f.name}`, dest, (n) => {
        got += n
        const pct = Math.floor(((doneMb + got / 1e6) / total) * 100)
        if (pct !== lastPct && pct < 100) {
          lastPct = pct
          onProgress({ task: 'neural', progress: pct / 100, step: 'Downloading voice model' })
        }
      })
      doneMb += f.mb
    }
    onProgress({ task: 'neural', progress: 1, step: 'Installing speech runtime (one time)…' })
    await runWorker('kokoro-worker.py', neuralDir(), ['--warmup'], 10 * 60_000)
    kokoro.reset()
    onProgress({ task: 'neural', done: true })
  } catch (err) {
    onProgress({ task: 'neural', error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

/** Download a German Piper voice (model + config), then warm up its runtime once. */
export async function downloadGermanVoice(id: string, onProgress: Progress) {
  const voice = GERMAN_VOICES.find((v) => v.id === id)
  if (!voice) throw new Error(`Unknown German voice ${id}`)
  await mkdir(piperDir(), { recursive: true })
  try {
    if (!(await piperDownloaded(id))) {
      let got = 0
      let lastPct = -1
      await fetchTo(`${piperRemote(id)}.onnx.json`, join(piperDir(), `${id}.onnx.json`), () => {})
      await fetchTo(`${piperRemote(id)}.onnx`, join(piperDir(), `${id}.onnx`), (n) => {
        got += n
        const pct = Math.floor((got / 1e6 / voice.mb) * 100)
        if (pct !== lastPct && pct < 100) {
          lastPct = pct
          onProgress({ task: 'german', progress: pct / 100, step: 'Downloading German voice' })
        }
      })
    }
    onProgress({ task: 'german', progress: 1, step: 'Installing speech runtime (one time)…' })
    await runWorker('piper-worker.py', piperDir(), ['--warmup', id], 10 * 60_000)
    piper.reset()
    onProgress({ task: 'german', done: true })
  } catch (err) {
    onProgress({ task: 'german', error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

class NeuralWorker {
  private child: ChildProcess | null = null
  private waiting = new Map<string, (ok: boolean) => void>()
  private buf = ''
  private stderr = ''
  private idle: NodeJS.Timeout | null = null
  private startedAt = 0
  private brokenUntil = 0
  private check: { at: number; ok: boolean } | null = null

  constructor(
    private readonly script: string,
    private readonly dir: () => string,
    private readonly ready: () => Promise<boolean>
  ) {}

  /** Model files on disk, uv present, and the worker hasn't just crashed on start. Cached 30 s. */
  async available(): Promise<boolean> {
    if (Date.now() < this.brokenUntil) return false
    if (this.check && Date.now() - this.check.at < 30_000) return this.check.ok
    const ok = !!(await findUv()) && (await this.ready())
    this.check = { at: Date.now(), ok }
    return ok
  }

  /** After a fresh download: forget a failed start and re-check the files. */
  reset() {
    this.brokenUntil = 0
    this.check = null
  }

  private async ensure(): Promise<ChildProcess> {
    if (this.child) return this.child
    const uv = await findUv()
    if (!uv) throw new Error('uv not found')
    if (this.child) return this.child // another call started it while we looked for uv
    const child = spawn(uv, ['run', '--script', '--quiet', resourcePath(this.script), this.dir()], {
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
        this.brokenUntil = Date.now() + 60_000
        console.warn(`[tts] ${this.script} failed to start:`, this.stderr.trim().split('\n').pop())
      }
    }
    child.on('exit', gone)
    child.on('error', () => gone(1))
    return child
  }

  async synth(text: string, voice: string, speed: number): Promise<string | null> {
    if (this.idle) clearTimeout(this.idle)
    // Idle workers hold a few hundred MB; let them go after 10 quiet minutes.
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
const kokoro = new NeuralWorker('kokoro-worker.py', neuralDir, neuralDownloaded)
// One Piper worker serves every German voice; "ready" means the one picked in settings is on disk.
let germanVoice = DEFAULT_GERMAN_VOICE
const piper = new NeuralWorker('piper-worker.py', piperDir, () => piperDownloaded(germanVoice))

// Safety net: German text while Jarvis is set to English (e.g. the user asked for German in chat)
// shouldn't be read with an English accent.
const GERMAN = /\b(und|der|die|das|ist|nicht|ich|ein|eine|mit|für|auf|den|dem|du|sie|wir|auch|noch|bitte|kann|habe|hast|wird|sind)\b/gi
function looksGerman(text: string) {
  const words = text.split(/\s+/).filter(Boolean).length
  const hits = text.match(GERMAN)?.length ?? 0
  return words > 0 && hits / words > 0.12
}

type Engine =
  | { kind: 'neural'; worker: NeuralWorker; voice: string; speed: number; fallback: string }
  | { kind: 'system'; voice: string }

async function pickEngine(text: string, settings: Settings): Promise<Engine> {
  const speed = Math.min(1.6, Math.max(0.6, settings.ttsSpeed || 1))
  const lang: AppLanguage = languageOf(settings.language) === 'de' || looksGerman(text) ? 'de' : 'en'
  const system: Engine = { kind: 'system', voice: await systemVoiceFor(lang, settings.ttsVoice) }
  if (settings.ttsEngine !== 'neural') return system
  if (lang === 'de') {
    germanVoice = isGermanVoice(settings.germanVoice) ? settings.germanVoice : DEFAULT_GERMAN_VOICE
    if (!(await piper.available())) return system
    return { kind: 'neural', worker: piper, voice: germanVoice, speed, fallback: system.voice }
  }
  if (!(await kokoro.available())) return system
  return { kind: 'neural', worker: kokoro, voice: settings.neuralVoice || 'bm_george', speed, fallback: system.voice }
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
  kokoro.cancel()
  piper.cancel()
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
  kokoro.stop()
  piper.stop()
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
      if (engine.kind === 'neural') job.wav = engine.worker.synth(text, engine.voice, engine.speed)
      queue.push(job)
      pump()
    })
  })
}

/**
 * Synthesize without playing: WAV bytes for the renderer to play itself. Live mode plays through the
 * window so the mic's echo cancellation knows what Jarvis is saying and can subtract it (it can't
 * see afplay), which is what makes talking over Jarvis work without headphones.
 */
export async function render(text: string, settings: Settings): Promise<Uint8Array | null> {
  if (!text.trim() || process.platform !== 'darwin') return null
  const engine = await pickEngine(text, settings)
  let file = engine.kind === 'neural' ? await engine.worker.synth(text, engine.voice, engine.speed) : null
  try {
    if (!file) {
      const voice = engine.kind === 'neural' ? engine.fallback : engine.voice
      const out = join(tmpdir(), `jarvis-tts-${randomUUID()}.wav`)
      const child = spawn('say', [...(voice ? ['-v', voice] : []), '-o', out, '--data-format=LEI16@22050', '-f', '-'], {
        stdio: ['pipe', 'ignore', 'ignore']
      })
      child.stdin!.on('error', () => {})
      child.stdin!.end(text)
      const ok = await new Promise<boolean>((r) => {
        child.on('close', (code) => r(code === 0))
        child.on('error', () => r(false))
      })
      if (!ok) return null
      file = out
    }
    return new Uint8Array(await readFile(file))
  } catch {
    return null
  } finally {
    if (file) void rm(file, { force: true })
  }
}

/** Replace whatever is being said. */
export function speak(text: string, settings: Settings) {
  stopSpeaking()
  void say(text, settings)
}
