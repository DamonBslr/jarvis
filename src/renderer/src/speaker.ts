// Plays Jarvis's voice inside the window instead of through afplay. Audio played here is visible to
// Chromium's echo canceller (the mic is opened with echoCancellation), so in live mode the mic hears
// the user rather than Jarvis's own voice coming back out of the speakers.

export class Speaker {
  private ctx: AudioContext | null = null
  private queue: Job[] = []
  /** Taken off the queue, still rendering or decoding. */
  private loading: Job | null = null
  private playing: { src: AudioBufferSourceNode; job: Job } | null = null
  private gen = 0

  constructor(private render: (text: string) => Promise<Uint8Array | null>) {}

  /** Queue a sentence. Resolves when it finished playing, or was stopped. Renders ahead while earlier ones play. */
  say(text: string): Promise<void> {
    return new Promise((done) => {
      if (!text.trim()) return done()
      this.queue.push({ text, done, audio: this.render(text).catch(() => null) })
      void this.pump()
    })
  }

  stop() {
    this.gen++
    const jobs = [...this.queue.splice(0), ...(this.loading ? [this.loading] : [])]
    this.loading = null
    if (this.playing) {
      const { src, job } = this.playing
      this.playing = null
      src.onended = null
      try {
        src.stop()
      } catch {
        /* not started */
      }
      jobs.push(job)
    }
    for (const j of jobs) j.done()
  }

  close() {
    this.stop()
    void this.ctx?.close()
    this.ctx = null
  }

  private context(): AudioContext {
    this.ctx ??= new AudioContext()
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private async pump() {
    if (this.playing || this.loading) return
    const job = this.queue.shift()
    if (!job) return
    this.loading = job
    const gen = this.gen
    const bytes = await job.audio
    let buffer: AudioBuffer | null = null
    if (bytes && gen === this.gen) {
      const ctx = this.context()
      // decodeAudioData detaches its input; hand it a copy of exactly these bytes.
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      buffer = await ctx.decodeAudioData(copy).catch(() => null)
    }
    if (gen !== this.gen) return // stopped meanwhile; stop() already resolved this job
    this.loading = null
    if (!buffer) {
      job.done()
      return void this.pump()
    }
    const ctx = this.context()
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    this.playing = { src, job }
    src.onended = () => {
      if (this.playing?.src !== src) return
      this.playing = null
      job.done()
      void this.pump()
    }
    src.start()
  }
}

interface Job {
  text: string
  done: () => void
  audio: Promise<Uint8Array | null>
}
