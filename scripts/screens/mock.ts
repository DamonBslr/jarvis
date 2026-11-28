// Fake preload API so the renderer runs in a plain browser for design screenshots (scripts/screens/shoot.mts).
// Scene is picked with ?scene=… : home | chat | onboarding (default chat).
import type {
  ApprovalRequest,
  ConnectionStatus,
  ConnectorInfo,
  Conversation,
  JarvisApi,
  KnowledgeItem,
  KnowledgeOverview,
  Memory,
  Project,
  ProjectCandidate,
  AutomationView,
  Settings,
  WebhookRelayStatus
} from '@shared/types'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'chat'
const now = Date.now()
const min = 60_000
const hour = 60 * min
const day = 24 * hour

const listeners = new Map<string, Set<(...a: unknown[]) => void>>()
const on = (ch: string) => (cb: (...a: any[]) => void) => {
  const set = listeners.get(ch) ?? new Set()
  set.add(cb)
  listeners.set(ch, set)
  return () => set.delete(cb)
}
const emit = (ch: string, ...args: unknown[]) => listeners.get(ch)?.forEach((cb) => cb(...args))
const ok = <T,>(v: T) => async () => v
const noop = async () => {}

const settings: Settings = {
  preferSubscription: true,
  ollamaUrl: 'http://127.0.0.1:11434',
  defaultCwd: '/Users/sam/code/atlas',
  hotkey: 'CommandOrControl+Shift+Space',
  jevUrl: 'http://127.0.0.1:8765',
  embedModel: 'nomic-embed-text',
  learnEngine: 'claude',
  learnOllamaModel: 'llama3.2',
  useMemory: true,
  linearRepoMap: { ATL: '/Users/sam/code/atlas' },
  linearAutoMove: true,
  quickHotkey: 'Alt+Space',
  voiceHotkey: 'Alt+Shift+Space',
  voiceModel: 'base',
  language: 'en',
  speakReplies: true,
  ttsVoice: '',
  ttsEngine: 'neural',
  neuralVoice: 'bm_george',
  germanVoice: 'de_DE-thorsten-high',
  ttsSpeed: 1,
  wakeWord: false,
  liveHotkey: 'Alt+Shift+L',
  liveBargeIn: false,
  liveAddressing: 'smart',
  menuBarOnly: false,
  autoUpdate: true,
  computerUse: false,
  browserTool: true,
  browserVisible: false,
  t3Tools: true,
  onboardedAt: scene === 'onboarding' ? undefined : now - 20 * day,
  userName: 'Sam',
  syncSources: { git: true, github: true, linear: true, claude: true },
  syncIntervalMin: 30,
  projectBriefs: true,
  codeRoots: ['~/code'],
  webhookRelayUrl: 'https://relay.example.com'
}

const tool = (id: string, name: string, input: object, output: string, isError = false) => ({
  type: 'tool' as const,
  id,
  name,
  input: JSON.stringify(input),
  output,
  isError,
  done: true
})

