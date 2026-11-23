// End-to-end test of connections inside real Electron (keychain vault, bridge server, stdio bridge proxy):
//   pnpm build && node scripts/connections-e2e.mts
// Bundles this file's Electron half with esbuild, runs it with Electron under a throwaway userData dir and app
// name (its own keychain entry), against the local mock OAuth + MCP server.
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (!process.versions.electron) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-conn-e2e-'))
  const root = resolve(import.meta.dirname, '..')
  execFileSync(
    join(root, 'node_modules/.bin/esbuild'),
    [import.meta.filename, '--bundle', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${join(dir, 'main.js')}`, `--alias:@shared=${join(root, 'src/shared')}`],
    { stdio: 'inherit' }
  )
  copyFileSync(join(root, 'out/main/bridge.js'), join(dir, 'bridge.js'))
  const electron = join(root, 'node_modules/.bin/electron')
  const child = spawn(electron, [join(dir, 'main.js')], { stdio: 'inherit', env: { ...process.env, JARVIS_E2E_DIR: dir } })
  child.on('exit', (code) => process.exit(code ?? 1))
} else {
  void electronMain()
}

async function electronMain() {
  const { app } = await import('electron')
  const dir = process.env.JARVIS_E2E_DIR!
  app.setName('jarvis-conn-e2e')
  app.setPath('userData', join(dir, 'userData'))
  app.dock?.hide()
  await app.whenReady()

  let failed = 0
  const ok = (c: unknown, m: string) => {
    if (!c) failed++
    console.log(c ? 'PASS' : 'FAIL', m)
  }
  try {
    const { startMock, fakeBrowser } = await import('./lib/mock-oauth-mcp.mts')
    const { startBridge, respondApproval } = await import('../src/main/mcp/server')
    const conns = await import('../src/main/connections')
    const store = await import('../src/main/connections/store')
    const { DEFAULT_SETTINGS } = await import('../src/main/store')
    const mock = await startMock()

    // Approvals: answer from a script instead of a window.
    let answer: 'allow' | 'deny' = 'allow'
    const asked: string[] = []
    await startBridge({
      settings: async () => DEFAULT_SETTINGS,
      requestApproval: (req) => {
        asked.push(req.toolName)
        setTimeout(() => respondApproval(req.requestId, answer === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'nope' }), 10)
      }
    })

    // 1. Add via OAuth: discovery, registration, PKCE sign-in, vault.
    const added = await conns.addConnection({ url: `${mock.origin}/mcp` }, fakeBrowser)
    ok(added.state === 'connected' && added.kind === 'oauth', `added ${added.id} (${added.state}${added.detail ? ': ' + added.detail : ''})`)
    ok(added.name === 'Mock Jobs' && added.id === 'mock_jobs', `name/id from metadata (${added.name}/${added.id})`)
    ok(added.account === 'owner@example.com', `acting as ${added.account}`)
    ok(added.tools?.length === 2, 'two tools')
    const creds = await store.getCredentials(added.id)
    ok(creds?.kind === 'oauth' && !!creds.tokens.refreshToken, 'tokens in the vault')
    const { readFileSync } = await import('node:fs')
    const plain = readFileSync(join(dir, 'userData', 'connections.json'), 'utf8') + readFileSync(join(dir, 'userData', 'secrets.json'), 'utf8')
    ok(creds?.kind === 'oauth' && !plain.includes(creds.tokens.accessToken) && !plain.includes(creds.tokens.refreshToken!), 'no plaintext token on disk')

    // 2. What an agent run gets.
    const contribution = async (autonomy: 'ask' | 'edit' | 'full', interactive = true, runId = `run-${autonomy}-${interactive}`) => ({
      runId,
      c: (await conns.connectionTools({
        settings: DEFAULT_SETTINGS,
        req: { runId, provider: 'claude', prompt: '', cwd: dir, autonomy },
        env: process.env,
        interactive
      }))!
    })
    const { runId, c } = await contribution('edit')
    const spec = c.servers[added.id] as { command: string; args: string[]; env: Record<string, string> }
    ok(!!spec && c.allowedTools?.includes(`mcp__${added.id}`), 'server + allowedTools for the connection')
    ok(c.hint?.includes('owner@example.com') && c.hint.includes('writes ask the user first'), 'hint names account and policy')
    const fresh = await store.getCredentials(added.id)
    ok(fresh?.kind === 'oauth' && !JSON.stringify(c).includes(fresh.tokens.accessToken), 'no token in the CLI-facing spec')

    // 3. Speak MCP to the bridge exactly like Claude Code / Codex would.
    const bridge = (s: typeof spec) => {
      const p = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ['pipe', 'pipe', 'inherit'] })
      let buf = ''
      const waiting = new Map<number, (v: any) => void>()
      p.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          const msg = JSON.parse(line)
          waiting.get(msg.id)?.(msg)
        }
      })
      let id = 0
      const rpc = (method: string, params?: unknown) =>
        new Promise<any>((res) => {
          const n = ++id
          waiting.set(n, res)
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
        })
      return { rpc, close: () => p.kill() }
    }

    const b = bridge(spec)
    const init = await b.rpc('initialize', { protocolVersion: '2025-06-18' })
    ok(init.result?.serverInfo?.name === added.id && init.result?.instructions === 'Use list_jobs first.', 'initialize forwards server instructions')
    const listed = await b.rpc('tools/list')
    ok(listed.result?.tools?.length === 2, 'tools/list through the proxy')
    const read = await b.rpc('tools/call', { name: 'list_jobs', arguments: {} })
    ok(read.result?.content?.[0]?.text === 'called list_jobs' && asked.length === 0, 'read tool runs without approval')
    const write = await b.rpc('tools/call', { name: 'save_job', arguments: { title: 'x' } })
    ok(write.result?.content?.[0]?.text === 'called save_job' && asked.at(-1) === `mcp__${added.id}__save_job`, 'write tool asked first (policy ask), then ran')
    answer = 'deny'
    const denied = await b.rpc('tools/call', { name: 'save_job', arguments: {} })
    ok(denied.result?.isError === true, 'denied write -> tool error')
    answer = 'allow'

    // 4. Token expires (2 s): the proxy refreshes on its own.
    await new Promise((r) => setTimeout(r, 2200))
    const afterExpiry = await b.rpc('tools/call', { name: 'list_jobs', arguments: {} })
    ok(afterExpiry.result?.content?.[0]?.text === 'called list_jobs', 'expired token refreshed transparently')
    const rotated = await store.getCredentials(added.id)
    ok(rotated?.kind === 'oauth' && rotated.tokens.refreshToken !== (creds as any).tokens.refreshToken, 'rotated refresh token saved')
    b.close()

    // 5. Policies.
    await conns.updateConnection(added.id, { policy: 'auto' })
    const autoRun = await contribution('edit', true, 'run-auto')
    const b2 = bridge(autoRun.c.servers[added.id] as typeof spec)
    await b2.rpc('initialize', {})
    const before = asked.length
    const autoWrite = await b2.rpc('tools/call', { name: 'save_job', arguments: {} })
    ok(autoWrite.result?.content?.[0]?.text === 'called save_job' && asked.length === before, 'policy auto: write runs without asking')
    b2.close()

    const askRun = await contribution('ask', true, 'run-readonly')
    const b3 = bridge(askRun.c.servers[added.id] as typeof spec)
    await b3.rpc('initialize', {})
    const roList = await b3.rpc('tools/list')
    ok(roList.result?.tools?.map((t: any) => t.name).join() === 'list_jobs', 'read-only run lists only read tools')
    const roWrite = await b3.rpc('tools/call', { name: 'save_job', arguments: {} })
    ok(roWrite.result?.isError === true, 'read-only run cannot call write tools')
    b3.close()

    await conns.updateConnection(added.id, { policy: 'ask' })
    const unattended = await contribution('full', false, 'run-routine')
    const b4 = bridge(unattended.c.servers[added.id] as typeof spec)
    await b4.rpc('initialize', {})
    answer = 'deny' // what requestApproval does when no window owns the run
    const routineWrite = await b4.rpc('tools/call', { name: 'save_job', arguments: {} })
    ok(routineWrite.result?.isError === true, 'unattended run: write with policy ask is not done without approval')
    answer = 'allow'
    b4.close()

    // 6. Agent-side listing through the jarvis bridge group.
    const { bridgeLaunch } = await import('../src/main/mcp/server')
    const jb = bridge(bridgeLaunch(runId, ['connections']) as typeof spec)
    await jb.rpc('initialize', {})
    const jl = await jb.rpc('tools/list')
    ok(jl.result?.tools?.some((t: any) => t.name === 'connect_service'), 'jarvis bridge offers connect_service')
    const listing = await jb.rpc('tools/call', { name: 'connections_list', arguments: {} })
    ok(/mock_jobs/.test(listing.result?.content?.[0]?.text ?? ''), 'connections_list shows the connection')
    jb.close()

    // 7. Audit + removal.
    const log = await conns.readAudit(50)
    ok(log.some((e) => e.outcome === 'denied') && log.some((e) => e.outcome === 'ok'), `audit has ${log.length} entries incl. ok + denied`)
    await conns.removeConnection(added.id)
    ok(!(await store.getConnection(added.id)) && !(await store.getCredentials(added.id)), 'remove deletes metadata and vault entry')

    mock.close()
  } catch (err) {
    failed++
    console.log('FAIL crashed:', err)
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed')
  app.exit(failed ? 1 : 0)
}
