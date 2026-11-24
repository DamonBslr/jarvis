// Jarvis's own chats, and the docs that explain each focus project (README, CLAUDE.md, AGENTS.md, docs/).
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import * as store from '../../store'
import { focusProjects, pruneItems, upsertItems, type ItemInput } from '../store'
import { repoRoot } from '../repos'
import { clip, oneLine, type Connector } from './types'

const textOf = (parts: { type: string; text?: string }[]) =>
  parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n')

export const jarvisConnector: Connector = {
  id: 'jarvis',
  name: 'Jarvis chats',
  reads: 'Your conversations with Jarvis (quick bar, voice, routines)',
  async detect() {
    return { available: true, detail: 'built in' }
  },
  async sync(ctx) {
    const convs = await store.loadConversations()
    const items: ItemInput[] = []
    for (const c of convs) {
      if (ctx.since && c.updatedAt < ctx.since - 60_000) continue
      if (!c.messages.length) continue
      const root = await repoRoot(c.cwd, ctx.env)
      const turns = c.messages
        .map((m) => ({ role: m.role, text: textOf(m.parts) }))
        .filter((m) => m.text)
      const asked = turns.filter((t) => t.role === 'user')
      const lastReply = [...turns].reverse().find((t) => t.role === 'assistant')
      items.push({
        uid: `jarvis:${c.id}`,
        source: 'jarvis',
        kind: 'chat',
        projectId: ctx.projects.repo(root),
        repo: root ?? undefined,
        title: oneLine(c.title, 120),
        body: [
          'You asked:',
          ...asked.slice(-8).map((t) => `- ${oneLine(t.text, 300)}`),
          lastReply ? `\nLast reply:\n${clip(lastReply.text, 1000)}` : ''
        ].join('\n'),
        author: 'Jarvis',
        at: c.updatedAt,
        meta: { convId: c.id, linear: c.linear?.identifier, routine: c.routineId }
      })
    }
    return upsertItems(items)
  }
}

const DOC_NAMES = /^(readme(\.[a-z]+)?|claude\.md|agents\.md|contributing\.md|architecture\.md|design\.md|product\.md|roadmap\.md|todo\.md|changelog\.md)$/i
const MAX_DOC_BYTES = 120_000
const MAX_DOCS = 30

async function projectDocs(root: string): Promise<string[]> {
  const out: string[] = []
  const top = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const e of top) if (e.isFile() && DOC_NAMES.test(e.name)) out.push(join(root, e.name))
  for (const dir of ['docs', 'doc', '.claude', 'specs', 'notes']) {
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])
    for (const e of entries) if (e.isFile() && /\.(md|mdx|txt)$/i.test(e.name)) out.push(join(root, dir, e.name))
  }
  if (await stat(join(root, 'package.json')).catch(() => null)) out.push(join(root, 'package.json'))
  return out.slice(0, MAX_DOCS)
}

/** package.json reduced to what describes the project (no lockfile-scale noise). */
function describePackage(raw: string): string {
  try {
    const p = JSON.parse(raw) as Record<string, any>
    return [
      p.name && `name: ${p.name}`,
      p.description && `description: ${p.description}`,
      p.scripts && `scripts: ${Object.keys(p.scripts).join(', ')}`,
      p.dependencies && `dependencies: ${Object.keys(p.dependencies).join(', ')}`,
      p.devDependencies && `devDependencies: ${Object.keys(p.devDependencies).join(', ')}`
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

export const docsConnector: Connector = {
  id: 'docs',
  name: 'Project docs',
  reads: 'README, CLAUDE.md, AGENTS.md and docs/ of your focus projects',
  async detect() {
    return { available: true, detail: 'reads only your focus projects' }
  },
  async sync() {
    let changed = 0
    for (const p of focusProjects().filter((x) => x.path)) {
      const root = p.path!
      const keep = new Set<string>()
      const items: ItemInput[] = []
      for (const file of await projectDocs(root)) {
        const st = await stat(file).catch(() => null)
        if (!st || st.size > MAX_DOC_BYTES) continue
        const rel = relative(root, file)
        let text = await readFile(file, 'utf8').catch(() => '')
        if (rel === 'package.json') text = describePackage(text)
        if (!text.trim()) continue
        const uid = `docs:${root}:${rel}`
        keep.add(uid)
        items.push({
          uid,
          source: 'docs',
          kind: 'doc',
          projectId: p.id,
          repo: root,
          title: `${p.name}/${rel}`,
          body: text,
          at: Math.floor(st.mtimeMs),
          meta: { path: file }
        })
      }
      changed += upsertItems(items)
      pruneItems(`docs:${root}:`, keep)
    }
    return changed
  }
}
