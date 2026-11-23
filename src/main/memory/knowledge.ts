import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { KnowledgeSource, Settings } from '@shared/types'
import { fromBlob, ftsQuery, getDb, toBlob } from './db'
import { dot, embed } from './embed'

const TEXT_EXT = new Set(
  '.md .mdx .txt .rst .org .ts .tsx .js .jsx .mjs .cjs .py .go .rs .rb .java .kt .swift .c .h .cpp .hpp .cs .php .sql .sh .zsh .yaml .yml .toml .json .html .css .scss .vue .svelte .astro .prisma .graphql'.split(
    ' '
  )
)
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.cache',
  'Pods',
  'DerivedData'
])
const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|.*\.min\.(js|css))$/
const MAX_FILE_BYTES = 400_000
const MAX_FILES = 5000
const CHUNK = 1400
const OVERLAP = 200

type Notify = () => void

interface SourceRow {
  id: number
  path: string
  status: KnowledgeSource['status']
  files: number
  chunks: number
  indexed_at: number | null
  error: string | null
}

export function listSources(): KnowledgeSource[] {
  return (getDb().prepare('SELECT * FROM sources ORDER BY path').all() as unknown as SourceRow[]).map((r) => ({
    id: r.id,
    path: r.path,
    status: r.status,
    files: r.files,
    chunks: r.chunks,
    indexedAt: r.indexed_at ?? undefined,
    error: r.error ?? undefined
  }))
}

export function addSource(path: string): number {
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO sources (path) VALUES (?)').run(path)
  return (db.prepare('SELECT id FROM sources WHERE path = ?').get(path) as { id: number }).id
}

export function removeSource(id: number) {
  const db = getDb()
  const ids = db.prepare('SELECT id FROM chunks WHERE source_id = ?').all(id) as { id: number }[]
  const del = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?')
  for (const c of ids) del.run(c.id)
  db.prepare('DELETE FROM sources WHERE id = ?').run(id)
  chunkVecCache = null
}

export function countChunks(): number {
  return (getDb().prepare('SELECT count(*) n FROM chunks').get() as { n: number }).n
}

async function walk(root: string, out: string[] = [], dir = root): Promise<string[]> {
  if (out.length >= MAX_FILES) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break
    if (e.name.startsWith('.') && e.name !== '.github') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, out, p)
    } else if (e.isFile() && TEXT_EXT.has(extname(e.name).toLowerCase()) && !SKIP_FILES.test(p)) {
      out.push(p)
    }
  }
  return out
}

