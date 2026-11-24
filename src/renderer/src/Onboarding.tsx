// First-run setup: who you are, what Jarvis may read, which projects matter, then the first learning pass.
import { useEffect, useState } from 'react'
import type { KnowledgeOverview, Settings, SyncProgress } from '@shared/types'
import { FocusPicker, FolderList, SourceList } from './knowledgeUi'

const api = window.jarvis
const STEPS = ['You', 'Access', 'Focus', 'Learn'] as const

export function Onboarding({ settings, onDone }: { settings: Settings; onDone(next: Settings): void }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(settings.userName ?? '')
  const [about, setAbout] = useState('')
  const [focus, setFocus] = useState<string[]>([])
  const [log, setLog] = useState<SyncProgress[]>([])
  const [learning, setLearning] = useState<'idle' | 'running' | 'done'>('idle')
  const [result, setResult] = useState<KnowledgeOverview | null>(null)

  useEffect(() => api.knowledge.onProgress((p) => setLog((l) => (l.at(-1)?.message === p.message ? l : [...l, p]).slice(-12))), [])

  const finish = async (skipped = false) => {
    const current = await api.getSettings()
    const next: Settings = { ...current, onboardedAt: Date.now(), userName: name.trim() || current.userName }
    await api.saveSettings(next)
    if (!skipped) void api.knowledge.markSeen()
    onDone(next)
  }

  const saveProfile = async () => {
    const n = name.trim()
    const a = about.trim()
    if (n) await api.memory.add({ type: 'profile', content: `User's name is ${n}.`, pinned: true })
    if (a) await api.memory.add({ type: 'profile', content: a.endsWith('.') ? `User: ${a}` : `User: ${a}.`, pinned: true })
    const current = await api.getSettings()
    await api.saveSettings({ ...current, userName: n || current.userName })
    setStep(1)
  }

  const learn = async () => {
    setStep(3)
    setLearning('running')
    await api.knowledge.setFocus(focus)
    await api.knowledge.sync()
    setResult(await api.knowledge.overview())
    setLearning('done')
  }

  return (
    <div className="onboard">
      <div className="onboard-top drag">
        <div className="brand">
          <span className="brand-orb" /> Jarvis
        </div>
        <ol className="onboard-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
              {s}
            </li>
          ))}
        </ol>
        <button className="link no-drag" onClick={() => void finish(true)}>
          Skip setup
        </button>
      </div>

      <div className="onboard-body">
        {step === 0 && (
          <section className="onboard-card intro">
            <div className="empty-orb" />
            <h1>Let's make me yours.</h1>
            <p>
              I live on this Mac and learn from the tools you already use: your repos, pull requests, tickets and the threads you run
              with coding agents. You choose what I can read. It stays in a local database on this Mac. The only exception: I send
              summaries of your focus projects to your own Claude subscription to write their briefs.
            </p>
            <label className="field">
              What should I call you?
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </label>
            <label className="field">
              <span>
                What do you work on? <span className="opt">optional</span>
              </span>
              <input
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder="e.g. Indie dev, ships iOS + web apps, runs an agency"
                onKeyDown={(e) => e.key === 'Enter' && void saveProfile()}
              />
            </label>
            <div className="onboard-actions">
              <button className="primary" onClick={() => void saveProfile()}>
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="onboard-card wide">
            <h2>What may I read?</h2>
            <p className="lede">
              Each source is read-only. I never push, comment or change anything while learning. You can turn any of them off later in
              Projects → Sources.
            </p>
            <SourceList />
            <h3>Folders on your Mac</h3>
            <p className="lede small">Notes, docs, specs. I index the text inside and keep it current.</p>
            <FolderList />
            <p className="lede small">
              Notion, Slack, your own apps: connect them in Settings → Connections. Agents can then use them with your access.
            </p>
            <div className="onboard-actions">
              <button className="ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="primary" onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="onboard-card wide">
            <h2>Which projects matter right now?</h2>
            <p className="lede">
              Ranked by your commits and agent sessions over the last 30 days. Pick the few you're actively working on.
            </p>
            <FocusPicker settings={settings} onChange={setFocus} />
            <div className="onboard-actions">
              <button className="ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="primary" disabled={!focus.length} onClick={() => void learn()}>
                Learn these {focus.length || ''} projects
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="onboard-card wide">
            <h2>{learning === 'done' ? 'Ready.' : 'Reading your work…'}</h2>
            {learning !== 'done' && (
              <>
                <p className="lede">
                  First pass reads the last few months. Writing the project briefs takes a minute or two. You can start using Jarvis now:
                  this keeps going in the background.
                </p>
                <div className="learn-log">
                  {log.map((p, i) => (
                    <div key={i} className={`learn-line ${i === log.length - 1 ? 'now' : ''}`}>
                      {p.message}
                    </div>
                  ))}
                </div>
                {log.at(-1)?.progress !== undefined && (
                  <div className="learn-bar">
                    <span style={{ width: `${Math.round((log.at(-1)?.progress ?? 0) * 100)}%` }} />
                  </div>
                )}
              </>
            )}
            {learning === 'done' && result && (
              <>
                <p className="lede">
                  {result.totalItems.toLocaleString()} things across {result.projects.length} projects. Here's what I'd look at first.
                </p>
                <div className="learn-projects">
                  {result.projects.map((d) => (
                    <div key={d.project.id} className="learn-project">
                      <div className="learn-project-name">{d.project.name}</div>
                      <div className="mem-meta">
                        {d.counts.week} updates this week · {d.loops.length} open loop{d.loops.length === 1 ? '' : 's'}
                      </div>
                      {d.loops.slice(0, 2).map((l) => (
                        <div key={l.key} className="learn-loop">
                          {l.title}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="onboard-actions">
              <button className="primary" onClick={() => void finish()}>
                {learning === 'done' ? 'Start' : 'Continue in the background'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
