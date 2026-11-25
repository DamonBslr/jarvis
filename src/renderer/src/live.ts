// Live mode: a hands-free conversation loop.
//   listen (VAD) -> transcribe locally -> decide whether it was meant for Jarvis -> send as a turn ->
//   speak the answer sentence by sentence while it streams -> listen again.
// The mic stays open for the whole session but frames are ignored while Jarvis talks (it would hear
// itself through the speakers), unless barge-in is on (headphones), where talking over it interrupts.
//
// Two things keep it from talking over people:
// - End of turn isn't just "0.9 s of quiet". Speech is cut into segments that are transcribed while
//   the user may still be going; a sentence that sounds unfinished ("…and then", "so I think") gets
//   a much longer pause before Jarvis answers, and anything said in that pause joins the same turn.
// - Not everything the mic hears is for Jarvis. Each turn is checked first: its name, a follow-up
//   right after it spoke, or a local classifier telling requests from side conversations.

import type { AgentEvent, AppLanguage, LiveAddressing } from '@shared/types'
import { detailStart, speakable, uid } from '@shared/chat'
import { concat, encodeWav, FRAME_MS, Mic, Vad } from './voice'

export type LivePhase = 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking'

export interface LiveHooks {
  transcribe(wav: ArrayBuffer): Promise<string>
  /** Probability the utterance was meant for Jarvis; null when no classifier is available. */
  addressed(text: string, lastReply: string, sinceReplyMs: number | null): Promise<number | null>
  addressing(): LiveAddressing
  language(): AppLanguage
  /** Start a turn with this run id. False if it couldn't start (chat busy or gone). */
  send(text: string, runId: string): boolean
  cancel(runId: string): void
  onEvent(cb: (runId: string, ev: AgentEvent) => void): () => void
  say(text: string): Promise<void>
  stopSpeaking(): void
  bargeIn(): boolean
  onPhase(phase: LivePhase): void
  onLevel(level: number): void
  /** What was heard so far; `ignored` once it was judged not meant for Jarvis. */
  onHeard(text: string, ignored?: boolean): void
  onError(message: string): void
  onEnd(reason?: string): void
}

/** Quiet that closes a speech segment; it's transcribed while we wait to see whether more is coming. */
const SEGMENT_SILENCE_MS = 600
/** Quiet after which a finished-sounding turn is answered… */
const END_SILENCE_MS = 1000
/** …and one that trails off mid-thought ("so what I'd like is", "und dann"). */
const HOLD_SILENCE_MS = 2600
const MAX_SEGMENT_MS = 30_000
const IDLE_END_MS = 3 * 60_000
/** Ignore the room for a moment after Jarvis stops talking (speaker tail, reverb). */
const TAIL_MS = 350
/** Right after Jarvis spoke, the next thing said is most likely a reply to it. */
const FOLLOW_UP_MS = 8000
/** Spoken budget per answer (~35 s of speech); the model is asked for far less. */
const SPOKEN_MAX = 500

