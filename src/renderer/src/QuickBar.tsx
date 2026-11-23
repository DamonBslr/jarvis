import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  Conversation,
  Mode,
  ProviderStatus,
  Settings
} from '@shared/types'
import { applyEvent, historyFor, messageText, speakable, uid } from '@shared/chat'
import { MessageView } from './MessageView'
import { ApprovalDialog } from './ApprovalDialog'
import { Mic, recordUtterance, startWakeListener, type Utterance } from './voice'

const api = window.jarvis

type VoiceState = 'idle' | 'listening' | 'transcribing'

export function QuickBar() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [modes, setModes] = useState<Mode[]>([])
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [conv, setConv] = useState<Conversation | null>(null)
  const [draft, setDraft] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [speaking, setSpeaking] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const convRef = useRef<Conversation | null>(null)
  const runRef = useRef<{ runId: string; msgId: string; spoken: boolean } | null>(null)
  const mic = useRef<Mic | null>(null)
  const utterance = useRef<Utterance | null>(null)
  const wakeMic = useRef<Mic | null>(null)
  const voiceRef = useRef<VoiceState>('idle')
  const speakingRef = useRef(false)
  const liveRef = useRef(false) // main window is in live mode: it owns the mic conversation
  const visible = useRef(false)
  voiceRef.current = voiceState
  convRef.current = conv

  useEffect(() => {
    // Settings first: the provider check spawns a login shell and can take a few seconds.
    void Promise.all([api.getSettings(), api.modes()]).then(([s, m]) => {
      setSettings(s)
      setModes(m)
    })
    void api.providers().then(setProviders)
    const offs = [
      api.onSettingsChanged(setSettings),
      api.voice.onSpeaking((on) => {
        speakingRef.current = on
        setSpeaking(on)
      }),
      api.voice.onLive((on) => (liveRef.current = on))
    ]
    const onVis = () => (visible.current = document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => {
      offs.forEach((o) => o())
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // Grow/shrink the window with the content.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => void api.quick.resize(el.getBoundingClientRect().height + 2))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const persist = useCallback((c: Conversation) => void api.saveConversation(c), [])

  const updateConv = useCallback(
    (fn: (c: Conversation) => Conversation, save = false) => {
      setConv((prev) => {
        if (!prev) return prev
        const next = fn(prev)
        if (save) persist(next)
        return next
      })
    },
    [persist]
  )

  // Agent events for our run.
  useEffect(() => {
    return api.onEvent((id, ev) => {
      const run = runRef.current
      if (!run || run.runId !== id) return
      const final = ev.kind === 'done'
      updateConv(
        (c) => ({
          ...c,
          updatedAt: Date.now(),
          sessions: ev.kind === 'session' ? { ...c.sessions, [c.provider]: ev.sessionId } : c.sessions,
          messages: c.messages.map((m) => (m.id === run.msgId ? applyEvent(m, ev) : m))
        }),
        final || ev.kind === 'session'
      )
      if (final) {
        runRef.current = null
        setRunId(null)
        if (run.spoken && settings?.speakReplies) {
          // Read the finished answer aloud (state update above is async; read from the ref next tick).
          setTimeout(() => {
            const msg = convRef.current?.messages.find((m) => m.id === run.msgId)
            const text = msg ? messageText(msg) : ''
            if (text) void api.voice.speak(speakable(text))
          }, 50)
        }
      }
    })
  }, [updateConv, settings?.speakReplies])

  useEffect(() => api.onLearned((ev) => {
    updateConv((c) => (c.id === ev.convId ? { ...c, messages: c.messages.map((m) => (m.id === ev.msgId ? { ...m, learned: ev.added } : m)) } : c))
  }), [updateConv])

  const alwaysAllow = useRef(new Set<string>())
  useEffect(
    () =>
      api.onApproval((req) => {
        if (!req.connect && alwaysAllow.current.has(req.toolName)) void api.respondApproval(req.requestId, { behavior: 'allow' })
        else setApprovals((q) => [...q, req])
      }),
    []
  )
  useEffect(() => {
    void api.quick.pin(approvals.length > 0 || voiceState !== 'idle')
  }, [approvals.length, voiceState])

  const decideApproval = useCallback((decision: ApprovalDecision, always?: boolean) => {
    setApprovals((q) => {
      const [head, ...rest] = q
      if (!head) return q
      void api.respondApproval(head.requestId, decision)
      if (!always) return rest
      alwaysAllow.current.add(head.toolName)
      return rest.filter((r) => {
        const covered = !r.connect && r.toolName === head.toolName
        if (covered) void api.respondApproval(r.requestId, { behavior: 'allow' })
        return !covered
      })
    })
  }, [])

  const send = useCallback(
    async (text: string, spoken = false) => {
      const prompt = text.trim()
      if (!prompt || runRef.current) return
      const cfg = settings ?? (await api.getSettings())
      const provs = providers.length ? providers : await api.providers()
      if (!providers.length) setProviders(provs)
      const modeList = modes.length ? modes : await api.modes()
      void api.voice.stopSpeaking()
      const firstAvailable = provs.find((p) => p.available)?.id ?? 'claude'
      let c: Conversation = convRef.current ?? {
        id: uid(),
        title: prompt.slice(0, 60),
        provider: firstAvailable,
        modeId: 'auto',
        cwd: cfg.defaultCwd,
        autonomy: 'edit',
        sessions: {},
        messages: [],
        updatedAt: Date.now(),
        quick: true
      }
      const userMsg: ChatMessage = { id: uid(), role: 'user', parts: [{ type: 'text', text: prompt }], createdAt: Date.now() }
      const asst: ChatMessage = { id: uid(), role: 'assistant', parts: [], provider: c.provider, createdAt: Date.now() }
      const id = uid()
      runRef.current = { runId: id, msgId: asst.id, spoken }
      setRunId(id)
      setDraft('')

      if (c.modeId === 'auto') {
        const decision = await api.route(prompt, c.provider).catch(() => null)
        c = { ...c, modeId: decision?.modeId ?? 'general', provider: decision?.provider ?? c.provider }
        asst.provider = c.provider
        asst.route = decision ?? undefined
      }
      const history = historyFor(c)
      c = { ...c, updatedAt: Date.now(), messages: [...c.messages, userMsg, asst] }
      setConv(c)
      persist(c)

      const mode = modeList.find((m) => m.id === c.modeId)
      const status = provs.find((p) => p.id === c.provider)
      await api.run({
        runId: id,
        convId: c.id,
        msgId: asst.id,
        provider: c.provider,
        prompt,
        cwd: c.cwd,
        sessionId: c.sessions[c.provider],
        model: c.model ?? (c.provider === 'ollama' ? status?.models?.[0] : undefined),
        systemPrompt: [mode?.systemPrompt, spoken ? 'The user spoke this request; keep the answer short and conversational.' : '']
          .filter(Boolean)
          .join('\n\n') || undefined,
        history: c.provider === 'ollama' ? history : undefined,
        autonomy: c.autonomy
      })
    },
    [settings, providers, modes, persist]
  )

  const stopListening = useCallback(() => {
    utterance.current?.stop()
  }, [])

  const listen = useCallback(async () => {
    if (voiceRef.current !== 'idle') return stopListening()
    setVoiceError(null)
    void api.voice.stopSpeaking()
    try {
      const status = await api.voice.status()
      if (!status.whisper.found || !status.model.downloaded) {
        setVoiceError('Voice needs whisper.cpp and a model — set it up in Jarvis → Settings → Voice.')
        return
      }
      if (!(await api.voice.requestMic())) {
        setVoiceError('Microphone access is off for Jarvis (System Settings → Privacy & Security → Microphone).')
        return
      }
      mic.current ??= await Mic.open()
      setVoiceState('listening')
      const u = recordUtterance(mic.current, { onLevel: setLevel })
      utterance.current = u
      const wav = await u.done
      utterance.current = null
      setLevel(0)
      if (!wav) return setVoiceState('idle')
      setVoiceState('transcribing')
      const text = await api.voice.transcribe(wav)
      setVoiceState('idle')
      if (text) void send(text, true)
      else setVoiceError("Didn't catch that.")
    } catch (err) {
      setVoiceState('idle')
      setVoiceError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      // Release the mic (and macOS's orange dot) between requests.
      mic.current?.close()
      mic.current = null
    }
  }, [send, stopListening])

  // Summoned via hotkey / tray / wake word.
  useEffect(() => {
    return api.quick.onShow(({ voice, prompt }) => {
      visible.current = true
      inputRef.current?.focus()
      if (prompt) void send(prompt, true)
      else if (voice) void listen()
    })
  }, [send, listen])

  // Wake word: keep a mic open while enabled and listen for "Jarvis…".
  useEffect(() => {
    if (!settings?.wakeWord) return
    let cancelled = false
    void (async () => {
      const status = await api.voice.status()
      if (!status.whisper.found || !status.model.downloaded || !(await api.voice.requestMic()) || cancelled) return
      const m = await Mic.open()
      if (cancelled) return m.close()
      wakeMic.current = m
      startWakeListener(
        m,
        (wav) => api.voice.transcribe(wav),
        (rest) => void api.voice.wake(rest),
        // Don't trigger on our own voice, or while the bar is already in use.
        () =>
          speakingRef.current || liveRef.current || voiceRef.current !== 'idle' || document.visibilityState === 'visible'
      )
    })()
    return () => {
      cancelled = true
      wakeMic.current?.close()
      wakeMic.current = null
    }
  }, [settings?.wakeWord])

  const reset = () => {
    if (runRef.current) return
    alwaysAllow.current.clear()
    setConv(null)
    setDraft('')
    setVoiceError(null)
    inputRef.current?.focus()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (approvals.length) return // the dialog owns the keyboard
      if (e.key === 'Escape') {
        e.preventDefault()
        if (voiceRef.current === 'listening') utterance.current?.cancel()
        else if (speakingRef.current) void api.voice.stopSpeaking()
        else void api.quick.hide()
      } else if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        reset()
      } else if (e.metaKey && e.key.toLowerCase() === 'o' && convRef.current) {
        e.preventDefault()
        void api.quick.openInMain(convRef.current.id)
      } else if (e.metaKey && e.key === '.' && runRef.current) {
        e.preventDefault()
        void api.cancel(runRef.current.runId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approvals.length])

  const lastUser = conv ? [...conv.messages].reverse().find((m) => m.role === 'user') : undefined
  const lastAsst = conv ? conv.messages[conv.messages.length - 1] : undefined
  const showAnswer = lastAsst?.role === 'assistant'
  const earlier = conv ? Math.max(0, Math.floor((conv.messages.length - 2) / 2)) : 0

  const placeholder =
    voiceState === 'listening'
      ? 'Listening…'
      : voiceState === 'transcribing'
        ? 'Transcribing…'
        : conv
          ? 'Follow up…'
          : 'Ask Jarvis anything…'

  return (
    <div className="quick-root" ref={rootRef}>
      <div className={`quick ${showAnswer || voiceError ? 'open' : ''}`}>
        <div className="quick-row drag">
          <span
            className={`quick-orb ${runId ? 'busy' : ''} ${voiceState}`}
            style={{ ['--level' as string]: level.toFixed(2) }}
          />
          <input
            ref={inputRef}
            className="quick-input no-drag"
            value={draft}
            autoFocus
            disabled={voiceState !== 'idle'}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(draft)
              }
            }}
          />
          {speaking && (
            <button className="quick-btn no-drag" title="Stop speaking (Esc)" onClick={() => void api.voice.stopSpeaking()}>
              ◼︎ voice
            </button>
          )}
          {runId ? (
            <button className="quick-btn no-drag" title="Stop (⌘.)" onClick={() => void api.cancel(runId)}>
              Stop
            </button>
          ) : (
            <button
              className={`quick-mic no-drag ${voiceState !== 'idle' ? 'on' : ''}`}
              title={voiceState === 'listening' ? 'Done talking' : `Talk (${settings?.voiceHotkey ?? ''})`}
              onClick={() => void listen()}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {voiceError && <div className="quick-error">{voiceError}</div>}

        {showAnswer && lastAsst && (
          <div className="quick-body">
            {earlier > 0 && <div className="quick-earlier">{earlier} earlier exchange{earlier === 1 ? '' : 's'} · open in Jarvis to see all</div>}
            {lastUser && <div className="quick-q">{messageText(lastUser)}</div>}
            <div className="quick-answer">
              {lastAsst.parts.length === 0 && !lastAsst.error ? (
                <div className="quick-thinking">Thinking…</div>
              ) : (
                <MessageView message={lastAsst} streaming={!!runId} />
              )}
            </div>
          </div>
        )}

        {conv && (
          <div className="quick-foot">
            <button className="link" onClick={() => void api.quick.openInMain(conv.id)}>
              Open in Jarvis <kbd>⌘O</kbd>
            </button>
            <button className="link" disabled={!!runId} onClick={reset}>
              New <kbd>⌘N</kbd>
            </button>
            <span className="quick-hint">
              <kbd>Esc</kbd> hide
            </span>
          </div>
        )}
      </div>

      {approvals[0] && (
        <ApprovalDialog request={approvals[0]} queued={approvals.length - 1} chatTitle={conv?.title} onDecide={decideApproval} />
      )}
    </div>
  )
}
