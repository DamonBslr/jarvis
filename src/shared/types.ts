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
  /** Additional MCP servers for this run (browser, computer use, T3 Code…), set by main from settings. */
  extraMcp?: Record<string, McpServerSpec>
  /** Tool names (e.g. "mcp__browser__browser_snapshot") pre-approved for Claude, alongside the Jarvis read-only tools. */
  extraAllowedTools?: string[]
  /** Extra Codex `-c key=value` overrides from capabilities. */
  codexConfig?: string[]
}

/** One MCP server: stdio (command) or streamable HTTP (url). */
export type McpServerSpec =
  | { type?: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers?: Record<string, string> }

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
  kind: 'memory' | 'chunk' | 'item' | 'project'
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
  /** Set when the agent asks to connect a new service; the dialog shows a connect prompt instead of a tool call. */
  connect?: {
    name: string
    url: string
    kind: ConnectionKind
    /** e.g. "Sign in on auth.example.com" — what happens after Allow. */
    action: string
    /** Ask the user for an API key/token in the dialog. It goes to the vault, never to the agent. */
    secretLabel?: string
  }
}

export type ApprovalDecision = { behavior: 'allow'; secret?: string } | { behavior: 'deny'; message?: string }

/**
 * A service Jarvis's agents can use with the user's access.
 *  - oauth:   remote MCP server behind OAuth 2.1 (Jarvis registers itself, you sign in once, tokens refresh)
 *  - token:   remote MCP server behind an API key / bearer token you paste once
 *  - open:    remote MCP server without auth
 *  - browser: a website you logged into once in Jarvis's browser profile (for sites without an API)
 */
export type ConnectionKind = 'oauth' | 'token' | 'open' | 'browser'

/** What agents may do: only read-only tools, writes ask you each time, or writes run on their own. */
export type ConnectionPolicy = 'read' | 'ask' | 'auto'

export interface Connection {
  /** Also the MCP server name agents see (tools become mcp__<id>__<tool>). */
  id: string
  name: string
  kind: ConnectionKind
  /** MCP endpoint, or the site for browser logins. */
  url: string
  policy: ConnectionPolicy
  /** token kind: header carrying the key (default Authorization, sent as "Bearer <key>"). */
  header?: string
  /** What it is / when to use it; shown to agents. */
  notes?: string
  createdAt: number
  lastUsedAt?: number
}

export interface ConnectionStatus extends Connection {
  state: 'connected' | 'needs-auth' | 'error' | 'unchecked'
  detail?: string
  tools?: { name: string; readOnly: boolean }[]
  /** Who Jarvis acts as (email/name from the token), when known. */
  account?: string
  /** OAuth: where you'd revoke Jarvis's access. */
  issuer?: string
  expiresAt?: number
}

export interface ConnectionAuditEntry {
  at: number
  connection: string
  tool: string
  runId: string
  outcome: 'ok' | 'error' | 'denied'
  detail?: string
}

export interface NewConnection {
  url: string
  name?: string
  /** Omit to detect (oauth / token / open) from the server. */
  kind?: ConnectionKind
  policy?: ConnectionPolicy
  token?: string
  header?: string
  notes?: string
}

export interface ConnectionProbe {
  kind: 'oauth' | 'token' | 'open'
  /** Suggested display name (from the server's metadata). */
  name?: string
  /** OAuth: the sign-in host. */
  issuer?: string
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
  /** Linear issue this chat is working on. */
  linear?: { id: string; identifier: string; title: string; url: string; prLinked?: string }
  /** Set when a routine created this chat. */
  routineId?: string
  /** Started from the quick bar. */
  quick?: boolean
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
  /** Global shortcut for the floating quick bar. */
  quickHotkey: string
  /** Global shortcut that opens the quick bar and starts listening. */
  voiceHotkey: string
  /** whisper.cpp model name (ggml-<name>.bin). */
  voiceModel: string
  /** Spoken language for transcription ('auto' detects). */
  voiceLanguage: string
  /** Read answers aloud when the question was spoken. */
  speakReplies: boolean
  /** macOS `say` voice ('' = system default). Also the fallback when the neural voice can't speak a reply. */
  ttsVoice: string
  /** 'neural' = Kokoro on this Mac (natural), 'system' = macOS `say`. */
  ttsEngine: 'neural' | 'system'
  /** Kokoro voice id, e.g. "bm_george" (prefix: a=US, b=UK English, e/f/i/p/j/z/h = other languages). */
  neuralVoice: string
  /** Speaking rate for the neural voice (1 = normal). */
  ttsSpeed: number
  /** Keep the mic open and react to "Jarvis …" (all transcription stays local). */
  wakeWord: boolean
  /** Global shortcut that starts/ends a hands-free live conversation in the main window. */
  liveHotkey: string
  /** Live mode: talking over Jarvis interrupts it (needs headphones, or it hears itself). */
  liveBargeIn: boolean
  /** Hide the Dock icon; Jarvis lives in the menu bar. */
  menuBarOnly: boolean
  /** Download and install updates automatically (packaged app only). */
  autoUpdate: boolean
  /** Let agents see and control the Mac (screenshots, mouse, keyboard). Actions ask first unless autonomy is "full". */
  computerUse: boolean
  /** Give agents Jarvis's own browser (persistent profile, separate from your everyday browser). */
  browserTool: boolean
  /** Show the Jarvis browser window while agents drive it (otherwise headless). */
  browserVisible: boolean
  /** Let agents talk to the local T3 Code app (threads, projects). */
  t3Tools: boolean
  /** Set when the first-run setup finished (or was skipped). */
  onboardedAt?: number
  /** What the user calls themselves (from setup). */
  userName?: string
  /** Which knowledge sources Jarvis may read, by connector id. Missing = off. */
  syncSources: Partial<Record<ConnectorId, boolean>>
  /** Minutes between background syncs (0 = only on demand). */
  syncIntervalMin: number
  /** Write a living brief per focus project (uses the learning engine). */
  projectBriefs: boolean
  /** Folders that hold code repos, scanned for projects (e.g. ~/code). */
  codeRoots: string[]
}

