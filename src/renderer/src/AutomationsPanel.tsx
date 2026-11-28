import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  Automation,
  AutomationRun,
  AutomationSchedule,
  AutomationThread,
  AutomationView,
  ProviderId,
  ProviderStatus,
  RunRequest,
  Settings,
  WebhookDeliveryNote,
  WebhookFilter,
  WebhookRelayStatus,
  WebhookSignature,
  WebhookTrigger
} from '@shared/types'
import { uid } from '@shared/chat'
import { DEFAULT_COALESCE_S, MAX_FILTERS, PAYLOAD_TOKEN } from '@shared/webhook'
import { timeAgo } from './knowledgeUi'
import { IconChat, IconCheck, IconClock, IconCopy, IconFolder, IconInbox, IconPlay, IconPlus, IconRefresh, IconRepeat, IconWebhook, IconX } from './icons'

const api = window.jarvis
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' }
const ACCESS_LABEL: Record<RunRequest['autonomy'], string> = { ask: 'Read-only', edit: 'Edit files', full: 'Full access' }
const TOKENS = ['{{linear}}', '{{prs}}', '{{repos}}', '{{date}}']

/** A chat runs can go into (only chats with messages are saved). */
export interface ChatRef {
  id: string
  title: string
  updatedAt: number
  provider: ProviderId
  model?: string
  cwd: string
  autonomy: RunRequest['autonomy']
}

/** What the page should open with: a new automation (optionally for a chat) or an existing one. */
export type AutomationIntent = { kind: 'new'; chat?: ChatRef } | { kind: 'edit'; id: string }

type Filter = 'all' | 'active' | 'paused'

// ---- formatting -------------------------------------------------------------

export function describeSchedule(s: AutomationSchedule) {
  if (s.kind === 'webhook') return s.filters.length ? `On webhook · ${s.filters.length} filter${s.filters.length > 1 ? 's' : ''}` : 'On webhook'
  if (s.kind === 'interval') {
    const m = s.minutes
    if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`
    if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`
    return `Every ${m} min`
  }
  if (s.kind === 'once') return `Once · ${new Date(s.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
  const d = s.days.join()
  const days =
    s.days.length === 7 ? 'Daily' : d === '1,2,3,4,5' ? 'Weekdays' : d === '0,6' ? 'Weekends' : s.days.map((i) => DAY_NAMES[i]).join(' ')
  return `${days} at ${s.time}`
}

/** "in 5m", "in 3h", "tomorrow 08:30", "Mon 08:30". */
function inTime(t: number) {
  const s = (t - Date.now()) / 1000
  if (s < 45) return 'now'
  if (s < 3600) return `in ${Math.round(s / 60)}m`
  const date = new Date(t)
  const hm = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (s < 6 * 3600) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  if (date.toDateString() === today.toDateString()) return `today ${hm}`
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${hm}`
  if (s < 6 * 86400) return `${DAY_NAMES[date.getDay()]} ${hm}`
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ` ${hm}`
}

