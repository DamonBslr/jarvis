// Pure chat helpers shared by the main window, the quick bar and main-process routines.
import type { AgentEvent, ChatMessage, Conversation } from './types'

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20)

export function applyEvent(msg: ChatMessage, ev: AgentEvent): ChatMessage {
  const parts = [...msg.parts]
  const last = parts[parts.length - 1]
  switch (ev.kind) {
    case 'text':
    case 'thinking': {
      const type = ev.kind
      if (last && last.type === type) parts[parts.length - 1] = { ...last, text: last.text + ev.delta }
      else parts.push({ type, text: ev.delta })
      return { ...msg, parts }
    }
    case 'tool_start':
      parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, done: false })
      return { ...msg, parts }
    case 'tool_end':
      return {
        ...msg,
        parts: parts.map((p) =>
          p.type === 'tool' && p.id === ev.id ? { ...p, output: ev.output, isError: ev.isError, done: true } : p
        )
      }
    case 'error':
      return { ...msg, error: msg.error ? `${msg.error}\n${ev.message}` : ev.message }
    case 'context':
      return { ...msg, context: ev.items }
    case 'route':
      return { ...msg, route: ev.route }
    case 'done':
      return {
        ...msg,
        costUsd: ev.costUsd,
        // Close any tool cards the provider never reported a result for.
        parts: parts.map((p) => (p.type === 'tool' && !p.done ? { ...p, done: true } : p))
      }
    default:
      return msg
  }
}

export function messageText(m: ChatMessage): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
}

export function historyFor(conv: Conversation) {
  return conv.messages.map((m) => ({ role: m.role, content: messageText(m) })).filter((m) => m.content.trim())
}

/** Markdown -> something worth reading aloud: no code, links, tables or emphasis marks. */
export function speakable(md: string, max = 700): string {
  const text = md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'))
  return (end > max / 2 ? cut.slice(0, end + 1) : cut) + ' … The rest is on screen.'
}
