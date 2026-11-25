import { useCallback, useEffect, useState } from 'react'
import type { ProviderId, ProviderStatus, Routine, Settings } from '@shared/types'
import { uid } from '@shared/chat'
import { timeAgo } from './knowledgeUi'

const api = window.jarvis
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' }

type Row = Routine & { running?: boolean }

const TEMPLATES: { name: string; build: (s: Settings) => Omit<Routine, 'id'> }[] = [
  {
    name: 'PR review sweep',
    build: (s) => ({
      name: 'PR review sweep',
      prompt:
        'Here are my open PRs and the PRs waiting for my review:\n{{prs}}\n\nList only what needs action from me right now, most urgent first, one line each with the link. If nothing needs me, say so in one line.',
      schedule: { kind: 'interval', minutes: 120 },
      provider: 'claude',
      model: 'haiku',
      cwd: s.defaultCwd,
      enabled: true,
      notify: true,
      speak: false
    })
  },
  {
    name: 'End-of-day wrap-up',
    build: (s) => ({
      name: 'End-of-day wrap-up',
      prompt:
        "It's the end of my day ({{date}}).\n\nLinear:\n{{linear}}\n\nRepos:\n{{repos}}\n\nPRs:\n{{prs}}\n\nSummarize what's still open, flag uncommitted or unpushed work I should not leave overnight, and suggest the first thing to pick up tomorrow. Max 8 lines.",
      schedule: { kind: 'daily', time: '17:30', days: [1, 2, 3, 4, 5] },
      provider: 'claude',
      cwd: s.defaultCwd,
      enabled: true,
      notify: true,
      speak: false
    })
  },
  {
    name: 'Blank routine',
    build: (s) => ({
      name: 'New routine',
      prompt: '',
      schedule: { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] },
      provider: 'claude',
      cwd: s.defaultCwd,
      enabled: false,
      notify: true,
      speak: false
    })
  }
]

