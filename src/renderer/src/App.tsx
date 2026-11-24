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
import { ProjectsPanel } from './ProjectsPanel'
import { Onboarding } from './Onboarding'
import { HomeDigest } from './HomeDigest'
import { applyEvent, historyFor, uid } from '@shared/chat'
import { Mic, recordUtterance, type Utterance } from './voice'
import { LIVE_SYSTEM_PROMPT, LiveLoop, type LivePhase } from './live'
import { IconArrowUp, IconBrain, IconClock, IconCompose, IconFolder, IconLayers, IconPanelRight, IconSettings, IconStop, IconX, IconTicket } from './icons'

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

/** Sidebar sections by last activity. */
function groupByDay(convs: Conversation[]): { label: string; items: Conversation[] }[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const day = 86_400_000
  const buckets: [string, number][] = [
    ['Today', today],
    ['Yesterday', today - day],
    ['Previous 7 days', today - 7 * day],
    ['Older', -Infinity]
  ]
  const groups = buckets.map(([label]) => ({ label, items: [] as Conversation[] }))
  for (const c of convs) groups[buckets.findIndex(([, from]) => c.updatedAt >= from)].items.push(c)
  return groups.filter((g) => g.items.length)
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p
export const prettyKey = (accel: string) =>
  accel
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, '⌘')
    .replace(/Control|Ctrl/g, '⌃')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '')

