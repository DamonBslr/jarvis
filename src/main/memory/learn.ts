import { homedir } from 'node:os'
import type { LearnedEvent, MemoryType, Settings } from '@shared/types'
import { clip, decide } from '../classify/jev'
import { runOnce } from '../providers/spawn'
import { embed } from './embed'
import { addMemory, getMemory, MEMORY_TYPES, nearestMemory, searchMemories, updateMemory } from './memories'

const EXPLICIT = /^\s*(\/remember|remember( that)?|note( that)?|from now on|always|never)\b/i
const HINTS =
  /\b(i (always|never|prefer|like|love|hate|dislike|want|don't want|usually|work|am|'m)|my (name|company|team|project|repo|stack|boss|manager|wife|husband|partner|job|role)|call me|stop (doing|using)|don't (ever|use|do)|instead of|we use|our (stack|team|process|repo))\b/i

const EXTRACT_PROMPT = `You maintain a long-term memory of a single user for their personal AI assistant "Jarvis".
From the exchange below, extract ONLY durable information about the user that will matter in future, unrelated sessions:
- profile: who they are (name, role, location, languages)
- preference: how they like things done (style, tools, tone, formats)
- workflow: process rules (branching, commits, reviews, tickets)
- project: their projects, repos, stacks, goals
- person: people/teams they work with
- fact: other stable facts
Ignore one-off task details, things the assistant said, and anything temporary.
Existing related memories are listed with ids. If new info refines or contradicts one, emit an update for that id instead of adding a duplicate.
Write each memory as one short, standalone sentence in third person ("User prefers ...").
Respond with JSON only, no prose:
{"ops":[{"op":"add","type":"preference","content":"..."},{"op":"update","id":12,"content":"..."}]}
Return {"ops":[]} if there is nothing worth remembering.`

type Op = { op: 'add'; type: MemoryType; content: string } | { op: 'update'; id: number; content: string; type?: MemoryType }

/** Cheap gate: is this turn worth an extraction call? Jev when available, regex otherwise. */
async function worthRemembering(prompt: string, answer: string, settings: Settings): Promise<boolean> {
  if (EXPLICIT.test(prompt)) return true
  const answers = await decide(settings.jevUrl, clip(`USER: ${prompt}\n\nASSISTANT: ${answer.slice(0, 1500)}`), {
    remember: {
      type: 'noul',
      instructions:
        "Does the USER's message reveal durable information about the user worth remembering for future sessions: a personal preference, a correction of how the assistant should work, a profile fact, a project detail, or a person they work with?",
      criteria: {
        true: 'Contains a lasting preference, rule, correction, or fact about the user or their projects.',
        false: 'Only a one-off question or task instruction with nothing lasting about the user.'
      }
    }
  })
  const a = answers?.remember
  if (a && a.type === 'noul') return a.noul >= 0.5
  return HINTS.test(prompt)
}

function parseOps(raw: string): Op[] {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as { ops?: Op[] }
    return Array.isArray(data.ops) ? data.ops.slice(0, 8) : []
  } catch {
    return []
  }
}

async function extract(input: string, settings: Settings, env: NodeJS.ProcessEnv): Promise<Op[]> {
  if (settings.learnEngine === 'ollama') {
    const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.learnOllamaModel,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: input }
        ]
      }),
      signal: AbortSignal.timeout(90_000)
    })
    const data = (await res.json()) as { message?: { content?: string } }
    return parseOps(data.message?.content ?? '')
  }

  // Claude Haiku via your subscription, stripped down: no tools, no MCP, no hooks/settings,
  // own small system prompt, nothing saved to session history.
  const out = await runOnce(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt',
      EXTRACT_PROMPT,
      '--output-format',
      'json'
    ],
    { stdin: input, env, cwd: homedir(), timeoutMs: 90_000 }
  )
  const line = out.trim().split('\n').pop() ?? ''
  const data = JSON.parse(line) as { result?: string }
  return parseOps(data.result ?? '')
}

/**
 * After a turn: decide if it taught us something, extract memories, de-duplicate, store.
 * Runs in the background; never blocks the chat.
 */
export async function learnFromTurn(
  turn: { convId: string; msgId: string; prompt: string; answer: string },
  settings: Settings,
  env: NodeJS.ProcessEnv
): Promise<LearnedEvent | null> {
  if (settings.learnEngine === 'off') return null
  if (!(await worthRemembering(turn.prompt, turn.answer, settings))) return null

  const qvec = (await embed([turn.prompt], settings))?.[0] ?? null
  const related = searchMemories(turn.prompt, qvec, settings, 8)
  const input = [
    'Existing related memories:',
    related.length ? related.map((r) => `#${r.item.id} [${r.item.type}] ${r.item.content}`).join('\n') : '(none)',
    '',
    `USER: ${clip(turn.prompt, 4000)}`,
    '',
    `ASSISTANT: ${clip(turn.answer, 2000)}`
  ].join('\n')

  const ops = await extract(input, settings, env)
  const added: LearnedEvent['added'] = []
  const relatedIds = new Set(related.map((r) => r.item.id))

  for (const op of ops) {
    const content = String((op as { content?: unknown }).content ?? '').trim()
    if (!content) continue
    if (op.op === 'update' && relatedIds.has(Number(op.id))) {
      const type = MEMORY_TYPES.includes(op.type as MemoryType) ? op.type : undefined
      updateMemory(Number(op.id), { content, type }, settings)
      added.push({ id: Number(op.id), type: type ?? getMemory(Number(op.id))?.type ?? 'fact', content, updated: true })
      continue
    }
    const type: MemoryType = MEMORY_TYPES.includes((op as { type: MemoryType }).type)
      ? (op as { type: MemoryType }).type
      : 'fact'
    // Semantic de-dup: near-identical memory already exists -> refresh it instead.
    const vec = (await embed([content], settings))?.[0]
    const near = vec ? nearestMemory(vec, settings) : null
    if (near && near.sim > 0.92) {
      updateMemory(near.id, { content }, settings)
      added.push({ id: near.id, type, content, updated: true })
    } else {
      const m = addMemory({ type, content, source: `learned:${turn.convId}` }, settings)
      added.push({ id: m.id, type: m.type, content: m.content })
    }
  }
  return added.length ? { convId: turn.convId, msgId: turn.msgId, added } : null
}