// ---- Knowledge: projects + activity from every connected source -----------------------------

/** Sources Jarvis can learn from. Each is a local reader; nothing leaves the Mac except brief generation. */
export type ConnectorId = 'git' | 'github' | 'linear' | 't3' | 'claude' | 'codex' | 'jarvis' | 'docs'

export interface ConnectorInfo {
  id: ConnectorId
  name: string
  /** What Jarvis reads from it, in one line. */
  reads: string
  /** Installed / signed in / reachable. */
  available: boolean
  detail?: string
  /** Who Jarvis reads as (GitHub login, Linear name), when known. */
  account?: string
  enabled: boolean
  /** How to make it available, when it isn't. */
  setup?: { kind: 'command' | 'key' | 'toggle' | 'app'; hint: string }
  sync?: SyncState
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'ok' | 'error'
  syncedAt?: number
  items?: number
  error?: string
}

export interface Project {
  /** Slug, stable. */
  id: string
  name: string
  /** Local repo / folder. */
  path?: string
  /** owner/name on GitHub. */
  github?: string
  linearTeam?: string
  linearProject?: string
  t3ProjectId?: string
  /** One of the projects the user is actively working on: indexed deeply, briefed, boosted in recall. */
  focus: boolean
  notes?: string
  /** Living summary written by Jarvis (markdown). */
  brief?: string
  briefAt?: number
  lastActivityAt?: number
  createdAt: number
}

/** A discovered project with the signals that make it look active. */
export interface ProjectCandidate {
  path: string
  name: string
  github?: string
  t3ProjectId?: string
  /** Commits by the user in the last 30 days. */
  commits30d: number
  /** Agent sessions (Claude Code, Codex, T3 threads) in the last 30 days. */
  sessions30d: number
  lastActivityAt?: number
  score: number
  /** Already a project in Jarvis. */
  known?: boolean
  focus?: boolean
}

export type ItemKind = 'commit' | 'pr' | 'issue' | 'thread' | 'session' | 'chat' | 'doc' | 'worktree'

export interface KnowledgeItem {
  id: number
  source: ConnectorId
  kind: ItemKind
  projectId?: string
  title: string
  body?: string
  url?: string
  state?: string
  author?: string
  at: number
}

export interface OpenLoop {
  /** Stable key, so a loop can be dismissed. */
  key: string
  projectId?: string
  source: ConnectorId
  /** review = someone waits on you; stalled = you started and stopped; attention = needs a look. */
  kind: 'review' | 'stalled' | 'attention' | 'uncommitted'
  title: string
  detail?: string
  url?: string
  at: number
}

export interface ProjectDigest {
  project: Project
  loops: OpenLoop[]
  recent: KnowledgeItem[]
  counts: { items: number; week: number }
}

export interface KnowledgeOverview {
  projects: ProjectDigest[]
  /** Loops not tied to a focus project. */
  otherLoops: OpenLoop[]
  /** Items since the user last looked, across focus projects. */
  sinceLastSeen: number
  lastSeenAt?: number
  totalItems: number
}

export interface SyncProgress {
  connector?: ConnectorId
  phase: 'sync' | 'brief' | 'done'
  message: string
  /** 0..1 over the whole run. */
  progress?: number
}

export type RoutineSchedule =
  | { kind: 'daily'; time: string; days: number[] } // time "HH:MM", days 0=Sun..6=Sat
  | { kind: 'interval'; minutes: number }

export interface Routine {
  id: string
  name: string
  /** Prompt; {{linear}}, {{prs}}, {{repos}}, {{date}} are filled with fresh data before the run. */
  prompt: string
  schedule: RoutineSchedule
  provider: ProviderId
  model?: string
  cwd: string
  enabled: boolean
  notify: boolean
  speak: boolean
  lastRunAt?: number
  lastConvId?: string
  lastError?: string
  /** When the schedule was last saved; a daily slot earlier than this never fires retroactively. */
  armedAt?: number
}

