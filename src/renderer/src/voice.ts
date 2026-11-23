// Microphone capture at 16 kHz, a small energy VAD, WAV encoding, and the "Jarvis" wake listener.
// Audio never leaves the machine: WAV bytes go to main, which runs whisper.cpp locally.

const RATE = 16000
const FRAME = 2048 // 128 ms at 16 kHz
export const FRAME_MS = (FRAME / RATE) * 1000

export class Mic {
  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
    private node: ScriptProcessorNode,
    private source: MediaStreamAudioSourceNode
  ) {}

  onFrame: ((frame: Float32Array, rms: number) => void) | null = null

  static async open(): Promise<Mic> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    const ctx = new AudioContext({ sampleRate: RATE })
    const source = ctx.createMediaStreamSource(stream)
    // ScriptProcessor is deprecated but needs no worklet module (keeps the CSP strict).
    const node = ctx.createScriptProcessor(FRAME, 1, 1)
    const mic = new Mic(ctx, stream, node, source)
    node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      mic.onFrame?.(data, Math.sqrt(sum / data.length))
    }
    source.connect(node)
    node.connect(ctx.destination) // required for onaudioprocess to fire; output buffer is silent
    return mic
  }

  close() {
    this.onFrame = null
    this.node.disconnect()
    this.source.disconnect()
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close()
  }
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export function encodeWav(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, RATE, true)
  v.setUint32(28, RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

/** Speech threshold that adapts to the room's noise floor. */
export class Vad {
  floor = 0.004
  isSpeech(rms: number) {
    const speech = rms > Math.max(0.012, this.floor * 3.2)
    if (!speech) this.floor = this.floor * 0.95 + rms * 0.05
    return speech
  }
}

export interface Utterance {
  stop(): void
  cancel(): void
  done: Promise<ArrayBuffer | null>
}

/**
 * Record one spoken request: ends after ~1.2 s of silence following speech, on stop(), or at maxMs.
 * Resolves null if nobody spoke.
 */
export function recordUtterance(mic: Mic, opts: { onLevel?: (l: number) => void; maxMs?: number } = {}): Utterance {
  const vad = new Vad()
  const chunks: Float32Array[] = []
  let heard = 0
  let silentFor = 0
  let elapsed = 0
  let finish!: (v: ArrayBuffer | null) => void
  const done = new Promise<ArrayBuffer | null>((r) => (finish = r))
  const frameMs = (FRAME / RATE) * 1000
  const end = (keep: boolean) => {
    mic.onFrame = null
    finish(keep && heard >= 2 ? encodeWav(concat(chunks)) : null)
  }
  mic.onFrame = (frame, rms) => {
    chunks.push(frame)
    elapsed += frameMs
    opts.onLevel?.(Math.min(1, rms * 12))
    if (vad.isSpeech(rms)) {
      heard++
      silentFor = 0
    } else if (heard) silentFor += frameMs
    if ((heard >= 2 && silentFor > 1200) || elapsed > (opts.maxMs ?? 20_000)) end(true)
    else if (!heard && elapsed > 7000) end(false)
  }
  return { stop: () => end(true), cancel: () => end(false), done }
}

const WAKE = /^\W*(?:(?:hey|hi|ok|okay|yo)\W+)?(?:jarvis|jervis|travis|javis)\b[\s,.!?:;-]*(.*)$/i

export function parseWake(text: string): string | null {
  const m = text.trim().match(WAKE)
  return m ? m[1].trim() : null
}

/**
 * Always-on listener: cuts speech into short segments, transcribes each locally,
 * and calls onWake(rest) when one starts with "Jarvis".
 */
export function startWakeListener(
  mic: Mic,
  transcribe: (wav: ArrayBuffer) => Promise<string>,
  onWake: (rest: string) => void,
  paused: () => boolean
) {
  const vad = new Vad()
  const preroll: Float32Array[] = []
  let seg: Float32Array[] | null = null
  let speechFrames = 0
  let silent = 0
  let busy = false
  mic.onFrame = (frame, rms) => {
    if (paused()) {
      seg = null
      return
    }
    const speech = vad.isSpeech(rms)
    if (!seg) {
      preroll.push(frame)
      if (preroll.length > 3) preroll.shift()
      if (speech) {
        seg = [...preroll]
        speechFrames = 1
        silent = 0
      }
      return
    }
    seg.push(frame)
    if (speech) {
      speechFrames++
      silent = 0
    } else silent++
    // ~0.75 s of silence or 6 s total closes the segment.
    if (silent >= 6 || seg.length > 47) {
      const audio = seg
      seg = null
      if (speechFrames < 3 || busy) return
      busy = true
      transcribe(encodeWav(concat(audio)))
        .then((text) => {
          const rest = parseWake(text)
          if (rest !== null) onWake(rest)
        })
        .catch(() => {})
        .finally(() => (busy = false))
    }
  }
}
