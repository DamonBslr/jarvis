import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitFile, GitStatus, LinearIssue, PullRequest } from '@shared/types'

const api = window.jarvis

type Tab = 'git' | 'linear'

const fileLabel = (f: GitFile) => {
  if (f.index === '?') return { code: 'U', cls: 'added', title: 'untracked' }
  if (f.index === 'U' || f.worktree === 'U') return { code: '!', cls: 'conflict', title: 'conflict' }
  const c = f.index !== '.' ? f.index : f.worktree
  const cls = c === 'A' ? 'added' : c === 'D' ? 'deleted' : 'modified'
  return { code: c, cls, title: f.index !== '.' ? 'staged' : 'unstaged' }
}

const STATE_ORDER: Record<string, number> = { started: 0, unstarted: 1, triage: 2, backlog: 3 }

function GitTab({
  cwd,
  refreshKey,
  onAsk,
  busy
}: {
  cwd: string
  refreshKey: number
  onAsk: (prompt: string) => void
  busy: boolean
}) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await api.git.status(cwd)
      setStatus(s)
      setPr(s.isRepo ? await api.git.pr(cwd) : null)
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load, refreshKey])

  if (!status) return <div className="wb-empty">Loading…</div>
  if (!status.isRepo)
    return (
      <div className="wb-empty">
        <p>This workspace isn't a git repository.</p>
        <button className="ghost" disabled={busy} onClick={() => onAsk('Initialize a git repository here with a sensible .gitignore and make an initial commit.')}>
          Initialize repo
        </button>
      </div>
    )

  const files = status.files ?? []
  const repoName = status.root?.split('/').pop()

  return (
    <div className="wb-git">
      <div className="wb-head">
        <div className="wb-branch">
          <span className="wb-repo">{repoName}</span>
          <span className="wb-branch-name">{status.branch}</span>
          {(status.ahead ?? 0) > 0 && <span className="wb-ab">↑{status.ahead}</span>}
          {(status.behind ?? 0) > 0 && <span className="wb-ab">↓{status.behind}</span>}
          {!status.upstream && status.branch !== '(detached)' && <span className="wb-ab dim">no upstream</span>}
        </div>
        <button className="icon" title="Refresh" onClick={() => void load()}>
          {loading ? '…' : '↻'}
        </button>
      </div>

      {pr && (
        <button className={`wb-pr ${pr.checks ?? ''}`} onClick={() => api.openExternal(pr.url)}>
          <span className="wb-pr-num">#{pr.number}</span>
          <span className="wb-pr-title">{pr.title}</span>
          <span className="wb-pr-meta">
            {pr.isDraft ? 'draft' : pr.state.toLowerCase()}
            {pr.checks && ` · checks ${pr.checks}`}
            {pr.reviewDecision && ` · ${pr.reviewDecision.toLowerCase().replace('_', ' ')}`}
          </span>
        </button>
      )}

      <div className="wb-actions">
        <button disabled={busy || !files.length} onClick={() => onAsk('Review the uncommitted changes, then commit them with a clear conventional commit message. Group into separate commits if they are unrelated.')}>
          Commit
        </button>
        <button disabled={busy} onClick={() => onAsk(pr ? `Push the latest commits to the existing PR #${pr.number} and summarize what changed.` : 'Push this branch and open a pull request with gh. Write a concise description and link any Linear issue this work belongs to.')}>
          {pr ? 'Push' : 'Open PR'}
        </button>
        <button disabled={busy} onClick={() => onAsk('Update this branch with the latest default branch (fetch, then rebase if the branch is unpushed, otherwise merge). Resolve simple conflicts; stop and ask me about anything non-trivial.')}>
          Sync
        </button>
        <button disabled={busy || !files.length} onClick={() => onAsk('Review the current uncommitted diff like a senior engineer: bugs, risky changes, missing tests. Be concise; do not change files.')}>
          Review
        </button>
      </div>

      <div className="wb-section">
        Changes <span className="wb-count">{files.length}</span>
      </div>
      <div className="wb-files">
        {files.length === 0 && <div className="wb-dim">Working tree clean</div>}
        {files.map((f) => {
          const l = fileLabel(f)
          return (
            <button
              key={f.path}
              className="wb-file"
              title={`${l.title}: ${f.path}`}
              onClick={async () => setDiff({ path: f.path, text: await api.git.diff(cwd, f.path) })}
            >
              <span className={`wb-code ${l.cls}`}>{l.code}</span>
              <span className="wb-file-name">{f.path.split('/').pop()}</span>
              <span className="wb-file-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
            </button>
          )
        })}
      </div>

      <div className="wb-section">Recent commits</div>
      <div className="wb-commits">
        {(status.commits ?? []).map((c) => (
          <div key={c.hash} className="wb-commit" title={`${c.author} · ${c.when}`}>
            <span className="wb-hash">{c.hash}</span>
            <span className="wb-subject">{c.subject}</span>
            <span className="wb-when">{c.when.replace(' ago', '')}</span>
          </div>
        ))}
      </div>

      {diff && (
        <div className="overlay" onClick={() => setDiff(null)}>
          <div className="panel diff-panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <h2 className="mono">{diff.path}</h2>
              <button className="icon" onClick={() => setDiff(null)}>
                ×
              </button>
            </div>
            <pre className="diff">
              {diff.text.split('\n').map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith('+') && !line.startsWith('+++')
                      ? 'add'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'del'
                        : line.startsWith('@@')
                          ? 'hunk'
                          : ''
                  }
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function LinearTab({
  onWork,
  repoFor
}: {
  onWork: (issue: LinearIssue) => void
  repoFor: (teamKey: string) => string | undefined
}) {
  const [conn, setConn] = useState<{ connected: boolean; user?: string; error?: string } | null>(null)
  const [key, setKey] = useState('')
  const [issues, setIssues] = useState<LinearIssue[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const loadIssues = useCallback(async () => {
    setError(null)
    try {
      setIssues(await api.linear.myIssues())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void api.linear.status().then((s) => {
      setConn(s)
      if (s.connected) void loadIssues()
    })
  }, [loadIssues])

  const grouped = useMemo(() => {
    const q = filter.toLowerCase()
    const list = (issues ?? []).filter(
      (i) => !q || i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
    )
    list.sort(
      (a, b) =>
        (STATE_ORDER[a.state.type] ?? 9) - (STATE_ORDER[b.state.type] ?? 9) ||
        (a.priority || 5) - (b.priority || 5)
    )
    return list
  }, [issues, filter])

  if (!conn) return <div className="wb-empty">Checking Linear…</div>

  if (!conn.connected)
    return (
      <div className="wb-connect">
        <p>
          Connect Linear with a personal API key. It's stored encrypted in your macOS keychain and used for the ticket
          list and for agent tools (read issue, move state, comment).
        </p>
        <button className="link" onClick={() => api.openExternal('https://linear.app/settings/account/security')}>
          Create a key in Linear → Settings → Security
        </button>
        <input
          type="password"
          placeholder="lin_api_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && key.trim()) {
              const s = await api.linear.setKey(key)
              setConn(s)
              setKey('')
              if (s.connected) void loadIssues()
            }
          }}
        />
        <button
          className="primary"
          disabled={!key.trim()}
          onClick={async () => {
            const s = await api.linear.setKey(key)
            setConn(s)
            setKey('')
            if (s.connected) void loadIssues()
          }}
        >
          Connect
        </button>
        {conn.error && <div className="error">{conn.error}</div>}
      </div>
    )

  return (
    <div className="wb-linear">
      <div className="wb-head">
        <input className="wb-filter" placeholder="Filter my issues…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon" title="Refresh" onClick={() => void loadIssues()}>
          ↻
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {!issues && !error && <div className="wb-empty">Loading issues…</div>}
      {issues && grouped.length === 0 && <div className="wb-empty">No open issues assigned to you.</div>}
      <div className="wb-issues">
        {grouped.map((i) => (
          <div key={i.id} className="wb-issue">
            <div className="wb-issue-top">
              <span className={`prio p${i.priority}`} title={i.priorityLabel} />
              <button className="wb-ident" onClick={() => api.openExternal(i.url)} title="Open in Linear">
                {i.identifier}
              </button>
              <span className="wb-state" style={{ color: i.state.color }}>
                {i.state.name}
              </span>
            </div>
            <div className="wb-issue-title">{i.title}</div>
            <div className="wb-issue-foot">
              <span className="wb-dim" title={repoFor(i.teamKey) ?? 'Uses the current workspace; remembered after first use'}>
                {repoFor(i.teamKey)?.split('/').pop() ?? 'current workspace'}
              </span>
              <button className="wb-work" onClick={() => onWork(i)}>
                Work on it →
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="wb-foot">
        Connected as {conn.user} ·{' '}
        <button
          className="link"
          onClick={async () => {
            await api.linear.clearKey()
            setConn({ connected: false })
            setIssues(null)
          }}
        >
          disconnect
        </button>
      </div>
    </div>
  )
}

export function Workbench(props: {
  cwd: string
  refreshKey: number
  busy: boolean
  onAsk: (prompt: string) => void
  onWork: (issue: LinearIssue) => void
  repoFor: (teamKey: string) => string | undefined
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('wb-tab') as Tab) || 'git'
    } catch {
      return 'git'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('wb-tab', tab)
    } catch {
      /* ignore */
    }
  }, [tab])

  return (
    <aside className="workbench">
      <div className="tabs wb-tabs">
        <button className={tab === 'git' ? 'active' : ''} onClick={() => setTab('git')}>
          Git
        </button>
        <button className={tab === 'linear' ? 'active' : ''} onClick={() => setTab('linear')}>
          Linear
        </button>
      </div>
      <div className="wb-body">
        {tab === 'git' ? (
          <GitTab cwd={props.cwd} refreshKey={props.refreshKey} onAsk={props.onAsk} busy={props.busy} />
        ) : (
          <LinearTab onWork={props.onWork} repoFor={props.repoFor} />
        )}
      </div>
    </aside>
  )
}
