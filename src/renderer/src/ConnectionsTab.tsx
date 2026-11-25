import { useCallback, useEffect, useState } from 'react'
import type { ConnectionAuditEntry, ConnectionPolicy, ConnectionProbe, ConnectionStatus } from '@shared/types'
import { timeAgo } from './knowledgeUi'

const api = window.jarvis

const POLICIES: [ConnectionPolicy, string][] = [
  ['read', 'Read only'],
  ['ask', 'Ask before changes'],
  ['auto', 'Act on its own']
]

const KIND_LABEL: Record<ConnectionStatus['kind'], string> = {
  oauth: 'OAuth',
  token: 'API key',
  open: 'no auth',
  browser: 'browser login'
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ago = (ts?: number) => (ts ? timeAgo(ts) : '')

function ConnectionRow({ c, onError }: { c: ConnectionStatus; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      onError(`${c.name}: ${errText(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const dot = c.state === 'connected' ? 'ok' : c.state === 'needs-auth' ? 'warn' : 'off'
  const writes = c.tools?.filter((t) => !t.readOnly).length ?? 0

  return (
    <div className="setup-row conn-row">
      <span className={`health-dot ${dot}`} />
      <div className="setup-main">
        <div className="conn-title">
          <strong>{c.name}</strong>
          <span className="conn-kind">{KIND_LABEL[c.kind]}</span>
        </div>
        <small title={c.issuer && c.kind === 'oauth' ? `Revoke anytime at ${new URL(c.issuer).host} (client "Jarvis"), or remove it here.` : undefined}>
          {c.url}
          {c.account && <> · as {c.account}</>}
          {c.lastUsedAt && <> · used {ago(c.lastUsedAt)}</>}
        </small>
        {c.state !== 'connected' && c.detail && (
          <div className="conn-status">
            <small className={c.state === 'needs-auth' ? 'warn-inline' : 'error-inline'}>{c.detail}</small>
            {c.state === 'needs-auth' && c.kind === 'oauth' && (
              <button className="ghost attention small-btn" disabled={!!busy} onClick={() => void run('reconnect', () => api.connections.reconnect(c.id))}>
                {busy === 'reconnect' ? 'Waiting for sign-in…' : 'Reconnect'}
              </button>
            )}
          </div>
        )}
        {c.tools && (
          <details className="conn-tools">
            <summary>
              {c.tools.length} {c.tools.length === 1 ? 'tool' : 'tools'} · {c.tools.length - writes} read-only, {writes} can change things
            </summary>
            <div>
              {c.kind !== 'browser' && <code className="conn-id">mcp__{c.id}</code>}
              {c.tools.map((t) => (
                <code key={t.name} className={t.readOnly ? '' : 'conn-write'}>
                  {t.name}
                </code>
              ))}
            </div>
          </details>
        )}

        {keyInput !== null && (
          <div className="conn-inline">
            <input
              type="password"
              autoFocus
              placeholder="New API key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && keyInput.trim())
                  void run('key', () => api.connections.reconnect(c.id, keyInput)).then(() => setKeyInput(null))
              }}
            />
            <button
              className="primary"
              disabled={!keyInput.trim() || !!busy}
              onClick={() => void run('key', () => api.connections.reconnect(c.id, keyInput)).then(() => setKeyInput(null))}
            >
              Save
            </button>
            <button className="ghost" onClick={() => setKeyInput(null)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="conn-actions">
        {c.kind !== 'browser' && (
          <select
            value={c.policy}
            title="What agents may do with this connection"
            onChange={(e) => void run('policy', () => api.connections.update(c.id, { policy: e.target.value as ConnectionPolicy }))}
          >
            {POLICIES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        {c.kind === 'oauth' && c.state !== 'needs-auth' && (
          <button className="ghost" disabled={!!busy} onClick={() => void run('reconnect', () => api.connections.reconnect(c.id))}>
            {busy === 'reconnect' ? 'Waiting for sign-in…' : 'Reconnect'}
          </button>
        )}
        {c.kind === 'token' && keyInput === null && (
          <button className={c.state === 'needs-auth' ? 'ghost attention' : 'ghost'} onClick={() => setKeyInput('')}>
            Replace key
          </button>
        )}
        {c.kind === 'browser' && (
          <button className="ghost" disabled={!!busy} onClick={() => void run('open', () => api.connections.openBrowser(c.id))}>
            Open to log in
          </button>
        )}
        {confirmRemove ? (
          <>
            <button className="danger" disabled={!!busy} onClick={() => void run('remove', () => api.connections.remove(c.id))}>
              Remove {c.name}
            </button>
            <button className="ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="text-btn danger-hover" onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

function AddConnection({ onError, onDone }: { onError: (msg: string) => void; onDone: () => void }) {
  const [mode, setMode] = useState<'mcp' | 'browser'>('mcp')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [probe, setProbe] = useState<ConnectionProbe | null>(null)
  const [token, setToken] = useState('')
  const [header, setHeader] = useState('')
  const [policy, setPolicy] = useState<ConnectionPolicy>('ask')
  const [busy, setBusy] = useState<'probe' | 'connect' | null>(null)

  const reset = () => {
    setUrl('')
    setName('')
    setProbe(null)
    setToken('')
    setHeader('')
    setPolicy('ask')
  }

  const check = async () => {
    setBusy('probe')
    setProbe(null)
    try {
      const p = await api.connections.probe(url)
      setProbe(p)
      if (!name && p.name) setName(p.name)
    } catch (err) {
      onError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  const connect = async () => {
    setBusy('connect')
    try {
      if (mode === 'browser') {
        const c = await api.connections.add({ url, name: name || undefined, kind: 'browser' })
        await api.connections.openBrowser(c.id)
      } else {
        await api.connections.add({
          url,
          name: name || undefined,
          kind: probe?.kind,
          policy,
          token: probe?.kind === 'token' ? token : undefined,
          header: probe?.kind === 'token' && header.trim() ? header.trim() : undefined
        })
      }
      reset()
      onDone()
    } catch (err) {
      onError(errText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="conn-add">
      <div className="conn-add-head">
        <strong>Add a connection</strong>
        <div className="tabs">
          <button className={mode === 'mcp' ? 'active' : ''} onClick={() => (setMode('mcp'), setProbe(null))}>
            MCP server
          </button>
          <button className={mode === 'browser' ? 'active' : ''} onClick={() => (setMode('browser'), setProbe(null))}>
            Website login
          </button>
        </div>
      </div>
      <small className="conn-help">
        {mode === 'mcp'
          ? 'Paste the MCP endpoint (e.g. https://jobs.example.com/mcp). Jarvis detects OAuth sign-in or asks for a key.'
          : "For sites without an API: opens the site in Jarvis's browser, you log in once, agents' browser tool stays logged in."}
      </small>
      <div className="conn-inline">
        <input
          placeholder={mode === 'mcp' ? 'https://…/mcp' : 'https://…'}
          value={url}
          onChange={(e) => (setUrl(e.target.value), setProbe(null))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && url.trim() && mode === 'mcp') void check()
          }}
        />
        <input className="conn-name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        {mode === 'mcp' && !probe && (
          <button className="ghost" disabled={!url.trim() || !!busy} onClick={() => void check()}>
            {busy === 'probe' ? 'Checking…' : 'Check'}
          </button>
        )}
        {mode === 'browser' && (
          <button className="primary" disabled={!url.trim() || !!busy} onClick={() => void connect()}>
            Open &amp; log in
          </button>
        )}
      </div>

      {mode === 'mcp' && probe && (
        <>
          <small className="conn-help">
            {probe.kind === 'oauth'
              ? `Signs in with OAuth on ${probe.issuer}. Your browser opens; approve "Jarvis" there.`
              : probe.kind === 'token'
                ? 'This server needs an API key or bearer token. It is stored encrypted in the keychain.'
                : 'This server needs no sign-in.'}
          </small>
          {probe.kind === 'token' && (
            <div className="conn-inline">
              <input type="password" placeholder="API key or token" value={token} onChange={(e) => setToken(e.target.value)} />
              <input className="conn-name" placeholder="Header (default Authorization)" value={header} onChange={(e) => setHeader(e.target.value)} />
            </div>
          )}
          <div className="conn-inline">
            <select value={policy} onChange={(e) => setPolicy(e.target.value as ConnectionPolicy)}>
              {POLICIES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!!busy || (probe.kind === 'token' && !token.trim())}
              onClick={() => void connect()}
            >
              {busy === 'connect' ? (probe.kind === 'oauth' ? 'Waiting for sign-in…' : 'Connecting…') : probe.kind === 'oauth' ? 'Sign in & connect' : 'Connect'}
            </button>
            <button className="ghost" onClick={() => setProbe(null)}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function ConnectionsTab() {
  const [list, setList] = useState<ConnectionStatus[] | null>(null)
  const [audit, setAudit] = useState<ConnectionAuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void api.connections.list().then(setList, (err) => setError(errText(err)))
    void api.connections.audit(20).then(setAudit, () => {})
  }, [])
  useEffect(() => {
    refresh()
    return api.connections.onChanged(refresh)
  }, [refresh])

  const names = new Map(list?.map((c) => [c.id, c.name]) ?? [])

  return (
    <>
      <p className="panel-sub">
        Services agents can use on your behalf. Keys stay in the macOS keychain; agents get tools, never credentials.
      </p>
      {error && (
        <div className="conn-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {list === null ? (
        <div className="wb-dim">Checking connections…</div>
      ) : (
        list.length > 0 && (
          <div className="setup-list">
            {list.map((c) => (
              <ConnectionRow key={c.id} c={c} onError={setError} />
            ))}
          </div>
        )
      )}
      <AddConnection onError={setError} onDone={refresh} />
      {audit.length > 0 && (
        <details className="conn-audit">
          <summary>Recent agent activity</summary>
          {audit.map((a, i) => (
            <div key={i} className={`conn-audit-row ${a.outcome}`}>
              <span>{new Date(a.at).toLocaleString()}</span>
              <code>
                {names.get(a.connection) ?? a.connection}.{a.tool}
              </code>
              <span>{a.outcome}</span>
              {a.detail && <small>{a.detail}</small>}
            </div>
          ))}
        </details>
      )}
    </>
  )
}