const chat: Conversation = {
  id: 'c1',
  title: 'Fix flaky checkout test',
  provider: 'claude',
  modeId: 'code',
  cwd: '/Users/sam/code/atlas',
  autonomy: 'edit',
  sessions: {},
  updatedAt: now - 2 * min,
  linear: { id: 'l1', identifier: 'ATL-214', title: 'Checkout test fails on CI', url: 'https://linear.app/x/issue/ATL-214' },
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: now - 6 * min,
      parts: [{ type: 'text', text: 'The checkout e2e test keeps failing on CI but passes locally. Can you find out why and fix it?' }]
    },
    {
      id: 'm2',
      role: 'assistant',
      provider: 'claude',
      createdAt: now - 5 * min,
      costUsd: 0.184,
      route: { modeId: 'code', provider: 'claude', confidence: 0.92, via: 'jev' },
      context: [
        { kind: 'memory', id: 1, label: 'Atlas CI runs on GitHub Actions with Node 22', score: 0.8 },
        { kind: 'memory', id: 2, label: 'Prefers small conventional commits', score: 0.7 },
        { kind: 'chunk', id: 3, label: 'docs/testing.md', score: 0.6 }
      ],
      parts: [
        { type: 'text', text: "I'll start by reproducing it and reading the test." },
        tool('t1', 'Bash', { command: 'pnpm test:e2e checkout --reporter=line' }, '1 failed: checkout › applies discount\n  Timeout 5000ms exceeded waiting for "Total: $72.00"'),
        tool('t2', 'Read', { file_path: 'e2e/checkout.spec.ts' }, '…'),
        tool('t3', 'Edit', { file_path: 'e2e/checkout.spec.ts' }, 'Applied 1 edit'),
        tool('t4', 'Bash', { command: 'pnpm test:e2e checkout --repeat-each=20' }, '20 passed (41.2s)'),
        {
          type: 'text',
          text: [
            'Found it. The test asserts the total **before the discount request settles**. Locally the API answers in ~20 ms, on CI it can take over a second, so the assertion races the network.',
            '',
            '**Fix** — wait for the discount response instead of a fixed timeout:',
            '',
            '```ts',
            "await Promise.all([",
            "  page.waitForResponse((r) => r.url().includes('/api/discount')),",
            "  page.getByRole('button', { name: 'Apply' }).click()",
            '])',
            "await expect(page.getByText('Total: $72.00')).toBeVisible()",
            '```',
            '',
            '- Ran the spec **20× in a row**: all green',
            '- Removed the `waitForTimeout(500)` that hid the race',
            '',
            'Want me to commit this on `fix/ATL-214-checkout-race` and open a PR?'
          ].join('\n')
        }
      ],
      learned: [{ id: 9, type: 'project', content: 'Atlas e2e tests must wait on network responses, never fixed timeouts.' }]
    },
    {
      id: 'm3',
      role: 'user',
      createdAt: now - 3 * min,
      parts: [{ type: 'text', text: 'Yes, commit and open the PR.' }]
    },
    {
      id: 'm4',
      role: 'assistant',
      provider: 'claude',
      createdAt: now - 2 * min,
      costUsd: 0.061,
      parts: [
        tool('t5', 'Bash', { command: 'git switch -c fix/ATL-214-checkout-race && git commit -am "test(e2e): wait for discount response"' }, '[fix/ATL-214-checkout-race 4f2a91c] test(e2e): wait for discount response'),
        tool('t6', 'Bash', { command: 'gh pr create --fill' }, 'https://github.com/sam/atlas/pull/482'),
        { type: 'text', text: 'Opened **#482** — test(e2e): wait for discount response. CI is running.' }
      ]
    }
  ]
}

const others: Conversation[] = [
  ['c2', 'Draft release notes for 2.4', 'codex', 40 * min],
  ['c3', 'Morning briefing', 'claude', 3 * hour, 'routine'],
  ['c4', 'Summarize the pricing call notes', 'ollama', 5 * hour],
  ['c5', 'Why is the build cache missing on main?', 'claude', day],
  ['c6', 'Rename env vars to ATLAS_ prefix', 'codex', 2 * day],
  ['c7', 'What time is it in Tokyo?', 'ollama', 3 * day, 'quick']
].map(([id, title, provider, ago, tag]) => ({
  id: id as string,
  title: title as string,
  provider: provider as Conversation['provider'],
  modeId: 'general',
  cwd: '/Users/sam/code/atlas',
  autonomy: 'edit' as const,
  sessions: {},
  messages: [{ id: 'x', role: 'user' as const, createdAt: now, parts: [{ type: 'text' as const, text: 'hi' }] }],
  updatedAt: now - (ago as number),
  automationId: tag === 'routine' ? 'r1' : undefined,
  quick: tag === 'quick'
}))

const fresh: Conversation = {
  id: 'c0',
  title: 'New chat',
  provider: 'claude',
  modeId: 'auto',
  cwd: '/Users/sam/code/atlas',
  autonomy: 'edit',
  sessions: {},
  messages: [],
  updatedAt: now
}

const conversations = scene === 'home' ? [fresh, chat, ...others] : [chat, ...others]

