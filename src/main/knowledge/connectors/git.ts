// Local git: commits and the state you left each project repo in (uncommitted work, unpushed branches).
import { listProjects, upsertItems, type ItemInput } from '../store'
import { gitIdentity, pool, sh } from '../repos'
import { DAY, type Connector } from './types'

const FIRST_SYNC_DAYS = 90
const SEP = '\x1f'
const REC = '\x1e'

export const gitConnector: Connector = {
  id: 'git',
  name: 'Git repos',
  reads: 'Commits, branches and uncommitted work in your project repos (read-only, never pushes)',
  async detect(env) {
    try {
      const v = (await sh('git', ['--version'], { env, timeout: 5000 })).trim()
      const id = await gitIdentity(env)
      return { available: true, detail: v, account: id.email ?? id.name }
    } catch {
      return { available: false, detail: 'git not found', setup: { kind: 'command', hint: 'xcode-select --install' } }
    }
  },
  async sync(ctx) {
    const me = await gitIdentity(ctx.env)
    const projects = listProjects().filter((p) => p.path)
    const since = Math.floor((ctx.since ? ctx.since - DAY : Date.now() - FIRST_SYNC_DAYS * DAY) / 1000)
    const batches = await pool(projects, 4, async (p): Promise<ItemInput[]> => {
      const root = p.path!
      const items: ItemInput[] = []
      // Focus projects: everyone's commits (what happened while you were away). Others: yours only.
      // Branches/remotes/tags only: tools like T3 keep checkpoint refs (refs/t3/*) that aren't real work.
      const args = ['log', '--branches', '--remotes', '--tags', '--no-merges', `--since=${since}`, '-n', p.focus ? '300' : '60', `--pretty=format:%H${SEP}%s${SEP}%b${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${REC}`]
      if (!p.focus && me.email) args.push(`--author=${me.email}`)
      const log = await sh('git', args, { cwd: root, env: ctx.env }).catch(() => '')
      for (const rec of log.split(REC)) {
        const [hash, subject, body, name, email, at, refs] = rec.trim().split(SEP)
        if (!hash || !subject || /^t3 checkpoint/i.test(subject)) continue
        items.push({
          uid: `git:${root}:${hash}`,
          source: 'git',
          kind: 'commit',
          projectId: p.id,
          repo: root,
          title: subject,
          body: [body?.trim(), refs ? `refs: ${refs}` : ''].filter(Boolean).join('\n') || undefined,
          author: name,
          at: Number(at) * 1000,
          meta: { hash, mine: !!me.email && email === me.email }
        })
      }

      // Where you left it: current branch, uncommitted files, branches with work not on any remote.
      const status = await sh('git', ['status', '--porcelain=v1', '--branch'], { cwd: root, env: ctx.env }).catch(() => '')
      const [head = '', ...files] = status.split('\n').filter(Boolean)
      const branch = head.replace(/^## /, '').split('...')[0]
      const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0)
      const refs = await sh(
        'git',
        ['for-each-ref', `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(upstream:track)${SEP}%(committerdate:unix)`, 'refs/heads'],
        { cwd: root, env: ctx.env }
      ).catch(() => '')
      // Recent local branches whose commits exist on no remote: work that lives only on this Mac.
      const recent = Date.now() / 1000 - 14 * 86400
      const local = refs
        .split('\n')
        .map((l) => l.split(SEP))
        .filter(([name, up, track, at]) => name && Number(at) > recent && (!up || /ahead/.test(track ?? '')))
      const unpushed: string[] = []
      for (const [name, up] of local.slice(0, 40)) {
        const n = Number(
          (await sh('git', ['rev-list', '--count', `refs/heads/${name}`, '--not', '--remotes'], { cwd: root, env: ctx.env }).catch(() => '0')).trim()
        )
        if (n > 0) unpushed.push(`${name} (${n} commit${n === 1 ? '' : 's'}${up ? '' : ', no remote'})`)
      }
      const lines = [
        `On branch ${branch || '?'}${ahead ? `, ${ahead} commit(s) not pushed` : ''}`,
        files.length ? `${files.length} uncommitted change(s):\n${files.slice(0, 25).map((f) => '  ' + f).join('\n')}` : 'Working tree clean',
        unpushed.length ? `Branches with commits on no remote (last 14 days):\n${unpushed.map((b) => '  ' + b).join('\n')}` : ''
      ].filter(Boolean)
      const latest = items[0]?.at
      items.push({
        uid: `git:${root}:state`,
        source: 'git',
        kind: 'worktree',
        projectId: p.id,
        repo: root,
        title: `${p.name}: ${files.length ? `${files.length} uncommitted` : 'clean'} on ${branch || '?'}`,
        body: lines.join('\n'),
        state: files.length || ahead || unpushed.length ? 'dirty' : 'clean',
        // Keep the state item near the last real activity so it doesn't look like fresh news on every sync.
        at: latest ?? p.lastActivityAt ?? Date.now(),
        meta: { branch, uncommitted: files.length, ahead, unpushed }
      })
      return items
    })
    return upsertItems(batches.flat())
  }
}
