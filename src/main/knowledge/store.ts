// Projects + activity items in the local SQLite store, and project-aware ranked search over them.
import { basename } from 'node:path'
import type { ConnectorId, ItemKind, KnowledgeItem, Project, Settings, SyncState } from '@shared/types'
import { fromBlob, ftsQuery, getDb, toBlob } from '../memory/db'
import { dot, embed } from '../memory/embed'

// ---- projects -------------------------------------------------------------

interface ProjectRow {
  id: string
  name: string
  path: string | null
  github: string | null
  linear_team: string | null
  linear_project: string | null
  t3_project_id: string | null
  focus: number
  notes: string | null
  brief: string | null
  brief_at: number | null
  brief_hash: string | null
  last_activity_at: number | null
  created_at: number
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  path: r.path ?? undefined,
  github: r.github ?? undefined,
  linearTeam: r.linear_team ?? undefined,
  linearProject: r.linear_project ?? undefined,
  t3ProjectId: r.t3_project_id ?? undefined,
  focus: !!r.focus,
  notes: r.notes ?? undefined,
  brief: r.brief ?? undefined,
  briefAt: r.brief_at ?? undefined,
  lastActivityAt: r.last_activity_at ?? undefined,
  createdAt: r.created_at
})

export function listProjects(): Project[] {
  return (
    getDb().prepare('SELECT * FROM projects ORDER BY focus DESC, last_activity_at DESC NULLS LAST, name').all() as unknown as ProjectRow[]
  ).map(toProject)
}

export const focusProjects = () => listProjects().filter((p) => p.focus)

export function getProject(id: string): Project | null {
  const r = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
  return r ? toProject(r) : null
}

export function briefHash(id: string): string | undefined {
  return (getDb().prepare('SELECT brief_hash h FROM projects WHERE id = ?').get(id) as { h: string | null } | undefined)?.h ?? undefined
}

/** Find a project by id, name or repo name (case-insensitive), for agent tools and prompts. */
export function findProject(ref: string): Project | null {
  const want = ref.trim().toLowerCase()
  if (!want) return null
  const all = listProjects()
  return (
    all.find((p) => p.id === want) ??
    all.find((p) => p.name.toLowerCase() === want) ??
    all.find((p) => p.github?.toLowerCase() === want || p.github?.toLowerCase().endsWith(`/${want}`)) ??
    all.find((p) => p.path && basename(p.path).toLowerCase() === want) ??
    null
  )
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'project'

/** Create (or return) the project for a repo path. */
export function ensureProject(input: { path: string; name?: string; github?: string; t3ProjectId?: string }): Project {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM projects WHERE path = ?').get(input.path) as unknown as ProjectRow | undefined
  if (existing) {
    // Fill in links we learned since.
    if ((input.github && !existing.github) || (input.t3ProjectId && !existing.t3_project_id)) {
      db.prepare('UPDATE projects SET github = coalesce(github, ?), t3_project_id = coalesce(t3_project_id, ?) WHERE id = ?').run(
        input.github ?? null,
        input.t3ProjectId ?? null,
        existing.id
      )
    }
    return getProject(existing.id)!
  }
  const base = slug(input.name ?? basename(input.path))
  let id = base
  for (let i = 2; db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id); i++) id = `${base}-${i}`
  db.prepare('INSERT INTO projects (id, name, path, github, t3_project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    input.name ?? basename(input.path),
    input.path,
    input.github ?? null,
    input.t3ProjectId ?? null,
    Date.now()
  )
  linkItemsToProject(id, input.path)
  return getProject(id)!
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'name' | 'focus' | 'notes' | 'github' | 'linearTeam' | 'linearProject' | 't3ProjectId'>>
) {
  const cols: Record<string, string> = {
    name: 'name',
    focus: 'focus',
    notes: 'notes',
    github: 'github',
    linearTeam: 'linear_team',
    linearProject: 'linear_project',
    t3ProjectId: 't3_project_id'
  }
  const db = getDb()
  for (const [k, v] of Object.entries(patch)) {
    const col = cols[k]
    if (!col || v === undefined) continue
    db.prepare(`UPDATE projects SET ${col} = ? WHERE id = ?`).run(typeof v === 'boolean' ? (v ? 1 : 0) : v === '' ? null : v, id)
  }
}

export function setBrief(id: string, brief: string, hash: string) {
  getDb().prepare('UPDATE projects SET brief = ?, brief_at = ?, brief_hash = ? WHERE id = ?').run(brief, Date.now(), hash, id)
}

