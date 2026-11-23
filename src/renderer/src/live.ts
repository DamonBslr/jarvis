// Live mode: a hands-free conversation loop.
//   listen (VAD) -> transcribe locally -> send as a turn -> speak the answer sentence by sentence while it
//   streams -> listen again.
// The mic stays open for the whole session but frames are ignored while Jarvis talks (it would hear
// itself through the speakers), unless barge-in is on (headphones), where talking over it interrupts.

import type { AgentEvent } from '@shared/types'
import { speakable, uid } from '@shared/chat'
import { concat, encodeWav, FRAME_MS, Mic, Vad } from './voice'

export type LivePhase = 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking'

export interface LiveHooks {
  transcribe(wav: ArrayBuffer): Promise<string>
  /** Start a turn with this run id. False if it couldn't start (chat busy or gone). */
  send(text: string, runId: string): boolean
  cancel(runId: string): void
  onEvent(cb: (runId: string, ev: AgentEvent) => void): () => void
  say(text: string): Promise<void>
  stopSpeaking(): void
  bargeIn(): boolean
  onPhase(phase: LivePhase): void
  onLevel(level: number): void
  onHeard(text: string): void
  onError(message: string): void
  onEnd(reason?: string): void
}

/** Silence after speech that closes an utterance. Shorter than push-to-talk: turns should feel snappy. */
const END_SILENCE_MS = 900
const MAX_UTTERANCE_MS = 30_000
const IDLE_END_MS = 3 * 60_000
/** Ignore the room for a moment after Jarvis stops talking (speaker tail, reverb). */
const TAIL_MS = 350

