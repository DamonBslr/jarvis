// Headless test of memory, RAG, routing and learning:
//   JARVIS_DB_DIR=$(mktemp -d) bun scripts/memory-test.mts [--learn]
import { DEFAULT_SETTINGS } from '../src/main/store'
import { addMemory, listMemories, searchMemories } from '../src/main/memory/memories'
import { addSource, indexSource, listSources, searchChunks } from '../src/main/memory/knowledge'
import { buildContext } from '../src/main/memory/context'
import { learnFromTurn } from '../src/main/memory/learn'
import { route } from '../src/main/classify/router'
import { MODES } from '../src/main/modes'
import { loadShellEnv } from '../src/main/shellEnv'

const settings = { ...DEFAULT_SETTINGS, jevUrl: process.env.JEV_URL ?? DEFAULT_SETTINGS.jevUrl }
const ok = (cond: unknown, msg: string) => console.log(cond ? 'PASS' : 'FAIL', msg)

addMemory({ type: 'workflow', content: 'User wants conventional commits and small PRs', pinned: false }, settings)
addMemory({ type: 'profile', content: 'User is named Alex and builds developer tools', pinned: true }, settings)
addMemory({ type: 'preference', content: 'User prefers pnpm over npm', pinned: false }, settings)

const hits = searchMemories('how should I write the commit message?', null, settings)
ok(hits[0]?.item.content.includes('conventional commits'), `memory FTS search -> ${hits[0]?.item.content}`)

const id = addSource(process.cwd() + '/src')
await indexSource(id, settings, () => {})
const src = listSources()[0]
ok(src.status === 'ready' && src.chunks > 0, `indexed ${src.files} files / ${src.chunks} chunks (${src.status} ${src.error ?? ''})`)
const chunks = searchChunks('ollama embed api', null, settings)
ok(chunks.some((c) => c.path.includes('embed')), `chunk search -> ${chunks.map((c) => c.path).join(', ')}`)

const ctx = await buildContext('commit my changes with git', settings)
ok(ctx?.text.includes('Alex') && ctx?.text.includes('conventional'), `context block has pinned + relevant (${ctx?.refs.length} refs)`)

const providers = [
  { id: 'claude' as const, available: true },
  { id: 'codex' as const, available: true },
  { id: 'ollama' as const, available: false }
]
const modes = MODES.filter((m) => m.id !== 'auto')
const r1 = await route('Create a branch for ENG-42 and fix the login bug', modes, providers, 'claude', settings)
ok(r1.modeId === 'code', `route code request -> ${r1.modeId} via ${r1.via} (${r1.confidence.toFixed(2)})`)
const r2 = await route('What should I cook tonight?', modes, providers, 'claude', settings)
ok(r2.modeId === 'general', `route general request -> ${r2.modeId} via ${r2.via}`)

if (process.argv.includes('--learn')) {
  const env = await loadShellEnv()
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE']) delete env[k]
  const t0 = Date.now()
  const learned = await learnFromTurn(
    {
      convId: 'test',
      msgId: 'm1',
      prompt: 'From now on never use npm, only pnpm. Also my main side project is called Orbit, a Tauri habit tracker.',
      answer: 'Got it.'
    },
    settings,
    env
  )
  console.log(`learned in ${Date.now() - t0}ms:`, learned?.added)
  ok(learned && learned.added.length > 0, 'learner extracted memories')
  const none = await learnFromTurn({ convId: 'test', msgId: 'm2', prompt: 'what time is it in Tokyo?', answer: '3pm' }, settings, env)
  ok(!none, 'learner skips trivial turn')
  console.log('\nall memories:\n' + listMemories().map((m) => `  [${m.type}] ${m.content}`).join('\n'))
}
