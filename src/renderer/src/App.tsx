import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovalDecision,
  ApprovalRequest,
  LinearIssue,
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
import { ApprovalDialog } from './ApprovalDialog'
import { Workbench } from './Workbench'
import { RoutinesPanel } from './RoutinesPanel'
import { applyEvent, historyFor, uid } from '@shared/chat'

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

function findPrUrl(conv: Conversation): string | null {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (m.role !== 'assistant') continue
    for (const p of m.parts) {
      const text = p.type === 'text' ? p.text : p.type === 'tool' ? (p.output ?? '') : ''
      const hit = text.match(PR_URL)
      if (hit) return hit[0]
    }
  }
  return null
}

function ticketPrompt(issue: LinearIssue): string {
  return [
    `Work on Linear issue ${issue.identifier}: ${issue.title}`,
    issue.url,
    '',
    `1. Read the full issue with the jarvis linear_get_issue tool (description + comments).`,
    `2. Check git status, then create and switch to branch \`${issue.branchName}\` from the up-to-date default branch.`,
    `3. Explore the relevant code and tell me your plan in a few bullets before large changes.`,
    `4. Implement, run the project's tests/lint, and commit with conventional commits referencing ${issue.identifier}.`,
    `5. When it works, push and open a PR with gh whose body links ${issue.url}. Print the PR URL.`
  ].join('\n')
}

const api = window.jarvis
const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' }
const AUTONOMY_LABEL: Record<RunRequest['autonomy'], string> = {
  ask: 'Read-only',
  edit: 'Edit files',
  full: 'Full access'
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p
export const prettyKey = (accel: string) =>
  accel
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, '⌘')
    .replace(/Control|Ctrl/g, '⌃')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '')

interface ActiveRun {
  runId: string
  convId: string
  msgId: string
  provider: ProviderId
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
  const [showRoutines, setShowRoutines] = useState(false)
  const [showWorkbench, setShowWorkbench] = useState(() => {
    try {
      return localStorage.getItem('wb-open') !== '0'
    } catch {
      return true
    }
  })
  const [gitTick, setGitTick] = useState(0)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [dismissedPr, setDismissedPr] = useState<Set<string>>(new Set())
  const [linking, setLinking] = useState(false)
  const alwaysAllow = useRef(new Map<string, Set<string>>()) // convId -> tool names

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