const EXIT =
  /^\W*(?:(?:ok(?:ay)?|thanks|thank you|jarvis|alright)[\s,.!]*)*(?:(?:stop|end|exit|quit|leave|close)\s+(?:the\s+)?(?:live(?:\s+mode)?|conversation|listening)|stop\s+listening|good\s?bye|bye(?:\s+bye)?|that'?s\s+all(?:\s+for\s+now)?|go\s+to\s+sleep)(?:[\s,.!]*(?:jarvis|thanks|thank you))*[\s,.!]*$/i

export const isExitPhrase = (text: string) => EXIT.test(text.trim())

export const LIVE_SYSTEM_PROMPT = [
  'This is a live voice conversation: the user is speaking, and your reply is read aloud with text-to-speech.',
  'Lead with a short spoken answer (one to three sentences, plain words, no markdown, lists, tables or URLs).',
  'If code or long detail is needed, put it after that summary; code blocks are shown on screen, not read.',
  'You can still use tools; say in a few words what you are about to do before long work.'
].join(' ')

interface Turn {
  runId: string
  chunker: SpeechChunker
  done: boolean
}

export class LiveLoop {
  private phase: LivePhase = 'listening'
  private vad = new Vad()
  private ring: Float32Array[] = []
  private seg: Float32Array[] | null = null
  private speechFrames = 0
  private silentMs = 0
  private idleMs = 0
  private loud = 0
  private resumeAt = 0
  private outstanding = 0
  private turn: Turn | null = null
  private ended = false
  private offEvents: () => void

  private constructor(
    private mic: Mic,
    private hooks: LiveHooks
  ) {
    mic.onFrame = (frame, rms) => this.frame(frame, rms)
    this.offEvents = hooks.onEvent((runId, ev) => this.event(runId, ev))
  }

  static async start(hooks: LiveHooks, greeting?: string): Promise<LiveLoop> {
    const loop = new LiveLoop(await Mic.open(), hooks)
    hooks.onPhase('listening')
    if (greeting) loop.speak(greeting)
    return loop
  }

  get current() {
    return this.phase
  }

  /** Stop the answer (cancelling its run) and listen. */
  interrupt() {
    if (this.ended) return
    this.dropTurn()
    this.seg = null
    this.listenAgain(150)
  }

  /** Say something outside a turn (approval needed, etc.) without the mic hearing it. */
  notify(text: string) {
    if (!this.ended) this.speak(text)
  }

  /** Leaves a running agent alone: ending live mode shouldn't throw away work in progress. */
  end(reason?: string) {
    if (this.ended) return
    this.ended = true
    this.turn = null
    this.offEvents()
    this.mic.close()
    this.hooks.stopSpeaking()
    this.hooks.onLevel(0)
    this.hooks.onEnd(reason)
  }

  // ---- audio --------------------------------------------------------------

  private frame(frame: Float32Array, rms: number) {
    if (this.ended) return
    this.ring.push(frame)
    if (this.ring.length > 4) this.ring.shift()
    const listening = this.phase === 'listening' || this.phase === 'hearing'
    this.hooks.onLevel(listening ? Math.min(1, rms * 12) : 0)
    if (listening) return this.listenFrame(frame, rms)
    if ((this.phase === 'speaking' || this.phase === 'thinking') && this.hooks.bargeIn()) this.bargeFrame(rms)
  }

  private listenFrame(frame: Float32Array, rms: number) {
    if (performance.now() < this.resumeAt) return
    const speech = this.vad.isSpeech(rms)
    if (!this.seg) {
      if (speech) {
        this.seg = [...this.ring] // a little audio from before the VAD fired, so first syllables survive
        this.speechFrames = 1
        this.silentMs = 0
        this.setPhase('hearing')
      } else if ((this.idleMs += FRAME_MS) > IDLE_END_MS) {
        this.end('Live mode ended after a few quiet minutes.')
      }
      return
    }
    this.seg.push(frame)
    if (speech) {
      this.speechFrames++
      this.silentMs = 0
    } else this.silentMs += FRAME_MS
    if (this.silentMs < END_SILENCE_MS && this.seg.length * FRAME_MS < MAX_UTTERANCE_MS) return
    const audio = this.seg
    this.seg = null
    this.idleMs = 0
    if (this.speechFrames < 3) return this.setPhase('listening') // a cough, a click
    void this.utterance(audio)
  }

  /** Talking over Jarvis. Louder bar while it speaks, since its own voice leaks in without headphones. */
  private bargeFrame(rms: number) {
    const speaking = this.phase === 'speaking'
    const bar = Math.max(speaking ? 0.045 : 0.02, this.vad.floor * (speaking ? 8 : 4))
    this.loud = rms > bar ? this.loud + 1 : 0
    if (this.loud < 3) return
    this.loud = 0
    this.dropTurn()
    this.seg = [...this.ring]
    this.speechFrames = 3
    this.silentMs = 0
    this.idleMs = 0
    this.setPhase('hearing')
  }

  // ---- turns --------------------------------------------------------------

  private async utterance(audio: Float32Array[]) {
    this.setPhase('transcribing')
    let text = ''
    try {
      text = await this.hooks.transcribe(encodeWav(concat(audio)))
    } catch (err) {
      this.hooks.onError(err instanceof Error ? err.message : String(err))
    }
    if (this.ended || this.phase !== 'transcribing') return
    if (!text) return this.listenAgain(0)
    this.hooks.onHeard(text)
    if (isExitPhrase(text)) {
      this.ended = true // stop listening now; finish the goodbye, then close
      this.hooks.onLevel(0)
      void this.hooks.say('Okay.').finally(() => {
        this.ended = false
        this.end()
      })
      return
    }
    const runId = uid()
    const turn: Turn = { runId, done: false, chunker: new SpeechChunker((t) => this.speak(t)) }
    this.turn = turn
    this.setPhase('thinking')
    if (!this.hooks.send(text, runId)) {
      this.turn = null
      this.speak("I'm still busy with the last request.")
    }
  }

  private event(runId: string, ev: AgentEvent) {
    const t = this.turn
    if (!t || t.runId !== runId || this.ended) return
    if (ev.kind === 'text') t.chunker.push(ev.delta)
    else if (ev.kind === 'tool_start') t.chunker.flush() // "Let me check" — say it before the tool runs
    else if (ev.kind === 'error') t.chunker.note('That ran into an error; details are on screen.')
    else if (ev.kind === 'done') {
      t.chunker.flush()
      t.done = true
      this.settle()
    }
  }

  private dropTurn() {
    const t = this.turn
    this.turn = null
    if (t && !t.done) this.hooks.cancel(t.runId)
    this.hooks.stopSpeaking()
  }

  private speak(text: string) {
    this.outstanding++
    if (this.phase !== 'hearing' && this.phase !== 'transcribing') this.setPhase('speaking')
    void this.hooks.say(text).finally(() => {
      this.outstanding--
      this.settle()
    })
  }

  /** After speech or the run ends: back to thinking if the agent is still working, else listen. */
  private settle() {
    if (this.ended || this.outstanding > 0) return
    if (this.turn && !this.turn.done) {
      if (this.phase === 'speaking') this.setPhase('thinking')
      return
    }
    this.turn = null
    if (this.phase === 'speaking' || this.phase === 'thinking') this.listenAgain(TAIL_MS)
  }

  private listenAgain(tailMs: number) {
    this.resumeAt = performance.now() + tailMs
    this.idleMs = 0
    this.setPhase('listening')
  }

  private setPhase(p: LivePhase) {
    if (this.phase === p) return
    this.phase = p
    this.hooks.onPhase(p)
  }
}

/**
 * Turns streamed markdown into speakable chunks at sentence boundaries, so speech starts with the
 * first sentence instead of after the whole answer. Code blocks are held until closed, then skipped.
 */
export class SpeechChunker {
  private buf = ''
  private spoken = 0
  private capped = false

  constructor(
    private emit: (text: string) => void,
    private max = 1500
  ) {}

  push(delta: string) {
    this.buf += delta
    this.drain(false)
  }

  flush() {
    this.drain(true)
  }

  /** Speak a fixed line after whatever's pending. */
  note(text: string) {
    this.flush()
    if (!this.capped) this.emit(text)
  }

  private drain(all: boolean) {
    if (this.capped) {
      this.buf = ''
      return
    }
    const cut = all ? this.buf.length : boundary(this.buf)
    if (cut <= 0) return
    const piece = this.buf.slice(0, cut).replace(/```[\s\S]*$/, ' (code on screen) ')
    this.buf = this.buf.slice(cut)
    let text = speakable(piece, Number.MAX_SAFE_INTEGER).replace(/\(code omitted\)/g, '(code on screen)')
    if (!/[\p{L}\p{N}]/u.test(text)) return
    if (this.spoken + text.length > this.max) {
      const room = Math.max(0, this.max - this.spoken)
      const head = text.slice(0, room)
      const end = head.lastIndexOf('. ')
      text = `${end > 0 ? head.slice(0, end + 1) : ''} The rest is on screen.`.trim()
      this.capped = true
    }
    this.spoken += text.length
    this.emit(text)
  }
}

/** Index just past the last complete sentence or line, outside any open code fence; 0 if none. */
export function boundary(buf: string): number {
  let limit = buf.length
  const fences = buf.match(/```/g)?.length ?? 0
  if (fences % 2) limit = buf.lastIndexOf('```')
  let cut = 0
  const re = /[.!?…]["'”’)\]]*\s+|\n+/g
  for (let m = re.exec(buf); m && m.index + m[0].length <= limit; m = re.exec(buf)) {
    const end = m.index + m[0].length
    // "1. " starting a list item isn't the end of a sentence.
    const lineStart = buf.lastIndexOf('\n', m.index - 1) + 1
    if (m[0][0] !== '\n' && /^\s*\d+$/.test(buf.slice(lineStart, m.index))) continue
    cut = end
  }
  return cut
}