export interface VoiceStatus {
  whisper: { found: boolean; path?: string }
  model: { name: string; downloaded: boolean; sizeMb?: number }
  micAccess: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  voices: string[]
  /** Neural voice: uv runs the worker, model files live in userData/kokoro. */
  neural: { uv: boolean; downloaded: boolean; sizeMb: number }
}

export interface VoiceProgress {
  task: 'model' | 'whisper' | 'neural'
  step?: string
  progress?: number
  done?: boolean
  error?: string
}

export interface UpdateState {
  version: string
  packaged: boolean
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  next?: string
  progress?: number
  error?: string
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
  /** Returns shortcuts that could not be registered (name -> reason). */
  saveSettings(s: Settings): Promise<Record<string, string>>
  hotkeyErrors(): Promise<Record<string, string>>
  onSettingsChanged(cb: (s: Settings) => void): () => void
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
  /** Conversations written by another window or a routine. */
  onConversationsChanged(cb: () => void): () => void
  onOpenConversation(cb: (convId: string) => void): () => void
  onOpenPanel(cb: (panel: 'settings' | 'routines' | 'projects' | 'onboarding') => void): () => void
  quick: {
    hide(): Promise<void>
    resize(height: number): Promise<void>
    /** Keep the bar open when it loses focus (approval waiting, recording). */
    pin(pinned: boolean): Promise<void>
    openInMain(convId: string): Promise<void>
    /** Fired when the quick bar is summoned; voice=true means start listening. */
    onShow(cb: (opts: { voice: boolean; prompt?: string }) => void): () => void
  }
  voice: {
    /** Pass a model name to check a model other than the saved one. */
    status(model?: string): Promise<VoiceStatus>
    requestMic(): Promise<boolean>
    transcribe(wav: ArrayBuffer): Promise<string>
    /** Replace whatever is being said. */
    speak(text: string): Promise<void>
    /** Queue after what's being said; resolves when this chunk has played (or speech was stopped). */
    say(text: string): Promise<void>
    stopSpeaking(): Promise<void>
    onSpeaking(cb: (on: boolean) => void): () => void
    downloadModel(name: string): Promise<void>
    installWhisper(): Promise<void>
    /** Download the neural voice (Kokoro) and install its runtime. */
    downloadNeural(): Promise<void>
    onProgress(cb: (p: VoiceProgress) => void): () => void
    /** Wake word heard: text after "Jarvis". */
    wake(rest: string): Promise<void>
    /** The main window reports live mode on/off (pauses the wake word, updates the tray). */
    setLive(on: boolean): Promise<void>
    onLive(cb: (on: boolean) => void): () => void
    /** Hotkey / tray / "Jarvis, live mode" asked the main window to start or end live mode. */
    onLiveToggle(cb: (start?: boolean) => void): () => void
  }
  routines: {
    list(): Promise<(Routine & { running?: boolean })[]>
    save(r: Routine): Promise<void>
    remove(id: string): Promise<void>
    runNow(id: string): Promise<void>
    onChanged(cb: () => void): () => void
  }
  connections: {
    list(): Promise<ConnectionStatus[]>
    /** Look at an MCP URL: OAuth, needs a key, or open. */
    probe(url: string): Promise<ConnectionProbe>
    /** Adds the connection; for OAuth this opens your browser and resolves after you sign in. */
    add(input: NewConnection): Promise<ConnectionStatus>
    update(id: string, patch: Partial<Pick<Connection, 'name' | 'policy' | 'notes'>>): Promise<void>
    /** Sign in again (OAuth) or replace the key (token). */
    reconnect(id: string, token?: string): Promise<ConnectionStatus>
    remove(id: string): Promise<void>
    /** Open the site in Jarvis's browser profile so you can log in. */
    openBrowser(id: string): Promise<void>
    audit(limit?: number): Promise<ConnectionAuditEntry[]>
    onChanged(cb: () => void): () => void
  }
  knowledge: {
    connectors(): Promise<ConnectorInfo[]>
    setSource(id: ConnectorId, enabled: boolean): Promise<void>
    /** Scan code roots + agent history for active repos. */
    discover(): Promise<ProjectCandidate[]>
    projects(): Promise<Project[]>
    /** Make these paths focus projects (creating them if needed); others lose focus. */
    setFocus(paths: string[]): Promise<Project[]>
    updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'focus' | 'notes' | 'github' | 'linearTeam' | 'linearProject'>>): Promise<void>
    removeProject(id: string): Promise<void>
    /** Sync enabled sources now (all, or one); resolves when done. */
    sync(id?: ConnectorId): Promise<void>
    /** (Re)write briefs for focus projects (all, or one). */
    brief(projectId?: string): Promise<void>
    overview(): Promise<KnowledgeOverview>
    timeline(projectId: string, limit?: number): Promise<KnowledgeItem[]>
    search(query: string, projectId?: string): Promise<KnowledgeItem[]>
    dismissLoop(key: string): Promise<void>
    /** The user looked at the overview: resets "since you were away". */
    markSeen(): Promise<void>
    onProgress(cb: (p: SyncProgress) => void): () => void
    onChanged(cb: () => void): () => void
  }
  updates: {
    state(): Promise<UpdateState>
    check(): Promise<void>
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
}
