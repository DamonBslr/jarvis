/**
 * Live mode keeps the mic open, so it also hears the user talking to colleagues, taking a call or
 * thinking aloud. This answers "was that meant for Jarvis?" with a local model: the Jev decision server
 * when it's up (fast, calibrated), else the smallest pulled Ollama model. Nothing leaves the machine.
 * Returns null when neither is reachable; the live loop then falls back to name / follow-up rules.
 */
import type { AddressedRequest, Settings } from '@shared/types'
import { decide, jevHealth } from './jev'

const INSTRUCTIONS =
  'A hands-free voice assistant called Jarvis keeps the microphone open, so it hears its user and anyone ' +
  'around them. Decide whether the heard utterance is meant for Jarvis: a question, request or command for ' +
  'the assistant, or a reply to what Jarvis just said. It is NOT meant for Jarvis when the user is talking to ' +
  'colleagues or family, on a phone or video call, reading something out, thinking aloud, or when it is ' +
  'background speech, TV or small talk between people.'

function describe(req: AddressedRequest): string {
  const lines: string[] = []
  if (req.lastReply?.trim()) {
    const ago = req.sinceReplyMs == null ? '' : ` (${Math.round(req.sinceReplyMs / 1000)} seconds ago)`
    lines.push(`Jarvis last said${ago}: "${req.lastReply.trim().slice(-400)}"`)
  } else lines.push('Jarvis has not said anything yet in this session.')
  lines.push(`Heard now: "${req.text.trim().slice(0, 800)}"`)
  return lines.join('\n')
}

export async function addressedProbability(req: AddressedRequest, settings: Settings): Promise<number | null> {
  if (!req.text.trim()) return 0
  if ((await jevHealth(settings.jevUrl)).online) {
    const answers = await decide(
      settings.jevUrl,
      describe(req),
      {
        forJarvis: {
          type: 'noul',
          instructions: INSTRUCTIONS,
          criteria: {
            true: 'Meant for Jarvis: asks it something, tells it to do something, or answers it.',
            false: 'Meant for someone else or no one: people talking, a call, muttering, background voices.'
          }
        }
      },
      3000
    )
    const a = answers?.forJarvis
    if (a?.type === 'noul' && Number.isFinite(a.noul)) return a.noul
  }
  return ollamaProbability(req, settings)
}

// ---- Ollama fallback ---------------------------------------------------------------------------

let picked: { url: string; model: string | null; at: number } | null = null

/** Smallest chat model pulled (classification needs speed, not depth). Cached for a minute. */
async function ollamaModel(url: string): Promise<string | null> {
  if (picked && picked.url === url && Date.now() - picked.at < 60_000) return picked.model
  let model: string | null = null
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(1000) })
    const data = (await res.json()) as { models?: { name: string; size?: number }[] }
    const chat = (data.models ?? []).filter((m) => !/embed|bge|minilm|nomic|rerank|whisper/i.test(m.name))
    chat.sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))
    model = chat[0]?.name ?? null
  } catch {
    /* not running */
  }
  picked = { url, model, at: Date.now() }
  return model
}

async function ollamaProbability(req: AddressedRequest, settings: Settings): Promise<number | null> {
  const model = await ollamaModel(settings.ollamaUrl)
  if (!model) return null
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: '15m',
        options: { temperature: 0, num_predict: 3 },
        messages: [
          { role: 'system', content: `${INSTRUCTIONS}\nAnswer with exactly one word: yes or no.` },
          { role: 'user', content: `${describe(req)}\n\nIs this meant for Jarvis?` }
        ]
      }),
      // A cold model load can take a few seconds; a classifier that slow isn't worth waiting for.
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { message?: { content?: string } }
    const word = (data.message?.content ?? '').trim().toLowerCase()
    if (/^(yes|ja)\b/.test(word)) return 0.85
    if (/^(no|nein)\b/.test(word)) return 0.15
    return null
  } catch {
    return null
  }
}
