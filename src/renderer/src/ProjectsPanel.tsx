// Projects: focus projects with their living brief, open loops and activity; sources and focus management.
import { useCallback, useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { KnowledgeItem, KnowledgeOverview, OpenLoop, ProjectDigest, Settings } from '@shared/types'
import { FocusPicker, FolderList, SOURCE_LABEL, SourceList, timeAgo, useSyncProgress } from './knowledgeUi'
import { IconPlug, IconRefresh, IconSettings, IconX } from './icons'

const api = window.jarvis
type View = { kind: 'project'; id: string } | { kind: 'elsewhere' } | { kind: 'sources' } | { kind: 'focus' }
type Tab = 'brief' | 'loops' | 'activity' | 'settings'

const LOOP_LABEL: Record<OpenLoop['kind'], string> = {
  review: 'waiting on you',
  attention: 'needs a look',
  stalled: 'stalled',
  uncommitted: 'local only'
}

export function ProjectsPanel({
  settings,
  onClose,
  onAsk
}: {
  settings: Settings
  onClose(): void
  /** Start a chat about a project (in its folder). */
  onAsk(prompt: string, cwd?: string): void
}) {
  const [ov, setOv] = useState<KnowledgeOverview | null>(null)
  const [view, setView] = useState<View | null>(null)
  const progress = useSyncProgress()

  const load = useCallback(() => api.knowledge.overview().then(setOv), [])
  useEffect(() => {
    void load()
    void api.knowledge.markSeen()
    return api.knowledge.onChanged(() => void load())
  }, [load])
  useEffect(() => {
    if (!ov || view) return
    setView(ov.projects[0] ? { kind: 'project', id: ov.projects[0].project.id } : { kind: 'focus' })
  }, [ov, view])

  const current = view?.kind === 'project' ? ov?.projects.find((d) => d.project.id === view.id) : undefined

  return (
    <div className="overlay page">
      <div className="panel projects-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Projects</h2>
          <div className="proj-head-right">
            {progress && progress.phase !== 'done' && <span className="sync-line">{progress.message}</span>}
            <button
              className={`icon-btn ${progress && progress.phase !== 'done' ? 'spinning' : ''}`}
              title={`Sync now${ov ? ` · ${ov.totalItems.toLocaleString()} items indexed` : ''}`}
              aria-label="Sync now"
              disabled={!!progress && progress.phase !== 'done'}
              onClick={() => void api.knowledge.sync()}
            >
              <IconRefresh size={15} />
            </button>
            <button className="icon panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
              <IconX size={14} />
            </button>
          </div>
        </div>

        <div className="proj-body">
          <nav className="proj-nav">
            <div className="proj-nav-label">Focus</div>
            {ov?.projects.map((d) => (
              <button
                key={d.project.id}
                className={`proj-nav-item ${view?.kind === 'project' && view.id === d.project.id ? 'active' : ''}`}
                onClick={() => setView({ kind: 'project', id: d.project.id })}
              >
                <span className="proj-nav-name">{d.project.name}</span>
                {d.loops.length > 0 && <span className="loop-count">{d.loops.length}</span>}
              </button>
            ))}
            {ov && ov.otherLoops.length > 0 && (
              <button className={`proj-nav-item ${view?.kind === 'elsewhere' ? 'active' : ''}`} onClick={() => setView({ kind: 'elsewhere' })}>
                <span className="proj-nav-name muted">Elsewhere</span>
                <span className="loop-count">{ov.otherLoops.length}</span>
              </button>
            )}
            <div className="proj-nav-sep" />
            <button className={`proj-nav-item action ${view?.kind === 'focus' ? 'active' : ''}`} onClick={() => setView({ kind: 'focus' })}>
              <IconSettings size={14} />
              Change focus…
            </button>
            <button className={`proj-nav-item action ${view?.kind === 'sources' ? 'active' : ''}`} onClick={() => setView({ kind: 'sources' })}>
              <IconPlug size={14} />
              Sources
            </button>
          </nav>

          <div className="proj-main">
            {!ov && <div className="mem-empty">Loading…</div>}
            {current && <ProjectView key={current.project.id} digest={current} onAsk={onAsk} />}
            {view?.kind === 'elsewhere' && ov && (
              <div className="proj-scroll">
                <h3>Open loops outside your focus projects</h3>
                <LoopList loops={ov.otherLoops} />
              </div>
            )}
            {view?.kind === 'sources' && (
              <div className="proj-scroll">
                <p className="panel-sub">Read-only. Jarvis syncs every {settings.syncIntervalMin || '–'} minutes while it runs.</p>
                <SourceList compact />
                <h3>Folders on your Mac</h3>
                <FolderList />
              </div>
            )}
            {view?.kind === 'focus' && (
              <FocusEditor
                settings={settings}
                initial={ov?.projects.map((d) => d.project.path).filter((p): p is string => !!p) ?? []}
                onSaved={(id) => {
                  void load().then(() => setView(id ? { kind: 'project', id } : null))
                }}
              />
            )}
          </div>
        </div>

      </div>
    </div>
  )
}

function FocusEditor({ settings, initial, onSaved }: { settings: Settings; initial: string[]; onSaved(firstId?: string): void }) {
  const [paths, setPaths] = useState<string[]>(initial)
  const [busy, setBusy] = useState(false)
  return (
    <div className="proj-scroll">
      <h3>Your focus projects</h3>
      <FocusPicker settings={settings} initial={initial} onChange={setPaths} />
      <div className="panel-actions">
        <button
          className="primary"
          disabled={busy || !paths.length}
          onClick={async () => {
            setBusy(true)
            const projects = await api.knowledge.setFocus(paths)
            void api.knowledge.sync()
            setBusy(false)
            onSaved(projects.find((p) => p.focus)?.id)
          }}
        >
          {busy ? 'Saving…' : 'Save and re-learn'}
        </button>
      </div>
    </div>
  )
}

function ProjectView({ digest, onAsk }: { digest: ProjectDigest; onAsk(prompt: string, cwd?: string): void }) {
  const p = digest.project
  const [tab, setTab] = useState<Tab>('brief')
  const [briefing, setBriefing] = useState(false)
  const [briefErr, setBriefErr] = useState<string | null>(null)
  const [notes, setNotes] = useState(p.notes ?? '')
  const [linear, setLinear] = useState(p.linearTeam ?? '')

  const rewrite = async () => {
    setBriefing(true)
    setBriefErr(null)
    try {
      await api.knowledge.brief(p.id)
    } catch (err) {
      setBriefErr(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBriefing(false)
    }
  }

  return (
    <div className="proj-view">
      <div className="proj-title">
        <div>
          <h3>{p.name}</h3>
          <div className="mem-meta">
            {[p.path, p.github, `${digest.counts.week} updates this week`, p.lastActivityAt && `active ${timeAgo(p.lastActivityAt)}`]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="proj-actions">
          <button className="primary" onClick={() => onAsk(`Catch me up on ${p.name}: where things stand, what's waiting on me, and what I should do next.`, p.path)}>
            Catch me up
          </button>
        </div>
      </div>

      <div className="tabs proj-tabs">
        {(['brief', 'loops', 'activity', 'settings'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'loops' ? `Open loops${digest.loops.length ? ` · ${digest.loops.length}` : ''}` : t}
          </button>
        ))}
      </div>

      <div className="proj-scroll">
        {tab === 'brief' && (
          <>
            {p.brief ? (
              <div className="md brief">
                <Markdown remarkPlugins={[remarkGfm]}>{p.brief}</Markdown>
              </div>
            ) : (
              <div className="mem-empty">{briefing ? 'Writing…' : 'No brief yet. It is written after the first sync.'}</div>
            )}
            <div className="brief-foot">
              <span className={briefErr ? 'src-err' : 'mem-meta'}>
                {briefErr ?? (p.briefAt ? `Written ${timeAgo(p.briefAt)} from your repos, PRs, tickets and agent threads` : '')}
              </span>
              <button className="ghost" disabled={briefing} onClick={() => void rewrite()}>
                {briefing ? 'Writing…' : 'Rewrite brief'}
              </button>
            </div>
          </>
        )}
        {tab === 'settings' && (
          <>
            <div className="proj-fields">
              <label className="field">
                <span>
                  Notes for Jarvis <span className="opt">goals, deadlines, who's involved</span>
                </span>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => notes !== (p.notes ?? '') && api.knowledge.updateProject(p.id, { notes })}
                  placeholder="e.g. Launch on the App Store by Dec 15. Ana does design."
                />
              </label>
              <label className="field inline">
                Linear team key
                <input
                  value={linear}
                  onChange={(e) => setLinear(e.target.value.toUpperCase())}
                  onBlur={() => linear !== (p.linearTeam ?? '') && api.knowledge.updateProject(p.id, { linearTeam: linear })}
                  placeholder="ENG"
                />
              </label>
            </div>
          </>
        )}
        {tab === 'loops' && <LoopList loops={digest.loops} empty="Nothing is waiting on you here." />}
        {tab === 'activity' && <Activity projectId={p.id} />}
      </div>
    </div>
  )
}

function LoopList({ loops, empty }: { loops: OpenLoop[]; empty?: string }) {
  if (!loops.length) return <div className="mem-empty">{empty ?? 'Nothing open.'}</div>
  return (
    <div className="loops">
      {loops.map((l) => (
        <div key={l.key} className={`loop ${l.kind}`}>
          <span className="loop-kind">{LOOP_LABEL[l.kind]}</span>
          <div className="loop-main">
            {l.url?.startsWith('http') ? (
              <button className="loop-title link" onClick={() => api.openExternal(l.url!)}>
                {l.title}
              </button>
            ) : (
              <span className="loop-title">{l.title}</span>
            )}
            <div className="mem-meta">
              {SOURCE_LABEL[l.source]}
              {l.detail ? ` · ${l.detail}` : ''} · {timeAgo(l.at)}
            </div>
          </div>
          <button className="icon del" title="Dismiss until it changes" onClick={() => api.knowledge.dismissLoop(l.key)}>
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Activity({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    const t = setTimeout(
      () => {
        const p = query.trim() ? api.knowledge.search(query, projectId) : api.knowledge.timeline(projectId, 120)
        void p.then((r) => live && setItems(r))
      },
      query ? 250 : 0
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [projectId, query])

  const grouped = useMemo(() => {
    const out: { day: string; items: KnowledgeItem[] }[] = []
    for (const it of (items ?? []).filter((i) => i.kind !== 'worktree' || query)) {
      const day = new Date(it.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      if (query) {
        out.length ? out[0].items.push(it) : out.push({ day: 'Best matches', items: [it] })
        continue
      }
      if (out.at(-1)?.day !== day) out.push({ day, items: [] })
      out.at(-1)!.items.push(it)
    }
    return out
  }, [items, query])

  return (
    <>
      <input className="mem-search" placeholder="Search this project's history…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!items && <div className="mem-empty">Loading…</div>}
      {items && !items.length && <div className="mem-empty">{query ? 'No matches.' : 'Nothing synced yet.'}</div>}
      <div className="timeline">
        {grouped.map((g) => (
          <div key={g.day} className="tl-day">
            <div className="tl-date">{g.day}</div>
            {g.items.map((it) => (
              <div key={it.id} className="tl-item">
                <span className={`tl-src src-${it.source}`}>{SOURCE_LABEL[it.source]}</span>
                <div className="tl-main">
                  {it.url?.startsWith('http') ? (
                    <button className="link tl-title" onClick={() => api.openExternal(it.url!)}>
                      {it.title}
                    </button>
                  ) : (
                    <span className="tl-title">{it.title}</span>
                  )}
                  <div className="mem-meta">
                    {[it.kind, it.state, it.author].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