const projects: Project[] = [
  { id: 'atlas', name: 'atlas', path: '/Users/sam/code/atlas', github: 'sam/atlas', focus: true, createdAt: now - 30 * day, lastActivityAt: now - 2 * min, briefAt: now - 3 * hour, brief: '## Where it stands\nCheckout v2 is feature-complete; the last blocker is the **flaky e2e suite** (ATL-214, PR #482 open).\n\n## Waiting on you\n- Review **#479** from Priya (payment retries)\n- Decide on the Stripe webhook retry window\n\n## Next\n1. Merge #482 once CI is green\n2. Cut release 2.4 on Thursday' },
  { id: 'helix', name: 'helix-api', path: '/Users/sam/code/helix-api', github: 'sam/helix-api', focus: true, createdAt: now - 30 * day, lastActivityAt: now - 4 * hour },
  { id: 'notes', name: 'field-notes', path: '/Users/sam/code/field-notes', focus: true, createdAt: now - 30 * day, lastActivityAt: now - 2 * day }
]

const items = (projectId: string): KnowledgeItem[] => [
  { id: 1, source: 'github', kind: 'pr', projectId, title: 'test(e2e): wait for discount response', state: 'open', author: 'sam', at: now - 2 * min, url: 'https://github.com' },
  { id: 2, source: 'github', kind: 'pr', projectId, title: 'feat(payments): retry failed captures', state: 'open', author: 'priya', at: now - 3 * hour },
  { id: 3, source: 'linear', kind: 'issue', projectId, title: 'ATL-209 Webhook retries double-charge in sandbox', state: 'In Progress', at: now - 6 * hour },
  { id: 4, source: 'git', kind: 'commit', projectId, title: 'refactor(cart): extract totals hook', author: 'sam', at: now - day },
  { id: 5, source: 'claude', kind: 'session', projectId, title: 'Investigate slow cart page', at: now - 2 * day }
]

const overview: KnowledgeOverview = {
  projects: projects.map((p, i) => ({
    project: p,
    loops:
      i === 0
        ? [
            { key: 'l1', projectId: p.id, source: 'github', kind: 'review', title: 'Review #479 feat(payments): retry failed captures', at: now - 3 * hour },
            { key: 'l2', projectId: p.id, source: 'linear', kind: 'stalled', title: 'ATL-209 Webhook retries double-charge in sandbox', at: now - 2 * day }
          ]
        : i === 1
          ? [{ key: 'l3', projectId: p.id, source: 'git', kind: 'uncommitted', title: '4 uncommitted files on feat/rate-limits', at: now - 4 * hour }]
          : [],
    recent: items(p.id),
    counts: { items: 120 - i * 30, week: [23, 9, 2][i] }
  })),
  otherLoops: [{ key: 'l4', source: 'github', kind: 'attention', title: 'Dependabot: bump vite to 8.3.8', at: now - day }],
  sinceLastSeen: 14,
  lastSeenAt: now - 16 * hour,
  totalItems: 1284
}

const memories: Memory[] = [
  ['profile', "User's name is Sam.", true, 41],
  ['preference', 'Prefers small conventional commits and concise PR descriptions.', true, 28],
  ['project', 'Atlas e2e tests must wait on network responses, never fixed timeouts.', false, 3],
  ['workflow', 'Cuts releases on Thursdays after the team sync.', false, 9],
  ['person', 'Priya owns payments; ping her on anything touching Stripe.', false, 6],
  ['fact', 'Atlas CI runs on GitHub Actions with Node 22.', false, 12]
].map(([type, content, pinned, uses], i) => ({
  id: i + 1,
  type: type as Memory['type'],
  content: content as string,
  source: i < 2 ? 'manual' : 'learned',
  pinned: pinned as boolean,
  uses: uses as number,
  createdAt: now - (i + 1) * day,
  updatedAt: now - i * day
}))

