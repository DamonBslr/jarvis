// Text answers for the agents' knowledge tools (served through the Jarvis MCP bridge).
import type { ConnectorId, Settings } from '@shared/types'
import { embed } from '../memory/embed'
import { itemLine } from './context'
import { openLoops } from './loops'
import { findProject, focusProjects, listProjects, recentItems, searchItems } from './store'

const DAY = 86_400_000
const SOURCES: ConnectorId[] = ['git', 'github', 'linear', 't3', 'claude', 'codex', 'jarvis', 'docs']

function needProject(ref: unknown) {
  const p = findProject(String(ref ?? ''))
  if (!p) {
    const names = listProjects()
      .map((x) => x.name)
      .slice(0, 30)
      .join(', ')
    throw new Error(`No project "${String(ref)}". Known projects: ${names || '(none yet — the user can add them in Jarvis → Projects)'}`)
  }
  return p
}

export async function knowledgeTool(name: string, args: any, settings: Settings, vec?: Float32Array | null): Promise<string> {
  const projects = listProjects()
  switch (name) {
    case 'projects_overview': {
      const focus = focusProjects()
      if (!focus.length) return 'No focus projects set yet. The user picks them in Jarvis → Projects.'
      const out: string[] = []
      for (const p of focus) {
        const loops = openLoops({ projectId: p.id })
        const state = p.brief?.match(/## Current state\s+([\s\S]*?)(\n## |$)/)?.[1]?.trim()
        out.push(
          `## ${p.name}${p.path ? ` (${p.path})` : ''}${p.github ? ` · ${p.github}` : ''}`,
          state ?? '(no brief yet)',
          loops.length ? `Open loops:\n${loops.slice(0, 8).map((l) => `- [${l.kind}] ${l.title}${l.url ? ` <${l.url}>` : ''}`).join('\n')}` : 'Open loops: none',
          ''
        )
      }
      const other = openLoops().filter((l) => !l.projectId || !focus.some((p) => p.id === l.projectId))
      if (other.length) out.push('## Elsewhere', ...other.slice(0, 10).map((l) => `- [${l.kind}] ${l.title}${l.url ? ` <${l.url}>` : ''}`))
      return out.join('\n')
    }
    case 'project_brief': {
      const p = needProject(args.project)
      const loops = openLoops({ projectId: p.id })
      const recent = recentItems({ projectId: p.id, limit: 40 })
        .filter((i) => i.kind !== 'doc')
        .slice(0, 20)
      return [
        `# ${p.name}`,
        [p.path && `Path: ${p.path}`, p.github && `GitHub: ${p.github}`, p.linearTeam && `Linear team: ${p.linearTeam}`, p.focus ? 'Focus project' : 'Not a focus project']
          .filter(Boolean)
          .join(' · '),
        p.notes ? `User's notes: ${p.notes}` : '',
        p.brief ? `\n${p.brief}` : '\n(No brief written yet.)',
        `\n## Open loops (live)\n${loops.map((l) => `- [${l.kind}] ${l.title}${l.url ? ` <${l.url}>` : ''}`).join('\n') || 'None'}`,
        `\n## Latest activity\n${recent.map((i) => itemLine(i, projects, 200)).join('\n') || 'None synced yet'}`
      ]
        .filter(Boolean)
        .join('\n')
    }
    case 'knowledge_search': {
      const q = String(args.query ?? '').trim()
      if (!q) throw new Error('query is required')
      const p = args.project ? needProject(args.project) : undefined
      const source = SOURCES.includes(args.source) ? (args.source as ConnectorId) : undefined
      const qvec = vec !== undefined ? vec : ((await embed([q], settings))?.[0] ?? null)
      const hits = searchItems(q, qvec, settings, {
        projectId: p?.id,
        sources: source ? [source] : undefined,
        since: Number(args.days) > 0 ? Date.now() - Number(args.days) * DAY : undefined,
        limit: Math.min(Number(args.limit) || 10, 25)
      })
      if (!hits.length) return 'No matching activity.'
      return `Activity matching "${q}":\n${hits.map((h) => itemLine(h.item, projects, 600)).join('\n')}`
    }
    case 'recent_activity': {
      const days = Math.min(Math.max(Number(args.days) || 7, 1), 90)
      const since = Date.now() - days * DAY
      const p = args.project ? needProject(args.project) : undefined
      const ids = p ? [p.id] : focusProjects().map((x) => x.id)
      const items = ids
        .flatMap((id) => recentItems({ projectId: id, since, limit: 60 }))
        .filter((i) => i.kind !== 'doc')
        .sort((a, b) => b.at - a.at)
        .slice(0, 80)
      if (!items.length) return `Nothing in the last ${days} days.`
      return items.map((i) => itemLine(i, projects, 160)).join('\n')
    }
    case 'open_loops': {
      const p = args.project ? needProject(args.project) : undefined
      const loops = openLoops({ projectId: p?.id })
      if (!loops.length) return 'Nothing waiting on the user.'
      return loops
        .slice(0, 40)
        .map((l) => {
          const proj = l.projectId ? projects.find((x) => x.id === l.projectId)?.name : undefined
          return `- [${l.kind}${proj ? ` · ${proj}` : ''}] ${l.title}${l.detail ? ` (${l.detail})` : ''}${l.url ? ` <${l.url}>` : ''}`
        })
        .join('\n')
    }
    default:
      throw new Error(`unknown knowledge tool ${name}`)
  }
}
