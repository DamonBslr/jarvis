import { isValidElement, memo, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, MessagePart } from '@shared/types'
import { IconBrain, IconCheck, IconChevronRight, IconCopy, ToolIcon } from './icons'
import { highlight } from './highlight'

const PROVIDER_LABEL = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' } as const
const MODE_LABEL: Record<string, string> = { general: 'Jarvis', code: 'Code · Git · Linear', local: 'Local quick' }

/** Routing and cost details, shown as the agent name's tooltip to keep the header quiet. */
function metaTitle(m: ChatMessage): string | undefined {
  const lines: string[] = []
  if (m.route) {
    lines.push(
      `Mode: ${MODE_LABEL[m.route.modeId] ?? m.route.modeId}` +
        (m.route.via === 'jev' ? ` (${Math.round(m.route.confidence * 100)}% confident)` : ' (keyword heuristic)')
    )
    if (m.route.probabilities)
      for (const [k, v] of Object.entries(m.route.probabilities)) lines.push(`  ${MODE_LABEL[k] ?? k}: ${Math.round(v * 100)}%`)
  }
  if (m.costUsd) lines.push(`Equivalent API cost: $${m.costUsd.toFixed(3)}`)
  return lines.length ? lines.join('\n') : undefined
}

/** Fenced code block with a language label and a copy button. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const cls = isValidElement<{ className?: string }>(children) ? (children.props.className ?? '') : ''
  const lang = /language-([\w+-]+)/.exec(cls)?.[1]
  const copy = () => {
    void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang ?? 'code'}</span>
        <button className="codeblock-copy" onClick={copy} title="Copy code">
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}
/** Highlights fenced code; inline code passes through unchanged. */
function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
  if (!lang || typeof children !== 'string') return <code className={className}>{children}</code>
  return <code className={className}>{highlight(children, lang)}</code>
}
const MD_COMPONENTS = { pre: CodeBlock, code: Code }

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
        <IconBrain size={12} /> {label}
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
        <span className="tool-icon">
          <ToolIcon name={part.name} />
        </span>
        <span className="tool-name">{part.name.replace(/^mcp__\w+?__/, '')}</span>
        <span className="tool-summary">{summarizeInput(part.name, part.input)}</span>
        <span className="tool-state" title={state} />
        <span className={`tool-caret ${open ? 'open' : ''}`}>
          <IconChevronRight size={13} />
        </span>
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

type ToolPart = Extract<MessagePart, { type: 'tool' }>

/** Consecutive tool calls render as one stacked group. */
function groupParts(parts: MessagePart[]): (Exclude<MessagePart, ToolPart> | ToolPart[])[] {
  const out: (Exclude<MessagePart, ToolPart> | ToolPart[])[] = []
  for (const p of parts) {
    if (p.type !== 'tool') out.push(p)
    else if (Array.isArray(out[out.length - 1])) (out[out.length - 1] as ToolPart[]).push(p)
    else out.push([p])
  }
  return out
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
        <span className="who" title={metaTitle(message)}>
          <span className="who-mark" data-provider={message.provider ?? 'jarvis'} />
          {message.provider ? PROVIDER_LABEL[message.provider] : 'Jarvis'}
        </span>
        {message.context && message.context.length > 0 && <ContextChip items={message.context} />}
      </div>
      {groupParts(message.parts).map((g, i) => {
        if (Array.isArray(g))
          return (
            <div className="tools" key={i}>
              {g.map((p, j) => (
                <ToolCard key={p.id || j} part={p} />
              ))}
            </div>
          )
        if (g.type === 'text')
          return (
            <div className="md" key={i}>
              <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {g.text}
              </Markdown>
            </div>
          )
        return <Thinking key={i} text={g.text} />
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
              <span className="learned-tag">
                <IconBrain size={12} /> {l.updated ? 'Updated memory' : 'Learned'}
              </span>{' '}
              {l.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
