import { useCallback, useEffect, useState } from 'react'
import type { ProviderStatus, Settings, UpdateState, VoiceProgress, VoiceStatus } from '@shared/types'

const api = window.jarvis

type Tab = 'general' | 'memory' | 'voice' | 'tools' | 'shortcuts' | 'app'

const MODELS: { id: string; label: string }[] = [
  { id: 'tiny.en', label: 'tiny.en · 75 MB · fastest, English' },
  { id: 'base', label: 'base · 142 MB · multilingual (default)' },
  { id: 'base.en', label: 'base.en · 142 MB · English' },
  { id: 'small', label: 'small · 466 MB · better accuracy' },
  { id: 'small.en', label: 'small.en · 466 MB · English' },
  { id: 'large-v3-turbo-q5_0', label: 'large-v3-turbo · 547 MB · best' }
]

const LANGS = [
  ['auto', 'Detect automatically'],
  ['en', 'English'],
  ['de', 'German'],
  ['fr', 'French'],
  ['it', 'Italian'],
  ['es', 'Spanish'],
  ['nl', 'Dutch'],
  ['pt', 'Portuguese']
]

// Kokoro v1.0 voices worth hearing (the rest of the set is noticeably weaker).
const NEURAL_VOICES: [string, string][] = [
  ['bm_george', 'George — British, calm (Jarvis)'],
  ['bm_fable', 'Fable — British, warm'],
  ['bm_daniel', 'Daniel — British, crisp'],
  ['bm_lewis', 'Lewis — British, deep'],
  ['bf_emma', 'Emma — British'],
  ['bf_isabella', 'Isabella — British'],
  ['am_michael', 'Michael — American'],
  ['am_fenrir', 'Fenrir — American, deep'],
  ['af_heart', 'Heart — American'],
  ['af_bella', 'Bella — American'],
  ['af_nicole', 'Nicole — American, soft']
]

