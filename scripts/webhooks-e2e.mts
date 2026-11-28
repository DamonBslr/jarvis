// End-to-end test of webhook automations: the real relay (relay/server.ts) on localhost, the app's relay
// client inside real Electron, and a real Claude Code run (haiku, tiny prompt):
//   pnpm build && node scripts/webhooks-e2e.mts
// Throwaway userData and relay data dir.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const RELAY_SECRET = 'e2e-relay-secret-0123456789abcdef'
const SIG_SECRET = 'e2e-signing-secret'

if (!process.versions.electron) void launch()
else void electronMain()

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-hook-e2e-'))
  const root = resolve(import.meta.dirname, '..')
  execFileSync(
    join(root, 'node_modules/.bin/esbuild'),
    [import.meta.filename, '--bundle', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${join(dir, 'main.js')}`, `--alias:@shared=${join(root, 'src/shared')}`, '--log-level=warning'],
    { stdio: 'inherit' }
  )
  copyFileSync(join(root, 'out/main/bridge.js'), join(dir, 'bridge.js'))
  const port = 18000 + Math.floor(Math.random() * 2000)
  const relay: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'relay/server.ts')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(dir, 'relay-data'), RELAY_SECRET, PING_MS: '2000' },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  relay.stdout!.on('data', (d) => process.stdout.write(`  [relay] ${d}`))
  await new Promise<void>((res) => relay.stdout!.on('data', (d) => String(d).includes('listening') && res()))
  const electron = join(root, 'node_modules/.bin/electron')
  const child = spawn(electron, [join(dir, 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, JARVIS_E2E_DIR: dir, JARVIS_RELAY: `http://127.0.0.1:${port}` }
  })
  child.on('exit', (code) => {
    relay.kill()
    process.exit(code ?? 1)
  })
}

