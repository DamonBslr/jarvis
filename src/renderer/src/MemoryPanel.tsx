import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeSource, Memory, MemoryStatus, MemoryType } from '@shared/types'
import { IconX } from './icons'

const api = window.jarvis.memory
const TYPES: MemoryType[] = ['profile', 'preference', 'workflow', 'project', 'person', 'fact']
type Tab = 'memories' | 'knowledge' | 'status'

function timeAgo(t?: number) {
  if (!t) return 'never'
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function MemoryRow({ m, onChange }: { m: Memory; onChange: () => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(m.content)
  return (
    <div className={`mem-row ${m.pinned ? 'pinned' : ''}`}>
      <select
        className="mem-type"
        value={m.type}
        onChange={(e) => api.update(m.id, { type: e.target.value as MemoryType }).then(onChange)}
      >
        {TYPES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      {editing ? (
        <input
          className="mem-edit"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEditing(false)
            if (text.trim() && text !== m.content) void api.update(m.id, { content: text }).then(onChange)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setText(m.content)
              setEditing(false)
            }
          }}
        />
      ) : (
        <div className="mem-content" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          {m.content}
          <span className="mem-meta">
            {m.source.startsWith('learned') ? 'learned' : m.source} · used {m.uses}× · {timeAgo(m.updatedAt)}
          </span>
        </div>
      )}
      <button
        className={`icon ${m.pinned ? 'on' : ''}`}
        title={m.pinned ? 'Pinned: always included' : 'Pin: always include in context'}
        onClick={() => api.update(m.id, { pinned: !m.pinned }).then(onChange)}
      >
        ★
      </button>
      <button className="icon del" title="Forget" onClick={() => api.remove(m.id).then(onChange)}>
        <IconX size={13} />
      </button>
    </div>
  )
}

export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('memories')
  const [query, setQuery] = useState('')
  const [memories, setMemories] = useState<Memory[]>([])
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [newText, setNewText] = useState('')
  const [newType, setNewType] = useState<MemoryType>('preference')

  const loadMemories = useCallback(() => api.list(query).then(setMemories), [query])
  const loadSources = useCallback(() => api.sources().then(setSources), [])

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])
  useEffect(() => {
    void loadSources()
    void api.status().then(setStatus)
    return api.onSourcesChanged(() => void loadSources())
  }, [loadSources])

  const add = async () => {
    if (!newText.trim()) return
    await api.add({ type: newType, content: newText })
    setNewText('')
    void loadMemories()
  }

  const addFolder = async () => {
    const dir = await window.jarvis.pickFolder()
    if (dir) await api.addSource(dir)
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel memory-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Memory</h2>
          <div className="tabs">
            {(['memories', 'knowledge', 'status'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <button className="icon panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <IconX size={14} />
          </button>
        </div>

        {tab === 'memories' && (
          <>
            <p className="panel-sub">
              What Jarvis knows about you. Learned automatically after conversations; pinned items are always in
              context.
            </p>
            <div className="mem-add">
              <select value={newType} onChange={(e) => setNewType(e.target.value as MemoryType)}>
                {TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <input
                placeholder="Teach Jarvis something, e.g. “I prefer pnpm and conventional commits”"
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void add()}
              />
              <button className="primary" onClick={() => void add()} disabled={!newText.trim()}>
                Add
              </button>
            </div>
            <input
              className="mem-search"
              placeholder="Search memories…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="mem-list">
              {memories.length === 0 && (
                <div className="mem-empty">
                  {query ? 'No matches.' : 'Nothing yet. Tell Jarvis about yourself, or just work — it learns as you go.'}
                </div>
              )}
              {memories.map((m) => (
                <MemoryRow key={`${m.id}-${m.updatedAt}`} m={m} onChange={() => void loadMemories()} />
              ))}
            </div>
          </>
        )}

        {tab === 'knowledge' && (
          <>
            <p className="panel-sub">
              Folders Jarvis indexes for retrieval: notes, docs, project repos. Re-indexing only reads changed files.
            </p>
            <div className="src-list">
              {sources.length === 0 && <div className="mem-empty">No knowledge folders yet.</div>}
              {sources.map((s) => (
                <div key={s.id} className="src-row">
                  <span className={`src-state ${s.status}`} />
                  <div className="src-main">
                    <div className="src-path">{s.path}</div>
                    <div className="mem-meta">
                      {s.status === 'error'
                        ? s.error
                        : s.status === 'indexing'
                          ? 'indexing…'
                          : `${s.files} files · ${s.chunks} chunks · ${timeAgo(s.indexedAt)}`}
                    </div>
                  </div>
                  <button className="ghost" onClick={() => api.reindex(s.id)} disabled={s.status === 'indexing'}>
                    Re-index
                  </button>
                  <button className="icon del" title="Remove" onClick={() => api.removeSource(s.id)}>
                    <IconX size={13} />
                  </button>
                </div>
              ))}
            </div>
            <button className="primary" onClick={() => void addFolder()}>
              Add folder…
            </button>
          </>
        )}

        {tab === 'status' && (
          <div className="status-grid">
            {!status ? (
              <div className="mem-empty">Checking…</div>
            ) : (
              <>
                <StatusRow
                  ok={status.jev.online}
                  title="Jev classifier"
                  detail={
                    status.jev.online
                      ? `${status.jev.model ?? 'online'} at ${status.jev.url} — routes messages and decides what to remember`
                      : `offline at ${status.jev.url}. Keyword fallback in use. Start it with: uvx --from "jev-style[mlx]" jev-style serve`
                  }
                />
                <StatusRow
                  ok={status.embeddings.online}
                  title="Semantic search"
                  detail={
                    status.embeddings.online
                      ? `Ollama ${status.embeddings.model}`
                      : `keyword-only. For meaning-based recall: ollama serve && ollama pull ${status.embeddings.model}`
                  }
                />
                <StatusRow
                  ok={status.learner.engine !== 'off'}
                  title="Learning"
                  detail={status.learner.detail ?? ''}
                />
                <StatusRow
                  ok
                  title="Store"
                  detail={`${status.memories} memories · ${status.chunks} knowledge chunks (local SQLite)`}
                />
              </>
            )}
          </div>
        )}

      </div>
    </div>
  )
}

function StatusRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="status-row">
      <span className={`health-dot ${ok ? 'ok' : 'off'}`} />
      <div>
        <div>{title}</div>
        <div className="mem-meta">{detail}</div>
      </div>
    </div>
  )
}