function duration(ms?: number) {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function threadLabel(a: AutomationView, chats: ChatRef[]) {
  const t = a.thread
  if (t.kind === 'new') return 'New chat each run'
  const title = a.threadTitle ?? chats.find((c) => c.id === t.convId)?.title
  if (t.kind === 'dedicated') return title ? `Own chat · ${title}` : 'Own chat (created on first run)'
  return title ? `In “${title}”` : 'In a deleted chat'
}

const ThreadIcon = ({ thread, size = 13 }: { thread: AutomationThread; size?: number }) =>
  thread.kind === 'origin' ? <IconChat size={size} /> : thread.kind === 'dedicated' ? <IconInbox size={size} /> : <IconPlus size={size} />

// ---- templates --------------------------------------------------------------

type Draft = Omit<Automation, 'id'>

function base(s: Settings, chat?: ChatRef): Draft {
  return {
    name: '',
    prompt: '',
    schedule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
    thread: chat ? { kind: 'origin', convId: chat.id } : { kind: 'new' },
    provider: chat?.provider ?? 'claude',
    model: chat?.model,
    cwd: chat?.cwd ?? s.defaultCwd,
    // Unattended runs can't ask for approval; keep the chat's level only when it's read-only or edit.
    autonomy: chat ? (chat.autonomy === 'full' ? 'edit' : chat.autonomy) : 'ask',
    enabled: true,
    notify: true,
    speak: false
  }
}

const TEMPLATES: { name: string; blurb: string; build: (d: Draft) => Draft }[] = [
  {
    name: 'Blank',
    blurb: 'Your own prompt and schedule',
    build: (d) => ({ ...d, name: 'New automation' })
  },
  {
    name: 'Morning briefing',
    blurb: 'Linear, PRs and repos, weekdays 08:30',
    build: (d) => ({
      ...d,
      name: 'Morning briefing',
      prompt:
        'Give me my briefing for {{date}}.\n\nMy Linear issues:\n{{linear}}\n\nMy open pull requests and review requests:\n{{prs}}\n\nLocal repos:\n{{repos}}\n\nWhat needs me first (reviews blocking others, failing or stale PRs, tickets already In Progress), then a suggested order for today. At most 12 lines, no preamble.',
      schedule: { kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }
    })
  },
  {
    name: 'PR review sweep',
    blurb: 'What needs your review, every 2 hours',
    build: (d) => ({
      ...d,
      name: 'PR review sweep',
      prompt:
        'Here are my open PRs and the PRs waiting for my review:\n{{prs}}\n\nList only what needs action from me right now, most urgent first, one line each with the link. If nothing needs me, say so in one line.',
      schedule: { kind: 'interval', minutes: 120 },
      model: d.thread.kind === 'origin' ? d.model : d.provider === 'claude' ? 'haiku' : d.model
    })
  },
  {
    name: 'GitHub pull request',
    blurb: 'Webhook: review each PR that opens',
    build: (d) => ({
      ...d,
      name: 'Review new pull requests',
      prompt:
        'A pull request was opened or reopened. The GitHub webhook payload is below.\n\n{{payload}}\n\nCheck out the branch, review the change for bugs and risky spots, and give me a short verdict with the 3 most important findings. Do not push or comment on GitHub.',
      schedule: {
        kind: 'webhook',
        filters: [
          { path: 'headers.x-github-event', op: 'equals', value: 'pull_request' },
          { path: 'body.action', op: 'in', value: ['opened', 'reopened'] }
        ],
        signature: { header: 'x-hub-signature-256', encoding: 'hex', prefix: 'sha256=', algorithm: 'sha256' },
        dedupe: { replayKey: '{{headers.x-github-delivery}}', coalesceKey: '{{body.pull_request.number}}', coalesceWindowSeconds: 120 },
        maxDeliveryAgeMinutes: 360
      }
    })
  },
  {
    name: 'End-of-day wrap-up',
    blurb: 'Unpushed work and tomorrow’s first task',
    build: (d) => ({
      ...d,
      name: 'End-of-day wrap-up',
      prompt:
        "It's the end of my day ({{date}}).\n\nLinear:\n{{linear}}\n\nRepos:\n{{repos}}\n\nPRs:\n{{prs}}\n\nSummarize what's still open, flag uncommitted or unpushed work I should not leave overnight, and suggest the first thing to pick up tomorrow. Max 8 lines.",
      schedule: { kind: 'daily', time: '17:30', days: [1, 2, 3, 4, 5] }
    })
  }
]

// ---- small controls ---------------------------------------------------------

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="tabs auto-seg" role="tablist">
      {options.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

const toLocalInput = (t: number) => {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function ScheduleEditor({
  value,
  onChange,
  webhook
}: {
  value: AutomationSchedule
  onChange: (s: AutomationSchedule) => void
  webhook: Omit<WebhookEditorProps, 'value' | 'onChange'>
}) {
  const switchKind = (kind: AutomationSchedule['kind']) => {
    if (kind === value.kind) return
    if (kind === 'daily') onChange({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] })
    else if (kind === 'interval') onChange({ kind: 'interval', minutes: 60 })
    else if (kind === 'webhook') onChange({ kind: 'webhook', filters: [] })
    else {
      const t = new Date()
      t.setHours(t.getHours() + 1, 0, 0, 0)
      onChange({ kind: 'once', at: t.getTime() })
    }
  }
  const hours = value.kind === 'interval' && value.minutes % 60 === 0
  return (
    <div className="auto-schedule">
      <Segmented
        value={value.kind}
        options={[
          ['daily', 'At a time'],
          ['interval', 'Repeating'],
          ['once', 'Once'],
          ['webhook', 'Webhook']
        ]}
        onChange={switchKind}
      />
      {value.kind === 'webhook' && <WebhookEditor {...webhook} value={value} onChange={onChange} />}
      {value.kind === 'daily' && (
        <div className="auto-sched-row">
          <input type="time" value={value.time} onChange={(e) => e.target.value && onChange({ ...value, time: e.target.value })} />
          <div className="day-chips" role="group" aria-label="Weekdays">
            {DAYS.map((d, i) => {
              const on = value.days.includes(i)
              return (
                <button
                  key={i}
                  className={on ? 'on' : ''}
                  title={DAY_NAMES[i]}
                  aria-pressed={on}
                  onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== i) : [...value.days, i].sort() })}
                >
                  {d}
                </button>
              )
            })}
          </div>
          <div className="auto-presets">
            <button className="link" onClick={() => onChange({ ...value, days: [1, 2, 3, 4, 5] })}>
              Weekdays
            </button>
            <button className="link" onClick={() => onChange({ ...value, days: [0, 1, 2, 3, 4, 5, 6] })}>
              Every day
            </button>
          </div>
        </div>
      )}
      {value.kind === 'interval' && (
        <div className="auto-sched-row">
          <span className="auto-sched-label">Every</span>
          <input
            type="number"
            min={1}
            value={hours ? value.minutes / 60 : value.minutes}
            onChange={(e) => {
              const n = Math.max(1, Math.round(Number(e.target.value) || 1))
              onChange({ kind: 'interval', minutes: hours ? n * 60 : n })
            }}
          />
          <select
            value={hours ? 'h' : 'm'}
            onChange={(e) =>
              onChange({ kind: 'interval', minutes: e.target.value === 'h' ? Math.max(1, Math.round(value.minutes / 60)) * 60 : value.minutes })
            }
          >
            <option value="m">minutes</option>
            <option value="h">hours</option>
          </select>
        </div>
      )}
      {value.kind === 'once' && (
        <div className="auto-sched-row">
          <input
            type="datetime-local"
            value={toLocalInput(value.at)}
            onChange={(e) => {
              const t = new Date(e.target.value).getTime()
              if (!Number.isNaN(t)) onChange({ kind: 'once', at: t })
            }}
          />
          {value.at < Date.now() && <span className="warn-inline">That time has passed: it runs right away.</span>}
        </div>
      )}
    </div>
  )
}

// ---- webhook trigger ---------------------------------------------------------------

type WebhookSchedule = Extract<AutomationSchedule, { kind: 'webhook' }>

