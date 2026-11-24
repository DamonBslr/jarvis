// What a run should know from the knowledge graph: the project you're in, your focus projects, relevant activity.
import type { ContextRef, KnowledgeItem, Project, Settings } from '@shared/types'
import { openLoops } from './loops'
import { focusProjects, listProjects, searchItems } from './store'
import { repoRoot } from './repos'

/** "what did I miss", "status", "briefing", German too. */
const CATCH_UP = /\b(miss(ed)?|catch me up|status|update|overview|briefing|what('s| is) (new|going on|happening)|where (was|were|am) i|today|this week|stand|verpasst|was (ist|gibt'?s) neu|überblick|zusammenfassung)\b/i

const date = (t: number) => new Date(t).toISOString().slice(0, 10)

export function itemLine(i: KnowledgeItem, projects: Project[], bodyChars = 350): string {
  const proj = i.projectId ? projects.find((p) => p.id === i.projectId)?.name : undefined
  const body = (i.body ?? '').replace(/\s+/g, ' ').trim().slice(0, bodyChars)
  return `- ${date(i.at)} [${i.source}/${i.kind}${i.state ? ` ${i.state}` : ''}${proj ? ` · ${proj}` : ''}] ${i.title}${i.url && !i.url.startsWith('t3-thread') ? ` <${i.url}>` : ''}${body ? `\n  ${body}` : ''}`
}

/** The project a workspace folder belongs to, else one named in the prompt. */
export async function activeProject(cwd: string | undefined, prompt: string, env: NodeJS.ProcessEnv): Promise<Project | undefined> {
  const projects = listProjects()
  if (cwd) {
    const root = await repoRoot(cwd, env)
    const p = root ? projects.find((x) => x.path === root) : undefined
    if (p) return p
  }
  const lower = prompt.toLowerCase()
  return focusProjects().find((p) => p.name.length >= 3 && new RegExp(`\\b${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower))
}

export async function knowledgeContext(
  prompt: string,
  qvec: Float32Array | null,
  cwd: string | undefined,
  settings: Settings,
  env: NodeJS.ProcessEnv
): Promise<{ lines: string[]; refs: ContextRef[] }> {
  const lines: string[] = []
  const refs: ContextRef[] = []
  const projects = listProjects()
  const focus = projects.filter((p) => p.focus)
  if (!projects.length) return { lines, refs }
  const active = await activeProject(cwd, prompt, env)

  if (focus.length) {
    lines.push('', `The user's focus projects (what they're actively working on): ${focus.map((p) => `${p.name}${p.path ? ` (${p.path})` : ''}`).join(', ')}.`)
  }

  if (active) {
    lines.push('', `Current project: ${active.name}${active.path ? ` at ${active.path}` : ''}${active.github ? ` · GitHub ${active.github}` : ''}${active.linearTeam ? ` · Linear ${active.linearTeam}` : ''}`)
    if (active.notes) lines.push(`User's notes: ${active.notes}`)
    if (active.brief) lines.push(`Brief (written ${date(active.briefAt ?? Date.now())} from the user's repos, PRs, tickets and agent threads):`, active.brief.slice(0, 3500))
    const loops = openLoops({ projectId: active.id }).slice(0, 6)
    if (loops.length) lines.push('Open loops here:', ...loops.map((l) => `- [${l.kind}] ${l.title}${l.url ? ` <${l.url}>` : ''}`))
    refs.push({ kind: 'project', id: 0, label: `${active.name} brief`, score: 1 })
  }

  if (CATCH_UP.test(prompt) && focus.length) {
    lines.push('', 'Focus project overview:')
    for (const p of focus) {
      if (p.id === active?.id) continue
      const loops = openLoops({ projectId: p.id })
      const state = p.brief?.match(/## Current state\s+([\s\S]*?)(\n## |$)/)?.[1]?.trim().replace(/\s+/g, ' ').slice(0, 400)
      lines.push(`### ${p.name}`, state ? state : '(no brief yet)')
      if (loops.length) lines.push(...loops.slice(0, 4).map((l) => `- [${l.kind}] ${l.title}`))
    }
  }

  const hits = searchItems(prompt, qvec, settings, { activeProject: active?.id, limit: 6 }).filter((h) => h.score > 0.008)
  if (hits.length) {
    lines.push('', "Possibly relevant from the user's activity (commits, PRs, tickets, agent sessions, threads):")
    for (const h of hits) {
      lines.push(itemLine(h.item, projects))
      refs.push({ kind: 'item', id: h.item.id, label: `${h.item.source}: ${h.item.title}`, score: h.score })
    }
  }
  return { lines, refs }
}
