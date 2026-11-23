// Types shared by main, preload and renderer.

export type ProviderId = 'claude' | 'codex' | 'ollama'

/** Normalized stream events. Every provider adapter maps its native output onto these. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool_start'; id: string; name: string; input: string }
  | { kind: 'tool_end'; id: string; output: string; isError?: boolean }
  | { kind: 'done'; costUsd?: number; durationMs?: number }
  | { kind: 'error'; message: string }
  | { kind: 'log'; message: string }

export interface RunRequest {
  runId: string
  provider: ProviderId
  prompt: string
  cwd: string
  /** Provider-native session/thread id to continue a conversation. */
  sessionId?: string
  model?: string
  /** Extra instructions from the active mode (e.g. Code & Git). */
  systemPrompt?: string
  /** Full history; used by stateless providers (Ollama). */
  history?: { role: 'user' | 'assistant'; content: string }[]
  /** Autonomy level. 'ask' = read-only / plan, 'edit' = may edit files in cwd, 'full' = no sandbox. */
  autonomy: 'ask' | 'edit' | 'full'
}

export interface ProviderStatus {
  id: ProviderId
  available: boolean
  version?: string
  detail?: string
  models?: string[]
}

export interface Mode {
  id: string
  name: string
  description: string
  systemPrompt: string
  defaultProvider?: ProviderId
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean; done: boolean }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  parts: MessagePart[]
  provider?: ProviderId
  error?: string
  costUsd?: number
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  provider: ProviderId
  model?: string
  modeId: string
  cwd: string
  autonomy: RunRequest['autonomy']
  /** Session id per provider, so switching providers mid-chat keeps each thread. */
  sessions: Partial<Record<ProviderId, string>>
  messages: ChatMessage[]
  updatedAt: number
}

export interface Settings {
  /** Remove ANTHROPIC_API_KEY etc. so the CLI uses your Claude subscription login instead of API billing. */
  preferSubscription: boolean
  ollamaUrl: string
  defaultCwd: string
  hotkey: string
}

export interface JarvisApi {
  providers(): Promise<ProviderStatus[]>
  run(req: RunRequest): Promise<void>
  cancel(runId: string): Promise<void>
  onEvent(cb: (runId: string, ev: AgentEvent) => void): () => void
  pickFolder(): Promise<string | null>
  loadConversations(): Promise<Conversation[]>
  saveConversation(c: Conversation): Promise<void>
  deleteConversation(id: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
  modes(): Promise<Mode[]>
}
