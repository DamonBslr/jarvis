// Knowledge orchestrator: connectors, background sync, focus projects, briefs, overview.
import { powerMonitor } from 'electron'
import type { ConnectorId, ConnectorInfo, KnowledgeOverview, Project, ProjectCandidate, Settings, SyncProgress } from '@shared/types'
import * as store from '../store'
import { loadShellEnv } from '../shellEnv'
import { childEnv } from '../runner'
import { claudeHistory, codexHistory } from './connectors/agents'
import { gitConnector } from './connectors/git'
import { githubConnector } from './connectors/github'
import { linearConnector } from './connectors/linear'
import { t3Connector } from './connectors/t3'
import { docsConnector, jarvisConnector } from './connectors/local'
import type { Connector } from './connectors/types'
import { discoverProjects } from './discover'
import { writeBrief } from './briefs'
import { openLoops } from './loops'
import { githubSlug } from './repos'
import {
  backfillItemEmbeddings,
  countItems,
  ensureProject,
  focusProjects,
  getSyncState,
  kvGet,
  kvSet,
  listProjects,
  ProjectIndex,
  recentItems,
  resetSyncCursor,
  setSyncState,
  sourceItemCount,
  touchActivity,
  updateProject
} from './store'

/** Sync order matters: projects get linked (git, T3) before sources that map onto them. */
export const CONNECTORS: Connector[] = [gitConnector, docsConnector, t3Connector, claudeHistory, codexHistory, jarvisConnector, githubConnector, linearConnector]
const byId = (id: ConnectorId) => CONNECTORS.find((c) => c.id === id)

let emitProgress: (p: SyncProgress) => void = () => {}
let emitChanged: () => void = () => {}
export function onKnowledgeEvents(h: { progress(p: SyncProgress): void; changed(): void }) {
  emitProgress = h.progress
  emitChanged = h.changed
}

const log = (m: string) => console.log(`[knowledge] ${m}`)

export async function connectorInfos(): Promise<ConnectorInfo[]> {
  const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
  return Promise.all(
    CONNECTORS.map(async (c) => {
      const d = await Promise.race([
        c.detect(env, settings),
        new Promise<Awaited<ReturnType<Connector['detect']>>>((r) => setTimeout(() => r({ available: false, detail: 'check timed out' }), 12_000))
      ]).catch((err) => ({ available: false, detail: String(err) }))
      return { id: c.id, name: c.name, reads: c.reads, ...d, enabled: !!settings.syncSources[c.id], sync: getSyncState(c.id) }
    })
  )
}

export async function setSource(id: ConnectorId, enabled: boolean): Promise<Settings> {
  const s = await store.getSettings()
  const next: Settings = { ...s, syncSources: { ...s.syncSources, [id]: enabled } }
  // Reading T3 needs Jarvis signed in to T3 (the same session its agents use).
  if (id === 't3' && enabled) next.t3Tools = true
  await store.saveSettings(next)
  return next
}

// ---- sync -----------------------------------------------------------------

let queue: Promise<void> = Promise.resolve()
let running = false
let lastRunAt = 0

export const isSyncing = () => running

/** Sync enabled sources (or one), then refresh briefs. Calls queue up instead of overlapping. */
export function sync(opts: { only?: ConnectorId; briefs?: boolean } = {}): Promise<void> {
  queue = queue.then(() => runSync(opts)).catch((err) => log(`sync failed: ${String(err)}`))
  return queue
}