const automations: AutomationView[] = [
  {
    id: 'r1', name: 'Morning briefing', prompt: 'Give me my briefing for {{date}}.\n\nMy Linear issues:\n{{linear}}\n\nMy open pull requests:\n{{prs}}',
    schedule: { kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }, thread: { kind: 'dedicated', convId: 'c3' }, threadTitle: 'Morning briefing',
    provider: 'claude', cwd: '/Users/sam/code/atlas', autonomy: 'ask', enabled: true, notify: true, speak: true, lastRunAt: now - 3 * hour, lastConvId: 'c3',
    nextRunAt: now + 18 * hour,
    history: [
      { at: now - 3 * hour, trigger: 'schedule', status: 'ok', convId: 'c3', durationMs: 48_000 },
      { at: now - 27 * hour, trigger: 'schedule', status: 'ok', convId: 'c3', durationMs: 61_000 },
      { at: now - 51 * hour, trigger: 'manual', status: 'failed', detail: 'gh: authentication expired', durationMs: 4_000 },
      { at: now - 75 * hour, trigger: 'schedule', status: 'ok', convId: 'c3', durationMs: 52_000 }
    ]
  },
  {
    id: 'r2', name: 'Watch CI on #482', prompt: 'Check the checks on PR #482. If any failed, find out why and fix it.',
    schedule: { kind: 'interval', minutes: 30 }, thread: { kind: 'origin', convId: 'c1' }, threadTitle: 'Fix flaky checkout test', createdBy: 'agent',
    provider: 'claude', cwd: '/Users/sam/code/atlas', autonomy: 'edit', enabled: true, notify: true, speak: false, lastRunAt: now - 12 * min, lastConvId: 'c1',
    nextRunAt: now + 18 * min, history: [{ at: now - 12 * min, trigger: 'schedule', status: 'ok', convId: 'c1', durationMs: 95_000 }]
  },
  {
    id: 'r3', name: 'PR review sweep', prompt: 'Here are my open PRs and the PRs waiting for my review:\n{{prs}}',
    schedule: { kind: 'interval', minutes: 120 }, thread: { kind: 'new' }, provider: 'codex', cwd: '/Users/sam/code/atlas', autonomy: 'ask',
    enabled: true, notify: true, speak: false, lastRunAt: now - 70 * min, lastConvId: 'c2', running: true, nextRunAt: now + 50 * min
  },
  {
    id: 'r5', name: 'Review new pull requests',
    prompt: 'A pull request was opened or reopened. The GitHub webhook payload is below.\n\n{{payload}}\n\nCheck out the branch, review the change for bugs and risky spots, and give me a short verdict with the 3 most important findings. Do not push or comment on GitHub.',
    schedule: {
      kind: 'webhook',
      filters: [
        { path: 'headers.x-github-event', op: 'equals', value: 'pull_request' },
        { path: 'body.action', op: 'in', value: ['opened', 'reopened'] },
        { path: 'body.pull_request.draft', op: 'notEquals', value: 'true' }
      ],
      signature: { header: 'x-hub-signature-256', encoding: 'hex', prefix: 'sha256=', algorithm: 'sha256' },
      dedupe: { replayKey: '{{headers.x-github-delivery}}', coalesceKey: '{{body.pull_request.number}}', coalesceWindowSeconds: 120 },
      maxDeliveryAgeMinutes: 360
    },
    thread: { kind: 'dedicated', convId: 'c2' }, threadTitle: 'Review new pull requests',
    provider: 'claude', model: 'sonnet', cwd: '/Users/sam/code/atlas', autonomy: 'ask', enabled: true, notify: true, speak: false,
    lastRunAt: now - 41 * min, lastConvId: 'c2',
    webhook: {
      url: 'https://relay.example.com/hooks/r5/Qm9vazVfd2ViaG9va190b2tlbl9kZW1v',
      hasSecret: true,
      pending: 0,
      lastDelivery: { at: now - 6 * min, outcome: 'filtered', detail: 'Did not match: body.action in opened, reopened' }
    },
    history: [
      { at: now - 41 * min, trigger: 'webhook', status: 'ok', convId: 'c2', durationMs: 132_000 },
      { at: now - 3 * hour, trigger: 'webhook', status: 'skipped', detail: 'Signature in x-hub-signature-256 did not match' },
      { at: now - 26 * hour, trigger: 'webhook', status: 'ok', convId: 'c2', durationMs: 98_000 }
    ]
  },
  {
    id: 'r4', name: 'Friday retro notes', prompt: 'Draft a retro from this week.', schedule: { kind: 'daily', time: '16:00', days: [5] },
    thread: { kind: 'new' }, provider: 'ollama', model: 'llama3.2', cwd: '/Users/sam/code/atlas', autonomy: 'ask', enabled: false, notify: false, speak: false
  }
]