interface WebhookEditorProps {
  value: WebhookSchedule
  onChange: (s: AutomationSchedule) => void
  isNew: boolean
  view?: AutomationView
  relay: WebhookRelayStatus | null
  /** New signature secret typed in this edit ('' = keep the stored one). */
  secret: string
  setSecret: (s: string) => void
  onRegenerate: () => Promise<void>
}

const OPS: [WebhookFilter['op'], string][] = [
  ['equals', 'equals'],
  ['notEquals', 'is not'],
  ['startsWith', 'starts with'],
  ['in', 'is one of'],
  ['exists', 'exists']
]

const SIG_PRESETS: { name: string; sig: WebhookSignature }[] = [
  { name: 'GitHub', sig: { header: 'x-hub-signature-256', encoding: 'hex', prefix: 'sha256=', algorithm: 'sha256' } },
  { name: 'Linear', sig: { header: 'linear-signature', encoding: 'hex', prefix: '', algorithm: 'sha256' } },
  { name: 'Generic', sig: { header: 'x-signature', encoding: 'hex', prefix: '', algorithm: 'sha256' } }
]

const OUTCOME: Record<WebhookDeliveryNote['outcome'], string> = {
  queued: 'started a run',
  coalesced: 'coalesced',
  filtered: 'filtered out',
  duplicate: 'duplicate, dropped',
  'too-old': 'too old, skipped',
  'bad-signature': 'bad signature, rejected',
  paused: 'ignored (paused)'
}

/** Show the URL without its token; Copy copies the whole thing. */
const maskUrl = (url: string) => url.replace(/\/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+$/, '/$1••••••••')

function relayLine(relay: WebhookRelayStatus | null): { dot: string; text: string } {
  if (!relay || (!relay.url && relay.state === 'off')) return { dot: 'idle', text: 'No relay set up' }
  if (relay.state === 'connected') return { dot: 'ok', text: `Relay connected · ${relay.hooks} webhook${relay.hooks === 1 ? '' : 's'}` }
  if (relay.state === 'connecting') return { dot: 'running', text: 'Connecting to the relay…' }
  if (relay.state === 'error') return { dot: 'err', text: relay.error ?? 'Relay error' }
  return { dot: 'idle', text: relay.hasSecret ? 'Relay off' : 'Relay secret missing (Settings → Tools)' }
}

function setFilter(list: WebhookFilter[], i: number, f: WebhookFilter) {
  return list.map((x, j) => (j === i ? f : x))
}

