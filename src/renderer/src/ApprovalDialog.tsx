import { useEffect } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'

function describe(toolName: string, input: any): { title: string; detail?: string } {
  const name = toolName.replace(/^mcp__jarvis__/, 'jarvis.').replace(/^mcp__/, '')
  if (typeof input?.command === 'string') return { title: `${name}: run a command`, detail: input.command }
  if (typeof input?.file_path === 'string') return { title: `${name}: ${input.file_path}` }
  if (typeof input?.url === 'string') return { title: `${name}: ${input.url}` }
  if (name.startsWith('jarvis.linear_')) return { title: `${name} ${input?.id ?? ''}`, detail: input?.state ?? input?.body }
  return { title: name }
}

export function ApprovalDialog({
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation() // don't also cancel the run
        onDecide({ behavior: 'deny' })
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onDecide({ behavior: 'allow' })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDecide])

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
          <button className="ghost" onClick={() => onDecide({ behavior: 'deny' })}>
            Deny <kbd>Esc</kbd>
          </button>
          <button className="ghost" onClick={() => onDecide({ behavior: 'allow' }, true)}>
            Always allow {short} in this chat
          </button>
          <button className="primary" autoFocus onClick={() => onDecide({ behavior: 'allow' })}>
            Allow <kbd className="on-primary">⌘↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
