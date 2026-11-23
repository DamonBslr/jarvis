import { useState } from 'react'
import type { ProviderStatus, Settings } from '@shared/types'

export function SettingsPanel({
  settings,
  providers,
  onSave,
  onClose
}: {
  settings: Settings
  providers: ProviderStatus[]
  onSave: (s: Settings) => void
  onClose: () => void
}) {
  const [s, setS] = useState(settings)
  const claude = providers.find((p) => p.id === 'claude')

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

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
          <span>Default workspace</span>
          <input value={s.defaultCwd} onChange={(e) => setS({ ...s, defaultCwd: e.target.value })} />
        </label>

        <label className="row">
          <span>Ollama URL</span>
          <input value={s.ollamaUrl} onChange={(e) => setS({ ...s, ollamaUrl: e.target.value })} />
        </label>

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

        <label className="row">
          <span>Summon hotkey</span>
          <input value={s.hotkey} onChange={(e) => setS({ ...s, hotkey: e.target.value })} />
        </label>

        <div className="provider-detail">
          {providers.map((p) => (
            <div key={p.id}>
              <strong>{p.id}</strong> — {p.available ? (p.version ?? 'online') : 'offline'}
              {p.detail && <small> · {p.detail}</small>}
            </div>
          ))}
        </div>

        <div className="panel-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => onSave(s)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