function FilterRow({ f, onChange, onRemove }: { f: WebhookFilter; onChange: (f: WebhookFilter) => void; onRemove: () => void }) {
  const changeOp = (op: WebhookFilter['op']) => {
    const v = 'value' in f ? (Array.isArray(f.value) ? f.value.join(',') : f.value) : ''
    if (op === 'exists') onChange({ path: f.path, op })
    else if (op === 'in') onChange({ path: f.path, op, value: v.split(',').map((x) => x.trim()) })
    else onChange({ path: f.path, op, value: v })
  }
  return (
    <div className="hook-filter">
      <input
        className="mono"
        value={f.path}
        placeholder="body.action"
        aria-label="Path"
        spellCheck={false}
        onChange={(e) => onChange({ ...f, path: e.target.value })}
      />
      <select value={f.op} aria-label="Operator" onChange={(e) => changeOp(e.target.value as WebhookFilter['op'])}>
        {OPS.map(([op, label]) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>
      {f.op === 'exists' ? (
        <span className="hook-filter-none" />
      ) : f.op === 'in' ? (
        <input
          className="mono"
          value={f.value.join(',')}
          placeholder="opened,reopened"
          aria-label="Values, comma separated"
          spellCheck={false}
          onChange={(e) => onChange({ ...f, value: e.target.value.split(',').map((x) => x.trim()) })}
        />
      ) : (
        <input className="mono" value={f.value} placeholder="opened" aria-label="Value" spellCheck={false} onChange={(e) => onChange({ ...f, value: e.target.value })} />
      )}
      <button className="icon del" title="Remove filter" aria-label="Remove filter" onClick={onRemove}>
        <IconX size={13} />
      </button>
    </div>
  )
}

function WebhookEditor({ value, onChange, isNew, view, relay, secret, setSecret, onRegenerate }: WebhookEditorProps) {
  const [copied, setCopied] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (p: Partial<WebhookTrigger>) => onChange({ ...value, ...p })
  const url = view?.webhook?.url
  const last = view?.webhook?.lastDelivery
  const line = relayLine(relay)
  const sig = value.signature
  const dedupe = value.dedupe ?? {}
  const setDedupe = (p: Partial<NonNullable<WebhookTrigger['dedupe']>>) => set({ dedupe: { ...dedupe, ...p } })

  const copy = async () => {
    if (!url) return
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="hook">
      <div className="hook-url-block">
        {url ? (
          <div className="hook-url">
            <code title="The token at the end authenticates; keep the URL private">{maskUrl(url)}</code>
            <button className="ghost small" onClick={() => void copy()}>
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} {copied ? 'Copied' : 'Copy URL'}
            </button>
            {confirmNew ? (
              <span className="auto-confirm">
                The old URL stops working.
                <button
                  className="ghost small danger-hover"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await onRegenerate().finally(() => setBusy(false))
                    setConfirmNew(false)
                  }}
                >
                  New URL
                </button>
                <button className="link" onClick={() => setConfirmNew(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="ghost small" title="Make a new token; the old URL stops working" onClick={() => setConfirmNew(true)}>
                <IconRefresh size={13} /> Regenerate
              </button>
            )}
          </div>
        ) : (
          <p className="auto-note">
            {isNew
              ? 'The webhook URL appears once you create the automation.'
              : relay?.url
                ? 'The URL appears once the relay is reachable.'
                : 'Set up the webhook relay in Settings → Tools to get a public URL for this automation.'}
          </p>
        )}
        <div className="hook-relay">
          <span className={`auto-dot ${line.dot}`} />
          {line.text}
          {last && (
            <span className="hook-last" title={last.detail}>
              · Last request {timeAgo(last.at)}: {OUTCOME[last.outcome]}
            </span>
          )}
        </div>
      </div>

      <div className="hook-section">
        <div className="hook-label">
          Only when
          <small>All must match. Paths start at headers., body. or query.; [] matches any array item.</small>
        </div>
        {value.filters.map((f, i) => (
          <FilterRow
            key={i}
            f={f}
            onChange={(nf) => set({ filters: setFilter(value.filters, i, nf) })}
            onRemove={() => set({ filters: value.filters.filter((_, j) => j !== i) })}
          />
        ))}
        {value.filters.length < MAX_FILTERS && (
          <button className="link hook-add" onClick={() => set({ filters: [...value.filters, { path: 'body.action', op: 'equals', value: '' }] })}>
            <IconPlus size={12} /> Add filter
          </button>
        )}
      </div>

      <div className="hook-section">
        <label className="auto-check">
          <input
            type="checkbox"
            checked={!!sig}
            onChange={(e) => set({ signature: e.target.checked ? SIG_PRESETS[0].sig : undefined })}
          />
          <span>
            Check an HMAC signature
            <small>Rejects requests whose body was not signed with your secret. Without it, the URL token alone authenticates.</small>
          </span>
        </label>
        {sig && (
          <div className="hook-sig">
            <div className="hook-presets">
              {SIG_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className={`chip ${sig.header === p.sig.header && sig.prefix === p.sig.prefix ? 'on' : ''}`}
                  onClick={() => set({ signature: p.sig })}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="hook-grid">
              <label className="auto-field">
                <span>Header</span>
                <input className="mono" value={sig.header} spellCheck={false} onChange={(e) => set({ signature: { ...sig, header: e.target.value } })} />
              </label>
              <label className="auto-field">
                <span>Prefix</span>
                <input className="mono" value={sig.prefix} placeholder="none" spellCheck={false} onChange={(e) => set({ signature: { ...sig, prefix: e.target.value } })} />
              </label>
              <label className="auto-field">
                <span>Algorithm</span>
                <select value={sig.algorithm ?? 'sha256'} onChange={(e) => set({ signature: { ...sig, algorithm: e.target.value as WebhookSignature['algorithm'] } })}>
                  <option value="sha256">HMAC-SHA256</option>
                  <option value="sha1">HMAC-SHA1</option>
                  <option value="sha512">HMAC-SHA512</option>
                </select>
              </label>
              <label className="auto-field">
                <span>Encoding</span>
                <select value={sig.encoding} onChange={(e) => set({ signature: { ...sig, encoding: e.target.value as WebhookSignature['encoding'] } })}>
                  <option value="hex">hex</option>
                  <option value="base64">base64</option>
                </select>
              </label>
              <label className="auto-field wide">
                <span>Secret</span>
                <input
                  type="password"
                  value={secret}
                  autoComplete="off"
                  placeholder={view?.webhook?.hasSecret ? 'Stored in the keychain · type to replace' : 'The secret you gave the sender'}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="hook-section">
        <div className="hook-label">
          Duplicates and bursts
          <small>Templates over the request, e.g. {'{{headers.x-github-delivery}}'}. Leave empty to run every request.</small>
        </div>
        <div className="hook-grid">
          <label className="auto-field wide">
            <span>Replay key</span>
            <input
              className="mono"
              value={dedupe.replayKey ?? ''}
              placeholder="{{headers.x-github-delivery}}"
              spellCheck={false}
              title="A request whose key was seen before (7 days) is dropped"
              onChange={(e) => setDedupe({ replayKey: e.target.value })}
            />
          </label>
          <label className="auto-field wide">
            <span>Coalesce key</span>
            <div className="hook-coalesce">
              <input
                className="mono"
                value={dedupe.coalesceKey ?? ''}
                placeholder="{{body.pull_request.number}}"
                spellCheck={false}
                title="The first request runs at once; more with the same key inside the window share one follow-up run"
                onChange={(e) => setDedupe({ coalesceKey: e.target.value })}
              />
              <span className="auto-sched-label">within</span>
              <input
                type="number"
                min={10}
                max={3600}
                value={dedupe.coalesceWindowSeconds ?? DEFAULT_COALESCE_S}
                disabled={!dedupe.coalesceKey?.trim()}
                onChange={(e) => setDedupe({ coalesceWindowSeconds: Number(e.target.value) || DEFAULT_COALESCE_S })}
              />
              <span className="auto-sched-label">s</span>
            </div>
          </label>
        </div>
        <div className="auto-sched-row">
          <span className="auto-sched-label">Skip requests held offline longer than</span>
          <input
            type="number"
            min={1}
            max={1440}
            placeholder="—"
            value={value.maxDeliveryAgeMinutes ?? ''}
            onChange={(e) => set({ maxDeliveryAgeMinutes: e.target.value ? Number(e.target.value) : undefined })}
          />
          <span className="auto-sched-label">minutes (empty: run all)</span>
        </div>
      </div>
    </div>
  )
}

const THREAD_OPTIONS: { kind: AutomationThread['kind']; title: string; body: string }[] = [
  { kind: 'origin', title: 'In a chat', body: 'Each run continues a chat you pick, like a message you sent.' },
  { kind: 'dedicated', title: 'In its own chat', body: 'One chat collects every run. The first run creates it.' },
  { kind: 'new', title: 'New chat each run', body: 'Every run starts clean in a chat of its own.' }
]

// ---- editor -----------------------------------------------------------------

function Editor({
  initial,
  isNew,
  view,
  providers,
  chats,
  onSave,
  onCancel,
  onDelete,
  onOpen,
  onRunNow,
  relay
}: {
  initial: Automation
  isNew: boolean
  view?: AutomationView
  providers: ProviderStatus[]
  chats: ChatRef[]
  relay: WebhookRelayStatus | null
  onSave: (a: Automation) => Promise<void>
  onCancel: () => void
  onDelete: () => void
  onOpen: (convId: string) => void
  onRunNow: () => void
}) {
  const [a, setA] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sigSecret, setSigSecret] = useState('')
  const set = (p: Partial<Automation>) => setA((x) => ({ ...x, ...p }))
  const hook = a.schedule.kind === 'webhook' ? a.schedule : null
  const models = providers.find((p) => p.id === a.provider)?.models ?? []
  const origin = a.thread.kind === 'origin' ? a.thread : null
  const originChat = origin ? chats.find((c) => c.id === origin.convId) : undefined
  const ownChatId = a.thread.kind === 'dedicated' ? a.thread.convId : undefined

  const pickThread = (kind: AutomationThread['kind']) => {
    if (kind === a.thread.kind) return
    if (kind === 'origin') {
      const prior = initial.thread.kind === 'origin' ? initial.thread.convId : chats[0]?.id
      set({ thread: { kind: 'origin', convId: prior ?? '' } })
    } else if (kind === 'dedicated') set({ thread: initial.thread.kind === 'dedicated' ? initial.thread : { kind: 'dedicated' } })
    else set({ thread: { kind: 'new' } })
  }

  const insertToken = (t: string) => set({ prompt: a.prompt + (a.prompt && !/\s$/.test(a.prompt) ? ' ' : '') + t })

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      let schedule = a.schedule
      if (schedule.kind === 'webhook') {
        // Drop half-typed rows the user left empty; the rest is validated in main.
        const filters = schedule.filters
          .filter((f) => f.path.trim())
          .map((f) => (f.op === 'in' ? { ...f, value: f.value.filter(Boolean) } : f))
        schedule = { ...schedule, filters }
        // Before the save, so the automation never exists without the secret its signature check needs.
        if (schedule.signature && sigSecret.trim()) await api.automations.setSignatureSecret(a.id, sigSecret.trim())
        else if (schedule.signature && !view?.webhook?.hasSecret) throw new Error('Enter the signature secret, or turn the signature check off')
      }
      await onSave({ ...a, schedule, model: a.provider === 'ollama' ? (a.model ?? models[0]) : a.model })
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setSaving(false)
    }
  }

  const valid =
    a.name.trim() &&
    a.prompt.trim() &&
    (a.thread.kind !== 'origin' || a.thread.convId) &&
    (a.schedule.kind !== 'daily' || a.schedule.days.length) &&
    (a.schedule.kind !== 'webhook' || !a.schedule.signature || a.schedule.signature.header.trim())
  const history = view?.history ?? []

  return (
    <div className="auto-editor">
      <div className="auto-editor-main">
        <input
          className="auto-name"
          value={a.name}
          placeholder="Name"
          aria-label="Name"
          autoFocus={isNew}
          onChange={(e) => set({ name: e.target.value })}
        />

        <section className="auto-card">
          <div className="auto-card-head">
            <span>Prompt</span>
            <span className="auto-tokens">
              {(hook ? [...TOKENS, PAYLOAD_TOKEN] : TOKENS).map((t) => (
                <button key={t} className="chip" onClick={() => insertToken(t)} title="Filled with fresh data before each run">
                  {t}
                </button>
              ))}
            </span>
          </div>
          <textarea
            className="auto-prompt"
            rows={7}
            value={a.prompt}
            placeholder="What should Jarvis do each run? E.g. “Check my open PRs and tell me which need attention.”"
            onChange={(e) => set({ prompt: e.target.value })}
          />
          {hook && (
            <p className="auto-note">
              Each run gets the request as a fenced data block marked untrusted, at <code>{PAYLOAD_TOKEN}</code> or after your prompt. The agent is told
              never to follow instructions inside it.
            </p>
          )}
        </section>

        <section className="auto-card">
          <div className="auto-card-head">
            <span>When</span>
          </div>
          <ScheduleEditor
            value={a.schedule}
            onChange={(schedule) => set({ schedule })}
            webhook={{
              isNew,
              view,
              relay,
              secret: sigSecret,
              setSecret: setSigSecret,
              onRegenerate: () => api.automations.regenerateToken(a.id)
            }}
          />
        </section>

        <section className="auto-card">
          <div className="auto-card-head">
            <span>Where runs go</span>
          </div>
          <div className="auto-threads" role="radiogroup">
            {THREAD_OPTIONS.map((o) => (
              <button
                key={o.kind}
                role="radio"
                aria-checked={a.thread.kind === o.kind}
                className={`auto-thread ${a.thread.kind === o.kind ? 'on' : ''}`}
                onClick={() => pickThread(o.kind)}
              >
                <span className="auto-thread-icon">
                  <ThreadIcon thread={{ kind: o.kind } as AutomationThread} size={15} />
                </span>
                <span className="auto-thread-title">{o.title}</span>
                <span className="auto-thread-body">{o.body}</span>
              </button>
            ))}
          </div>
          {origin && (
            <label className="auto-field">
              <span>Chat</span>
              <select value={origin.convId} onChange={(e) => set({ thread: { kind: 'origin', convId: e.target.value } })}>
                {!originChat && <option value={origin.convId}>{origin.convId ? 'Deleted chat' : 'Pick a chat…'}</option>}
                {chats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title.slice(0, 70)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {ownChatId && (
            <div className="auto-field">
              <span>Chat</span>
              <button className="link" onClick={() => onOpen(ownChatId)}>
                {chats.find((c) => c.id === ownChatId)?.title ?? 'Open its chat'} →
              </button>
            </div>
          )}
          {a.thread.kind !== 'new' && (
            <label className="auto-check">
              <input type="checkbox" checked={!!a.freshSession} onChange={(e) => set({ freshSession: e.target.checked })} />
              <span>
                Fresh session each run
                <small>The chat keeps every run, but the agent starts without the earlier conversation.</small>
              </span>
            </label>
          )}
        </section>

        <section className="auto-card">
          <div className="auto-card-head">
            <span>Agent</span>
          </div>
          {origin ? (
            <p className="auto-note">
              Runs use the chat’s engine and workspace
              {originChat ? (
                <>
                  {' '}
                  ({PROVIDER_LABEL[originChat.provider]}
                  {originChat.model ? ` ${originChat.model}` : ''} in <code>{originChat.cwd.split('/').pop()}</code>)
                </>
              ) : null}
              .
            </p>
          ) : (
            <div className="auto-grid">
              <label className="auto-field">
                <span>Engine</span>
                <select value={a.provider} onChange={(e) => set({ provider: e.target.value as ProviderId, model: undefined })}>
                  {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => (
                    <option key={id} value={id} disabled={!providers.find((p) => p.id === id)?.available}>
                      {PROVIDER_LABEL[id]}
                    </option>
                  ))}
                </select>
              </label>
              {models.length > 0 && (
                <label className="auto-field">
                  <span>Model</span>
                  <select value={a.model ?? models[0]} onChange={(e) => set({ model: e.target.value })}>
                    {models.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="auto-field wide">
                <span>Workspace</span>
                <div className="auto-folder">
                  <input value={a.cwd} onChange={(e) => set({ cwd: e.target.value })} spellCheck={false} />
                  <button
                    className="ghost small"
                    onClick={async () => {
                      const dir = await api.pickFolder()
                      if (dir) set({ cwd: dir })
                    }}
                  >
                    <IconFolder size={13} /> Choose…
                  </button>
                </div>
              </div>
            </div>
          )}
          {a.provider !== 'ollama' || origin ? (
            <label className="auto-field">
              <span>Access</span>
              <select
                value={a.autonomy}
                className={a.autonomy === 'full' ? 'danger' : ''}
                onChange={(e) => set({ autonomy: e.target.value as RunRequest['autonomy'] })}
              >
                {(Object.keys(ACCESS_LABEL) as RunRequest['autonomy'][]).map((k) => (
                  <option key={k} value={k}>
                    {ACCESS_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {hook && a.autonomy !== 'ask' && (
            <p className="auto-note warn-inline">
              Anyone who can reach the webhook URL can start this run with text of their choosing. Prefer Read-only unless you sign requests and trust the
              sender.
            </p>
          )}
          <p className="auto-note">
            {a.autonomy === 'ask'
              ? 'Runs unattended: the agent can read and look things up; anything needing approval is declined.'
              : a.autonomy === 'edit'
                ? 'Runs unattended: the agent may edit files in the workspace; shell commands and other actions that need approval are declined.'
                : 'Runs unattended with full access: no sandbox and no approvals. Only for prompts you trust completely.'}
          </p>
        </section>

        <section className="auto-card">
          <div className="auto-card-head">
            <span>When it finishes</span>
          </div>
          <div className="auto-flags">
            <label className="auto-check">
              <input type="checkbox" checked={a.notify} onChange={(e) => set({ notify: e.target.checked })} />
              <span>Notify me</span>
            </label>
            <label className="auto-check">
              <input type="checkbox" checked={a.speak} onChange={(e) => set({ speak: e.target.checked })} />
              <span>Read it aloud</span>
            </label>
          </div>
        </section>

        {error && <div className="auto-error">{error}</div>}

        <div className="auto-actions">
          {!isNew &&
            (confirmDelete ? (
              <span className="auto-confirm">
                Delete “{a.name}”?
                <button className="ghost small danger-hover" onClick={onDelete}>
                  Delete
                </button>
                <button className="link" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className="ghost danger-hover" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            ))}
          <span style={{ flex: 1 }} />
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={!valid || saving} onClick={() => void save()}>
            {isNew ? 'Create automation' : 'Save'}
          </button>
        </div>
      </div>

      {!isNew && view && (
        <aside className="auto-side">
          <div className="auto-side-block">
            <div className="auto-side-label">Status</div>
            <div className="auto-side-status">
              <span className={`auto-dot ${statusOf(view)}`} />
              {view.running ? 'Running now' : view.waiting ? 'Waiting for its chat' : view.enabled ? 'Active' : 'Paused'}
            </div>
            {view.nextRunAt && view.enabled && <div className="auto-side-meta">Next run {inTime(view.nextRunAt)}</div>}
            {view.webhook && view.enabled && (
              <div className="auto-side-meta">
                {view.webhook.pending ? `${view.webhook.pending} request${view.webhook.pending > 1 ? 's' : ''} waiting to run` : 'Runs when a request arrives'}
              </div>
            )}
            <button className="ghost small auto-run" disabled={view.running || view.waiting} onClick={onRunNow}>
              <IconPlay size={12} /> Run now
            </button>
          </div>
          <div className="auto-side-block">
            <div className="auto-side-label">Recent runs</div>
            {history.length === 0 ? (
              <div className="auto-side-meta">No runs yet.</div>
            ) : (
              <ul className="auto-history">
                {history.slice(0, 12).map((r, i) => (
                  <HistoryRow key={`${r.at}-${i}`} run={r} onOpen={onOpen} />
                ))}
              </ul>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}

function HistoryRow({ run, onOpen }: { run: AutomationRun; onOpen: (convId: string) => void }) {
  return (
    <li className={`auto-hist ${run.status}`} title={run.detail}>
      <span className={`auto-dot ${run.status === 'ok' ? 'ok' : run.status === 'failed' ? 'err' : 'idle'}`} />
      <span className="auto-hist-main">
        <span className="auto-hist-when">{timeAgo(run.at)}</span>
        <span className="auto-hist-meta">
          {run.status === 'failed' ? 'failed' : run.status === 'skipped' ? 'skipped' : duration(run.durationMs)}
          {run.trigger === 'manual' ? ' · manual' : run.trigger === 'webhook' ? ' · webhook' : ''}
        </span>
        {run.detail && run.status !== 'ok' && <span className="auto-hist-detail">{run.detail}</span>}
      </span>
      {run.convId && (
        <button className="link" onClick={() => onOpen(run.convId!)}>
          Open
        </button>
      )}
    </li>
  )
}

function statusOf(a: AutomationView): 'running' | 'err' | 'ok' | 'idle' {
  if (a.running || a.waiting) return 'running'
  if (!a.enabled) return 'idle'
  if (a.lastError) return 'err'
  return 'ok'
}

// ---- page -------------------------------------------------------------------

export function AutomationsPanel({
  settings,
  providers,
  chats,
  intent,
  onIntentDone,
  onClose,
  onOpen
}: {
  settings: Settings
  providers: ProviderStatus[]
  chats: ChatRef[]
  intent: AutomationIntent | null
  onIntentDone: () => void
  onClose: () => void
  onOpen: (convId: string) => void
}) {
  const [list, setList] = useState<AutomationView[] | null>(null)
  const [editing, setEditing] = useState<{ automation: Automation; isNew: boolean } | null>(null)
  const [picking, setPicking] = useState<ChatRef | undefined | false>(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [relay, setRelay] = useState<WebhookRelayStatus | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    void api.webhooks.status().then(setRelay)
    return api.webhooks.onStatus(setRelay)
  }, [])

  const load = useCallback(() => void api.automations.list().then(setList), [])
  useEffect(() => {
    load()
    const off = api.automations.onChanged(load)
    const t = setInterval(() => {
      load()
      tick((n) => n + 1)
    }, 20_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [load])

  // Opened from a chat ("Automate") or a chip on a chat that has automations.
  useEffect(() => {
    if (!intent || !list) return
    if (intent.kind === 'new') {
      setEditing(null)
      setPicking(intent.chat)
    } else {
      const a = list.find((x) => x.id === intent.id)
      if (a) setEditing({ automation: a, isNew: false })
    }
    onIntentDone()
  }, [intent, list, onIntentDone])

  const startFrom = (t: (typeof TEMPLATES)[number], chat?: ChatRef) => {
    setPicking(false)
    setEditing({ automation: { id: uid(), ...t.build(base(settings, chat)) }, isNew: true })
  }

  const save = async (a: Automation) => {
    await api.automations.save(a)
    setEditing(null)
    load()
  }

  const toggle = async (a: AutomationView) => {
    setList((l) => l?.map((x) => (x.id === a.id ? { ...x, enabled: !a.enabled } : x)) ?? l)
    const { running: _r, waiting: _w, nextRunAt: _n, threadTitle: _t, webhook: _h, ...stored } = a
    await api.automations.save({ ...stored, enabled: !a.enabled })
  }

  const runNow = (id: string) => {
    void api.automations.runNow(id)
    setList((l) => l?.map((x) => (x.id === id ? { ...x, running: true } : x)) ?? l)
  }

  const shown = useMemo(
    () =>
      (list ?? [])
        .filter((a) => (filter === 'all' ? true : filter === 'active' ? a.enabled : !a.enabled))
        .sort((x, y) => Number(y.enabled) - Number(x.enabled) || (x.nextRunAt ?? Infinity) - (y.nextRunAt ?? Infinity)),
    [list, filter]
  )
  const active = (list ?? []).filter((a) => a.enabled)
  const soonest = active.filter((a) => a.nextRunAt).sort((x, y) => x.nextRunAt! - y.nextRunAt!)[0]
  const editingView = editing && !editing.isNew ? list?.find((x) => x.id === editing.automation.id) : undefined

  return (
    <div className="overlay page">
      <div className="panel automations" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          {editing ? (
            <h2>
              <button className="auto-crumb" onClick={() => setEditing(null)}>
                Automations
              </button>
              <span className="auto-crumb-sep">/</span>
              {editing.isNew ? 'New automation' : editing.automation.name}
            </h2>
          ) : (
            <h2>Automations</h2>
          )}
          {!editing && picking === false && (
            <button className="primary" onClick={() => setPicking(undefined)}>
              <IconPlus size={14} /> New automation
            </button>
          )}
          <button className="icon panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <IconX size={15} />
          </button>
        </div>

        {editing ? (
          <Editor
            key={editing.automation.id}
            initial={editing.automation}
            isNew={editing.isNew}
            view={editingView}
            providers={providers}
            chats={chats}
            onSave={save}
            onCancel={() => setEditing(null)}
            onOpen={onOpen}
            onRunNow={() => runNow(editing.automation.id)}
            relay={relay}
            onDelete={async () => {
              await api.automations.remove(editing.automation.id)
              setEditing(null)
              load()
            }}
          />
        ) : (
          <>
            <p className="panel-sub">
              Prompts Jarvis runs on a schedule or when a webhook fires, even with the window closed: in a chat, in a chat of
              their own, or in a new chat each run. You can also just ask in any chat, e.g. “every weekday at 9, check my PRs”.
            </p>

            {picking !== false && (
              <div className="auto-templates">
                <div className="auto-templates-head">
                  <span>
                    {picking ? (
                      <>
                        New automation for <strong>“{picking.title}”</strong>
                      </>
                    ) : (
                      'Start from'
                    )}
                  </span>
                  <button className="link" onClick={() => setPicking(false)}>
                    Cancel
                  </button>
                </div>
                <div className="auto-template-grid">
                  {TEMPLATES.map((t) => (
                    <button key={t.name} className="auto-template" onClick={() => startFrom(t, picking)}>
                      <span className="auto-template-name">{t.name}</span>
                      <span className="auto-template-blurb">{t.blurb}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {list && list.length > 0 && (
              <div className="auto-toolbar">
                <Segmented
                  value={filter}
                  options={[
                    ['all', `All ${list.length}`],
                    ['active', `Active ${active.length}`],
                    ['paused', `Paused ${list.length - active.length}`]
                  ]}
                  onChange={setFilter}
                />
                {soonest && (
                  <span className="auto-soonest">
                    <IconClock size={13} /> Next: <strong>{soonest.name}</strong> {inTime(soonest.nextRunAt!)}
                  </span>
                )}
              </div>
            )}

            {list === null ? null : list.length === 0 ? (
              <div className="auto-empty">
                <div className="auto-empty-icon">
                  <IconRepeat size={22} />
                </div>
                <div className="auto-empty-title">No automations yet</div>
                <p>
                  Create one here, or ask in a chat: “remind me to review PRs every afternoon”, “each Monday at 9, summarize last
                  week’s commits in a new chat”.
                </p>
                {picking === false && (
                  <button className="primary" onClick={() => setPicking(undefined)}>
                    <IconPlus size={14} /> New automation
                  </button>
                )}
              </div>
            ) : (
              <div className="auto-list">
                {shown.map((a) => {
                  const st = statusOf(a)
                  return (
                    <div key={a.id} className={`auto-row ${a.enabled ? '' : 'off'}`}>
                      <span className={`auto-dot ${st}`} title={a.lastError ?? undefined} />
                      <button className="auto-row-main" onClick={() => setEditing({ automation: a, isNew: false })}>
                        <span className="auto-row-name">
                          {a.name}
                          {a.createdBy === 'agent' && <span className="conv-tag" title="Scheduled by an agent from a chat">from chat</span>}
                        </span>
                        <span className="auto-row-meta">
                          <span className="auto-when">
                            {a.schedule.kind === 'webhook' ? <IconWebhook size={12} /> : <IconClock size={12} />}
                            {describeSchedule(a.schedule)}
                          </span>
                          <span className="auto-where">
                            <ThreadIcon thread={a.thread} size={12} />
                            {threadLabel(a, chats)}
                          </span>
                        </span>
                      </button>
                      <span className="auto-row-state">
                        {a.running ? (
                          <span className="auto-live">Running…</span>
                        ) : a.waiting ? (
                          <span className="auto-live">Waiting for chat…</span>
                        ) : a.lastError && a.enabled ? (
                          <span className="error-inline" title={a.lastError}>
                            Failed {timeAgo(a.lastRunAt)}
                          </span>
                        ) : a.enabled && a.webhook ? (
                          <span className={a.webhook.lastDelivery ? '' : 'auto-muted'} title={a.webhook.lastDelivery?.detail}>
                            {a.webhook.pending
                              ? `${a.webhook.pending} waiting`
                              : a.webhook.lastDelivery
                                ? `Request ${timeAgo(a.webhook.lastDelivery.at)}`
                                : a.webhook.url
                                  ? 'Waiting for requests'
                                  : 'Needs the relay'}
                          </span>
                        ) : a.enabled && a.nextRunAt ? (
                          <span>Next {inTime(a.nextRunAt)}</span>
                        ) : a.enabled ? (
                          <span className="auto-muted">Done</span>
                        ) : (
                          <span className="auto-muted">Paused</span>
                        )}
                        {a.lastConvId && !a.running && (
                          <button className="link" onClick={() => onOpen(a.lastConvId!)}>
                            Last run {timeAgo(a.lastRunAt)}
                          </button>
                        )}
                      </span>
                      <button
                        className="icon auto-runnow"
                        disabled={a.running || a.waiting}
                        title="Run now"
                        aria-label={`Run ${a.name} now`}
                        onClick={() => runNow(a.id)}
                      >
                        <IconPlay size={14} />
                      </button>
                      <label className="switch" title={a.enabled ? 'On' : 'Paused'}>
                        <input type="checkbox" checked={a.enabled} aria-label={`${a.name} on`} onChange={() => void toggle(a)} />
                        <span />
                      </label>
                    </div>
                  )
                })}
                {shown.length === 0 && <div className="mem-empty">Nothing {filter}.</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