function greeting(name?: string) {
  const h = new Date().getHours()
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name}.` : `${part}.`
}

const PHASE_LABEL: Record<LivePhase, string> = {
  listening: 'Listening…',
  hearing: 'Hearing you…',
  transcribing: 'Transcribing…',
  thinking: 'Working on it…',
  speaking: 'Speaking…'
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
    <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
  </svg>
)

const LiveIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
    <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
  </svg>
)

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
  const [showProjects, setShowProjects] = useState(false)
  // Projects, Memory and Routines are pages over the main column; one at a time, the sidebar stays usable.
  const openPage = (page: 'projects' | 'memory' | 'routines' | null) => {
    setShowProjects(page === 'projects')
    setShowMemory(page === 'memory')
    setShowRoutines(page === 'routines')
  }
  const [onboarding, setOnboarding] = useState(false)
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
  const [live, setLive] = useState<{ phase: LivePhase; convId: string; heard?: string } | null>(null)
  const [dictation, setDictation] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const [level, setLevel] = useState(0)
  const [voiceNote, setVoiceNote] = useState<string | null>(null)
  const liveRef = useRef<LiveLoop | null>(null)
  const liveStarting = useRef(false)
  const dictationRef = useRef<Utterance | null>(null)
  const dictating = useRef(false)

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
  const convsRef = useRef(convs)
  convsRef.current = convs
  const settingsRef = useRef(settings)
  settingsRef.current = settings
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
      api.onOpenPanel((panel) =>
        panel === 'routines'
          ? openPage('routines')
          : panel === 'projects'
            ? openPage('projects')
            : panel === 'onboarding'
              ? setOnboarding(true)
              : setShowSettings(true)
      ),
      api.onSettingsChanged(setSettings)
    ]
    const setup = () => {
      setShowSettings(false)
      setOnboarding(true)
    }
    window.addEventListener('jarvis:onboarding', setup)
    offs.push(() => window.removeEventListener('jarvis:onboarding', setup))
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
      if (run && !req.connect && alwaysAllow.current.get(run.convId)?.has(req.toolName)) {
        void api.respondApproval(req.requestId, { behavior: 'allow' })
        return
      }
      setApprovals((q) => [...q, req])
      liveRef.current?.notify('I need your approval on screen.')
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
          const covered = !r.connect && runsByRunId.current.get(r.runId)?.convId === convId && r.toolName === head.toolName
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
  const [scrolledUp, setScrolledUp] = useState(false)
  const checkScroll = useCallback(() => {
    const el = scrollRef.current
    setScrolledUp(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 24)
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight
    checkScroll()
    // Content can grow after this render (code blocks, fonts); re-check once laid out.
    const raf = requestAnimationFrame(checkScroll)
    return () => cancelAnimationFrame(raf)
  }, [active?.messages, checkScroll])

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
    openPage(null)
    setDraft('')
    setTimeout(() => inputRef.current?.focus(), 0)
    return c
  }, [settings, providers, active?.cwd])

  const send = useCallback(async (text?: string, target?: Conversation, opts: { runId?: string; live?: boolean } = {}) => {
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
    const runId = opts.runId ?? uid()
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
      systemPrompt: [mode?.systemPrompt, opts.live ? LIVE_SYSTEM_PROMPT : ''].filter(Boolean).join('\n\n') || undefined,
      history: provider === 'ollama' ? historyFor(conv) : undefined,
      autonomy: conv.autonomy
    })
  }, [draft, settings, active, newConversation, runs, modes, providers, updateConv])
  const sendRef = useRef(send)
  sendRef.current = send

  // ---- voice: dictation into the composer, and live (hands-free) mode ----

  const voiceReady = useCallback(async () => {
    const status = await api.voice.status()
    if (!status.whisper.found || !status.model.downloaded) {
      setVoiceNote('Voice needs whisper.cpp and a model — set it up in Settings → Voice.')
      return false
    }
    if (!(await api.voice.requestMic())) {
      setVoiceNote('Microphone access is off for Jarvis (System Settings → Privacy & Security → Microphone).')
      return false
    }
    return true
  }, [])

  /** Click (or ⌘D) to talk, stops on a pause or a second click; the transcript lands in the composer to edit. */
  const dictate = useCallback(async () => {
    if (liveRef.current) return
    if (dictationRef.current) return dictationRef.current.stop()
    if (dictating.current) return
    dictating.current = true
    setVoiceNote(null)
    let mic: Mic | null = null
    try {
      if (!(await voiceReady())) return
      void api.voice.stopSpeaking()
      mic = await Mic.open()
      setDictation('listening')
      const u = recordUtterance(mic, { onLevel: setLevel })
      dictationRef.current = u
      const wav = await u.done
      dictationRef.current = null
      setLevel(0)
      mic.close()
      mic = null
      if (!wav) return
      setDictation('transcribing')
      const text = await api.voice.transcribe(wav)
      if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ` : '') + text)
      else setVoiceNote("Didn't catch that.")
    } catch (err) {
      setVoiceNote(errText(err))
    } finally {
      mic?.close()
      dictationRef.current = null
      dictating.current = false
      setDictation('idle')
      setLevel(0)
      inputRef.current?.focus()
    }
  }, [voiceReady])

  const stopLive = useCallback((reason?: string) => liveRef.current?.end(reason), [])

  /** Hands-free loop in the active chat (or a new one if it's busy): listen, answer out loud, listen again. */
  const startLive = useCallback(async () => {
    if (liveRef.current || liveStarting.current || !settingsRef.current) return
    liveStarting.current = true
    setVoiceNote(null)
    dictationRef.current?.cancel()
    try {
      if (!(await voiceReady())) return
      const cur = convsRef.current.find((c) => c.id === activeId)
      const conv = cur && !runsRef.current[cur.id] ? cur : newConversation()
      if (!conv) return
      const convId = conv.id
      setActiveId(convId)
      void api.voice.stopSpeaking()
      setLive({ phase: 'listening', convId })
      liveRef.current = await LiveLoop.start(
        {
          transcribe: (wav) => api.voice.transcribe(wav),
          send: (text, runId) => {
            const c = convsRef.current.find((x) => x.id === convId)
            if (!c || runsRef.current[c.id]) return false
            void sendRef.current(text, c, { runId, live: true })
            return true
          },
          cancel: (runId) => void api.cancel(runId),
          onEvent: api.onEvent,
          say: (t) => api.voice.say(t),
          stopSpeaking: () => void api.voice.stopSpeaking(),
          bargeIn: () => !!settingsRef.current?.liveBargeIn,
          onPhase: (phase) => setLive((l) => l && { ...l, phase }),
          onLevel: setLevel,
          onHeard: (heard) => setLive((l) => l && { ...l, heard }),
          onError: (msg) => setVoiceNote(errText(msg)),
          onEnd: (reason) => {
            liveRef.current = null
            setLive(null)
            setLevel(0)
            void api.voice.setLive(false)
            if (reason) setVoiceNote(reason)
          }
        },
        'Listening.'
      )
      void api.voice.setLive(true)
    } catch (err) {
      setLive(null)
      setVoiceNote(errText(err))
    } finally {
      liveStarting.current = false
    }
  }, [voiceReady, activeId, newConversation])

  // Global hotkey, tray, or "Jarvis, live mode".
  useEffect(
    () =>
      api.voice.onLiveToggle((start) => {
        if (start ?? !liveRef.current) void startLive()
        else stopLive()
      }),
    [startLive, stopLive]
  )

  // A deleted live chat ends the session; so does closing the window.
  useEffect(() => {
    if (live && !convs.some((c) => c.id === live.convId)) stopLive()
  }, [convs, live, stopLive])
  useEffect(() => () => liveRef.current?.end(), [])

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

  /** New read-only chat about a project (in its folder), e.g. "Catch me up on kosoku". */
  const askAbout = useCallback(
    async (prompt: string, cwd?: string) => {
      if (!settings) return
      setShowProjects(false)
      const conv: Conversation = {
        id: uid(),
        title: prompt.split(':')[0].slice(0, 60),
        provider: providerStatus('claude')?.available ? 'claude' : (providers.find((p) => p.available)?.id ?? 'claude'),
        modeId: 'general',
        cwd: cwd ?? settings.defaultCwd,
        autonomy: 'ask',
        sessions: {},
        messages: [],
        updatedAt: Date.now()
      }
      setConvs((prev) => [conv, ...prev])
      setActiveId(conv.id)
      await send(prompt, conv)
    },
    [settings, providers, send]
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

  // The workbench stays out of the way on an empty chat unless it is opened there explicitly.
  const isEmpty = !active || active.messages.length === 0
  const [wbOnEmpty, setWbOnEmpty] = useState(false)
  const wbVisible = showWorkbench && !!active && (!isEmpty || wbOnEmpty)
  const toggleWorkbench = useCallback(() => {
    if (wbVisible) {
      if (isEmpty) setWbOnEmpty(false)
      else setShowWorkbench(false)
    } else {
      setShowWorkbench(true)
      if (isEmpty) setWbOnEmpty(true)
    }
  }, [wbVisible, isEmpty])

  // Global keys
  const panelOpen = showSettings || showMemory || showRoutines || showProjects
  const approvalOpen = approvals.length > 0
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleWorkbench()
      } else if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newConversation()
      } else if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        void dictate()
      } else if (e.key === 'Escape' && panelOpen && !approvalOpen) {
        // Esc closes the open panel before it stops anything running.
        setShowSettings(false)
        setShowMemory(false)
        setShowRoutines(false)
        setShowProjects(false)
      } else if (e.key === 'Escape' && liveRef.current) {
        // First Esc stops the answer, the next ends live mode.
        const phase = liveRef.current.current
        if (phase === 'thinking' || phase === 'speaking') liveRef.current.interrupt()
        else stopLive()
      } else if (e.key === 'Escape' && dictationRef.current) {
        dictationRef.current.cancel()
      } else if (e.key === 'Escape' && activeRun) {
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newConversation, cancel, activeRun, dictate, stopLive, panelOpen, approvalOpen, toggleWorkbench])

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
  if (!settings.onboardedAt || onboarding)
    return (
      <Onboarding
        settings={settings}
        onDone={(next) => {
          setSettings(next)
          setOnboarding(false)
        }}
      />
    )

  return (
    <div className={`app ${wbVisible ? 'with-wb' : ''} ${showProjects || showMemory || showRoutines ? 'page-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top drag">
          <div className="brand">
            <span className="brand-orb" />
            Jarvis
          </div>
        </div>
        <button className="new-chat" onClick={newConversation}>
          <IconCompose size={15} />
          <span>New chat</span>
          <kbd>⌘N</kbd>
        </button>
        <nav className="conv-list">
          {groupByDay(convs).map((g) => (
            <section key={g.label} className="conv-group">
              <div className="conv-group-label">{g.label}</div>
              {g.items.map((c) => (
                <div
                  key={c.id}
                  className={`conv-item ${c.id === activeId ? 'active' : ''}`}
                  onClick={() => {
                    setActiveId(c.id)
                    openPage(null)
                  }}
                >
                  <span className={`dot ${runs[c.id] ? 'running' : ''}`} data-provider={c.provider} />
                  <span className="conv-title">{c.title}</span>
                  {c.routineId && <span className="conv-tag" title="Created by a routine">routine</span>}
                  {c.quick && !c.routineId && <span className="conv-tag" title="Started from the quick bar">quick</span>}
                  <button
                    className="conv-del"
                    title="Delete"
                    aria-label="Delete chat"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeConversation(c.id)
                    }}
                  >
                    <IconX size={13} />
                  </button>
                </div>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className={`nav-item ${showProjects ? 'active' : ''}`} onClick={() => openPage('projects')}>
            <IconLayers size={15} /> Projects
          </button>
          <button className={`nav-item ${showMemory ? 'active' : ''}`} onClick={() => openPage('memory')}>
            <IconBrain size={15} /> Memory
          </button>
          <button className={`nav-item ${showRoutines ? 'active' : ''}`} onClick={() => openPage('routines')}>
            <IconClock size={15} /> Routines
          </button>
          <button className="nav-item" onClick={() => setShowSettings(true)}>
            <IconSettings size={15} /> Settings
          </button>
          <div className="provider-health" onClick={refreshProviders} title="Engines · click to re-check">
            {providers.map((p) => (
              <span key={p.id} className="health-row" title={p.detail ?? p.version ?? ''}>
                <span className={`health-dot ${p.available ? 'ok' : 'off'}`} />
                {PROVIDER_LABEL[p.id].replace(' Code', '')}
                {p.detail && p.available && <span className="health-warn">!</span>}
              </span>
            ))}
          </div>
        </div>
      </aside>

      <main className={`main ${isEmpty ? 'is-empty' : ''}`}>
        <header className="topbar drag">
          {active ? (
            <div className="controls no-drag">
              <select className="ctl-mode" value={active.modeId} onChange={(e) => setMode(e.target.value)} title="Mode">
                {modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <span className="who-mark sm" data-provider={active.provider} />
              <select
                value={active.provider}
                onChange={(e) =>
                  updateConv(active.id, (c) => ({ ...c, provider: e.target.value as ProviderId, model: undefined }))
                }
                title="Engine"
                className="ctl-engine"
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
              <span className="ctl-sep" />
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
                <IconFolder size={14} /> {basename(active.cwd)}
              </button>
            </div>
          ) : (
            <div />
          )}
          <div className="topbar-right no-drag">
            {active?.linear && (
              <button className="ticket-chip" onClick={() => api.openExternal(active.linear!.url)} title={active.linear.title}>
                <IconTicket size={13} />
                {active.linear.identifier}
                {active.linear.prLinked && ' · PR linked'}
              </button>
            )}
            <button
              className={`icon-btn wb-toggle ${wbVisible ? 'on' : ''}`}
              onClick={toggleWorkbench}
              title="Git & Linear workbench (⌘B)"
              aria-label="Toggle workbench"
            >
              <IconPanelRight size={17} />
            </button>
          </div>
        </header>

        <div className={`messages ${scrolledUp ? 'scrolled-up' : ''}`} ref={scrollRef} onScroll={checkScroll}>
          {isEmpty ? (
            <div className="empty">
              <div className="empty-orb" />
              <h1>{greeting(settings.userName)}</h1>
              <p className="empty-sub">
                {currentMode?.description ??
                  'Runs on your machine through Claude Code, Codex and local Ollama models — using your own subscriptions.'}
              </p>
              <HomeDigest onAsk={(p, cwd) => void askAbout(p, cwd)} onOpen={() => openPage('projects')} />
            </div>
          ) : (
            active.messages.map((m) => (
              <MessageView key={m.id} message={m} streaming={activeRun?.msgId === m.id} />
            ))
          )}
        </div>

        <footer className="composer">
          {voiceNote && (
            <div className="voice-note">
              <span>{voiceNote}</span>
              <button className="icon" onClick={() => setVoiceNote(null)} title="Dismiss" aria-label="Dismiss">
                <IconX size={13} />
              </button>
            </div>
          )}
          <div className="composer-stack">
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
            {live ? (
              <div className={`live-bar ${live.phase}`}>
                <span className={`live-orb ${live.phase}`} style={{ ['--level' as string]: level.toFixed(2) }} />
                <div className="live-text">
                  <div className="live-status">
                    {PHASE_LABEL[live.phase]}
                    {live.convId !== activeId && (
                      <button className="link" onClick={() => setActiveId(live.convId)}>
                        back to live chat
                      </button>
                    )}
                  </div>
                  <div className="live-heard">
                    {live.heard ? `“${live.heard}”` : 'Just talk. Say “stop live mode” or press Esc to end.'}
                  </div>
                </div>
                {(live.phase === 'thinking' || live.phase === 'speaking') && (
                  <button className="ghost" onClick={() => liveRef.current?.interrupt()} title="Stop the answer and listen (Esc)">
                    Interrupt
                  </button>
                )}
                <button className="live-end" onClick={() => stopLive()} title="End live mode">
                  End
                </button>
              </div>
            ) : (
              <div className="composer-box">
                <textarea
                  ref={inputRef}
                  value={draft}
                  autoFocus
                  rows={1}
                  placeholder={
                    dictation === 'listening'
                      ? 'Listening… pause or click the mic when done'
                      : dictation === 'transcribing'
                        ? 'Transcribing…'
                        : active
                          ? `Message ${PROVIDER_LABEL[active.provider]} in ${basename(active.cwd)}…`
                          : 'Ask Jarvis…'
                  }
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <button
                  className={`voice-btn ${dictation !== 'idle' ? 'on' : ''} ${dictation}`}
                  style={{ ['--level' as string]: level.toFixed(2) }}
                  onClick={() => void dictate()}
                  disabled={dictation === 'transcribing'}
                  title={dictation === 'listening' ? 'Done talking' : 'Dictate (⌘D)'}
                >
                  <MicIcon />
                </button>
                <button
                  className="voice-btn"
                  onClick={() => void startLive()}
                  disabled={dictation !== 'idle'}
                  title={`Live conversation (${prettyKey(settings.liveHotkey)})`}
                >
                  <LiveIcon />
                </button>
                {activeRun ? (
                  <button className="stop" onClick={cancel} title="Stop (Esc)" aria-label="Stop">
                    <IconStop size={16} />
                  </button>
                ) : (
                  <button className="send" onClick={() => void send()} disabled={!draft.trim()} title="Send (Enter)" aria-label="Send">
                    <IconArrowUp size={16} />
                  </button>
                )}
              </div>
            )}
          </div>
          {isEmpty && !live && (
            <div className="hint">
              {(
                [
                  [settings.quickHotkey, 'Quick ask from anywhere'],
                  [settings.voiceHotkey, 'Talk']
                ] as const
              ).map(([k, label]) => (
                <span key={label} className="hint-item">
                  <kbd>{prettyKey(k)}</kbd> {label}
                </span>
              ))}
            </div>
          )}
        </footer>
      </main>

      {wbVisible && active && (
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

      {showProjects && (
        <ProjectsPanel settings={settings} onClose={() => setShowProjects(false)} onAsk={(p, cwd) => void askAbout(p, cwd)} />
      )}

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