const EXIT =
  /^\W*(?:(?:ok(?:ay)?|thanks|thank you|jarvis|alright)[\s,.!]*)*(?:(?:stop|end|exit|quit|leave|close)\s+(?:the\s+)?(?:live(?:\s+mode)?|conversation|listening)|stop\s+listening|good\s?bye|bye(?:\s+bye)?|that'?s\s+all(?:\s+for\s+now)?|go\s+to\s+sleep)(?:[\s,.!]*(?:jarvis|thanks|thank you))*[\s,.!]*$/i
/** Exit phrases that can't be small talk with someone else ("bye" can). */
const EXPLICIT_EXIT = /\b(?:live|listening|jarvis)\b/i

export const isExitPhrase = (text: string) => EXIT.test(text.trim())

/** Whisper's usual spellings of the name. */
const NAME = /\b(?:jarvis|jervis|javis|jarvas|dschawis)\b/i
export const saysName = (text: string) => NAME.test(text)

// Words a sentence doesn't end on: conjunctions, articles, prepositions, fillers (English and German).
const OPEN_WORDS = new Set(
  (
    'and or but so because cause then the a an to of for with from in on at about into like if that which who ' +
    'when where while my your our their his her its is are was were am be can could would should will do does ' +
    'did have has had um uh er erm hmm mean think want need maybe also just actually ' +
    'und oder aber also weil dass denn dann der die das den dem des ein eine einen einem einer zu von mit für ' +
    'in im an am auf aus bei nach über unter wenn ob wie was wo mein meine dein deine ist sind war hast hat ' +
    'kannst könntest würdest soll sollte möchte will ähm äh öhm hm halt eigentlich noch'
  ).split(' ')
)

/** Does this transcript trail off mid-thought? Then the user is probably still going. */
export function soundsUnfinished(text: string): boolean {
  const t = text.trim()
  if (!t || /(?:[,;:–—-]|…|\.\.\.)$/.test(t)) return true
  const last = t.replace(/[.!?"'”’)\]]+$/, '').split(/\s+/).pop()?.toLowerCase() ?? ''
  return OPEN_WORDS.has(last)
}

const PHRASES = {
  en: {
    greeting: 'Listening.',
    okay: 'Okay.',
    busy: "I'm still busy with the last request.",
    error: 'That ran into an error; details are on screen.',
    detail: 'The details are on screen.',
    rest: 'The rest is on screen.',
    and: 'and',
    to: 'to'
  },
  de: {
    greeting: 'Ich höre.',
    okay: 'Okay.',
    busy: 'Ich bin noch mit der letzten Anfrage beschäftigt.',
    error: 'Da ist ein Fehler aufgetreten, Details stehen auf dem Bildschirm.',
    detail: 'Die Details stehen auf dem Bildschirm.',
    rest: 'Den Rest siehst du auf dem Bildschirm.',
    and: 'und',
    to: 'zu'
  }
} satisfies Record<AppLanguage, Record<string, string>>
export type LivePhrases = (typeof PHRASES)['en']
export const livePhrases = (lang: AppLanguage): LivePhrases => PHRASES[lang] ?? PHRASES.en

interface Turn {
  runId: string
  chunker: SpeechChunker
  done: boolean
  /** A tool ran: later text is narration until the run ends, then the last block is the answer. */
  tools: boolean
  /** Text since the last tool call (only the final block gets spoken). */
  held: string
  /** Talked over (barge-in): stay quiet until we know whether that was for Jarvis. */
  muted: boolean
}

/** Transcripts of the segments in the turn being heard, in order. */
interface Pending {
  texts: (string | null)[]
  waiting: number
  /** When the user started talking (follow-ups count from here, not from when they stopped). */
  startedAt: number
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
  private lastSpeechAt = 0
  private segStart = 0
  private pending: Pending | null = null
  private outstanding = 0
  private turn: Turn | null = null
  /** What Jarvis said last and when it finished, for follow-ups ("yes, do that"). */
  private lastReply = ''
  private repliedAt = 0
  private ended = false
  private offEvents: () => void

  private constructor(
    private mic: Mic,
    private hooks: LiveHooks
  ) {
    mic.onFrame = (frame, rms) => this.frame(frame, rms)
    this.offEvents = hooks.onEvent((runId, ev) => this.event(runId, ev))
  }

  static async start(hooks: LiveHooks): Promise<LiveLoop> {
    const loop = new LiveLoop(await Mic.open(), hooks)
    hooks.onPhase('listening')
    loop.speak(loop.phrases.greeting)
    return loop
  }

  get current() {
    return this.phase
  }

  private get phrases() {
    return livePhrases(this.hooks.language())
  }

  /** Stop the answer (cancelling its run) and listen. */
  interrupt() {
    if (this.ended) return
    this.dropTurn()
    this.seg = null
    this.pending = null
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
    this.pending = null
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
    const now = performance.now()
    if (now < this.resumeAt) return
    const speech = this.vad.isSpeech(rms)
    if (!this.seg) {
      if (speech) {
        this.seg = [...this.ring] // a little audio from before the VAD fired, so first syllables survive
        this.speechFrames = 1
        this.silentMs = 0
        this.lastSpeechAt = now
        this.segStart = now
        this.setPhase('hearing')
      } else if (this.pending) this.maybeCommit(now)
      else if ((this.idleMs += FRAME_MS) > IDLE_END_MS) this.end('Live mode ended after a few quiet minutes.')
      return
    }
    this.seg.push(frame)
    if (speech) {
      this.speechFrames++
      this.silentMs = 0
      this.lastSpeechAt = now
    } else this.silentMs += FRAME_MS
    if (this.silentMs < SEGMENT_SILENCE_MS && this.seg.length * FRAME_MS < MAX_SEGMENT_MS) return
    const audio = this.seg
    this.seg = null
    this.idleMs = 0
    if (this.speechFrames < 3) {
      if (!this.pending) this.resume() // a cough, a click
      return
    }
    this.addSegment(audio)
  }

  /** Transcribe a segment in the background; the turn only closes once the user has really stopped. */
  private addSegment(audio: Float32Array[]) {
    const pend = (this.pending ??= { texts: [], waiting: 0, startedAt: this.segStart })
    const i = pend.texts.push(null) - 1
    pend.waiting++
    this.hooks
      .transcribe(encodeWav(concat(audio)))
      .catch((err) => {
        this.hooks.onError(err instanceof Error ? err.message : String(err))
        return ''
      })
      .then((text) => {
        pend.texts[i] = text
        pend.waiting--
        if (this.pending !== pend || this.ended) return
        const sofar = joined(pend)
        if (sofar) this.hooks.onHeard(sofar)
      })
  }

  /** Called on quiet frames while a turn is pending: answer once the pause is long enough for what was said. */
  private maybeCommit(now: number) {
    const pend = this.pending
    if (!pend || pend.waiting) return
    const text = joined(pend)
    if (!text) {
      this.pending = null
      return this.resume()
    }
    if (now - this.lastSpeechAt < (soundsUnfinished(text) ? HOLD_SILENCE_MS : END_SILENCE_MS)) return
    this.pending = null
    void this.commit(text, pend.startedAt)
  }

  /** Talking over Jarvis. Louder bar while it speaks, since its own voice leaks in without headphones. */
  private bargeFrame(rms: number) {
    const speaking = this.phase === 'speaking'
    const bar = Math.max(speaking ? 0.045 : 0.02, this.vad.floor * (speaking ? 8 : 4))
    this.loud = rms > bar ? this.loud + 1 : 0
    if (this.loud < 4) return // ~half a second of voice, not a door or a cough
    this.loud = 0
    if (this.hooks.addressing() === 'all') this.dropTurn()
    else {
      // Might be someone else in the room: go quiet, but keep the run until we know it was for Jarvis.
      this.hooks.stopSpeaking()
      if (this.turn) this.turn.muted = true
    }
    this.seg = [...this.ring]
    this.speechFrames = 3
    this.silentMs = 0
    this.idleMs = 0
    this.lastSpeechAt = this.segStart = performance.now()
    this.setPhase('hearing')
  }

  // ---- turns --------------------------------------------------------------

  private async commit(text: string, startedAt: number) {
    this.setPhase('transcribing')
    this.hooks.onHeard(text)
    const mode = this.hooks.addressing()
    const followUp = this.repliedAt > 0 && startedAt - this.repliedAt < FOLLOW_UP_MS
    if (isExitPhrase(text) && (mode === 'all' || followUp || EXPLICIT_EXIT.test(text))) {
      this.ended = true // stop listening now; finish the goodbye, then close
      this.hooks.onLevel(0)
      void this.hooks.say(this.phrases.okay).finally(() => {
        this.ended = false
        this.end()
      })
      return
    }
    const forJarvis = await this.isForJarvis(text, mode, followUp)
    if (this.ended || this.phase !== 'transcribing') return
    if (!forJarvis) {
      this.hooks.onHeard(text, true)
      return this.resume()
    }
    const old = this.turn
    this.dropTurn()
    this.idleMs = 0
    const runId = uid()
    const turn: Turn = { runId, done: false, tools: false, held: '', muted: false, chunker: this.chunker() }
    this.turn = turn
    this.lastReply = ''
    this.setPhase('thinking')
    // Talked over a running answer: its run was just cancelled and takes a moment to wind down.
    for (let tries = 0; !this.hooks.send(text, runId); tries++) {
      if (!old || old.done || tries >= 20) {
        if (this.turn === turn) this.turn = null
        return this.speak(this.phrases.busy)
      }
      await new Promise((r) => setTimeout(r, 150))
      if (this.ended || this.turn !== turn) return
    }
  }

  private async isForJarvis(text: string, mode: LiveAddressing, followUp: boolean): Promise<boolean> {
    if (mode === 'all' || saysName(text)) return true
    if (mode === 'name') return followUp
    const since = this.repliedAt ? performance.now() - this.repliedAt : null
    const p = await this.hooks.addressed(text, this.lastReply, since).catch(() => null)
    // No classifier around: fall back to what 'name' mode does.
    if (p === null) return followUp
    return p >= (followUp ? 0.3 : 0.5)
  }

  /** Not for Jarvis: carry on with whatever it was doing before. */
  private resume() {
    const t = this.turn
    if (!t) return this.listenAgain(0)
    t.muted = false
    if (t.done) {
      this.turn = null
      this.listenAgain(0)
    } else this.setPhase('thinking')
  }

  private chunker(): SpeechChunker {
    return new SpeechChunker((text) => this.speakTurn(text), SPOKEN_MAX, this.phrases)
  }

  private event(runId: string, ev: AgentEvent) {
    const t = this.turn
    if (!t || t.runId !== runId || this.ended) return
    if (ev.kind === 'text') {
      if (t.tools) t.held += ev.delta
      else t.chunker.push(ev.delta)
    } else if (ev.kind === 'tool_start') {
      // The first "Let me check" is said before the tool runs; narration between later tools isn't.
      if (!t.tools) t.chunker.flush()
      t.tools = true
      t.held = ''
    } else if (ev.kind === 'error') t.chunker.note(this.phrases.error)
    else if (ev.kind === 'done') {
      if (t.tools) {
        t.chunker = this.chunker() // fresh budget for the actual answer
        t.chunker.push(t.held)
        t.held = ''
      }
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

  private speakTurn(text: string) {
    if (this.turn?.muted) return
    this.lastReply = `${this.lastReply} ${text}`.trim().slice(-600)
    this.speak(text)
  }

  private speak(text: string) {
    this.outstanding++
    if (this.phase !== 'hearing' && this.phase !== 'transcribing') this.setPhase('speaking')
    void this.hooks.say(text).finally(() => {
      this.outstanding--
      this.repliedAt = performance.now()
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
    if (this.turn?.muted) return // talked over; resume() decides once we know who it was for
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

const joined = (p: Pending) => p.texts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()

/**
 * Turns streamed markdown into speakable chunks at sentence boundaries, so speech starts with the
 * first sentence instead of after the whole answer. Stops where on-screen detail begins (a `---`
 * line, code, a heading, table or list once something has been said) and at a length budget.
 */
export class SpeechChunker {
  private buf = ''
  private spoken = 0
  private capped = false

  constructor(
    private emit: (text: string) => void,
    private max = 1500,
    private phrases: LivePhrases = PHRASES.en
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
    const detail = detailStart(this.buf, this.spoken > 0)
    const cut = detail >= 0 ? detail : all ? this.buf.length : boundary(this.buf)
    if (cut <= 0 && detail < 0) return
    const piece = this.buf.slice(0, cut).replace(/```[\s\S]*$/, ' (code on screen) ')
    this.buf = this.buf.slice(cut)
    let text = spokenForm(
      speakable(piece, Number.MAX_SAFE_INTEGER).replace(/\(code omitted\)/g, '(code on screen)'),
      this.phrases
    )
    if (!/[\p{L}\p{N}]/u.test(text)) text = ''
    if (this.spoken + text.length > this.max) {
      const room = Math.max(0, this.max - this.spoken)
      const head = text.slice(0, room)
      const end = head.lastIndexOf('. ')
      text = `${end > 0 ? head.slice(0, end + 1) : ''} ${this.phrases.rest}`.trim()
      this.capped = true
    } else if (detail >= 0) {
      text = `${text} ${this.phrases.detail}`.trim()
      this.capped = true
    }
    if (!text) return
    this.spoken += text.length
    this.emit(text)
  }
}

/** Written shorthand that sounds wrong read aloud: paths, abbreviations, arrows, emoji. */
export function spokenForm(text: string, phrases: LivePhrases = PHRASES.en): string {
  return text
    // src/main/store.ts -> store.ts (but leave dates like 11/25/2026 alone)
    .replace(/(?:~|[\w.@-]+)?(?:\/[\w.@-]+){2,}\/?/g, (p) => (/[a-z]/i.test(p) ? (p.split('/').filter(Boolean).pop() ?? p) : p))
    .replace(/\be\.\s?g\.,?/gi, 'for example')
    .replace(/\bi\.\s?e\.,?/gi, 'that is')
    .replace(/\betc\./gi, 'and so on')
    .replace(/\bz\.\s?B\./g, 'zum Beispiel')
    .replace(/\bd\.\s?h\./g, 'das heißt')
    .replace(/\busw\./g, 'und so weiter')
    .replace(/\s*(?:->|→|=>)\s*/g, ` ${phrases.to} `)
    .replace(/\s&\s/g, ` ${phrases.and} `)
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
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
