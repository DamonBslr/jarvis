import type { Provider } from './types'

/**
 * Local models via Ollama's HTTP API. Stateless: the app sends full history each turn.
 * Good for fast/private/offline jobs (summaries, routing, drafting) — no tools yet.
 */
export const ollamaProvider: Provider = {
  id: 'ollama',

  async status({ settings }) {
    try {
      const res = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) })
      const data = (await res.json()) as { models?: { name: string }[] }
      const models = (data.models ?? []).map((m) => m.name)
      return {
        id: 'ollama',
        available: true,
        models,
        detail: models.length ? undefined : 'No models pulled. Try: ollama pull gemma3'
      }
    } catch {
      return { id: 'ollama', available: false, detail: `Ollama not reachable at ${settings.ollamaUrl} (run: ollama serve)` }
    }
  },

  run(req, { settings }, emit) {
    const ac = new AbortController()
    const started = Date.now()

    const messages = [
      ...(req.systemPrompt || req.context
        ? [{ role: 'system', content: [req.systemPrompt, req.context].filter(Boolean).join('\n\n') }]
        : []),
      ...(req.history ?? []),
      { role: 'user', content: req.prompt }
    ]

    const finished = (async () => {
      try {
        if (!req.model || req.model === 'default') throw new Error('Pick an Ollama model first (none selected).')
        const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: req.model, messages, stream: true }),
          signal: ac.signal
        })
        if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`)

        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            const chunk = JSON.parse(line)
            if (chunk.error) throw new Error(chunk.error)
            if (chunk.message?.thinking) emit({ kind: 'thinking', delta: chunk.message.thinking })
            if (chunk.message?.content) emit({ kind: 'text', delta: chunk.message.content })
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        emit({ kind: 'done', durationMs: Date.now() - started })
      }
    })()

    return { finished, cancel: () => ac.abort() }
  }
}
