import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentEvent,
  ChatMessage,
  Conversation,
  Mode,
  ProviderId,
  ProviderStatus,
  RunRequest,
  Settings
} from '@shared/types'
import { MessageView } from './MessageView'
import { SettingsPanel } from './SettingsPanel'
import { MemoryPanel } from './MemoryPanel'

const api = window.jarvis
const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' }
const AUTONOMY_LABEL: Record<RunRequest['autonomy'], string> = {
  ask: 'Read-only',
  edit: 'Edit files',
  full: 'Full access'
}

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20)
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

interface ActiveRun {
  runId: string
  convId: string
  msgId: string
  provider: ProviderId
}

function applyEvent(msg: ChatMessage, ev: AgentEvent): ChatMessage {
  const parts = [...msg.parts]
  const last = parts[parts.length - 1]
  switch (ev.kind) {
    case 'text':
    case 'thinking': {
      const type = ev.kind
      if (last && last.type === type) parts[parts.length - 1] = { ...last, text: last.text + ev.delta }
      else parts.push({ type, text: ev.delta })
      return { ...msg, parts }
    }
    case 'tool_start':
      parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, done: false })
      return { ...msg, parts }
    case 'tool_end':
      return {
        ...msg,
        parts: parts.map((p) =>
          p.type === 'tool' && p.id === ev.id ? { ...p, output: ev.output, isError: ev.isError, done: true } : p
        )
      }
    case 'error':
      return { ...msg, error: msg.error ? `${msg.error}\n${ev.message}` : ev.message }
    case 'context':
      return { ...msg, context: ev.items }
    case 'done':
      return {
        ...msg,
        costUsd: ev.costUsd,
        // Close any tool cards the provider never reported a result for.
        parts: parts.map((p) => (p.type === 'tool' && !p.done ? { ...p, done: true } : p))
      }
    default:
      return msg
  }
}