function describe(r: Routine) {
  if (r.schedule.kind === 'interval') {
    const m = r.schedule.minutes
    return m % 60 === 0 ? `every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `every ${m} min`
  }
  const d = r.schedule.days
  const days =
    d.length === 7 ? 'daily' : d.join() === '1,2,3,4,5' ? 'weekdays' : d.join() === '0,6' ? 'weekends' : d.map((i) => DAY_NAMES[i]).join(' ')
  return `${days} at ${r.schedule.time}`
}

const ago = (ts?: number) => (ts ? timeAgo(ts) : 'never run')

function Editor({
  routine,
  providers,
  onSave,
  onCancel,
  onDelete
}: {
  routine: Routine
  providers: ProviderStatus[]
  onSave: (r: Routine) => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [r, setR] = useState(routine)
  const models = providers.find((p) => p.id === r.provider)?.models ?? []
  return (
    <div className="routine-editor">
      <div className="row-pair">
        <label className="row">
          <span>Name</span>
          <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
        </label>
        <label className="row">
          <span>Runs</span>
          <select
            value={r.schedule.kind}
            onChange={(e) =>
              setR({
                ...r,
                schedule:
                  e.target.value === 'daily' ? { kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] } : { kind: 'interval', minutes: 60 }
              })
            }
          >
            <option value="daily">At a time of day</option>
            <option value="interval">Every few hours</option>
          </select>
        </label>
      </div>

      {r.schedule.kind === 'daily' ? (
        <div className="schedule-row">
          <input
            type="time"
            value={r.schedule.time}
            onChange={(e) => r.schedule.kind === 'daily' && setR({ ...r, schedule: { ...r.schedule, time: e.target.value } })}
          />
          <div className="day-chips">
            {DAYS.map((d, i) => {
              const sched = r.schedule as Extract<Routine['schedule'], { kind: 'daily' }>
              const on = sched.days.includes(i)
              return (
                <button
                  key={i}
                  className={on ? 'on' : ''}
                  title={DAY_NAMES[i]}
                  onClick={() =>
                    setR({
                      ...r,
                      schedule: { ...sched, days: on ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort() }
                    })
                  }
                >
                  {d}
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <label className="row">
          <span>Every (minutes)</span>
          <input
            type="number"
            min={5}
            step={5}
            value={r.schedule.minutes}
            onChange={(e) => setR({ ...r, schedule: { kind: 'interval', minutes: Math.max(5, Number(e.target.value) || 60) } })}
          />
        </label>
      )}

      <div className="row-pair">
        <label className="row">
          <span>Engine</span>
          <select value={r.provider} onChange={(e) => setR({ ...r, provider: e.target.value as ProviderId, model: undefined })}>
            {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => (
              <option key={id} value={id} disabled={!providers.find((p) => p.id === id)?.available}>
                {PROVIDER_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        {models.length > 0 && (
          <label className="row">
            <span>Model</span>
            <select value={r.model ?? models[0]} onChange={(e) => setR({ ...r, model: e.target.value })}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <label className="row">
        <span>Workspace</span>
        <input value={r.cwd} onChange={(e) => setR({ ...r, cwd: e.target.value })} />
      </label>

      <label className="row">
        <span>
          Prompt · <code>{'{{linear}}'}</code> <code>{'{{prs}}'}</code> <code>{'{{repos}}'}</code> <code>{'{{date}}'}</code> are
          filled with fresh data
        </span>
        <textarea className="routine-prompt" rows={8} value={r.prompt} onChange={(e) => setR({ ...r, prompt: e.target.value })} />
      </label>

      <div className="routine-flags">
        <label>
          <input type="checkbox" checked={r.notify} onChange={(e) => setR({ ...r, notify: e.target.checked })} /> Notify me
        </label>
        <label>
          <input type="checkbox" checked={r.speak} onChange={(e) => setR({ ...r, speak: e.target.checked })} /> Read it aloud
        </label>
      </div>
      <p className="panel-sub">Routines run read-only and unattended: the agent can read and look things up, but anything that needs approval is declined.</p>

      <div className="panel-actions">
        <button className="ghost danger-text" onClick={onDelete}>
          Delete
        </button>
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={!r.name.trim() || !r.prompt.trim()} onClick={() => onSave(r)}>
          Save
        </button>
      </div>
    </div>
  )
}

export function RoutinesPanel({
  settings,
  providers,
  onClose,
  onOpen
}: {
  settings: Settings
  providers: ProviderStatus[]
  onClose: () => void
  onOpen: (convId: string) => void
}) {
  const [list, setList] = useState<Row[]>([])
  const [editing, setEditing] = useState<Routine | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(() => void api.routines.list().then(setList), [])
  useEffect(() => {
    load()
    const off = api.routines.onChanged(load)
    const t = setInterval(load, 15_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [load])

  const save = async (r: Routine) => {
    await api.routines.save(r)
    setEditing(null)
    load()
  }

  return (
    <div className="overlay page">
      <div className="panel routines" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Routines</h2>
          {!editing && !adding && (
            <button className="primary" onClick={() => setAdding(true)}>
              New routine
            </button>
          )}
        </div>
        <p className="panel-sub">
          Prompts Jarvis runs on a schedule with fresh Linear, GitHub and repo data. Each run becomes a chat you can
          follow up on.
        </p>

        {editing ? (
          <Editor
            routine={editing}
            providers={providers}
            onSave={(r) => void save(r)}
            onCancel={() => setEditing(null)}
            onDelete={async () => {
              await api.routines.remove(editing.id)
              setEditing(null)
              load()
            }}
          />
        ) : (
          <>
            <div className="routine-list">
              {list.map((r) => (
                <div key={r.id} className={`routine-row ${r.enabled ? '' : 'off'}`}>
                  <label className="switch" title={r.enabled ? 'On' : 'Off'}>
                    <input type="checkbox" checked={r.enabled} onChange={(e) => void save({ ...r, enabled: e.target.checked })} />
                    <span />
                  </label>
                  <div className="routine-main" onClick={() => setEditing(r)}>
                    <div className="routine-name">{r.name}</div>
                    <div className="routine-meta">
                      <span className="routine-when">{describe(r)}</span> · {PROVIDER_LABEL[r.provider]}
                      {r.model ? ` ${r.model}` : ''} ·{' '}
                      {r.running ? (
                        <span className="routine-running">running…</span>
                      ) : r.lastError ? (
                        <span className="error-inline" title={r.lastError}>
                          failed {ago(r.lastRunAt)}
                        </span>
                      ) : (
                        ago(r.lastRunAt)
                      )}
                      {r.lastConvId && (
                        <>
                          {' · '}
                          <button
                            className="link"
                            onClick={(e) => {
                              e.stopPropagation()
                              onOpen(r.lastConvId!)
                            }}
                          >
                            Last result
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    className="ghost small"
                    disabled={r.running}
                    onClick={() => {
                      void api.routines.runNow(r.id)
                      setList((l) => l.map((x) => (x.id === r.id ? { ...x, running: true } : x)))
                    }}
                  >
                    Run now
                  </button>
                </div>
              ))}
              {list.length === 0 && <div className="mem-empty">No routines yet.</div>}
            </div>

            {adding ? (
              <div className="template-list">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    className="ghost"
                    onClick={() => {
                      setAdding(false)
                      setEditing({ id: uid(), ...t.build(settings) })
                    }}
                  >
                    {t.name}
                  </button>
                ))}
                <button className="link" onClick={() => setAdding(false)}>
                  cancel
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
