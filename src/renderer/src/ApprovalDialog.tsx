import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'

function describe(toolName: string, input: any): { title: string; detail?: string } {
  const name = toolName.replace(/^mcp__jarvis__/, 'jarvis.').replace(/^mcp__/, '')
  if (typeof input?.command === 'string') return { title: `${name}: run a command`, detail: input.command }
  if (typeof input?.file_path === 'string') return { title: `${name}: ${input.file_path}` }
  if (typeof input?.url === 'string') return { title: `${name}: ${input.url}` }
  if (name.startsWith('jarvis.linear_')) return { title: `${name} ${input?.id ?? ''}`, detail: input?.state ?? input?.body }
  return { title: name }
}

const CONNECT_KIND: Record<NonNullable<ApprovalRequest['connect']>['kind'], string> = {
  oauth: 'Sign in with OAuth',
  token: 'API key',
  open: 'No sign-in',
  browser: 'Website login'
}

/** The agent asks to connect a service: confirm, and enter a key here when one is needed (never in the chat). */
function ConnectDialog({
  request,
  queued,
  chatTitle,
  onDecide
}: {
  request: ApprovalRequest
  queued: number
  chatTitle?: string
  onDecide: (decision: ApprovalDecision) => void
}) {
  const c = request.connect!
  const reason = typeof (request.input as any)?.reason === 'string' ? (request.input as any).reason : null
  const [secret, setSecret] = useState('')
  const secretRef = useRef(secret)
  secretRef.current = secret
  const ready = !c.secretLabel || secret.trim().length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onDecide({ behavior: 'deny' })
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target as HTMLElement)?.tagName === 'INPUT')) {
        e.preventDefault()
        if (c.secretLabel && !secretRef.current.trim()) return
        onDecide({ behavior: 'allow', ...(c.secretLabel ? { secret: secretRef.current.trim() } : {}) })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDecide, c.secretLabel])

  return (
    <div className="overlay approval-overlay">
      <div className="panel approval connect" role="alertdialog" aria-labelledby="approval-title">
        <div className="approval-kicker">
          Connect a service · {CONNECT_KIND[c.kind]}
          {queued > 0 && <span className="approval-queue">+{queued} waiting</span>}
        </div>
        <h2 id="approval-title">Give Jarvis access to {c.name}?</h2>
        {chatTitle && <div className="approval-chat">{chatTitle}</div>}
        <div className="approval-url">{c.url}</div>
        {reason && <p className="approval-desc">“{reason}”</p>}
        <p className="approval-desc">{c.action}</p>
        {c.secretLabel && (
          <label className="approval-secret">
            {c.secretLabel}
            <input type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Stored encrypted; the agent never sees it" />
          </label>
        )}
        <div className="panel-actions">
          <button className="ghost" onClick={() => onDecide({ behavior: 'deny' })}>
            Not now <kbd>Esc</kbd>
          </button>
          <button
            className="primary"
            autoFocus={!c.secretLabel}
            disabled={!ready}
            onClick={() => onDecide({ behavior: 'allow', ...(c.secretLabel ? { secret: secret.trim() } : {}) })}
          >
            {c.kind === 'oauth' ? 'Sign in' : c.kind === 'browser' ? 'Open browser' : 'Connect'} <kbd className="on-primary">⌘↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

export function ApprovalDialog(props: {
  request: ApprovalRequest
  queued: number
  chatTitle?: string
  onDecide: (decision: ApprovalDecision, always?: boolean) => void
}) {
  return props.request.connect ? <ConnectDialog {...props} /> : <ToolApproval {...props} />
}

function ToolApproval({
  request,
  queued,
  chatTitle,
  onDecide
}: {
  request: ApprovalRequest
  queued: number
  chatTitle?: string
  onDecide: (decision: ApprovalDecision, always?: boolean) => void
}) {
  const { title, detail } = describe(request.toolName, request.input)
  const input = request.input as any
  const description = typeof input?.description === 'string' ? input.description : null
  const short = request.toolName.replace(/^mcp__jarvis__/, '').replace(/^mcp__/, '')
  const [always, setAlways] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation() // don't also cancel the run
        onDecide({ behavior: 'deny' })
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onDecide({ behavior: 'allow' }, always)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDecide, always])

  return (
    <div className="overlay approval-overlay">
      <div className="panel approval" role="alertdialog" aria-labelledby="approval-title">
        <div className="approval-kicker">
          Approval needed
          {queued > 0 && <span className="approval-queue">+{queued} waiting</span>}
        </div>
        <h2 id="approval-title">{title}</h2>
        {chatTitle && <div className="approval-chat">{chatTitle}</div>}
        {description && <p className="approval-desc">{description}</p>}
        {detail && <pre className="approval-cmd">{detail}</pre>}
        <details className="approval-raw">
          <summary>Full input</summary>
          <pre>{JSON.stringify(request.input, null, 2)}</pre>
        </details>
        <div className="panel-actions">
          <label className="approval-always">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            Always allow {short} in this chat
          </label>
          <button className="ghost" onClick={() => onDecide({ behavior: 'deny' })}>
            Deny <kbd>Esc</kbd>
          </button>
          <button className="primary" autoFocus onClick={() => onDecide({ behavior: 'allow' }, always)}>
            Allow <kbd className="on-primary">⌘↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