async function runSync(opts: { only?: ConnectorId; briefs?: boolean }) {
  running = true
  try {
    const [shellEnv, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
    const env = childEnv(shellEnv, 'claude', settings)
    const list = CONNECTORS.filter((c) => settings.syncSources[c.id] && (!opts.only || c.id === opts.only))
    const steps = list.length + (opts.briefs !== false ? 1 : 0)
    let step = 0
    for (const c of list) {
      emitProgress({ connector: c.id, phase: 'sync', message: `Reading ${c.name}…`, progress: step / steps })
      setSyncState(c.id, { status: 'syncing' })
      const startedAt = Date.now()
      try {
        const n = await c.sync({ env, settings, projects: new ProjectIndex(), since: getSyncState(c.id)?.syncedAt ?? 0, log })
        setSyncState(c.id, { status: 'ok', syncedAt: startedAt, items: sourceItemCount(c.id), error: undefined })
        log(`${c.id}: ${n} changed`)
      } catch (err) {
        setSyncState(c.id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
        log(`${c.id}: ${String(err)}`)
      }
      step++
      emitChanged()
    }
    touchActivity()
    lastRunAt = Date.now()
    emitChanged()
    void backfillItemEmbeddings(settings)

    let briefError: string | undefined
    const backoff = Number(kvGet('briefs:backoffUntil') ?? 0)
    if (opts.briefs !== false && settings.projectBriefs && settings.learnEngine !== 'off' && Date.now() > backoff) {
      const focus = focusProjects()
      for (const [i, p] of focus.entries()) {
        emitProgress({ phase: 'brief', message: `Writing the ${p.name} brief…`, progress: (step + i / Math.max(1, focus.length)) / steps })
        try {
          if (await writeBrief(p, settings, env)) emitChanged()
        } catch (err) {
          briefError = err instanceof Error ? err.message : String(err)
          log(`brief ${p.id}: ${briefError}`)
          // Usage limits, auth problems: stop for an hour instead of failing every project on every sync.
          kvSet('briefs:backoffUntil', String(Date.now() + 3600_000))
          break
        }
      }
    }
    emitProgress({ phase: 'done', message: briefError ? `Synced. Briefs paused: ${briefError}` : 'Up to date', progress: 1 })
  } finally {
    running = false
  }
}

export async function refreshBriefs(projectId?: string) {
  const [shellEnv, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
  const env = childEnv(shellEnv, 'claude', settings)
  const list = focusProjects().filter((p) => !projectId || p.id === projectId)
  kvSet('briefs:backoffUntil', null) // the user asked explicitly
  for (const p of list) {
    emitProgress({ phase: 'brief', message: `Writing the ${p.name} brief…` })
    try {
      await writeBrief(p, { ...settings, projectBriefs: true }, env, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emitProgress({ phase: 'done', message: `Brief failed: ${message}`, progress: 1 })
      throw new Error(message)
    }
    emitChanged()
  }
  emitProgress({ phase: 'done', message: 'Briefs updated', progress: 1 })
}

/** Background sync on the user's interval, after setup. */
export function startKnowledgeScheduler() {
  const tick = async () => {
    const s = await store.getSettings()
    if (!s.onboardedAt || !s.syncIntervalMin || running) return
    if (Date.now() - lastRunAt >= s.syncIntervalMin * 60_000) void sync({ briefs: true })
  }
  setTimeout(() => void tick(), 20_000)
  setInterval(() => void tick(), 60_000)
  powerMonitor.on('resume', () => setTimeout(() => void tick(), 30_000))
}

// ---- projects -------------------------------------------------------------

let lastCandidates: ProjectCandidate[] = []

export async function discover(): Promise<ProjectCandidate[]> {
  const [env, settings] = await Promise.all([loadShellEnv(), store.getSettings()])
  // Discovery only looks at sources the user allowed.
  const sources = CONNECTORS.filter((c) => settings.syncSources[c.id])
  const { candidates, codeRoots } = await discoverProjects(env, settings, sources, log)
  if (!settings.codeRoots.length && codeRoots.length) await store.saveSettings({ ...settings, codeRoots })
  lastCandidates = candidates
  return candidates
}

/** These repos are the user's focus; everything else steps back. Triggers a deep re-read. */
export async function setFocus(paths: string[]): Promise<Project[]> {
  const env = await loadShellEnv()
  const want = new Set(paths)
  for (const path of want) {
    const c = lastCandidates.find((x) => x.path === path)
    const p = ensureProject({ path, name: c?.name, github: c?.github ?? (await githubSlug(path, env)), t3ProjectId: c?.t3ProjectId })
    if (!p.focus) updateProject(p.id, { focus: true })
  }
  for (const p of listProjects()) if (p.focus && (!p.path || !want.has(p.path))) updateProject(p.id, { focus: false })
  for (const id of ['git', 'docs', 'claude', 'codex', 't3', 'github', 'linear', 'jarvis'] as ConnectorId[]) resetSyncCursor(id)
  emitChanged()
  return listProjects()
}

export async function markSeen() {
  kvSet('lastSeenAt', String(Date.now()))
}

export function overview(): KnowledgeOverview {
  const lastSeenAt = Number(kvGet('lastSeenAt') ?? 0) || undefined
  const focus = focusProjects()
  const allLoops = openLoops()
  const weekAgo = Date.now() - 7 * 86_400_000
  return {
    projects: focus.map((project) => ({
      project,
      loops: allLoops.filter((l) => l.projectId === project.id).slice(0, 12),
      recent: recentItems({ projectId: project.id, limit: 30 })
        .filter((i) => i.kind !== 'doc' && i.kind !== 'worktree')
        .slice(0, 10),
      counts: { items: countItems(project.id), week: countItems(project.id, weekAgo) }
    })),
    otherLoops: allLoops.filter((l) => !l.projectId || !focus.some((p) => p.id === l.projectId)).slice(0, 15),
    sinceLastSeen: lastSeenAt ? focus.reduce((n, p) => n + countItems(p.id, lastSeenAt), 0) : 0,
    lastSeenAt,
    totalItems: countItems()
  }
}

export { byId as connector }
