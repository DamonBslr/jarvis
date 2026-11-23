// npx tsx scripts/integrations-test.mts <repoPath>
import * as git from '../src/main/integrations/git'
import * as linear from '../src/main/integrations/linear'
const ok = (c: unknown, m: string) => console.log(c ? 'PASS' : 'FAIL', m)
const repo = process.argv[2]
const s = await git.status(repo, process.env)
ok(s.isRepo && s.branch === 'main', `git status branch=${s.branch}`)
ok(s.files?.some((f) => f.path === 'src/math.ts' && f.worktree === 'M'), 'modified file parsed')
ok(s.files?.some((f) => f.path === 'TODO.md' && f.index === '?'), 'untracked file parsed')
ok(s.commits?.[0]?.subject === 'feat: initial', 'commit log parsed')
const d = await git.diff(repo, 'src/math.ts', process.env)
ok(d.includes('+export const sub'), 'diff of modified file')
const u = await git.diff(repo, 'TODO.md', process.env)
ok(u.includes('+notes'), 'diff of untracked file')
ok((await git.status('/tmp', process.env)).isRepo === false, 'non-repo detected')
try {
  await linear.viewer('lin_api_invalid')
  ok(false, 'linear rejects bad key')
} catch (e) {
  ok(true, `linear rejects bad key: ${(e as Error).message.slice(0, 80)}`)
}
