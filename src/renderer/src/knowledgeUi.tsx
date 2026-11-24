// Building blocks shared by first-run setup and the Projects panel: sources (with consent) and focus picking.
import { useCallback, useEffect, useState } from 'react'
import type { ConnectorId, ConnectorInfo, KnowledgeSource, ProjectCandidate, Settings, SyncProgress } from '@shared/types'
import { IconX } from './icons'

const api = window.jarvis

export function timeAgo(t?: number) {
  if (!t) return 'never'
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export const SOURCE_LABEL: Record<ConnectorId, string> = {
  git: 'git',
  github: 'GitHub',
  linear: 'Linear',
  t3: 'T3',
  claude: 'Claude Code',
  codex: 'Codex',
  jarvis: 'Jarvis',
  docs: 'docs'
}

/** Live sync progress line (null when idle). */
export function useSyncProgress() {
  const [p, setP] = useState<SyncProgress | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.knowledge.onProgress((next) => {
      setP(next)
      clearTimeout(timer)
      if (next.phase === 'done') timer = setTimeout(() => setP(null), 2500)
    })
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [])
  return p
}

function CopyCommand({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="cmd"
      title="Copy, then run it in Terminal"
      onClick={() => {
        void navigator.clipboard.writeText(cmd)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      <code>{cmd}</code>
      <span>{copied ? 'copied' : 'copy'}</span>
    </button>
  )
}

function LinearKey({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="src-key">
      <input
        type="password"
        placeholder="Linear personal API key (lin_api_…)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && key.trim() && document.getElementById('linear-save')?.click()}
      />
      <button
        id="linear-save"
        className="primary"
        disabled={!key.trim() || busy}
        onClick={async () => {
          setBusy(true)
          const r = await api.linear.setKey(key)
          setBusy(false)
          if (r.connected) onDone()
          else setErr(r.error ?? 'That key did not work')
        }}
      >
        {busy ? 'Checking…' : 'Save'}
      </button>
      <button className="link" onClick={() => api.openExternal('https://linear.app/settings/account/security')}>
        Create a key
      </button>
      {err && <div className="src-err">{err}</div>}
    </div>
  )
}

/** Every source Jarvis can read, each behind an explicit "Allow". */
export function SourceList({ compact }: { compact?: boolean }) {
  const [list, setList] = useState<ConnectorInfo[] | null>(null)
  const [busy, setBusy] = useState<ConnectorId | null>(null)
  const load = useCallback(() => api.knowledge.connectors().then(setList), [])
  useEffect(() => {
    void load()
    const offs = [api.knowledge.onChanged(() => void load()), api.onSettingsChanged(() => void load())]
    return () => offs.forEach((o) => o())
  }, [load])

  if (!list) return <div className="mem-empty">Looking at what's on this Mac…</div>

  const toggle = async (c: ConnectorInfo) => {
    setBusy(c.id)
    try {
      await api.knowledge.setSource(c.id, !c.enabled)
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={`sources ${compact ? 'compact' : ''}`}>
      {list.map((c) => {
        const state = c.enabled ? (c.sync?.status === 'error' ? 'error' : c.sync?.status === 'syncing' ? 'syncing' : 'on') : c.available ? 'ready' : 'missing'
        return (
          <div key={c.id} className={`source ${state}`}>
            <span className={`source-dot ${state}`} />
            <div className="source-main">
              <div className="source-name">
                {c.name}
                {c.account && <span className="source-account">{c.account}</span>}
              </div>
              <div className="source-reads">{c.reads}</div>
              <div className="source-detail">
                {c.enabled && c.sync?.status === 'error'
                  ? c.sync.error
                  : c.enabled && c.sync?.syncedAt
                    ? `${c.sync.items ?? 0} items · synced ${timeAgo(c.sync.syncedAt)}`
                    : c.enabled && c.sync?.status === 'syncing'
                      ? 'reading…'
                      : c.detail}
              </div>
              {!c.available && c.setup?.kind === 'command' && <CopyCommand cmd={c.setup.hint} />}
              {!c.available && c.setup?.kind === 'key' && c.id === 'linear' && <LinearKey onDone={() => void load()} />}
              {!c.available && c.setup?.kind === 'app' && <div className="source-hint">{c.setup.hint}, then check again.</div>}
            </div>
            {c.available || c.enabled ? (
              <button
                className={`allow ${c.enabled ? 'on' : ''}`}
                disabled={busy === c.id}
                onClick={() => void toggle(c)}
                title={c.enabled ? 'Jarvis reads this. Click to stop.' : 'Let Jarvis read this'}
              >
                {busy === c.id ? '…' : c.enabled ? 'Allowed' : 'Allow'}
              </button>
            ) : (
              <button className="ghost" onClick={() => void load()}>
                Check again
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Mac folders (notes, docs) indexed for retrieval: the existing knowledge-folder index. */
export function FolderList() {
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const load = useCallback(() => api.memory.sources().then(setSources), [])
  useEffect(() => {
    void load()
    return api.memory.onSourcesChanged(() => void load())
  }, [load])
  return (
    <div className="folders">
      {sources.map((s) => (
        <div key={s.id} className="folder-row">
          <span className={`src-state ${s.status}`} />
          <span className="src-path">{s.path}</span>
          <span className="mem-meta">{s.status === 'indexing' ? 'indexing…' : s.status === 'error' ? s.error : `${s.files} files`}</span>
          <button className="icon del" title="Stop reading this folder" onClick={() => api.memory.removeSource(s.id)}>
            <IconX size={13} />
          </button>
        </div>
      ))}
      <button
        className="ghost add-folder"
        onClick={async () => {
          const dir = await api.pickFolder()
          if (dir) await api.memory.addSource(dir)
        }}
      >
        + Add a folder (notes, documents…)
      </button>
    </div>
  )
}

const MAX_FOCUS = 7

/** Pick the handful of projects that matter now. Preselects the most active ones (one per GitHub repo). */
export function FocusPicker({
  settings,
  onChange,
  initial
}: {
  settings: Settings
  onChange(paths: string[]): void
  initial?: string[]
}) {
  const [cands, setCands] = useState<ProjectCandidate[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set(initial ?? []))
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roots, setRoots] = useState(settings.codeRoots)

  const run = useCallback(async () => {
    setCands(null)
    setError(null)
    try {
      const list = await api.knowledge.discover()
      setCands(list)
      // Discovery may have guessed the code folders on first run.
      void api.getSettings().then((s) => setRoots(s.codeRoots))
      setPicked((prev) => {
        if (prev.size) return prev
        const focused = list.filter((c) => c.focus).map((c) => c.path)
        if (focused.length) return new Set(focused)
        const seen = new Set<string>()
        const top: string[] = []
        for (const c of list) {
          if (top.length >= 5 || c.score < 10) break
          if (c.github && seen.has(c.github)) continue
          if (c.github) seen.add(c.github)
          top.push(c.path)
        }
        return new Set(top)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCands([])
    }
  }, [])
  useEffect(() => {
    void run()
  }, [run])
  useEffect(() => onChange([...picked]), [picked, onChange])

  const addRoot = async () => {
    const dir = await api.pickFolder()
    if (!dir) return
    const s = await api.getSettings()
    await api.saveSettings({ ...s, codeRoots: [...new Set([...s.codeRoots, dir])] })
    void run()
  }
  const addRepo = async () => {
    const dir = await api.pickFolder()
    if (!dir) return
    setCands((c) => (c && !c.some((x) => x.path === dir) ? [{ path: dir, name: dir.split('/').pop() ?? dir, commits30d: 0, sessions30d: 0, score: 0 }, ...c] : c))
    setPicked((p) => new Set(p).add(dir))
  }

  if (!cands) return <div className="mem-empty">Looking for the repos you've been working in…</div>
  const visible = showAll ? cands : cands.filter((c, i) => i < 12 || picked.has(c.path))

  return (
    <div className="focus-picker">
      <div className="focus-roots">
        Scanned {roots.length ? `${roots.join(', ')} and your agent history` : 'your agent history'}
        <button className="link" onClick={() => void addRoot()}>
          add a code folder
        </button>
        ·
        <button className="link" onClick={() => void addRepo()}>
          pick a repo
        </button>
      </div>
      {error && <div className="src-err">{error}</div>}
      {!cands.length && <div className="mem-empty">No active repos found. Add the folder where your code lives.</div>}
      <div className="cands">
        {visible.map((c) => {
          const on = picked.has(c.path)
          return (
            <label key={c.path} className={`cand ${on ? 'on' : ''}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={!on && picked.size >= MAX_FOCUS}
                onChange={() =>
                  setPicked((p) => {
                    const n = new Set(p)
                    if (n.has(c.path)) n.delete(c.path)
                    else n.add(c.path)
                    return n
                  })
                }
              />
              <div className="cand-main">
                <div className="cand-name">
                  {c.name}
                  {c.github && <span className="cand-gh">{c.github}</span>}
                </div>
                <div className="cand-sig">
                  {[
                    c.commits30d ? `${c.commits30d} commits` : '',
                    c.sessions30d ? `${c.sessions30d} agent sessions` : '',
                    c.lastActivityAt ? `active ${timeAgo(c.lastActivityAt)}` : ''
                  ]
                    .filter(Boolean)
                    .join(' · ') || c.path}
                </div>
              </div>
              <ActivityBar score={c.score} max={cands[0]?.score || 1} />
            </label>
          )
        })}
      </div>
      {cands.length > visible.length && (
        <button className="link more" onClick={() => setShowAll(true)}>
          Show {cands.length - visible.length} more
        </button>
      )}
      <div className="focus-count">
        {picked.size} of up to {MAX_FOCUS} selected. Jarvis goes deep on these: full history, docs, teammates' PRs, a living brief.
        Everything else stays searchable.
      </div>
    </div>
  )
}

function ActivityBar({ score, max }: { score: number; max: number }) {
  const w = Math.max(4, Math.round((Math.log1p(score) / Math.log1p(max)) * 100))
  return (
    <span className="act-bar" title={`activity score ${score}`}>
      <span style={{ width: `${w}%` }} />
    </span>
  )
}
