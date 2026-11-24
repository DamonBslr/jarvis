// Headless test of the knowledge graph against this Mac's real data (read-only on every source):
//   JARVIS_DB_DIR=$(mktemp -d) npx tsx scripts/knowledge-test.mts [--github]
// Discovers projects from Claude Code / Codex history + code roots, focuses the top ones, syncs
// git/docs/claude/codex (+ GitHub with --github), then checks loops, search, context and tools.
import { DEFAULT_SETTINGS } from '../src/main/store'
import { loadShellEnv } from '../src/main/shellEnv'
import { discoverProjects } from '../src/main/knowledge/discover'
import { claudeHistory, codexHistory } from '../src/main/knowledge/connectors/agents'
import { gitConnector } from '../src/main/knowledge/connectors/git'
import { githubConnector } from '../src/main/knowledge/connectors/github'
import { docsConnector } from '../src/main/knowledge/connectors/local'
import { ensureProject, listProjects, ProjectIndex, recentItems, searchItems, updateProject, countItems, touchActivity } from '../src/main/knowledge/store'
import { openLoops } from '../src/main/knowledge/loops'
import { knowledgeContext } from '../src/main/knowledge/context'
import { knowledgeTool } from '../src/main/knowledge/tools'
import type { Connector } from '../src/main/knowledge/connectors/types'

const settings = { ...DEFAULT_SETTINGS, embedModel: '' }
const env = await loadShellEnv()
const ok = (cond: unknown, msg: string) => console.log(cond ? 'PASS' : 'FAIL', msg)
const t0 = Date.now()
const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

const { candidates, codeRoots } = await discoverProjects(env, settings, [claudeHistory, codexHistory], console.log)
ok(candidates.length > 0, `discovered ${candidates.length} candidate repos, code roots ${codeRoots.join(', ')} (${lap()})`)
for (const c of candidates.slice(0, 8)) console.log(`   ${c.score.toString().padStart(4)}  ${c.name}  commits30d=${c.commits30d} sessions30d=${c.sessions30d} ${c.github ?? ''}`)

const top = candidates.slice(0, 5)
for (const c of top) updateProject(ensureProject({ path: c.path, name: c.name, github: c.github }).id, { focus: true })
ok(listProjects().filter((p) => p.focus).length === top.length, `focused ${top.map((c) => c.name).join(', ')}`)

const sources: Connector[] = [gitConnector, docsConnector, claudeHistory, codexHistory, ...(process.argv.includes('--github') ? [githubConnector] : [])]
for (const c of sources) {
  const d = await c.detect(env, settings)
  if (!d.available) {
    console.log('SKIP', c.id, d.detail)
    continue
  }
  const n = await c.sync({ env, settings, projects: new ProjectIndex(), since: 0, log: console.log })
  ok(n >= 0, `${c.id}: ${n} items (${lap()})`)
}
touchActivity()
ok(countItems() > 0, `total items ${countItems()}`)

const p = listProjects().find((x) => x.focus)!
const recent = recentItems({ projectId: p.id, limit: 5 })
ok(recent.length > 0, `${p.name} recent: ${recent.map((r) => `${r.source}:${r.title.slice(0, 40)}`).join(' | ')}`)

const loops = openLoops()
console.log(`INFO ${loops.length} open loops`)
for (const l of loops.slice(0, 8)) console.log(`   [${l.kind}] ${l.projectId ?? '-'} ${l.title.slice(0, 90)}`)

const hits = searchItems(`${p.name} ui`, null, settings, { activeProject: p.id })
ok(hits.length > 0, `search -> ${hits.slice(0, 3).map((h) => h.item.title.slice(0, 50)).join(' | ')}`)

const ctx = await knowledgeContext('what did I miss this week?', null, p.path, settings, env)
ok(ctx.lines.some((l) => l.includes('Current project')), `context for ${p.name}: ${ctx.lines.length} lines, ${ctx.refs.length} refs`)

const overview = await knowledgeTool('projects_overview', {}, settings, null)
ok(overview.includes(p.name), `projects_overview: ${overview.split('\n').length} lines`)
const brief = await knowledgeTool('project_brief', { project: p.name }, settings, null)
ok(brief.includes('Latest activity'), `project_brief ${p.name}: ${brief.length} chars`)
if (process.argv.includes('--brief')) {
  const { writeBrief } = await import('../src/main/knowledge/briefs')
  const { childEnv } = await import('../src/main/runner')
  const wrote = await writeBrief(p, settings, childEnv(env, 'claude', { ...settings, preferSubscription: !process.env.ANTHROPIC_BASE_URL }), true)
  const after = listProjects().find((x) => x.id === p.id)
  ok(wrote && after?.brief?.includes('## Current state'), `brief for ${p.name} (${lap()}):\n${after?.brief}`)
}
console.log(`done in ${lap()}`)