export function removeProject(id: string) {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/** Point every item from this repo at the project (items synced before the project existed). */
function linkItemsToProject(id: string, path: string) {
  getDb().prepare('UPDATE items SET project_id = ? WHERE repo = ? AND project_id IS NULL').run(id, path)
}

export function touchActivity() {
  getDb().exec(
    'UPDATE projects SET last_activity_at = (SELECT max(at) FROM items WHERE items.project_id = projects.id) WHERE EXISTS (SELECT 1 FROM items WHERE items.project_id = projects.id)'
  )
}

/** Which project a repo root / GitHub repo / Linear team / T3 project belongs to. */
export class ProjectIndex {
  private byPath = new Map<string, string>()
  private byGithub = new Map<string, string>()
  private byT3 = new Map<string, string>()
  private byLinear = new Map<string, string>()
  readonly projects: Project[]
  constructor() {
    this.projects = listProjects()
    for (const p of this.projects) {
      if (p.path) this.byPath.set(p.path, p.id)
      if (p.github) this.byGithub.set(p.github.toLowerCase(), p.id)
      if (p.t3ProjectId) this.byT3.set(p.t3ProjectId, p.id)
      if (p.linearProject) this.byLinear.set(`p:${p.linearProject.toLowerCase()}`, p.id)
      if (p.linearTeam) this.byLinear.set(`t:${p.linearTeam.toLowerCase()}`, p.id)
    }
  }
  repo(root?: string | null) {
    return root ? this.byPath.get(root) : undefined
  }
  github(nameWithOwner?: string | null) {
    return nameWithOwner ? this.byGithub.get(nameWithOwner.toLowerCase()) : undefined
  }
  t3(id?: string | null) {
    return id ? this.byT3.get(id) : undefined
  }
  /** Linear project name wins over team key (one team often spans several projects). */
  linear(project?: string | null, team?: string | null) {
    return (project && this.byLinear.get(`p:${project.toLowerCase()}`)) || (team && this.byLinear.get(`t:${team.toLowerCase()}`)) || undefined
  }
  isFocus(id?: string) {
    return !!id && !!this.projects.find((p) => p.id === id)?.focus
  }
}

// ---- items ----------------------------------------------------------------

export interface ItemInput {
  /** Unique per source, e.g. "github:pr:owner/repo#12". */
  uid: string
  source: ConnectorId
  kind: ItemKind
  projectId?: string
  repo?: string
  title: string
  body?: string
  url?: string
  state?: string
  author?: string
  at: number
  meta?: Record<string, unknown>
}

const MAX_BODY = 8000

/** Insert or update items by uid. Changed text drops the embedding so it is recomputed. */
export function upsertItems(items: ItemInput[]): number {
  if (!items.length) return 0
  const db = getDb()
  const find = db.prepare('SELECT id, title, body FROM items WHERE uid = ?')
  const ins = db.prepare(
    'INSERT INTO items (uid, source, kind, project_id, repo, title, body, url, state, author, at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const upd = db.prepare(
    'UPDATE items SET kind = ?, project_id = coalesce(?, project_id), repo = coalesce(?, repo), title = ?, body = ?, url = ?, state = ?, author = ?, at = ?, meta = ? WHERE id = ?'
  )
  const dropVec = db.prepare('UPDATE items SET embedding = NULL WHERE id = ?')
  const delFts = db.prepare('DELETE FROM items_fts WHERE rowid = ?')
  const insFts = db.prepare('INSERT INTO items_fts (rowid, title, body) VALUES (?, ?, ?)')
  let changed = 0
  db.exec('BEGIN')
  try {
    for (const it of items) {
      const title = it.title.trim().slice(0, 300) || '(untitled)'
      const body = it.body?.trim().slice(0, MAX_BODY) || null
      const meta = it.meta ? JSON.stringify(it.meta) : null
      const cur = find.get(it.uid) as { id: number; title: string; body: string | null } | undefined
      if (!cur) {
        const { lastInsertRowid } = ins.run(
          it.uid,
          it.source,
          it.kind,
          it.projectId ?? null,
          it.repo ?? null,
          title,
          body,
          it.url ?? null,
          it.state ?? null,
          it.author ?? null,
          it.at,
          meta
        )
        insFts.run(Number(lastInsertRowid), title, body ?? '')
        changed++
        continue
      }
      upd.run(it.kind, it.projectId ?? null, it.repo ?? null, title, body, it.url ?? null, it.state ?? null, it.author ?? null, it.at, meta, cur.id)
      if (cur.title !== title || cur.body !== body) {
        delFts.run(cur.id)
        insFts.run(cur.id, title, body ?? '')
        dropVec.run(cur.id)
        vecCache = null
        changed++
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return changed
}

/** Drop items of a source that a full sync no longer saw (e.g. closed-and-gone PRs), within a uid prefix. */
export function pruneItems(prefix: string, keep: Set<string>) {
  const db = getDb()
  const rows = db.prepare("SELECT id, uid FROM items WHERE uid LIKE ? ESCAPE '\\'").all(prefix.replace(/[\\%_]/g, '\\$&') + '%') as {
    id: number
    uid: string
  }[]
  const del = db.prepare('DELETE FROM items WHERE id = ?')
  const delFts = db.prepare('DELETE FROM items_fts WHERE rowid = ?')
  for (const r of rows) {
    if (keep.has(r.uid)) continue
    del.run(r.id)
    delFts.run(r.id)
  }
}

interface ItemRow {
  id: number
  source: ConnectorId
  kind: ItemKind
  project_id: string | null
  title: string
  body: string | null
  url: string | null
  state: string | null
  author: string | null
  at: number
  meta?: string | null
}

const ITEM_COLS = 'id, source, kind, project_id, title, body, url, state, author, at'

export const toItem = (r: ItemRow): KnowledgeItem => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  projectId: r.project_id ?? undefined,
  title: r.title,
  body: r.body ?? undefined,
  url: r.url ?? undefined,
  state: r.state ?? undefined,
  author: r.author ?? undefined,
  at: r.at
})

export function itemMeta(id: number): Record<string, unknown> {
  const r = getDb().prepare('SELECT meta FROM items WHERE id = ?').get(id) as { meta: string | null } | undefined
  try {
    return r?.meta ? JSON.parse(r.meta) : {}
  } catch {
    return {}
  }
}

export function recentItems(opts: { projectId?: string; since?: number; sources?: ConnectorId[]; limit?: number } = {}): KnowledgeItem[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (opts.projectId) {
    where.push('project_id = ?')
    args.push(opts.projectId)
  }
  if (opts.since) {
    where.push('at >= ?')
    args.push(opts.since)
  }
  if (opts.sources?.length) {
    where.push(`source IN (${opts.sources.map(() => '?').join(',')})`)
    args.push(...opts.sources)
  }
  const sql = `SELECT ${ITEM_COLS} FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`
  return (getDb().prepare(sql).all(...args, opts.limit ?? 50) as unknown as ItemRow[]).map(toItem)
}

/** Items with their meta, for loop detection. */
export function itemsWithMeta(where: string, ...args: (string | number)[]): (KnowledgeItem & { uid: string; meta: Record<string, unknown> })[] {
  return (getDb().prepare(`SELECT ${ITEM_COLS}, uid, meta FROM items WHERE ${where}`).all(...args) as unknown as (ItemRow & { uid: string })[]).map((r) => {
    let meta: Record<string, unknown> = {}
    try {
      meta = r.meta ? JSON.parse(r.meta) : {}
    } catch {
      /* ignore */
    }
    return { ...toItem(r), uid: r.uid, meta }
  })
}

export function countItems(projectId?: string, since?: number): number {
  const db = getDb()
  if (projectId)
    return (db.prepare('SELECT count(*) n FROM items WHERE project_id = ? AND at >= ?').get(projectId, since ?? 0) as { n: number }).n
  return (db.prepare('SELECT count(*) n FROM items WHERE at >= ?').get(since ?? 0) as { n: number }).n
}

// ---- embeddings -----------------------------------------------------------

let vecCache: { ids: Int32Array; vecs: Float32Array[] } | null = null
function itemVectors(model: string) {
  if (vecCache) return vecCache
  const rows = getDb()
    .prepare('SELECT id, embedding FROM items WHERE embedding IS NOT NULL AND embed_model = ?')
    .all(model) as { id: number; embedding: Uint8Array }[]
  vecCache = { ids: Int32Array.from(rows.map((r) => r.id)), vecs: rows.map((r) => fromBlob(r.embedding)) }
  return vecCache
}

let backfilling = false
/** Embed items without vectors, focus projects and recent items first. Bounded per call. */
export async function backfillItemEmbeddings(settings: Settings, max = 600) {
  if (backfilling || !settings.embedModel) return
  backfilling = true
  try {
    const db = getDb()
    let done = 0
    while (done < max) {
      const rows = db
        .prepare(
          `SELECT i.id, i.title, i.body FROM items i LEFT JOIN projects p ON p.id = i.project_id
           WHERE i.embedding IS NULL OR i.embed_model IS NOT ?
           ORDER BY coalesce(p.focus, 0) DESC, i.at DESC LIMIT 32`
        )
        .all(settings.embedModel) as { id: number; title: string; body: string | null }[]
      if (!rows.length) break
      const vecs = await embed(
        rows.map((r) => `${r.title}\n${(r.body ?? '').slice(0, 1500)}`),
        settings
      )
      if (!vecs) break
      const up = db.prepare('UPDATE items SET embedding = ?, embed_model = ? WHERE id = ?')
      rows.forEach((r, i) => up.run(toBlob(vecs[i]), settings.embedModel, r.id))
      done += rows.length
    }
    vecCache = null
  } finally {
    backfilling = false
  }
}

// ---- search ---------------------------------------------------------------

export interface SearchOpts {
  /** Project the user is in right now (workspace): strongest boost. */
  activeProject?: string
  /** Only this project. */
  projectId?: string
  sources?: ConnectorId[]
  since?: number
  limit?: number
}

const DAY = 86_400_000

/**
 * Hybrid search over items: BM25 + cosine fused with reciprocal rank fusion, then weighted by
 * what matters to the user: the project they're in, their focus projects, and recency.
 */
export function searchItems(query: string, queryVec: Float32Array | null, settings: Settings, opts: SearchOpts = {}) {
  const db = getDb()
  const K = 60
  const ranks = new Map<number, number>()
  const fts = ftsQuery(query)
  if (fts) {
    const hits = db
      .prepare('SELECT rowid id FROM items_fts WHERE items_fts MATCH ? ORDER BY bm25(items_fts, 2.0, 1.0) LIMIT 80')
      .all(fts) as { id: number }[]
    hits.forEach((h, i) => ranks.set(h.id, (ranks.get(h.id) ?? 0) + 1 / (K + i)))
  }
  if (queryVec) {
    const { ids, vecs } = itemVectors(settings.embedModel)
    const scored: { id: number; s: number }[] = []
    for (let i = 0; i < ids.length; i++) scored.push({ id: ids[i], s: dot(queryVec, vecs[i]) })
    scored.sort((a, b) => b.s - a.s)
    scored
      .slice(0, 80)
      .filter((x) => x.s > 0.35)
      .forEach((x, i) => ranks.set(x.id, (ranks.get(x.id) ?? 0) + 1 / (K + i)))
  }
  if (!ranks.size) return []

  const focus = new Set(focusProjects().map((p) => p.id))
  const get = db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`)
  const now = Date.now()
  const out: { item: KnowledgeItem; score: number }[] = []
  for (const [id, base] of ranks) {
    const r = get.get(id) as unknown as ItemRow | undefined
    if (!r) continue
    const it = toItem(r)
    if (opts.projectId && it.projectId !== opts.projectId) continue
    if (opts.sources?.length && !opts.sources.includes(it.source)) continue
    if (opts.since && it.at < opts.since) continue
    let w = 1
    if (it.projectId && it.projectId === opts.activeProject) w *= 2
    else if (it.projectId && focus.has(it.projectId)) w *= 1.5
    w *= 0.55 + 0.45 * Math.exp(-(now - it.at) / (21 * DAY))
    out.push({ item: it, score: base * w })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8)
}

// ---- sync state + kv ------------------------------------------------------

export function getSyncState(source: ConnectorId): SyncState | undefined {
  const r = getDb().prepare('SELECT * FROM sync_state WHERE source = ?').get(source) as
    | { status: SyncState['status']; synced_at: number | null; items: number | null; error: string | null }
    | undefined
  return r ? { status: r.status, syncedAt: r.synced_at ?? undefined, items: r.items ?? undefined, error: r.error ?? undefined } : undefined
}

export function setSyncState(source: ConnectorId, s: SyncState) {
  getDb()
    .prepare(
      'INSERT INTO sync_state (source, status, synced_at, items, error) VALUES (?, ?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET status = excluded.status, synced_at = coalesce(excluded.synced_at, synced_at), items = coalesce(excluded.items, items), error = excluded.error'
    )
    .run(source, s.status, s.syncedAt ?? null, s.items ?? null, s.error ?? null)
}

export function sourceItemCount(source: ConnectorId): number {
  return (getDb().prepare('SELECT count(*) n FROM items WHERE source = ?').get(source) as { n: number }).n
}

export function kvGet(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

export function kvSet(key: string, value: string | null) {
  if (value === null) getDb().prepare('DELETE FROM kv WHERE key = ?').run(key)
  else getDb().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Make the next sync of a source a full re-read (e.g. after focus projects change). */
export function resetSyncCursor(source: ConnectorId) {
  getDb().prepare('UPDATE sync_state SET synced_at = NULL WHERE source = ?').run(source)
}
