// Pure chat helpers shared by the main window, the quick bar and main-process automations.
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

/** The answer after the last tool call: what's worth saying, without the "let me check…" narration in between. */
export function finalText(m: ChatMessage): string {
  const i = m.parts.findLastIndex((p) => p.type === 'tool')
  return m.parts
    .slice(i + 1)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
}

/**
 * Pinned into every turn the user spoke (live mode, spoken quick-bar requests). Written answers read
 * aloud sound like someone reciting a document; this asks for something a person would actually say.
 */
export const VOICE_REPLY_STYLE = [
  'Voice reply: the user spoke this request and your answer is read aloud by text-to-speech. Talk the way a sharp assistant would on the phone, not the way you would write.',
  '- One to three short sentences, about 40 words, never more than 60. Lead with the answer; no preamble ("Sure!", "Great question"), no restating the question, no sign-off.',
  '- Plain spoken words only: no markdown, bullet points, headings, tables, emoji, URLs or file paths. Say "the settings file", not "src/main/store.ts". Round numbers and say them the way people do ("about two hundred", "half past three").',
  '- Give the gist instead of reading out lists or details ("Three checks failed, mostly lint") and offer more ("Want me to go through them?"). At most one question.',
  '- Contractions and a relaxed, friendly tone are good.',
  '- If on-screen detail really helps (code, commands, a long list, links), put it after a line containing only --- . Everything after that line is shown, not spoken, so the spoken part must stand on its own.',
  '- Before work with tools, say one short sentence about what you are doing ("Checking your calendar."), then stay quiet until you have the answer. Do not narrate each step.'
].join('\n')

/** Where on-screen detail starts in a voice reply: a `---` line, a code block, heading or table. -1 if none. */
export function detailStart(md: string, lists = false): number {
  const rx = lists
    ? /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$|^[ \t]*```|^#{1,6}[ \t]|^[ \t]*\||^[ \t]*(?:[-*•]|\d+[.)])[ \t]+\S/m
    : /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$|^[ \t]*```|^#{1,6}[ \t]|^[ \t]*\|/m
  return rx.exec(md)?.index ?? -1
}

/** The part of a voice reply meant to be heard (everything when the model didn't separate it). */
export function spokenPart(md: string): string {
  const cut = detailStart(md)
  return (cut > 0 && md.slice(0, cut).trim()) || md
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