function VoiceTab({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [progress, setProgress] = useState<Partial<Record<VoiceProgress['task'], VoiceProgress>>>({})

  const refresh = useCallback(() => void api.voice.status(s.voiceModel).then(setStatus), [s.voiceModel])
  useEffect(refresh, [refresh])
  useEffect(
    () =>
      api.voice.onProgress((p) => {
        setProgress((prev) => ({ ...prev, [p.task]: p }))
        if (p.done) refresh()
      }),
    [refresh]
  )

  if (!status) return <div className="wb-dim">Checking voice setup…</div>
  const whisperP = progress.whisper
  const modelP = progress.model
  const installing = whisperP && !whisperP.done && !whisperP.error
  const downloading = modelP && !modelP.done && !modelP.error
  const neuralP = progress.neural
  const neuralBusy = neuralP && !neuralP.done && !neuralP.error
  const neuralReady = status.neural.uv && status.neural.downloaded

  return (
    <>
      <div className="setup-list">
        <div className="setup-row">
          <span className={`health-dot ${status.whisper.found ? 'ok' : 'off'}`} />
          <div className="setup-main">
            <div>Speech recognition (whisper.cpp)</div>
            <small>
              {status.whisper.found
                ? status.whisper.path
                : installing
                  ? `Building… ${whisperP?.step ?? ''}`
                  : 'Not installed. Builds locally from source (needs Xcode tools; cmake via uv or Homebrew).'}
              {whisperP?.error && <span className="error-inline"> {whisperP.error}</span>}
            </small>
          </div>
          {!status.whisper.found && (
            <button className="ghost" disabled={!!installing} onClick={() => void api.voice.installWhisper().catch(() => {})}>
              {installing ? 'Building…' : 'Install'}
            </button>
          )}
        </div>

        <div className="setup-row">
          <span className={`health-dot ${status.model.downloaded ? 'ok' : 'off'}`} />
          <div className="setup-main">
            <div>Model</div>
            <select value={s.voiceModel} onChange={(e) => setS({ ...s, voiceModel: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {downloading && (
              <div className="progress">
                <div style={{ width: `${Math.round((modelP?.progress ?? 0) * 100)}%` }} />
              </div>
            )}
            {modelP?.error && <small className="error-inline">{modelP.error}</small>}
          </div>
          {!status.model.downloaded && (
            <button className="ghost" disabled={!!downloading} onClick={() => void api.voice.downloadModel(s.voiceModel).catch(() => {})}>
              {downloading ? `${Math.round((modelP?.progress ?? 0) * 100)}%` : `Download ${status.model.sizeMb ?? ''} MB`}
            </button>
          )}
        </div>

        <div className="setup-row">
          <span className={`health-dot ${status.micAccess === 'granted' ? 'ok' : 'off'}`} />
          <div className="setup-main">
            <div>Microphone</div>
            <small>
              {status.micAccess === 'granted'
                ? 'Allowed'
                : status.micAccess === 'denied'
                  ? 'Blocked — enable Jarvis in System Settings → Privacy & Security → Microphone'
                  : 'Not asked yet'}
            </small>
          </div>
          {status.micAccess !== 'granted' && status.micAccess !== 'denied' && (
            <button className="ghost" onClick={() => void api.voice.requestMic().then(refresh)}>
              Allow
            </button>
          )}
        </div>

        <div className="setup-row">
          <span className={`health-dot ${neuralReady ? 'ok' : 'off'}`} />
          <div className="setup-main">
            <div>Natural voice (Kokoro, on this Mac)</div>
            <small>
              {!status.neural.uv
                ? 'Needs uv to run: brew install uv'
                : neuralReady
                  ? 'Installed'
                  : neuralBusy
                    ? (neuralP?.step ?? 'Downloading…')
                    : 'Not downloaded. Replies use the macOS voice until then.'}
              {neuralP?.error && <span className="error-inline"> {neuralP.error}</span>}
            </small>
            {neuralBusy && (
              <div className="progress">
                <div style={{ width: `${Math.round((neuralP?.progress ?? 0) * 100)}%` }} />
              </div>
            )}
          </div>
          {status.neural.uv && !neuralReady && (
            <button className="ghost" disabled={!!neuralBusy} onClick={() => void api.voice.downloadNeural().catch(() => {})}>
              {neuralBusy ? `${Math.round((neuralP?.progress ?? 0) * 100)}%` : `Download ${status.neural.sizeMb} MB`}
            </button>
          )}
        </div>
      </div>

      <div className="row-pair">
        <label className="row">
          <span>Spoken language</span>
          <select
            value={s.voiceModel.endsWith('.en') ? 'en' : s.voiceLanguage}
            disabled={s.voiceModel.endsWith('.en')}
            onChange={(e) => setS({ ...s, voiceLanguage: e.target.value })}
          >
            {LANGS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <span>Reply voice</span>
          <select
            value={s.ttsEngine === 'neural' ? `n:${s.neuralVoice}` : 'system'}
            onChange={(e) =>
              setS(
                e.target.value === 'system'
                  ? { ...s, ttsEngine: 'system' }
                  : { ...s, ttsEngine: 'neural', neuralVoice: e.target.value.slice(2) }
              )
            }
          >
            <optgroup label="Natural (Kokoro)">
              {NEURAL_VOICES.map(([id, label]) => (
                <option key={id} value={`n:${id}`}>
                  {label}
                </option>
              ))}
            </optgroup>
            <option value="system">macOS voice</option>
          </select>
        </label>
      </div>

      <div className="row-pair">
        {s.ttsEngine === 'neural' ? (
          <label className="row">
            <span>Speed · {s.ttsSpeed.toFixed(2)}×</span>
            <input
              type="range"
              min={0.8}
              max={1.4}
              step={0.05}
              value={s.ttsSpeed}
              onChange={(e) => setS({ ...s, ttsSpeed: Number(e.target.value) })}
            />
          </label>
        ) : (
          <span />
        )}
        <label className="row">
          <span>{s.ttsEngine === 'neural' ? 'Fallback voice (German etc.)' : 'macOS voice'}</span>
          <select value={s.ttsVoice} onChange={(e) => setS({ ...s, ttsVoice: e.target.value })}>
            <option value="">System default</option>
            {status.voices.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="row check">
        <input type="checkbox" checked={s.speakReplies} onChange={(e) => setS({ ...s, speakReplies: e.target.checked })} />
        <div>
          <div>Answer out loud when I speak</div>
          <small>
            {s.ttsEngine === 'neural' && neuralReady
              ? 'Natural voice, generated on this Mac.'
              : 'Uses macOS speech.'}{' '}
            Code blocks are skipped. Save, then{' '}
            <button className="link" onClick={() => void api.voice.speak("Good afternoon. I'm Jarvis, and I'm listening.")}>
              Test voice
            </button>
          </small>
        </div>
      </label>

      <label className="row check">
        <input type="checkbox" checked={s.wakeWord} onChange={(e) => setS({ ...s, wakeWord: e.target.checked })} />
        <div>
          <div>Listen for “Jarvis”</div>
          <small>
            Keeps the microphone open so you can say “Jarvis, …” anytime. Speech is cut into short clips and
            transcribed on this Mac only; nothing is recorded or sent anywhere. macOS shows the mic indicator while
            it's on. Say “Jarvis, live mode” to start a live conversation.
          </small>
        </div>
      </label>

      <label className="row check">
        <input type="checkbox" checked={s.liveBargeIn} onChange={(e) => setS({ ...s, liveBargeIn: e.target.checked })} />
        <div>
          <div>Live mode: interrupt by talking</div>
          <small>
            Talking over Jarvis stops its answer and cancels the run. Use headphones — through speakers Jarvis hears
            itself. When off, press Esc or Interrupt instead; the mic is ignored while Jarvis speaks.
          </small>
        </div>
      </label>
    </>
  )
}

function ToolsTab({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  return (
    <>
      <label className="row check">
        <input type="checkbox" checked={s.browserTool} onChange={(e) => setS({ ...s, browserTool: e.target.checked })} />
        <div>
          <div>Browser</div>
          <small>
            Agents get Jarvis's own Chrome profile, separate from your everyday browser. Logins you make there stick.
            Clicking and typing ask first in "Edit files" mode.
          </small>
        </div>
      </label>
      {s.browserTool && (
        <label className="row check">
          <input
            type="checkbox"
            checked={s.browserVisible}
            onChange={(e) => setS({ ...s, browserVisible: e.target.checked })}
          />
          <div>
            <div>Show the browser window</div>
            <small>Watch the agent browse (and sign in for it). Off runs headless. Routines always run headless.</small>
          </div>
        </label>
      )}
      <label className="row check">
        <input type="checkbox" checked={s.computerUse} onChange={(e) => setS({ ...s, computerUse: e.target.checked })} />
        <div>
          <div>Computer use</div>
          <small>
            Agents can take screenshots and control mouse and keyboard. Every action asks first unless autonomy is
            "Full access". Needs Screen Recording and Accessibility for Jarvis (System Settings → Privacy &amp; Security).
          </small>
        </div>
      </label>
      <label className="row check">
        <input type="checkbox" checked={s.t3Tools} onChange={(e) => setS({ ...s, t3Tools: e.target.checked })} />
        <div>
          <div>T3 Code</div>
          <small>
            Agents can list, read and start threads in your local T3 Code. Jarvis signs in via the t3 CLI as "Jarvis"
            (revocable in T3); turning this off revokes it.
          </small>
        </div>
      </label>
    </>
  )
}

function AppTab({ s, setS }: { s: Settings; setS: (s: Settings) => void }) {
  const [u, setU] = useState<UpdateState | null>(null)
  useEffect(() => {
    void api.updates.state().then(setU)
    return api.updates.onState(setU)
  }, [])
  const statusText: Record<UpdateState['status'], string> = {
    idle: 'Up to date check pending',
    disabled: 'Updates run in the packaged app only (pnpm dist)',
    checking: 'Checking…',
    available: `Version ${u?.next} is available`,
    downloading: `Downloading ${u?.next ?? ''} · ${Math.round((u?.progress ?? 0) * 100)}%`,
    ready: `Version ${u?.next} is ready — restart to install`,
    none: 'You have the latest version',
    error: `Update check failed: ${u?.error ?? ''}`
  }
  return (
    <>
      <label className="row check">
        <input type="checkbox" checked={s.menuBarOnly} onChange={(e) => setS({ ...s, menuBarOnly: e.target.checked })} />
        <div>
          <div>Menu bar only</div>
          <small>Hide the Dock icon. Jarvis stays in the menu bar; the hotkeys and the menu open everything.</small>
        </div>
      </label>
      <label className="row check">
        <input type="checkbox" checked={s.autoUpdate} onChange={(e) => setS({ ...s, autoUpdate: e.target.checked })} />
        <div>
          <div>Install updates automatically</div>
          <small>Downloads new releases in the background and installs them when you quit.</small>
        </div>
      </label>
      {u && (
        <div className="setup-row">
          <span className={`health-dot ${u.status === 'error' ? 'off' : 'ok'}`} />
          <div className="setup-main">
            <div>Jarvis {u.version}</div>
            <small>{statusText[u.status]}</small>
          </div>
          {u.packaged &&
            (u.status === 'ready' || u.status === 'available' ? (
              <button className="primary" onClick={() => void api.updates.install()}>
                {u.status === 'ready' ? 'Restart' : 'Download'}
              </button>
            ) : (
              <button className="ghost" disabled={u.status === 'checking'} onClick={() => void api.updates.check()}>
                Check now
              </button>
            ))}
        </div>
      )}
    </>
  )
}

export function SettingsPanel({
  settings,
  providers,
  onSave,
  onClose
}: {
  settings: Settings
  providers: ProviderStatus[]
  onSave: (s: Settings) => Promise<Record<string, string>>
  onClose: () => void
}) {
  const [s, setS] = useState(settings)
  const [tab, setTab] = useState<Tab>('general')
  const [hotkeyErrors, setHotkeyErrors] = useState<Record<string, string>>({})
  const claude = providers.find((p) => p.id === 'claude')

  useEffect(() => {
    void api.hotkeyErrors().then(setHotkeyErrors)
  }, [])

  const save = async () => {
    const errors = await onSave(s)
    setHotkeyErrors(errors)
    if (Object.keys(errors).length) setTab('shortcuts')
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel settings" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2>Settings</h2>
          <div className="tabs">
            {(['general', 'memory', 'voice', 'tools', 'shortcuts', 'app'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-body">
          {tab === 'general' && (
            <>
              <label className="row check">
                <input
                  type="checkbox"
                  checked={s.preferSubscription}
                  onChange={(e) => setS({ ...s, preferSubscription: e.target.checked })}
                />
                <div>
                  <div>Use my Claude subscription</div>
                  <small>
                    Hides <code>ANTHROPIC_API_KEY</code> from Claude Code so it uses your Pro/Max login instead of
                    per-token API billing.
                    {claude?.detail && <strong> {claude.detail}.</strong>}
                  </small>
                </div>
              </label>

              <label className="row">
                <span>Default workspace (quick bar and new chats)</span>
                <input value={s.defaultCwd} onChange={(e) => setS({ ...s, defaultCwd: e.target.value })} />
              </label>

              <label className="row">
                <span>Ollama URL</span>
                <input value={s.ollamaUrl} onChange={(e) => setS({ ...s, ollamaUrl: e.target.value })} />
              </label>

              <label className="row check">
                <input
                  type="checkbox"
                  checked={s.linearAutoMove}
                  onChange={(e) => setS({ ...s, linearAutoMove: e.target.checked })}
                />
                <div>
                  <div>Move Linear tickets automatically</div>
                  <small>In Progress when you start work on a ticket, In Review when you link its PR.</small>
                </div>
              </label>

              {Object.keys(s.linearRepoMap).length > 0 && (
                <div className="row">
                  <span>Linear team → repo</span>
                  {Object.entries(s.linearRepoMap).map(([team, path]) => (
                    <div key={team} className="repo-map">
                      <code>{team}</code>
                      <input
                        value={path}
                        onChange={(e) => setS({ ...s, linearRepoMap: { ...s.linearRepoMap, [team]: e.target.value } })}
                      />
                      <button
                        className="icon del"
                        onClick={() => {
                          const next = { ...s.linearRepoMap }
                          delete next[team]
                          setS({ ...s, linearRepoMap: next })
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="provider-detail">
                {providers.map((p) => (
                  <div key={p.id}>
                    <strong>{p.id}</strong> — {p.available ? (p.version ?? 'online') : 'offline'}
                    {p.detail && <small> · {p.detail}</small>}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'memory' && (
            <>
              <label className="row check">
                <input type="checkbox" checked={s.useMemory} onChange={(e) => setS({ ...s, useMemory: e.target.checked })} />
                <div>
                  <div>Use memory</div>
                  <small>Inject what Jarvis knows about you and relevant knowledge-folder excerpts into every run.</small>
                </div>
              </label>

              <div className="row-pair">
                <label className="row">
                  <span>Learn with</span>
                  <select
                    value={s.learnEngine}
                    onChange={(e) => setS({ ...s, learnEngine: e.target.value as Settings['learnEngine'] })}
                  >
                    <option value="claude">Claude Haiku (subscription)</option>
                    <option value="ollama">Ollama (fully local)</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                {s.learnEngine === 'ollama' && (
                  <label className="row">
                    <span>Learner model</span>
                    <input value={s.learnOllamaModel} onChange={(e) => setS({ ...s, learnOllamaModel: e.target.value })} />
                  </label>
                )}
              </div>

              <div className="row-pair">
                <label className="row">
                  <span>Jev classifier URL</span>
                  <input value={s.jevUrl} onChange={(e) => setS({ ...s, jevUrl: e.target.value })} />
                </label>
                <label className="row">
                  <span>Embedding model (Ollama)</span>
                  <input value={s.embedModel} onChange={(e) => setS({ ...s, embedModel: e.target.value })} />
                </label>
              </div>
            </>
          )}

          {tab === 'voice' && <VoiceTab s={s} setS={setS} />}

          {tab === 'tools' && <ToolsTab s={s} setS={setS} />}

          {tab === 'shortcuts' && (
            <>
              <p className="panel-sub">
                Electron accelerator syntax, e.g. <code>Alt+Space</code>, <code>CommandOrControl+Shift+J</code>.
              </p>
              {(
                [
                  ['quick', 'quickHotkey', 'Quick bar'],
                  ['voice', 'voiceHotkey', 'Talk (quick bar + listen)'],
                  ['live', 'liveHotkey', 'Live conversation (start / end)'],
                  ['main', 'hotkey', 'Main window']
                ] as const
              ).map(([name, key, label]) => (
                <label key={key} className="row">
                  <span>{label}</span>
                  <input value={s[key]} onChange={(e) => setS({ ...s, [key]: e.target.value })} />
                  {hotkeyErrors[name] && <small className="error-inline">{hotkeyErrors[name]}</small>}
                </label>
              ))}
            </>
          )}

          {tab === 'app' && <AppTab s={s} setS={setS} />}
        </div>

        <div className="panel-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
