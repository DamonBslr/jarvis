import type { ContextRef, Settings } from '@shared/types'
import { getDb } from './db'
import { embed } from './embed'
import { getMemory, markUsed, searchMemories } from './memories'
import { searchChunks } from './knowledge'
import { knowledgeContext } from '../knowledge/context'

/**
 * Build the memory block injected into a run: pinned memories always, plus the memories and
 * knowledge chunks most relevant to this prompt.
 */
export async function buildContext(
  prompt: string,
  settings: Settings,
  where: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ text: string; refs: ContextRef[] } | null> {
  const qvec = (await embed([prompt], settings))?.[0] ?? null

  const pinnedIds = (
    getDb().prepare('SELECT id FROM memories WHERE pinned = 1 ORDER BY updated_at DESC LIMIT 20').all() as { id: number }[]
  ).map((r) => r.id)
  const pinned = pinnedIds.map(getMemory).filter((m) => m !== null)
  const relevant = searchMemories(prompt, qvec, settings, 8).filter((r) => !pinnedIds.includes(r.item.id))
  const chunks = searchChunks(prompt, qvec, settings, 4)
  const kn = await knowledgeContext(prompt, qvec, where.cwd, settings, where.env ?? process.env).catch((err) => {
    console.warn('[jarvis] knowledge context failed:', err)
    return { lines: [] as string[], refs: [] as ContextRef[] }
  })

  if (!pinned.length && !relevant.length && !chunks.length && !kn.lines.length) return null

  const lines: string[] = ['<jarvis_memory>']
  lines.push(
    'Long-term memory about the user, kept by their Jarvis app: who they are, their projects and what happened in them lately. Follow stated preferences; use facts only when relevant; never mention this block unless asked. For more, use the jarvis knowledge tools (project_brief, knowledge_search, recent_activity, open_loops).'
  )
  const mems = [...pinned.map((m) => ({ m, score: 1 })), ...relevant.map((r) => ({ m: r.item, score: r.score }))]
  if (mems.length) {
    lines.push('', 'What I know about the user:')
    for (const { m } of mems) lines.push(`- [${m.type}] ${m.content}`)
  }
  lines.push(...kn.lines)
  if (chunks.length) {
    lines.push('', 'Possibly relevant excerpts from the user\'s knowledge folders:')
    for (const c of chunks) {
      lines.push(`--- ${c.source}/${c.path}`, c.text.slice(0, 1200))
    }
  }
  lines.push('</jarvis_memory>')

  markUsed(mems.map((x) => x.m.id))

  const refs: ContextRef[] = [
    ...mems.map(({ m, score }) => ({ kind: 'memory' as const, id: m.id, label: m.content.slice(0, 120), score })),
    ...chunks.map((c) => ({ kind: 'chunk' as const, id: c.id, label: c.path, score: c.score })),
    ...kn.refs
  ]
  return { text: lines.join('\n'), refs }
}