const connectors: ConnectorInfo[] = [
  { id: 'git', name: 'Local git', reads: 'Commits, branches and uncommitted work in your repos', available: true, enabled: true, sync: { status: 'ok', syncedAt: now - 4 * min, items: 612 } },
  { id: 'github', name: 'GitHub', reads: 'PRs, reviews and issues via gh', available: true, enabled: true, account: 'sam', sync: { status: 'ok', syncedAt: now - 4 * min, items: 231 } },
  { id: 'linear', name: 'Linear', reads: 'Issues assigned to you and your team', available: true, enabled: true, account: 'Sam Rivera', sync: { status: 'ok', syncedAt: now - 4 * min, items: 88 } },
  { id: 'claude', name: 'Claude Code', reads: 'Session history from ~/.claude', available: true, enabled: true, sync: { status: 'ok', syncedAt: now - 4 * min, items: 140 } },
  { id: 'codex', name: 'Codex', reads: 'Session history from ~/.codex', available: true, enabled: false, detail: '58 sessions found' },
  { id: 't3', name: 'T3 Code', reads: 'Threads and projects', available: false, enabled: false, detail: 'T3 Code is not running', setup: { kind: 'app', hint: 'Open T3 Code' } }
]

const candidates: ProjectCandidate[] = [
  { path: '/Users/sam/code/atlas', name: 'atlas', github: 'sam/atlas', commits30d: 84, sessions30d: 31, lastActivityAt: now - 2 * min, score: 140 },
  { path: '/Users/sam/code/helix-api', name: 'helix-api', github: 'sam/helix-api', commits30d: 37, sessions30d: 12, lastActivityAt: now - 4 * hour, score: 62 },
  { path: '/Users/sam/code/field-notes', name: 'field-notes', commits30d: 11, sessions30d: 2, lastActivityAt: now - 2 * day, score: 18 },
  { path: '/Users/sam/code/dotfiles', name: 'dotfiles', github: 'sam/dotfiles', commits30d: 3, sessions30d: 0, lastActivityAt: now - 9 * day, score: 4 }
]

const connections: ConnectionStatus[] = [
  { id: 'sentry', name: 'Sentry', kind: 'oauth', url: 'https://mcp.sentry.dev/mcp', policy: 'read', createdAt: now - 10 * day, lastUsedAt: now - hour, state: 'connected', account: 'sam@atlas.dev', issuer: 'https://sentry.io', tools: [{ name: 'search_issues', readOnly: true }, { name: 'resolve_issue', readOnly: false }] },
  { id: 'notion', name: 'Notion', kind: 'oauth', url: 'https://mcp.notion.com/mcp', policy: 'ask', createdAt: now - 5 * day, state: 'needs-auth', detail: 'Sign-in expired' },
  { id: 'vercel', name: 'Vercel', kind: 'token', url: 'https://mcp.vercel.com', policy: 'auto', createdAt: now - 2 * day, lastUsedAt: now - day, state: 'connected', tools: [{ name: 'list_deployments', readOnly: true }] }
]

