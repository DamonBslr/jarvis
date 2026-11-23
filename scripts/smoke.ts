// Headless smoke test of provider adapters: bun scripts/smoke.ts <claude|codex|ollama> "prompt"
import { loadShellEnv } from '../src/main/shellEnv'
import { claudeProvider } from '../src/main/providers/claude'
import { codexProvider } from '../src/main/providers/codex'
import { ollamaProvider } from '../src/main/providers/ollama'

const [id = 'claude', prompt = 'Run `ls` then reply with the number of entries.'] = process.argv.slice(2)
const p = { claude: claudeProvider, codex: codexProvider, ollama: ollamaProvider }[id as 'claude']
const env = await loadShellEnv()
delete env.ANTHROPIC_API_KEY
delete env.CLAUDECODE
const settings = { preferSubscription: true, ollamaUrl: 'http://127.0.0.1:11434', defaultCwd: process.cwd(), hotkey: '' }
console.log('status:', await p.status({ env, settings }))
console.log('PATH entries from login shell:', env.PATH?.split(':').length ?? 0)
const h = p.run(
  { runId: 't', provider: id as 'claude', prompt, cwd: process.cwd(), autonomy: 'ask', model: process.argv[4], sessionId: process.env.SID },
  { env, settings },
  (ev) => console.log(JSON.stringify(ev).slice(0, 200))
)
await h.finished