/** Split text into overlapping chunks, preferring paragraph/line boundaries. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n')
  if (clean.length <= CHUNK) return clean.trim() ? [clean] : []
  const out: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + CHUNK, clean.length)
    if (end < clean.length) {
      const para = clean.lastIndexOf('\n\n', end)
      const line = clean.lastIndexOf('\n', end)
      if (para > start + CHUNK / 2) end = para
      else if (line > start + CHUNK / 2) end = line
    }
    const piece = clean.slice(start, end).trim()
    if (piece) out.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - OVERLAP, start + 1)
  }
  return out
}

const indexing = new Set<number>()

/** Incremental index: only re-reads files whose mtime changed; drops deleted files. */
export async function indexSource(id: number, settings: Settings, notify: Notify) {
  if (indexing.has(id)) return
  indexing.add(id)
  const db = getDb()
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as unknown as SourceRow | undefined
  if (!src) return void indexing.delete(id)

  db.prepare("UPDATE sources SET status = 'indexing', error = NULL WHERE id = ?").run(id)
  notify()
  try {
    const st = await stat(src.path)
    const files = st.isDirectory() ? await walk(src.path) : [src.path]

    const known = new Map(
      (db.prepare('SELECT path, max(mtime) mtime FROM chunks WHERE source_id = ? GROUP BY path').all(id) as {
        path: string
        mtime: number
      }[]).map((r) => [r.path, r.mtime])
    )
    const seen = new Set<string>()
    const delChunks = (path: string) => {
      const rows = db.prepare('SELECT id FROM chunks WHERE source_id = ? AND path = ?').all(id, path) as { id: number }[]
      const d = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?')
      for (const r of rows) d.run(r.id)
      db.prepare('DELETE FROM chunks WHERE source_id = ? AND path = ?').run(id, path)
    }

    const ins = db.prepare('INSERT INTO chunks (source_id, path, mtime, ord, text) VALUES (?, ?, ?, ?, ?)')
    const insFts = db.prepare('INSERT INTO chunks_fts (rowid, text, path) VALUES (?, ?, ?)')
    let processed = 0

    for (const file of files) {
      const rel = st.isDirectory() ? relative(src.path, file) : file
      seen.add(rel)
      let fst
      try {
        fst = await stat(file)
      } catch {
        continue
      }
      if (fst.size > MAX_FILE_BYTES) continue
      const mtime = Math.floor(fst.mtimeMs)
      if (known.get(rel) === mtime) continue

      const text = await readFile(file, 'utf8').catch(() => '')
      if (!text || text.includes('\u0000')) continue
      delChunks(rel)
      const pieces = chunkText(text)
      db.exec('BEGIN')
      try {
        pieces.forEach((p, ord) => {
          // Prefix the path so both keyword and semantic search can match on file names.
          const body = `${rel}\n${p}`
          const { lastInsertRowid } = ins.run(id, rel, mtime, ord, body)
          insFts.run(Number(lastInsertRowid), body, rel)
        })
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      if (++processed % 50 === 0) notify()
    }

    for (const path of known.keys()) if (!seen.has(path)) delChunks(path)

    const counts = db
      .prepare('SELECT count(*) chunks, count(DISTINCT path) files FROM chunks WHERE source_id = ?')
      .get(id) as { chunks: number; files: number }
    db.prepare("UPDATE sources SET status = 'ready', files = ?, chunks = ?, indexed_at = ? WHERE id = ?").run(
      counts.files,
      counts.chunks,
      Date.now(),
      id
    )
    chunkVecCache = null
    notify()
    await backfillChunkEmbeddings(settings, notify)
  } catch (err) {
    db.prepare("UPDATE sources SET status = 'error', error = ? WHERE id = ?").run(
      err instanceof Error ? err.message : String(err),
      id
    )
    notify()
  } finally {
    indexing.delete(id)
  }
}

let backfilling = false
export async function backfillChunkEmbeddings(settings: Settings, notify?: Notify) {
  if (backfilling || !settings.embedModel) return
  backfilling = true
  try {
    const db = getDb()
    for (;;) {
      const rows = db
        .prepare('SELECT id, text FROM chunks WHERE embedding IS NULL OR embed_model IS NOT ? LIMIT 32')
        .all(settings.embedModel) as { id: number; text: string }[]
      if (!rows.length) break
      const vecs = await embed(
        rows.map((r) => r.text),
        settings
      )
      if (!vecs) break // Ollama/model missing: keyword search still works
      const up = db.prepare('UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ?')
      rows.forEach((r, i) => up.run(toBlob(vecs[i]), settings.embedModel, r.id))
    }
    chunkVecCache = null
    notify?.()
  } finally {
    backfilling = false
  }
}

let chunkVecCache: { ids: Int32Array; vecs: Float32Array[] } | null = null
function chunkVectors(model: string) {
  if (chunkVecCache) return chunkVecCache
  const rows = getDb()
    .prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embed_model = ?')
    .all(model) as { id: number; embedding: Uint8Array }[]
  chunkVecCache = { ids: Int32Array.from(rows.map((r) => r.id)), vecs: rows.map((r) => fromBlob(r.embedding)) }
  return chunkVecCache
}

export interface ChunkHit {
  id: number
  path: string
  source: string
  text: string
  score: number
}

export function searchChunks(query: string, queryVec: Float32Array | null, settings: Settings, limit = 5): ChunkHit[] {
  const db = getDb()
  const K = 60
  const ranks = new Map<number, number>()

  const fts = ftsQuery(query)
  if (fts) {
    const hits = db
      .prepare('SELECT rowid id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 40')
      .all(fts) as { id: number }[]
    hits.forEach((h, i) => ranks.set(h.id, (ranks.get(h.id) ?? 0) + 1 / (K + i)))
  }
  if (queryVec) {
    const { ids, vecs } = chunkVectors(settings.embedModel)
    const scored: { id: number; s: number }[] = []
    for (let i = 0; i < ids.length; i++) scored.push({ id: ids[i], s: dot(queryVec, vecs[i]) })
    scored.sort((a, b) => b.s - a.s)
    scored
      .slice(0, 40)
      .filter((x) => x.s > 0.35)
      .forEach((x, i) => ranks.set(x.id, (ranks.get(x.id) ?? 0) + 1 / (K + i)))
  }

  const get = db.prepare(
    'SELECT c.id, c.path, c.text, s.path source FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?'
  )
  return [...ranks]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const r = get.get(id) as { id: number; path: string; text: string; source: string } | undefined
      return r ? { ...r, score } : null
    })
    .filter((x): x is ChunkHit => !!x)
}