const api: JarvisApi = {
  providers: ok([
    { id: 'claude', available: true, version: '2.4.1', models: [] },
    { id: 'codex', available: true, version: '0.98.0', models: [] },
    { id: 'ollama', available: true, version: '0.12.3', models: ['llama3.2', 'qwen3:8b'] }
  ]),
  run: noop,
  cancel: noop,
  onEvent: on('event'),
  onLearned: on('learned'),
  route: async () => ({ modeId: 'general', provider: 'claude', confidence: 0.8, via: 'heuristic' }),
  onApproval: on('approval'),
  respondApproval: noop,
  openExternal: noop,
  git: {
    status: ok({
      isRepo: true,
      root: '/Users/sam/code/atlas',
      branch: 'fix/ATL-214-checkout-race',
      upstream: 'origin/fix/ATL-214-checkout-race',
      ahead: 1,
      behind: 0,
      files: [
        { path: 'e2e/checkout.spec.ts', index: 'M', worktree: '.' },
        { path: 'src/cart/useTotals.ts', index: '.', worktree: 'M' },
        { path: 'e2e/fixtures/discount.json', index: '?', worktree: '?' }
      ],
      commits: [
        { hash: '4f2a91c', subject: 'test(e2e): wait for discount response', when: '2 minutes ago', author: 'Sam' },
        { hash: 'b81d0e4', subject: 'refactor(cart): extract totals hook', when: '1 day ago', author: 'Sam' },
        { hash: '19ac3f2', subject: 'feat(checkout): apply discount codes', when: '2 days ago', author: 'Priya' },
        { hash: 'e0c7b55', subject: 'chore: bump playwright', when: '3 days ago', author: 'Sam' }
      ]
    }),
    diff: ok('diff --git a/e2e/checkout.spec.ts b/e2e/checkout.spec.ts\n@@ -12,7 +12,10 @@\n-  await page.waitForTimeout(500)\n+  await Promise.all([\n+    page.waitForResponse((r) => r.url().includes("/api/discount")),\n+    apply.click()\n+  ])'),
    pr: ok({ number: 482, title: 'test(e2e): wait for discount response', url: 'https://github.com/sam/atlas/pull/482', state: 'OPEN', isDraft: false, checks: 'pending', reviewDecision: 'REVIEW_REQUIRED' })
  },
  linear: {
    status: ok({ connected: true, user: 'Sam Rivera' }),
    setKey: ok({ connected: true, user: 'Sam Rivera' }),
    clearKey: noop,
    myIssues: ok([
      { id: 'l1', identifier: 'ATL-214', title: 'Checkout test fails on CI', url: '#', priority: 1, priorityLabel: 'Urgent', branchName: 'fix/ATL-214', updatedAt: '', state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' }, teamId: 't', teamKey: 'ATL' },
      { id: 'l2', identifier: 'ATL-209', title: 'Webhook retries double-charge in sandbox', url: '#', priority: 2, priorityLabel: 'High', branchName: 'fix/ATL-209', updatedAt: '', state: { id: 's', name: 'In Progress', type: 'started', color: '#f2c94c' }, teamId: 't', teamKey: 'ATL' },
      { id: 'l3', identifier: 'HLX-31', title: 'Per-key rate limits for the public API', url: '#', priority: 3, priorityLabel: 'Medium', branchName: 'feat/HLX-31', updatedAt: '', state: { id: 's', name: 'Todo', type: 'unstarted', color: '#9b9ba4' }, teamId: 't2', teamKey: 'HLX' }
    ]),
    startWork: ok(null),
    linkPr: ok(null)
  },
  pickFolder: ok(null),
  loadConversations: ok(conversations),
  saveConversation: noop,
  deleteConversation: noop,
  getSettings: ok(settings),
  saveSettings: ok({}),
  hotkeyErrors: ok({}),
  onSettingsChanged: on('settings'),
  modes: ok([
    { id: 'auto', name: 'Auto', description: 'Jarvis picks the mode and engine for the first message.', systemPrompt: '' },
    { id: 'general', name: 'Jarvis', description: 'General assistant. Answers, researches, runs tasks in the workspace.', systemPrompt: '' },
    { id: 'code', name: 'Code · Git · Linear', description: 'Engineering ops.', systemPrompt: '', defaultProvider: 'claude' },
    { id: 'local', name: 'Local quick', description: 'Private, offline, fast.', systemPrompt: '', defaultProvider: 'ollama' }
  ]),
  memory: {
    list: ok(memories),
    add: async (m) => ({ ...memories[0], ...m }),
    update: noop,
    remove: noop,
    sources: ok([
      { id: 1, path: '~/Documents/Notes', status: 'ready', files: 214, chunks: 1890, indexedAt: now - day },
      { id: 2, path: '~/code/atlas/docs', status: 'indexing', files: 38, chunks: 0 }
    ]),
    addSource: noop,
    removeSource: noop,
    reindex: noop,
    status: ok({
      memories: memories.length,
      chunks: 1890,
      jev: { online: true, url: 'http://127.0.0.1:8765', model: 'jev-mini' },
      embeddings: { online: true, model: 'nomic-embed-text' },
      learner: { engine: 'claude' }
    }),
    onSourcesChanged: on('sources')
  },
  onConversationsChanged: on('convs'),
  onOpenConversation: on('openConv'),
  onOpenPanel: on('panel'),
  quick: { hide: noop, resize: noop, pin: noop, openInMain: noop, onShow: on('quickShow') },
  voice: {
    status: ok({
      whisper: { found: true, path: '/opt/homebrew/bin/whisper-cli' },
      model: { name: 'base', downloaded: true, sizeMb: 142 },
      micAccess: 'granted',
      voices: ['Daniel', 'Samantha'],
      neural: { uv: true, downloaded: true, sizeMb: 340 },
      german: { downloaded: [] }
    }),
    requestMic: ok(true),
    transcribe: ok(''),
    speak: noop,
    say: noop,
    render: async () => null,
    stopSpeaking: noop,
    onSpeaking: on('speaking'),
    downloadModel: noop,
    installWhisper: noop,
    downloadNeural: noop,
    downloadGermanVoice: noop,
    onProgress: on('voiceProgress'),
    addressed: async () => 0.9,
    wake: noop,
    setLive: noop,
    onLive: on('live'),
    onLiveToggle: on('liveToggle')
  },
  automations: {
    list: async () => (scene === 'empty-auto' ? [] : automations),
    save: noop,
    remove: noop,
    runNow: noop,
    onChanged: on('automations'),
    onRun: on('automationRun'),
    regenerateToken: noop,
    setSignatureSecret: noop
  },
  webhooks: {
    status: ok<WebhookRelayStatus>({ url: settings.webhookRelayUrl, hasSecret: true, state: 'connected', connectedAt: now - 2 * hour, hooks: 1, lastDeliveryAt: now - 6 * min }),
    setRelaySecret: noop,
    reconnect: noop,
    onStatus: on('webhookStatus')
  },
  connections: {
    list: ok(connections),
    probe: ok({ kind: 'oauth' }),
    add: async () => connections[0],
    update: noop,
    reconnect: async () => connections[0],
    remove: noop,
    openBrowser: noop,
    audit: ok([
      { at: now - hour, connection: 'sentry', tool: 'search_issues', runId: 'r', outcome: 'ok' },
      { at: now - day, connection: 'vercel', tool: 'list_deployments', runId: 'r', outcome: 'ok' }
    ]),
    onChanged: on('connections')
  },
  knowledge: {
    connectors: ok(connectors),
    setSource: noop,
    discover: ok(candidates),
    projects: ok(projects),
    setFocus: ok(projects),
    updateProject: noop,
    removeProject: noop,
    sync: noop,
    brief: noop,
    overview: ok(overview),
    timeline: async (id) => items(id),
    search: async (_q, id) => items(id ?? 'atlas'),
    dismissLoop: noop,
    markSeen: noop,
    onProgress: on('kprogress'),
    onChanged: on('kchanged')
  },
  updates: {
    state: ok({ version: '0.5.0', packaged: true, status: 'none' }),
    check: noop,
    install: noop,
    onState: on('updates')
  }
}

const approvals: Record<string, ApprovalRequest> = {
  tool: {
    requestId: 'a1',
    runId: 'none',
    toolName: 'Bash',
    input: { command: 'git push -u origin fix/ATL-214-checkout-race', description: 'Push the branch so the PR can be opened' }
  },
  connect: {
    requestId: 'a2',
    runId: 'none',
    toolName: 'mcp__jarvis__connect',
    input: { reason: 'To look up the failing deploy logs for #482' },
    connect: { name: 'Vercel', url: 'https://mcp.vercel.com', kind: 'token', action: 'Jarvis stores the key encrypted and agents use it through the vault.', secretLabel: 'Vercel access token' }
  }
}

;(window as any).jarvis = api
;(window as any).jarvisFocus = () => {}
;(window as any).__mock = { emit, approve: (k: string) => emit('approval', approvals[k]) }
