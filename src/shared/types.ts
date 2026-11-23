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
  /** Memory + knowledge injected into this run. */
  | { kind: 'context'; items: ContextRef[] }
  /** Auto-routing decision (Jev or heuristic). */
  | { kind: 'route'; route: RouteDecision }

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
  /** Retrieved memory/knowledge block, filled in by main before the provider runs. */
  context?: string
  convId?: string
  msgId?: string
  /** Jarvis MCP bridge launch spec (set by main). */
  mcp?: { command: string; args: string[]; env: Record<string, string> }
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

export type MemoryType = 'profile' | 'preference' | 'project' | 'workflow' | 'person' | 'fact'

export interface Memory {
  id: number
  type: MemoryType
  content: string
  /** Where it came from: 'manual' | 'learned' | conversation id. */
  source: string
  pinned: boolean
  uses: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeSource {
  id: number
  path: string
  status: 'pending' | 'indexing' | 'ready' | 'error'
  files: number
  chunks: number
  indexedAt?: number
  error?: string
}

export interface ContextRef {
  kind: 'memory' | 'chunk'
  id: number
  label: string
  score: number
}

export interface RouteDecision {
  modeId: string
  provider: ProviderId
  confidence: number
  via: 'jev' | 'heuristic'
  probabilities?: Record<string, number>
}

export interface LearnedEvent {
  convId: string
  msgId: string
  added: { id: number; type: MemoryType; content: string; updated?: boolean }[]
}

export interface MemoryStatus {
  memories: number
  chunks: number
  jev: { online: boolean; url: string; model?: string }
  embeddings: { online: boolean; model: string; detail?: string }
  learner: { engine: Settings['learnEngine']; detail?: string }
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
  context?: ContextRef[]
  route?: RouteDecision
  learned?: LearnedEvent['added']
}

export interface LinearState {
  id: string
  name: string
  type: string // backlog | unstarted | started | completed | canceled | triage
  color: string
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  url: string
  priority: number
  priorityLabel: string
  branchName: string
  updatedAt: string
  state: LinearState
  teamId: string
  teamKey: string
  project?: string
  description?: string
}

export interface GitFile {
  path: string
  /** porcelain XY codes: index / worktree ('.' unchanged, M, A, D, R, ?, U) */
  index: string
  worktree: string
}

export interface GitStatus {
  isRepo: boolean
  root?: string
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files?: GitFile[]
  commits?: { hash: string; subject: string; when: string; author: string }[]
  remote?: string
}

export interface PullRequest {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision?: string
  checks?: 'passing' | 'failing' | 'pending'
}

export interface ApprovalRequest {
  requestId: string
  runId: string
  toolName: string
  input: unknown
}

export type ApprovalDecision = { behavior: 'allow' } | { behavior: 'deny'; message?: string }

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
  /** Linear issue this chat is working on. */
  linear?: { id: string; identifier: string; title: string; url: string; prLinked?: string }
}

export interface Settings {
  /** Remove ANTHROPIC_API_KEY etc. so the CLI uses your Claude subscription login instead of API billing. */
  preferSubscription: boolean
  ollamaUrl: string
  defaultCwd: string
  hotkey: string
  /** Jev-style decision server (jev-style: 8765, jevos: 8017). */
  jevUrl: string
  /** Ollama embedding model for semantic search (falls back to keyword search if missing). */
  embedModel: string
  /** Who extracts memories after a turn. */
  learnEngine: 'claude' | 'ollama' | 'off'
  learnOllamaModel: string
  /** Inject memory + knowledge into every run. */
  useMemory: boolean
  /** Linear team key -> local repo path, remembered when you start work on a ticket. */
  linearRepoMap: Record<string, string>
  /** Move tickets automatically: In Progress on start, In Review when a PR is linked. */
  linearAutoMove: boolean
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
  onLearned(cb: (ev: LearnedEvent) => void): () => void
  route(prompt: string, fallback: ProviderId): Promise<RouteDecision>
  onApproval(cb: (req: ApprovalRequest) => void): () => void
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>
  openExternal(url: string): Promise<void>
  git: {
    status(cwd: string): Promise<GitStatus>
    diff(cwd: string, path: string): Promise<string>
    pr(cwd: string): Promise<PullRequest | null>
  }
  linear: {
    status(): Promise<{ connected: boolean; user?: string; error?: string }>
    setKey(key: string): Promise<{ connected: boolean; user?: string; error?: string }>
    clearKey(): Promise<void>
    myIssues(): Promise<LinearIssue[]>
    startWork(identifier: string): Promise<LinearState | null>
    linkPr(identifier: string, url: string): Promise<LinearState | null>
  }
  memory: {
    list(query?: string): Promise<Memory[]>
    add(m: { type: MemoryType; content: string; pinned?: boolean }): Promise<Memory>
    update(id: number, patch: Partial<Pick<Memory, 'type' | 'content' | 'pinned'>>): Promise<void>
    remove(id: number): Promise<void>
    sources(): Promise<KnowledgeSource[]>
    addSource(path: string): Promise<void>
    removeSource(id: number): Promise<void>
    reindex(id: number): Promise<void>
    status(): Promise<MemoryStatus>
    onSourcesChanged(cb: () => void): () => void
  }
}
