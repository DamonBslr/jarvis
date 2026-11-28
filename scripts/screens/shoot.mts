// Design screenshots of the renderer with a mocked API: pnpm screens [outDir]
// Serves src/renderer with Vite, injects scripts/screens/mock.ts in place of the preload, and captures each scene.
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createServer, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, type Page } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const out = resolve(process.argv[2] ?? resolve(root, 'screens'))
mkdirSync(out, { recursive: true })

const injectMock: Plugin = {
  name: 'inject-mock',
  transformIndexHtml: (html) =>
    html
      .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
      .replace('<script type="module" src="/src/main.tsx">', `<script type="module" src="/@fs${resolve(import.meta.dirname, 'mock.ts')}"></script>\n    <script type="module" src="/src/main.tsx">`)
}

const server = await createServer({
  configFile: false,
  root: resolve(root, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
  plugins: [react(), injectMock],
  server: { port: 5199, strictPort: false, fs: { allow: [root] } },
  logLevel: 'error'
})
await server.listen()
const base = server.resolvedUrls!.local[0]

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })

type Scene = { name: string; url: string; size?: { width: number; height: number }; prep?: (p: Page) => Promise<void> }
const click = (text: string) => async (p: Page) => {
  await p.getByRole('button', { name: text, exact: true }).first().click()
}
const scenes: Scene[] = [
  { name: '01-home', url: '?scene=home' },
  { name: '02-chat', url: '?scene=chat' },
  { name: '03-chat-linear', url: '?scene=chat', prep: click('Linear') },
  { name: '04-approval', url: '?scene=chat', prep: (p) => p.evaluate(() => (window as any).__mock.approve('tool')) },
  { name: '05-connect', url: '?scene=chat', prep: (p) => p.evaluate(() => (window as any).__mock.approve('connect')) },
  { name: '06-projects', url: '?scene=chat', prep: click('Projects') },
  { name: '07-memory', url: '?scene=chat', prep: click('Memory') },
  { name: '08-automations', url: '?scene=chat', prep: click('Automations') },
  {
    name: '08b-automation-edit',
    url: '?scene=chat',
    prep: async (p) => {
      await click('Automations')(p)
      await p.waitForTimeout(200)
      await p.locator('.auto-row-main').first().click()
    }
  },
  {
    name: '08c-automation-new-for-chat',
    url: '?scene=chat',
    prep: async (p) => {
      await p.getByRole('button', { name: 'New automation for this chat' }).click()
      await p.waitForTimeout(200)
      await p.locator('.auto-template').nth(1).click()
    }
  },
  {
    name: '08e-automation-run-in-chat',
    url: '?scene=chat',
    prep: (p) =>
      p.evaluate(async () => {
        const m = (window as any).__mock
        const conv = await (window as any).jarvis.loadConversations().then((cs: any[]) => cs[0])
        const at = Date.now()
        const user = { id: 'au', role: 'user', createdAt: at, parts: [{ type: 'text', text: 'Check the checks on PR #482. If any failed, find out why and fix it.' }], automation: { id: 'r2', name: 'Watch CI on #482' } }
        const asst = { id: 'aa', role: 'assistant', provider: 'claude', createdAt: at, parts: [] }
        m.emit('automationRun', { phase: 'start', automationId: 'r2', runId: 'run-x', msgId: 'aa', provider: 'claude', conv: { ...conv, messages: [...conv.messages, user, asst] } })
        await new Promise((r) => setTimeout(r, 50))
        m.emit('event', 'run-x', { kind: 'text', delta: 'All checks on **#482** are green now — ' })
        m.emit('event', 'run-x', { kind: 'text', delta: 'e2e passed 3 runs in a row.' })
        await new Promise((r) => setTimeout(r, 50))
        document.querySelector('.messages')!.scrollTop = 1e6
      })
  },
  { name: '08d-automations-empty', url: '?scene=empty-auto', prep: click('Automations') },
  {
    name: '08f-automation-webhook',
    url: '?scene=chat',
    size: { width: 1440, height: 1500 },
    prep: async (p) => {
      await click('Automations')(p)
      await p.waitForTimeout(200)
      await p.locator('.auto-row-main', { hasText: 'Review new pull requests' }).click()
    }
  },
  {
    name: '08g-automation-webhook-new',
    url: '?scene=chat',
    size: { width: 1440, height: 1500 },
    prep: async (p) => {
      await click('Automations')(p)
      await p.waitForTimeout(200)
      await p.getByRole('button', { name: 'New automation', exact: true }).first().click()
      await p.waitForTimeout(150)
      await p.locator('.auto-template', { hasText: 'GitHub pull request' }).click()
    }
  },
  {
    name: '09b-settings-webhook-relay',
    url: '?scene=chat',
    size: { width: 1440, height: 1100 },
    prep: async (p) => {
      await click('Settings')(p)
      await p.waitForTimeout(150)
      await p.locator('.panel').getByRole('button', { name: /tools/i }).first().click()
      await p.waitForTimeout(100)
      await p.locator('.relay-status').evaluate((el) => el.scrollIntoView({ block: 'end' }))
    }
  },
  { name: '09-settings', url: '?scene=chat', prep: click('Settings') },
  {
    name: '10-settings-connections',
    url: '?scene=chat',
    prep: async (p) => {
      await click('Settings')(p)
      await p.waitForTimeout(150)
      await p.locator('.panel').getByRole('button', { name: /connections/i }).first().click()
    }
  },
  { name: '11-onboarding', url: '?scene=onboarding' },
  { name: '12-quickbar', url: '?scene=chat#quick', size: { width: 808, height: 168 } }
]

// The real window is frameless with macOS traffic lights inset top-left; draw them so the chrome reads as it does in the app.
const trafficLights = () => {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:fixed;top:18px;left:18px;display:flex;gap:8px;z-index:99999;pointer-events:none'
  for (const c of ['#ff5f57', '#febc2e', '#28c840']) {
    const d = document.createElement('div')
    d.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c};box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.25)`
    wrap.appendChild(d)
  }
  document.body.appendChild(wrap)
}
// The quick bar is a transparent floating window; show it over a desktop-like backdrop.
const quickBackdrop = () => {
  document.documentElement.style.background = 'radial-gradient(120% 140% at 20% 0%, #3a4a63 0%, #1d2433 45%, #12151c 100%)'
  document.body.style.padding = '24px'
  // macOS draws the panel's shadow (hasShadow: true); approximate it.
  const q = document.querySelector<HTMLElement>('.quick')
  if (q) q.style.boxShadow = '0 22px 48px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05)'
}

const only = process.env.SCENES?.split(',')
for (const s of scenes) {
  if (only && !only.some((o) => s.name.includes(o))) continue
  // Fresh context per scene so localStorage (e.g. the remembered workbench tab) never leaks between scenes.
  const ctx = await browser.newContext({ viewport: s.size ?? { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base + s.url)
  await page.waitForSelector('#root > *')
  await page.waitForTimeout(400)
  try {
    await s.prep?.(page)
  } catch (e) {
    errors.push(`prep: ${(e as Error).message.split('\n')[0]}`)
  }
  await page.waitForTimeout(500)
  if (process.env.EVAL) console.log(await page.evaluate(process.env.EVAL))
  await page.evaluate(s.url.includes('#quick') ? quickBackdrop : trafficLights)
  await page.waitForTimeout(50)
  await page.screenshot({ path: resolve(out, `${s.name}.png`) })
  console.log(`${s.name}${errors.length ? `  !! ${errors.join(' | ')}` : ''}`)
  await ctx.close()
}

await browser.close()
await server.close()
console.log(`saved to ${out}`)
