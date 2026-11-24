// Living project briefs: a model reads a focus project's docs + recent activity and writes what Jarvis should know.
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { Project, Settings } from '@shared/types'
import { runOnce } from '../providers/spawn'
import { openLoops } from './loops'
import { briefHash, recentItems, setBrief } from './store'

const DAY = 86_400_000
/** Don't rewrite a brief more often than this unless asked. */
const MIN_INTERVAL = 4 * 3600_000

const BRIEF_PROMPT = `You keep a living brief of one software project for the owner's personal assistant "Jarvis".
Jarvis reads this brief before helping the owner, so it must be accurate, dense and current.
From the project docs and the activity log below (commits, pull requests, issues, coding-agent sessions and threads), write Markdown with exactly these sections:

## What it is
1-3 sentences: purpose, users, stack (only what the material supports).
## Current state
Where the work stands right now: active branches/PRs, what was shipped recently, what is mid-flight.
## Recent work (last 2 weeks)
Up to 8 bullets, newest first, concrete ("Rebuilt coach UI on ui-sdk, PR #41 open").
## Open loops
Things waiting on the owner or left unfinished (reviews, failing checks, stalled tickets, uncommitted work, agent threads not followed up). Say "None" if none.
## Conventions & context
Up to 6 bullets: how this project is worked on (branching, commands, deploy target, people involved), only if evident.

Rules: no preamble, no invented facts, refer to the owner as "you", keep it under 450 words, use names/numbers from the material.`

function material(p: Project): { text: string; hash: string } {
  const docs = recentItems({ projectId: p.id, sources: ['docs'], limit: 12 })
  const activity = recentItems({ projectId: p.id, since: Date.now() - 21 * DAY, limit: 160 }).filter((i) => i.source !== 'docs')
  const loops = openLoops({ projectId: p.id })
  const priority = (t: string) => (/readme|claude\.md|agents\.md/i.test(t) ? 0 : /package\.json/.test(t) ? 1 : 2)
  const docText = docs
    .sort((a, b) => priority(a.title) - priority(b.title))
    .map((d) => `### ${d.title}\n${(d.body ?? '').slice(0, priority(d.title) === 0 ? 3500 : 1200)}`)
    .join('\n\n')
    .slice(0, 9000)
  const date = (t: number) => new Date(t).toISOString().slice(0, 10)
  let budget = 14_000
  const lines: string[] = []
  for (const it of activity) {
    const detail = it.kind === 'commit' ? '' : (it.body ?? '').replace(/\s+/g, ' ').slice(0, it.source === 'linear' || it.kind === 'pr' ? 300 : 450)
    const line = `- ${date(it.at)} [${it.source}/${it.kind}${it.state ? ` ${it.state}` : ''}${it.author ? ` by ${it.author}` : ''}] ${it.title}${detail ? ` — ${detail}` : ''}`
    if ((budget -= line.length) < 0) break
    lines.push(line)
  }
  const text = [
    `Project: ${p.name}${p.path ? ` (${p.path})` : ''}${p.github ? `, GitHub ${p.github}` : ''}${p.linearTeam ? `, Linear team ${p.linearTeam}` : ''}`,
    p.notes ? `Owner's notes: ${p.notes}` : '',
    `Today: ${date(Date.now())}`,
    '',
    '# Docs',
    docText || '(none)',
    '',
    '# Activity, newest first',
    lines.join('\n') || '(no activity in the last 3 weeks)',
    '',
    '# Detected open loops',
    loops.map((l) => `- [${l.kind}] ${l.title}${l.detail ? ` (${l.detail})` : ''}`).join('\n') || '(none)'
  ]
    .filter((x) => x !== '')
    .join('\n')
  // Hash what changed meaningfully: item ids + timestamps + loops + notes (not today's date).
  const hash = createHash('sha1')
    .update(JSON.stringify([activity.map((i) => [i.id, i.at]), docs.map((d) => [d.id, d.at]), loops.map((l) => l.key), p.notes ?? '']))
    .digest('hex')
  return { text, hash }
}

async function generate(input: string, settings: Settings, env: NodeJS.ProcessEnv): Promise<string> {
  if (settings.learnEngine === 'ollama') {
    const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.learnOllamaModel,
        stream: false,
        messages: [
          { role: 'system', content: BRIEF_PROMPT },
          { role: 'user', content: input }
        ]
      }),
      signal: AbortSignal.timeout(180_000)
    })
    const data = (await res.json()) as { message?: { content?: string } }
    return (data.message?.content ?? '').trim()
  }
  // Claude via the subscription, lean: no tools, MCP, hooks or saved session.
  const out = await runOnce(
    'claude',
    [
      '-p',
      '--model',
      'sonnet',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt',
      BRIEF_PROMPT,
      '--output-format',
      'json'
    ],
    { stdin: input, env, cwd: homedir(), timeoutMs: 180_000 }
  )
  const data = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { result?: string; is_error?: boolean }
  if (data.is_error) throw new Error(data.result || 'brief generation failed')
  return (data.result ?? '').trim()
}

/** Write (or refresh) one project's brief. Skips when nothing changed, unless forced. */
export async function writeBrief(p: Project, settings: Settings, env: NodeJS.ProcessEnv, force = false): Promise<boolean> {
  if (settings.learnEngine === 'off' || !settings.projectBriefs) return false
  const { text, hash } = material(p)
  if (!force && (briefHash(p.id) === hash || (p.briefAt && Date.now() - p.briefAt < MIN_INTERVAL))) return false
  const brief = await generate(text, settings, env)
  if (!brief) return false
  setBrief(p.id, brief, hash)
  return true
}