  // Another window (quick bar) or a routine wrote conversations: merge, never clobbering a chat running here.
  const runsRef = useRef(runs)
  runsRef.current = runs
  const reloadConversations = useCallback(async () => {
    const disk = await api.loadConversations()
    setConvs((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c]))
      const merged = disk.map((d) => {
        const local = byId.get(d.id)
        if (!local) return d
        if (runsRef.current[d.id] || local.updatedAt > d.updatedAt) return local
        return d
      })
      const diskIds = new Set(disk.map((d) => d.id))
      // Keep unsaved local chats (e.g. a fresh "New chat").
      const localOnly = prev.filter((c) => !diskIds.has(c.id) && (c.messages.length === 0 || runsRef.current[c.id]))
      return [...localOnly, ...merged].sort((a, b) => b.updatedAt - a.updatedAt)
    })
    return disk
  }, [])

  useEffect(() => {
    const offs = [
      api.onConversationsChanged(() => void reloadConversations()),
      api.onOpenConversation((id) => {
        void reloadConversations().then(() => setActiveId(id))
      }),
      api.onOpenPanel((panel) => (panel === 'routines' ? setShowRoutines(true) : setShowSettings(true))),
      api.onSettingsChanged(setSettings)
    ]
    return () => offs.forEach((o) => o())
  }, [reloadConversations])

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
        setGitTick((t) => t + 1)
        runsByRunId.current.delete(runId)
        setRuns((r) => {
          const next = { ...r }
          delete next[run.convId]
          return next
        })
      }
    })
  }, [updateConv])

  // Approval popups from the agent (Claude permission prompts via the Jarvis MCP bridge).
  useEffect(() => {
    return api.onApproval((req) => {
      const run = runsByRunId.current.get(req.runId)
      if (run && alwaysAllow.current.get(run.convId)?.has(req.toolName)) {
        void api.respondApproval(req.requestId, { behavior: 'allow' })
        return
      }
      setApprovals((q) => [...q, req])
    })
  }, [])

  const decideApproval = useCallback((decision: ApprovalDecision, always?: boolean) => {
    setApprovals((q) => {
      const [head, ...rest] = q
      if (!head) return q
      void api.respondApproval(head.requestId, decision)
      const convId = runsByRunId.current.get(head.runId)?.convId
      if (always && convId) {
        const set = alwaysAllow.current.get(convId) ?? new Set<string>()
        set.add(head.toolName)
        alwaysAllow.current.set(convId, set)
        // Release any queued requests this rule now covers.
        return rest.filter((r) => {
          const covered = runsByRunId.current.get(r.runId)?.convId === convId && r.toolName === head.toolName
          if (covered) void api.respondApproval(r.requestId, { behavior: 'allow' })
          return !covered
        })
      }
      return rest
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('wb-open', showWorkbench ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [showWorkbench])

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

  const send = useCallback(async (text?: string, target?: Conversation) => {
    const prompt = (text ?? draft).trim()
    if (!prompt || !settings) return
    const conv = target ?? active ?? newConversation()
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
    if (text === undefined) setDraft('')

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

  /** "Work on it": new Code-mode chat bound to the ticket, in the team's repo, ticket moved to In Progress. */
  const startTicket = useCallback(
    async (issue: LinearIssue) => {
      if (!settings) return
      const existing = convs.find((c) => c.linear?.id === issue.id)
      if (existing) return setActiveId(existing.id)

      const cwd = settings.linearRepoMap[issue.teamKey] ?? active?.cwd ?? settings.defaultCwd
      if (!settings.linearRepoMap[issue.teamKey]) {
        const next = { ...settings, linearRepoMap: { ...settings.linearRepoMap, [issue.teamKey]: cwd } }
        setSettings(next)
        void api.saveSettings(next)
      }
      const conv: Conversation = {
        id: uid(),
        title: `${issue.identifier} ${issue.title}`.slice(0, 60),
        provider: providerStatus('claude')?.available ? 'claude' : (providers.find((p) => p.available)?.id ?? 'claude'),
        modeId: 'code',
        cwd,
        autonomy: 'edit',
        sessions: {},
        messages: [],
        updatedAt: Date.now(),
        linear: { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }
      }
      setConvs((prev) => [conv, ...prev])
      setActiveId(conv.id)
      void api.linear.startWork(issue.identifier).catch(() => null)
      await send(ticketPrompt(issue), conv)
    },
    [settings, convs, active?.cwd, providers, send]
  )

  const prCandidate =
    active?.linear && !active.linear.prLinked && !dismissedPr.has(active.id) && !activeRun ? findPrUrl(active) : null

  const linkPr = async () => {
    if (!active?.linear || !prCandidate) return
    setLinking(true)
    try {
      const state = await api.linear.linkPr(active.linear.identifier, prCandidate)
      updateConv(active.id, (c) => ({ ...c, linear: c.linear && { ...c.linear, prLinked: prCandidate } }))
      if (state) setGitTick((t) => t + 1)
    } finally {
      setLinking(false)
    }
  }

  const cancel = useCallback(() => {
    if (activeRun) void api.cancel(activeRun.runId)
  }, [activeRun])

  // Global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setShowWorkbench((v) => !v)
      } else if (e.metaKey && e.key.toLowerCase() === 'n') {
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
    <div className={`app ${showWorkbench && active ? 'with-wb' : ''}`}>
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
              {c.routineId && <span className="conv-tag" title="Created by a routine">routine</span>}
              {c.quick && !c.routineId && <span className="conv-tag" title="Started from the quick bar">quick</span>}
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
          <button className="ghost" onClick={() => setShowRoutines(true)}>
            Routines
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
          <div className="topbar-right no-drag">
            {active?.linear && (
              <button className="ticket-chip" onClick={() => api.openExternal(active.linear!.url)} title={active.linear.title}>
                {active.linear.identifier}
                {active.linear.prLinked && ' · PR linked'}
              </button>
            )}
            <button
              className={`ghost wb-toggle ${showWorkbench ? 'on' : ''}`}
              onClick={() => setShowWorkbench((v) => !v)}
              title="Git & Linear workbench (⌘B)"
            >
              Workbench
            </button>
          </div>
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
                <kbd>{prettyKey(settings.quickHotkey)}</kbd> quick ask · <kbd>{prettyKey(settings.voiceHotkey)}</kbd> talk ·{' '}
                <kbd>{prettyKey(settings.hotkey)}</kbd> this window · <kbd>Esc</kbd> stops a run
              </p>
            </div>
          ) : (
            active.messages.map((m) => (
              <MessageView key={m.id} message={m} streaming={activeRun?.msgId === m.id} />
            ))
          )}
        </div>

        {prCandidate && active?.linear && (
          <div className="pr-banner">
            <span>
              PR detected · link to <strong>{active.linear.identifier}</strong>
              {settings.linearAutoMove ? ' and move to In Review' : ''}?
            </span>
            <button className="primary" disabled={linking} onClick={() => void linkPr()}>
              {linking ? 'Linking…' : 'Link PR'}
            </button>
            <button className="ghost" onClick={() => setDismissedPr((s) => new Set(s).add(active.id))}>
              Dismiss
            </button>
          </div>
        )}

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

      {showWorkbench && active && (
        <Workbench
          cwd={active.cwd}
          refreshKey={gitTick}
          busy={!!activeRun}
          onAsk={(prompt) => void send(prompt, active)}
          onWork={(issue) => void startTicket(issue)}
          repoFor={(team) => settings.linearRepoMap[team]}
        />
      )}

      {approvals[0] && (
        <ApprovalDialog
          request={approvals[0]}
          queued={approvals.length - 1}
          chatTitle={convs.find((c) => c.id === runsByRunId.current.get(approvals[0].runId)?.convId)?.title}
          onDecide={decideApproval}
        />
      )}

      {showMemory && <MemoryPanel onClose={() => setShowMemory(false)} />}

      {showRoutines && (
        <RoutinesPanel
          settings={settings}
          providers={providers}
          onClose={() => setShowRoutines(false)}
          onOpen={(id) => {
            setShowRoutines(false)
            void reloadConversations().then(() => setActiveId(id))
          }}
        />
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          providers={providers}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            const errors = await api.saveSettings(s)
            setSettings(s)
            void refreshProviders()
            if (Object.keys(errors).length) return errors
            setShowSettings(false)
            return errors
          }}
        />
      )}
    </div>
  )
}
