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
