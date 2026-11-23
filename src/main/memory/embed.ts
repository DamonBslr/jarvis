import type { Settings } from '@shared/types'

let lastFailure = 0
let lastError: string | undefined

/**
 * Embeddings via Ollama (`/api/embed`). Returns unit-normalized vectors, or null when
 * unavailable — callers then fall back to keyword (FTS) search only.
 */
export async function embed(texts: string[], settings: Settings): Promise<Float32Array[] | null> {
  if (!texts.length || !settings.embedModel) return []
  // Don't hammer a missing server: back off for 30s after a failure.
  if (Date.now() - lastFailure < 30_000) return null
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.embedModel, input: texts, truncate: true }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { embeddings?: number[][] }
    if (!data.embeddings?.length) throw new Error('no embeddings returned')
    lastError = undefined
    return data.embeddings.map(normalize)
  } catch (err) {
    lastFailure = Date.now()
    lastError = err instanceof Error ? err.message : String(err)
    return null
  }
}

export function embedStatus(settings: Settings) {
  return {
    online: !lastError,
    model: settings.embedModel,
    detail: lastError
  }
}

export async function probeEmbeddings(settings: Settings) {
  lastFailure = 0
  const r = await embed(['ping'], settings)
  return { online: !!r?.length, model: settings.embedModel, detail: r?.length ? undefined : lastError }
}

function normalize(v: number[]): Float32Array {
  const out = new Float32Array(v)
  let n = 0
  for (let i = 0; i < out.length; i++) n += out[i] * out[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i++) out[i] /= n
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
