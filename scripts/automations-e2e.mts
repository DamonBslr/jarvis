// End-to-end test of automations inside real Electron with real Claude Code (haiku, tiny prompts):
//   pnpm build && node scripts/automations-e2e.mts
// Throwaway userData. Covers the three thread targets, fresh sessions, a deleted target chat, and the
// automation_* agent tools over the stdio bridge.
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (!process.versions.electron) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-auto-e2e-'))
  const root = resolve(import.meta.dirname, '..')
  execFileSync(
    join(root, 'node_modules/.bin/esbuild'),
    [import.meta.filename, '--bundle', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${join(dir, 'main.js')}`, `--alias:@shared=${join(root, 'src/shared')}`, '--log-level=warning'],
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
  app.setName('jarvis-auto-e2e')
  app.setPath('userData', join(dir, 'userData'))
  app.dock?.hide()
  await app.whenReady()

  let failed = 0
  const ok = (c: unknown, m: string) => {
    if (!c) failed++
    console.log(c ? 'PASS' : 'FAIL', m)
  }
  try {
    const store = await import('../src/main/store')
    const autos = await import('../src/main/automations')
    const { startBridge, bridgeLaunch } = await import('../src/main/mcp/server')
    const { uid } = await import('../src/shared/chat')
    type RunRequest = import('../src/shared/types').RunRequest
    type AutomationRunEvent = import('../src/shared/types').AutomationRunEvent

    await store.saveSettings({ ...store.DEFAULT_SETTINGS, useMemory: false, learnEngine: 'off', browserTool: false, t3Tools: false })
    const fakeRuns = new Map<string, RunRequest>()
    await startBridge({
      settings: () => store.getSettings(),
      requestApproval: () => {},
      automationTool: (name, args, runId) => autos.agentTool(name, args, fakeRuns.get(runId))
    })
    const runEvents: AutomationRunEvent[] = []
    let streamed = 0
    autos.startScheduler(
      {
        conversationsChanged: () => {},
        openConversation: () => {},
        event: () => void streamed++,
        run: (ev) => void runEvents.push(ev)
      },
      () => {}
    )

    const cwd = dir
    const base = { provider: 'claude' as const, model: 'haiku', cwd, autonomy: 'ask' as const, enabled: false, notify: false, speak: false }
    const sched = { kind: 'interval' as const, minutes: 600 }
    const prompt = 'Reply with exactly one word: pong. No tools.'
    const text = (m: { parts: { type: string; text?: string }[] }) => m.parts.map((p) => p.text ?? '').join('')

    // 1) origin: a chat that exists; two runs land in it and continue its session.
    const chat = {
      id: uid(), title: 'Origin chat', provider: 'claude' as const, model: 'haiku', modeId: 'general', cwd, autonomy: 'ask' as const,
      sessions: {}, messages: [], updatedAt: Date.now()
    }
    await store.saveConversation(chat)
    await autos.saveAutomation({ id: 'origin', name: 'Origin ping', prompt, schedule: sched, thread: { kind: 'origin', convId: chat.id }, ...base })
    const c1 = await autos.runAutomation('origin')
    const s1 = (await store.loadConversation(chat.id))!.sessions.claude
    const c2 = await autos.runAutomation('origin')
    const after = (await store.loadConversation(chat.id))!
    ok(c1 === chat.id && c2 === chat.id, 'origin: both runs land in the chat they were created for')
    ok(after.messages.length === 4 && after.messages[0].automation?.id === 'origin', 'origin: 2 turns appended, user turn marked as automation')
    ok(/pong/i.test(text(after.messages[3])), `origin: real answer saved ("${text(after.messages[3]).trim().slice(0, 30)}")`)
    ok(!!s1 && !!after.sessions.claude, 'origin: session id stored for follow-ups')
    ok(runEvents.filter((e) => e.phase === 'start').length === 2 && streamed > 0, 'origin: start events + live stream emitted')

    // 2) dedicated: first run creates the chat, the second reuses it; fresh session each run.
    await autos.saveAutomation({ id: 'ded', name: 'Dedicated ping', prompt, schedule: sched, thread: { kind: 'dedicated' }, freshSession: true, ...base })
    const d1 = await autos.runAutomation('ded')
    const d1Session = (await store.loadConversation(d1!))!.sessions.claude
    const d2 = await autos.runAutomation('ded')
    const ded = (await autos.getAutomation('ded'))!
    const dchat = (await store.loadConversation(d1!))!
    ok(d1 && d1 === d2 && ded.thread.kind === 'dedicated' && ded.thread.convId === d1, 'dedicated: one chat, reused by every run')
    ok(dchat.messages.length === 4 && dchat.automationId === 'ded' && dchat.title === 'Dedicated ping', 'dedicated: chat collects runs, tagged with automation')
    ok(d1Session && dchat.sessions.claude && d1Session !== dchat.sessions.claude, 'dedicated + freshSession: new session per run')

    // 3) new: every run its own chat.
    await autos.saveAutomation({ id: 'new', name: 'New ping', prompt, schedule: sched, thread: { kind: 'new' }, ...base })
    const n1 = await autos.runAutomation('new')
    const n2 = await autos.runAutomation('new')
    ok(n1 && n2 && n1 !== n2, 'new: a new chat per run')
    const hist = (await autos.getAutomation('new'))!.history ?? []
    ok(hist.length === 2 && hist.every((h) => h.status === 'ok' && h.durationMs! > 0), 'history: runs recorded with status + duration')

    // 4) origin chat deleted: run fails, automation pauses.
    await autos.saveAutomation({ id: 'gone', name: 'Gone', prompt, schedule: sched, thread: { kind: 'origin', convId: 'doesnotexist' }, ...base, enabled: true })
    ok((await autos.runAutomation('gone')) === null, 'deleted target: nothing runs')
    const gone = (await autos.getAutomation('gone'))!
    ok(!gone.enabled && gone.history?.[0]?.status === 'failed' && /deleted/.test(gone.lastError ?? ''), 'deleted target: paused with a clear error')

    // 5) agent tools over the real stdio bridge.
    const runId = 'agent-run'
    fakeRuns.set(runId, { runId, convId: chat.id, provider: 'claude', model: 'haiku', cwd, autonomy: 'ask', prompt: '' })
    const launch = bridgeLaunch(runId, ['automations'])
    const bridge = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'inherit'] })
    let buf = ''
    const waiters = new Map<number, (v: any) => void>()
    bridge.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        waiters.get(msg.id)?.(msg)
      }
    })
    let nextId = 1
    const rpc = (method: string, params: object = {}) =>
      new Promise<any>((res) => {
        const id = nextId++
        waiters.set(id, res)
        bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } })
    const tools = (await rpc('tools/list')).result.tools.map((t: { name: string }) => t.name)
    ok(['automation_schedule', 'automation_list', 'automation_run_now', 'automation_delete'].every((n) => tools.includes(n)), 'bridge: automation tools listed')
    const call = async (name: string, args: object) => {
      const msg = await rpc('tools/call', { name, arguments: args })
      return msg.result ?? { isError: true, content: [{ type: 'text', text: msg.error?.message ?? 'error' }] }
    }
    const created = await call('automation_schedule', {
      title: 'Standup nudge',
      prompt: 'Remind me about standup.',
      schedule: { type: 'fixed_time', timeOfDay: '09:45', weekdays: [1, 2, 3, 4, 5] }
    })
    const createdText = created.content[0].text as string
    const id = /id (\w+)/.exec(createdText)?.[1]
    ok(!created.isError && id && /in this chat/.test(createdText), `agent: scheduled in this chat → ${createdText.slice(0, 90)}…`)
    const made = (await autos.getAutomation(id!))!
    ok(made.thread.kind === 'origin' && made.thread.convId === chat.id && made.createdBy === 'agent' && made.enabled, 'agent: bound to the calling chat, enabled')
    const upd = await call('automation_schedule', { id, thread: 'new', schedule: { type: 'interval', everyMinutes: 45 } })
    const updated = (await autos.getAutomation(id!))!
    ok(!upd.isError && updated.thread.kind === 'new' && updated.schedule.kind === 'interval' && updated.prompt === 'Remind me about standup.', 'agent: update changes only given fields')
    const list = (await call('automation_list', {})).content[0].text as string
    ok(list.includes('Standup nudge') && list.includes('Origin ping'), 'agent: list shows automations')
    const bad = await call('automation_schedule', { title: 'x', prompt: 'y', schedule: { type: 'fixed_time', timeOfDay: '25:00' } })
    ok(bad.isError, 'agent: invalid schedule rejected')
    await call('automation_delete', { id })
    ok(!(await autos.getAutomation(id!)), 'agent: delete removes it')
    bridge.kill()
  } catch (err) {
    failed++
    console.log('FAIL threw', err)
  }
  console.log(failed ? `${failed} failed` : 'all passed')
  app.exit(failed ? 1 : 0)
}