function historyFor(conv: Conversation) {
  return conv.messages
    .map((m) => ({
      role: m.role,
      content: m.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('')
    }))
    .filter((m) => m.content.trim())
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [modes, setModes] = useState<Mode[]>([])
  const [convs, setConvs] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, ActiveRun>>({}) // keyed by convId
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showMemory, setShowMemory] = useState(false)

  const runsByRunId = useRef(new Map<string, ActiveRun>())
  const dirty = useRef(new Set<string>())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const active = convs.find((c) => c.id === activeId) ?? null
  const activeRun = active ? runs[active.id] : undefined
  const providerStatus = (id: ProviderId) => providers.find((p) => p.id === id)

  const refreshProviders = useCallback(() => api.providers().then(setProviders), [])

  // Boot
  useEffect(() => {
    void Promise.all([api.getSettings(), api.loadConversations(), api.modes()]).then(([s, cs, ms]) => {
      setSettings(s)
      setConvs(cs)
      setModes(ms)
      setActiveId(cs[0]?.id ?? null)
    })
    void refreshProviders()
    window.jarvisFocus(() => inputRef.current?.focus())
  }, [refreshProviders])

  // Persist conversations that changed (debounced by React batching).
  useEffect(() => {
    if (!dirty.current.size) return
    for (const id of dirty.current) {
      const c = convs.find((x) => x.id === id)
      if (c) void api.saveConversation(c)
    }
    dirty.current.clear()
  }, [convs])

  const updateConv = useCallback((id: string, fn: (c: Conversation) => Conversation, persist = true) => {
    if (persist) dirty.current.add(id)
    setConvs((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))
  }, [])

  // Agent event stream
  useEffect(() => {
    return api.onEvent((runId, ev) => {
      const run = runsByRunId.current.get(runId)
      if (!run) return
      const finalEvent = ev.kind === 'done'
      updateConv(
        run.convId,
        (c) => ({
          ...c,
          updatedAt: Date.now(),
          sessions: ev.kind === 'session' ? { ...c.sessions, [run.provider]: ev.sessionId } : c.sessions,
          messages: c.messages.map((m) => (m.id === run.msgId ? applyEvent(m, ev) : m))
        }),
        finalEvent || ev.kind === 'session'
      )
      if (finalEvent) {
        runsByRunId.current.delete(runId)
        setRuns((r) => {
          const next = { ...r }
          delete next[run.convId]
          return next
        })
      }
    })
  }, [updateConv])

  // Memories learned from a finished turn (arrives a few seconds after the answer).
  useEffect(() => {
    return api.onLearned((ev) => {
      updateConv(ev.convId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === ev.msgId ? { ...m, learned: ev.added } : m))
      }))
    })
  }, [updateConv])

  // Stick to bottom while streaming
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight
  }, [active?.messages])

  const newConversation = useCallback(() => {
    if (!settings) return
    const firstAvailable = providers.find((p) => p.available)?.id ?? 'claude'
    const c: Conversation = {
      id: uid(),
      title: 'New chat',
      provider: firstAvailable,
      modeId: 'auto',
      cwd: active?.cwd ?? settings.defaultCwd,
      autonomy: 'edit',
      sessions: {},
      messages: [],
      updatedAt: Date.now()
    }
    setConvs((prev) => [c, ...prev])
    setActiveId(c.id)
    setDraft('')
    setTimeout(() => inputRef.current?.focus(), 0)
    return c
  }, [settings, providers, active?.cwd])

  const send = useCallback(async () => {
    const prompt = draft.trim()
    if (!prompt || !settings) return
    const conv = active ?? newConversation()
    if (!conv || runs[conv.id]) return

    const userMsg: ChatMessage = { id: uid(), role: 'user', parts: [{ type: 'text', text: prompt }], createdAt: Date.now() }
    const asstMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      parts: [],
      provider: conv.provider,
      createdAt: Date.now()
    }
    const runId = uid()
    const run: ActiveRun = { runId, convId: conv.id, msgId: asstMsg.id, provider: conv.provider }
    runsByRunId.current.set(runId, run)
    setRuns((r) => ({ ...r, [conv.id]: run }))

    const isFirst = conv.messages.length === 0
    dirty.current.add(conv.id)
    setConvs((prev) => {
      const exists = prev.some((c) => c.id === conv.id)
      const base = exists ? prev : [conv, ...prev]
      return base.map((c) =>
        c.id === conv.id
          ? {
              ...c,
              title: isFirst ? prompt.slice(0, 60) : c.title,
              updatedAt: Date.now(),
              messages: [...c.messages, userMsg, asstMsg]
            }
          : c
      )
    })
    setDraft('')

    // Auto mode: classify the first message (Jev / heuristic), then lock the conversation to that mode.
    let { provider, modeId, model } = conv
    if (modeId === 'auto') {
      const decision = await api.route(prompt, conv.provider).catch(() => null)
      modeId = decision?.modeId ?? 'general'
      if (decision && decision.provider !== provider) {
        provider = decision.provider
        model = undefined
      }
      run.provider = provider
      updateConv(conv.id, (c) => ({
        ...c,
        modeId,
        provider,
        model,
        messages: c.messages.map((m) => (m.id === asstMsg.id ? { ...m, provider, route: decision ?? undefined } : m))
      }))
    }

    const mode = modes.find((m) => m.id === modeId)
    const status = providerStatus(provider)
    const effectiveModel = model ?? (provider === 'ollama' ? status?.models?.[0] : undefined)

    await api.run({
      runId,
      convId: conv.id,
      msgId: asstMsg.id,
      provider,
      prompt,
      cwd: conv.cwd,
      sessionId: conv.sessions[provider],
      model: effectiveModel,
      systemPrompt: mode?.systemPrompt || undefined,
      history: provider === 'ollama' ? historyFor(conv) : undefined,
      autonomy: conv.autonomy
    })
  }, [draft, settings, active, newConversation, runs, modes, providers, updateConv])

  const cancel = useCallback(() => {
    if (activeRun) void api.cancel(activeRun.runId)
  }, [activeRun])

  // Global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newConversation()
      } else if (e.key === 'Escape' && activeRun) {
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newConversation, cancel, activeRun])

  const removeConversation = async (id: string) => {
    const r = runs[id]
    if (r) await api.cancel(r.runId)
    await api.deleteConversation(id)
    setConvs((prev) => prev.filter((c) => c.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const pickFolder = async () => {
    if (!active) return
    const dir = await api.pickFolder()
    if (dir) updateConv(active.id, (c) => ({ ...c, cwd: dir }))
  }

  const setMode = (modeId: string) => {
    if (!active) return
    const mode = modes.find((m) => m.id === modeId)
    const wanted = mode?.defaultProvider
    updateConv(active.id, (c) => ({
      ...c,
      modeId,
      provider: wanted && providerStatus(wanted)?.available ? wanted : c.provider,
      model: wanted && wanted !== c.provider ? undefined : c.model
    }))
  }

  const currentMode = modes.find((m) => m.id === active?.modeId)
  const modelOptions = useMemo(
    () => (active ? (providerStatus(active.provider)?.models ?? []) : []),
    [active, providers]
  )

  if (!settings) return <div className="boot">Starting Jarvis…</div>

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top drag">
          <div className="brand">
            <span className="brand-orb" />
            Jarvis
          </div>
        </div>
        <button className="new-chat" onClick={newConversation}>
          New chat <kbd>⌘N</kbd>
        </button>
        <nav className="conv-list">
          {convs.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${c.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <span className={`dot ${runs[c.id] ? 'running' : ''}`} data-provider={c.provider} />
              <span className="conv-title">{c.title}</span>
              <button
                className="conv-del"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeConversation(c.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="provider-health" onClick={refreshProviders} title="Click to re-check">
            {providers.map((p) => (
              <div key={p.id} className="health-row" title={p.detail ?? p.version ?? ''}>
                <span className={`health-dot ${p.available ? 'ok' : 'off'}`} />
                {PROVIDER_LABEL[p.id]}
                {p.detail && p.available && <span className="health-warn">!</span>}
              </div>
            ))}
          </div>
          <button className="ghost" onClick={() => setShowMemory(true)}>
            Memory
          </button>
          <button className="ghost" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar drag">
          {active ? (
            <div className="controls no-drag">
              <select value={active.modeId} onChange={(e) => setMode(e.target.value)} title="Mode">
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <select
                value={active.provider}
                onChange={(e) =>
                  updateConv(active.id, (c) => ({ ...c, provider: e.target.value as ProviderId, model: undefined }))
                }
                title="Engine"
              >
                {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => (
                  <option key={id} value={id} disabled={!providerStatus(id)?.available}>
                    {PROVIDER_LABEL[id]}
                    {providerStatus(id)?.available ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
              {modelOptions.length > 0 && (
                <select
                  value={active.model ?? modelOptions[0]}
                  onChange={(e) => updateConv(active.id, (c) => ({ ...c, model: e.target.value }))}
                  title="Model"
                >
                  {modelOptions.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              )}
              {active.provider !== 'ollama' && (
                <select
                  value={active.autonomy}
                  onChange={(e) =>
                    updateConv(active.id, (c) => ({ ...c, autonomy: e.target.value as RunRequest['autonomy'] }))
                  }
                  title="What the agent may do"
                  className={active.autonomy === 'full' ? 'danger' : ''}
                >
                  {(Object.keys(AUTONOMY_LABEL) as RunRequest['autonomy'][]).map((a) => (
                    <option key={a} value={a}>
                      {AUTONOMY_LABEL[a]}
                    </option>
                  ))}
                </select>
              )}
              <button className="folder" onClick={pickFolder} title={active.cwd}>
                <span className="folder-icon">▸</span> {basename(active.cwd)}
              </button>
            </div>
          ) : (
            <div />
          )}
        </header>

        <div className="messages" ref={scrollRef}>
          {!active || active.messages.length === 0 ? (
            <div className="empty">
              <div className="empty-orb" />
              <h1>What should we do?</h1>
              <p>
                {currentMode?.description ??
                  'Runs on your machine through Claude Code, Codex and local Ollama models — using your own subscriptions.'}
              </p>
              <p className="hint">
                <kbd>⌘⇧Space</kbd> summons Jarvis from anywhere · <kbd>Esc</kbd> stops a run
              </p>
            </div>
          ) : (
            active.messages.map((m) => (
              <MessageView key={m.id} message={m} streaming={activeRun?.msgId === m.id} />
            ))
          )}
        </div>

        <footer className="composer">
          <div className="composer-box">
            <textarea
              ref={inputRef}
              value={draft}
              autoFocus
              rows={1}
              placeholder={
                active ? `Message ${PROVIDER_LABEL[active.provider]} in ${basename(active.cwd)}…` : 'Ask Jarvis…'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {activeRun ? (
              <button className="stop" onClick={cancel} title="Stop (Esc)">
                ■
              </button>
            ) : (
              <button className="send" onClick={() => void send()} disabled={!draft.trim()} title="Send (Enter)">
                ↑
              </button>
            )}
          </div>
        </footer>
      </main>

      {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} />}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          providers={providers}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            await api.saveSettings(s)
            setSettings(s)
            setShowSettings(false)
            void refreshProviders()
          }}
        />
      )}
    </div>
  )
}
