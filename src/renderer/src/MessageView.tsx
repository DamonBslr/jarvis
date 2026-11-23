import { memo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, MessagePart } from '@shared/types'

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' } as const
const MODE_LABEL: Record<string, string> = { general: 'Jarvis', code: 'Code · Git · Linear', local: 'Local quick' }

function ContextChip({ items }: { items: NonNullable<ChatMessage['context']> }) {
  const [open, setOpen] = useState(false)
  const mems = items.filter((i) => i.kind === 'memory').length
  const docs = items.length - mems
  const label = [mems && `${mems} memor${mems === 1 ? 'y' : 'ies'}`, docs && `${docs} doc${docs === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="chip-wrap">
      <button className="chip" onClick={() => setOpen((o) => !o)} title="Context injected from memory">
        recalled {label}
      </button>
      {open && (
        <div className="chip-pop">
          {items.map((i) => (
            <div key={`${i.kind}${i.id}`} className="chip-pop-row">
              <span className="chip-kind">{i.kind === 'memory' ? 'mem' : 'doc'}</span>
              {i.label}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

function summarizeInput(name: string, input: string): string {
  try {
    const obj = JSON.parse(input)
    const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'].find(
      (k) => typeof obj?.[k] === 'string'
    )
    if (key) return obj[key]
  } catch {
    /* plain string input */
  }
  return input.split('\n')[0] || name
}

function ToolCard({ part }: { part: Extract<MessagePart, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const state = !part.done ? 'running' : part.isError ? 'error' : 'ok'
  return (
    <div className={`tool ${state}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-state" />
        <span className="tool-name">{part.name}</span>
        <span className="tool-summary">{summarizeInput(part.name, part.input)}</span>
        <span className="tool-caret">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre>{part.input}</pre>
          {part.output !== undefined && part.output !== '' && <pre className="tool-out">{part.output}</pre>}
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button onClick={() => setOpen((o) => !o)}>{open ? 'Hide reasoning' : 'Show reasoning'}</button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

export const MessageView = memo(function MessageView({
  message,
  streaming
}: {
  message: ChatMessage
  streaming: boolean
}) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="msg user">
        <div className="bubble">{text}</div>
      </div>
    )
  }

  const empty = message.parts.length === 0 && !message.error
  return (
    <div className="msg assistant">
      <div className="msg-meta">
        <span className="who">{message.provider ? PROVIDER_LABEL[message.provider] : 'Jarvis'}</span>
        {message.costUsd !== undefined && message.costUsd > 0 && (
          <span className="cost" title="Equivalent API cost reported by the CLI">
            ≈${message.costUsd.toFixed(3)}
          </span>
        )}
        {message.route && (
          <span
            className="chip static"
            title={
              message.route.probabilities
                ? Object.entries(message.route.probabilities)
                    .map(([k, v]) => `${MODE_LABEL[k] ?? k}: ${Math.round(v * 100)}%`)
                    .join('\n')
                : 'keyword heuristic (Jev offline)'
            }
          >
            routed → {MODE_LABEL[message.route.modeId] ?? message.route.modeId}
            {message.route.via === 'jev' ? ` · ${Math.round(message.route.confidence * 100)}% jev` : ' · heuristic'}
          </span>
        )}
        {message.context && message.context.length > 0 && <ContextChip items={message.context} />}
      </div>
      {message.parts.map((p, i) => {
        if (p.type === 'text')
          return (
            <div className="md" key={i}>
              <Markdown remarkPlugins={[remarkGfm]}>{p.text}</Markdown>
            </div>
          )
        if (p.type === 'thinking') return <Thinking key={i} text={p.text} />
        return <ToolCard key={p.id || i} part={p} />
      })}
      {empty && streaming && (
        <div className="working">
          <span />
          <span />
          <span />
        </div>
      )}
      {message.error && <div className="error">{message.error}</div>}
      {message.learned && message.learned.length > 0 && (
        <div className="learned">
          {message.learned.map((l) => (
            <div key={l.id}>
              <span className="learned-tag">{l.updated ? 'updated memory' : 'learned'}</span> {l.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