async function electronMain() {
  const { app } = await import('electron')
  const dir = process.env.JARVIS_E2E_DIR!
  const relayUrl = process.env.JARVIS_RELAY!
  app.setName('jarvis-hook-e2e')
  app.setPath('userData', join(dir, 'userData'))
  app.dock?.hide()
  await app.whenReady()

  let failed = 0
  const ok = (c: unknown, m: string) => {
    if (!c) failed++
    console.log(c ? 'PASS' : 'FAIL', m)
  }
  const until = async <T,>(fn: () => Promise<T> | T, ms = 20_000): Promise<T | undefined> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 200))
    }
    return undefined
  }
  try {
    const store = await import('../src/main/store')
    const secrets = await import('../src/main/secrets')
    const autos = await import('../src/main/automations')
    const hooks = await import('../src/main/webhooks')
    type WebhookRelayStatus = import('../src/shared/types').WebhookRelayStatus
    type RunRequest = import('../src/shared/types').RunRequest

    await store.saveSettings({ ...store.DEFAULT_SETTINGS, useMemory: false, learnEngine: 'off', browserTool: false, t3Tools: false, webhookRelayUrl: relayUrl })
    await secrets.setSecret('webhook-relay', RELAY_SECRET)
    let relay: WebhookRelayStatus | null = null
    autos.startScheduler(
      { conversationsChanged: () => {}, openConversation: () => {}, event: () => {}, run: () => {} },
      () => hooks.automationsChanged()
    )
    hooks.startWebhooks({ onStatus: (s) => void (relay = s), changed: () => {} })
    ok(await until(() => relay?.state === 'connected'), 'client connects to the relay')

    const relayStatus = async () =>
      (await (await fetch(`${relayUrl}/client/status`, { headers: { authorization: `Bearer ${RELAY_SECRET}` } })).json()) as { hooks: number; queued: number; connected: boolean }

    // A webhook automation: GitHub-style signature, filter, replay key; each run in a new chat.
    const id = 'hook1'
    await hooks.setSignatureSecret(id, SIG_SECRET)
    await autos.saveAutomation({
      id,
      name: 'Webhook echo',
      prompt: 'Reply with exactly the value of body.word from the webhook request below and nothing else. No tools.\n\n{{payload}}',
      schedule: {
        kind: 'webhook',
        filters: [{ path: 'body.action', op: 'equals', value: 'opened' }],
        signature: { header: 'x-hub-signature-256', encoding: 'hex', prefix: 'sha256=', algorithm: 'sha256' },
        dedupe: { replayKey: '{{headers.x-delivery}}' }
      },
      thread: { kind: 'new' },
      provider: 'claude',
      model: 'haiku',
      cwd: dir,
      autonomy: 'ask',
      enabled: true,
      notify: false,
      speak: false
    })
    ok(await until(async () => (await relayStatus()).hooks === 1), 'hook registered with the relay')
    const view = (await autos.automationViews()).find((a) => a.id === id)!
    const url = view.webhook?.url ?? ''
    ok(url.startsWith(`${relayUrl}/hooks/${id}/`) && url.length > relayUrl.length + 30, `view has the webhook URL (${url.replace(/[^/]{8}$/, '…')})`)

    ok((await fetch(url)).status === 200, 'GET on the URL: 200 (live check)')
    ok((await fetch(url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).status === 404, 'wrong token: 404')
    ok((await fetch(`${relayUrl}/hooks/nope/${'x'.repeat(32)}`, { method: 'POST', body: '{}' })).status === 404, 'unknown hook: 404, nothing stored')

    const post = (body: object, headers: Record<string, string> = {}, sign = true) => {
      const raw = JSON.stringify(body)
      const sig = createHmac('sha256', SIG_SECRET).update(raw).digest('hex')
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sign ? { 'x-hub-signature-256': `sha256=${sig}` } : {}), ...headers },
        body: raw
      })
    }
    const last = async () => (await autos.automationViews()).find((a) => a.id === id)!.webhook?.lastDelivery
    const history = async () => (await autos.getAutomation(id))!.history ?? []

    // 1) Unsigned: the relay accepts (it can't know), the app rejects and records it.
    const unsigned = await post({ action: 'opened', word: 'nope' }, { 'x-delivery': 'u1' }, false)
    ok(unsigned.status === 202, 'relay accepts the request (202)')
    ok(await until(async () => (await last())?.outcome === 'bad-signature'), 'unsigned request rejected by the app')
    ok(await until(async () => (await history())[0]?.status === 'skipped' && (await history())[0]?.trigger === 'webhook'), 'bad signature shows in the run history')

    // 2) Signed but filtered out.
    await post({ action: 'closed', word: 'nope' }, { 'x-delivery': 'f1' })
    ok(await until(async () => (await last())?.outcome === 'filtered'), 'non-matching request filtered')

    // 3) Signed + matching: a real run.
    const t0 = Date.now()
    await post({ action: 'opened', word: 'pineapple' }, { 'x-delivery': 'd1' })
    const ran = await until(async () => {
      const h = await history()
      return h[0]?.trigger === 'webhook' && h[0].status !== 'skipped' && h[0].at >= t0 - 1000 ? h[0] : undefined
    }, 180_000)
    ok(ran?.status === 'ok' && ran.convId, `webhook run finished (${ran?.status ?? 'timeout'}${ran?.detail ? `: ${ran.detail}` : ''})`)
    if (ran?.convId) {
      const conv = (await store.loadConversation(ran.convId))!
      const text = (m: { parts: { type: string; text?: string }[] }) => m.parts.map((p) => p.text ?? '').join('')
      ok(/\[webhook request/.test(text(conv.messages[0])) && !/pineapple/.test(text(conv.messages[0])), 'chat bubble shows a stand-in, not the raw payload')
      ok(/pineapple/i.test(text(conv.messages[1])), `agent read the payload ("${text(conv.messages[1]).trim().slice(0, 40)}")`)
    }

    // 4) Same delivery key again: dropped as a replay.
    await post({ action: 'opened', word: 'again' }, { 'x-delivery': 'd1' })
    ok(await until(async () => (await last())?.outcome === 'duplicate'), 'replayed delivery dropped')
    ok(await until(async () => (await relayStatus()).queued === 0), 'relay queue drained (all acked)')

    // 5) Jarvis offline: the relay queues; on reconnect the request is delivered.
    await store.saveSettings({ ...(await store.getSettings()), webhookRelayUrl: '' })
    hooks.restart()
    ok(await until(async () => !(await relayStatus()).connected), 'client disconnected')
    const offline = await (await post({ action: 'closed' }, { 'x-delivery': 'o1' })).json()
    ok(offline.delivered === false && (await relayStatus()).queued === 1, 'relay queued the request while Jarvis was offline')
    const before = (await last())?.at ?? 0
    await store.saveSettings({ ...(await store.getSettings()), webhookRelayUrl: relayUrl })
    hooks.restart()
    ok(await until(async () => ((await last())?.at ?? 0) > before && (await relayStatus()).queued === 0), 'queued request delivered and acked after reconnect')

    // 6) Agent tool: schedule a webhook automation, get its URL back.
    const run: RunRequest = { runId: 'r', convId: 'conv-x', provider: 'claude', model: 'haiku', cwd: dir, autonomy: 'ask', prompt: '' }
    const reply = await autos.agentTool(
      'automation_schedule',
      {
        title: 'Agent hook',
        prompt: 'Summarize the request.',
        thread: 'new',
        schedule: { type: 'webhook', filters: [{ path: 'headers.x-event', op: 'in', value: ['push', 'tag'] }], signature: { header: 'x-sig', encoding: 'base64', prefix: '', secret: 'abc' } }
      },
      run
    )
    const agentUrl = /webhookUrl: (\S+)/.exec(reply)?.[1]
    ok(agentUrl?.startsWith(`${relayUrl}/hooks/`), `agent tool returns webhookUrl → ${reply.slice(0, 70)}…`)
    ok(await until(async () => (await relayStatus()).hooks === 2), 'agent-made hook registered')
    let threw = ''
    await autos.agentTool('automation_schedule', { title: 'x', prompt: 'y', schedule: { type: 'webhook', signature: { header: 'x-sig', encoding: 'hex', prefix: '' } } }, run).catch((e) => (threw = e.message))
    ok(/secret is required/.test(threw), 'agent tool: signature without a secret is refused')

    // 7) Regenerate the token: the old URL stops working.
    await hooks.regenerateToken(id)
    const fresh = (await autos.automationViews()).find((a) => a.id === id)!.webhook!.url!
    ok(fresh !== url && (await fetch(url)).status === 404 && (await fetch(fresh)).status === 200, 'regenerated token: old URL 404, new URL 200')

    // 8) Pausing unregisters the hook.
    await autos.saveAutomation({ ...(await autos.getAutomation(id))!, enabled: false })
    ok(await until(async () => (await fetch(fresh)).status === 404), 'paused automation: URL answers 404')
  } catch (err) {
    failed++
    console.log('FAIL threw', err)
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  app.exit(failed ? 1 : 0)
}
