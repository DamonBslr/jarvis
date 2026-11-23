/**
 * Client for Jev-style decision servers (`POST /v1/systemone`): give a state + questions,
 * get calibrated probabilities back. No text generation, so it's fast and cheap enough to run
 * on every message. Works with jev-style (default :8765) and jevos (:8017).
 */

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> }

let health: { url: string; online: boolean; model?: string; at: number } | null = null

export async function jevHealth(url: string, force = false): Promise<{ online: boolean; model?: string }> {
  if (!force && health && health.url === url && Date.now() - health.at < 30_000) return health
  let online = false
  let model: string | undefined
  for (const path of ['/v1/models', '/healthz', '/health']) {
    try {
      const res = await fetch(url + path, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) continue
      online = true
      if (path === '/v1/models') {
        const data = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null
        model = data?.data?.[0]?.id
      }
      break
    } catch {
      /* try next */
    }
  }
  health = { url, online, model, at: Date.now() }
  return health
}

export async function decide(
  url: string,
  state: string | object,
  questions: Record<string, JevQuestion>,
  timeoutMs = 8000
): Promise<Record<string, JevAnswer> | null> {
  const h = await jevHealth(url)
  if (!h.online) return null
  try {
    const res = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> }
    return data.answers ?? null
  } catch {
    health = { url, online: false, at: Date.now() }
    return null
  }
}

/** Trim long state so it fits small decision models' context (jevos: 8k tokens). */
export function clip(text: string, max = 6000): string {
  return text.length <= max ? text : text.slice(0, max / 2) + '\n…\n' + text.slice(-max / 2)
}
