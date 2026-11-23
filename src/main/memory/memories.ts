import type { Memory, MemoryType, Settings } from '@shared/types'
import { fromBlob, ftsQuery, getDb, toBlob } from './db'
import { dot, embed } from './embed'

export const MEMORY_TYPES: MemoryType[] = ['profile', 'preference', 'project', 'workflow', 'person', 'fact']

interface Row {
  id: number
  type: MemoryType
  content: string
  source: string
  pinned: number
  uses: number
  created_at: number
  updated_at: number
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  type: r.type,
  content: r.content,
  source: r.source,
  pinned: !!r.pinned,
  uses: r.uses,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const COLS = 'id, type, content, source, pinned, uses, created_at, updated_at'

// In-memory vector cache; memories are few (hundreds/thousands), brute force is fine.
let vecCache: Map<number, Float32Array> | null = null
function vectors(model: string): Map<number, Float32Array> {
  if (vecCache) return vecCache
  vecCache = new Map()
  const rows = getDb()
    .prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND embed_model = ?')
    .all(model) as { id: number; embedding: Uint8Array }[]
  for (const r of rows) vecCache.set(r.id, fromBlob(r.embedding))
  return vecCache
}

async function embedRow(id: number, content: string, settings: Settings) {
  const v = await embed([content], settings)
  if (!v?.[0]) return
  getDb()
    .prepare('UPDATE memories SET embedding = ?, embed_model = ? WHERE id = ?')
    .run(toBlob(v[0]), settings.embedModel, id)
  vecCache = null
}

export function listMemories(): Memory[] {
  return (getDb().prepare(`SELECT ${COLS} FROM memories ORDER BY pinned DESC, updated_at DESC`).all() as unknown as Row[]).map(
    toMemory
  )
}

export function getMemory(id: number): Memory | null {
  const r = getDb().prepare(`SELECT ${COLS} FROM memories WHERE id = ?`).get(id) as unknown as Row | undefined
  return r ? toMemory(r) : null
}

export function addMemory(
  m: { type: MemoryType; content: string; pinned?: boolean; source?: string },
  settings: Settings
): Memory {
  const type = MEMORY_TYPES.includes(m.type) ? m.type : 'fact'
  const content = m.content.trim().slice(0, 2000)
  if (!content) throw new Error('empty memory')
  const now = Date.now()
  const db = getDb()
  const { lastInsertRowid } = db
    .prepare('INSERT INTO memories (type, content, source, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(type, content, m.source ?? 'manual', m.pinned ? 1 : 0, now, now)
  const id = Number(lastInsertRowid)
  db.prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)').run(id, content)
  void embedRow(id, content, settings)
  return getMemory(id)!
}

export function updateMemory(
  id: number,
  patch: Partial<Pick<Memory, 'type' | 'content' | 'pinned'>>,
  settings: Settings
) {
  const cur = getMemory(id)
  if (!cur) return
  const next = {
    type: patch.type && MEMORY_TYPES.includes(patch.type) ? patch.type : cur.type,
    content: (patch.content ?? cur.content).trim().slice(0, 2000),
    pinned: patch.pinned ?? cur.pinned
  }
  const db = getDb()
  db.prepare('UPDATE memories SET type = ?, content = ?, pinned = ?, updated_at = ? WHERE id = ?').run(
    next.type,
    next.content,
    next.pinned ? 1 : 0,
    Date.now(),
    id
  )
  if (next.content !== cur.content) {
    db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(id)
    db.prepare('INSERT INTO memories_fts (rowid, content) VALUES (?, ?)').run(id, next.content)
    db.prepare('UPDATE memories SET embedding = NULL WHERE id = ?').run(id)
    vecCache = null
    void embedRow(id, next.content, settings)
  }
}

export function removeMemory(id: number) {
  const db = getDb()
  db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(id)
  vecCache?.delete(id)
}

export function markUsed(ids: number[]) {
  const stmt = getDb().prepare('UPDATE memories SET uses = uses + 1 WHERE id = ?')
  for (const id of ids) stmt.run(id)
}

export function countMemories(): number {
  return (getDb().prepare('SELECT count(*) n FROM memories').get() as { n: number }).n
}

/** Re-embed rows that are missing vectors (e.g. after enabling Ollama or changing model). */
export async function backfillMemoryEmbeddings(settings: Settings) {
  const rows = getDb()
    .prepare('SELECT id, content FROM memories WHERE embedding IS NULL OR embed_model IS NOT ?')
    .all(settings.embedModel) as { id: number; content: string }[]
  for (let i = 0; i < rows.length; i += 32) {
    const batch = rows.slice(i, i + 32)
    const vecs = await embed(
      batch.map((r) => r.content),
      settings
    )
    if (!vecs) return
    const stmt = getDb().prepare('UPDATE memories SET embedding = ?, embed_model = ? WHERE id = ?')
    batch.forEach((r, j) => stmt.run(toBlob(vecs[j]), settings.embedModel, r.id))
  }
  vecCache = null
}

export interface Scored<T> {
  item: T
  score: number
}

/**
 * Hybrid search: BM25 keyword hits + cosine similarity, fused with reciprocal rank fusion.
 * `queryVec` is optional; without it this is keyword-only.
 */
export function searchMemories(query: string, queryVec: Float32Array | null, settings: Settings, limit = 8) {
  const db = getDb()
  const ranks = new Map<number, number>()
  const K = 60

  const fts = ftsQuery(query)
  if (fts) {
    const hits = db
      .prepare('SELECT rowid id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT 30')
      .all(fts) as { id: number }[]
    hits.forEach((h, i) => ranks.set(h.id, (ranks.get(h.id) ?? 0) + 1 / (K + i)))
  }

  const sims = new Map<number, number>()
  if (queryVec) {
    const scored = [...vectors(settings.embedModel)].map(([id, v]) => ({ id, s: dot(queryVec, v) }))
    scored.sort((a, b) => b.s - a.s)
    scored
      .slice(0, 30)
      .filter((x) => x.s > 0.3)
      .forEach((x, i) => {
        sims.set(x.id, x.s)
        ranks.set(x.id, (ranks.get(x.id) ?? 0) + 1 / (K + i))
      })
  }

  const top = [...ranks].sort((a, b) => b[1] - a[1]).slice(0, limit)
  return top
    .map(([id, score]) => ({ item: getMemory(id), score, sim: sims.get(id) }))
    .filter((x): x is { item: Memory; score: number; sim: number | undefined } => !!x.item)
}

/** Nearest existing memory by meaning, for de-duplication when learning. */
export function nearestMemory(vec: Float32Array, settings: Settings): { id: number; sim: number } | null {
  let best: { id: number; sim: number } | null = null
  for (const [id, v] of vectors(settings.embedModel)) {
    const s = dot(vec, v)
    if (!best || s > best.sim) best = { id, sim: s }
  }
  return best
}
