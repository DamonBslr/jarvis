// Webhook triggers for automations. Jarvis runs behind NAT, so a small public relay (relay/server.ts) takes
// the requests and Jarvis holds an outbound connection to it:
//
//   1. PUT  <relay>/client/hooks   registers every enabled webhook automation (id + sha256 of its URL token),
//                                  so the relay turns away unknown hooks and wrong tokens without storing them.
//   2. GET  <relay>/client/events  server-sent events: queued requests first, then live ones.
//   3. POST <relay>/client/ack     once a request is decided (and, when it runs, saved as a pending run).
//
// Signatures, filters, replay/coalesce and age are checked here (webhookCore), on the raw body the relay
// forwards untouched. Runs go through runAutomation like any other trigger.
import { app, powerMonitor } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Automation, AutomationView, WebhookDeliveryNote, WebhookRelayStatus } from '@shared/types'
import * as store from './store'
import { getSecret, secretNames, setSecret } from './secrets'
import { getAutomation, isBusy, listAutomations, recordSkipped, runAutomation, setWebhookBridge } from './automations'
import { decide, REPLAY_TTL_MS, type HookState, type PendingRun, type RelayDelivery } from './webhookCore'

const RELAY_SECRET = 'webhook-relay'
const tokenKey = (id: string) => `webhook-token:${id}`
const sigKey = (id: string) => `webhook-sig:${id}`
/** The relay pings every 20 s; this long without a byte means the connection is dead. */
const WATCHDOG_MS = 65_000
const MAX_BACKOFF_MS = 60_000

// ---- persisted state ------------------------------------------------------------

interface State {
  hooks: Record<string, HookState & { last?: WebhookDeliveryNote }>
  pending: PendingRun[]
  /** Relay delivery ids already handled (the relay re-sends anything whose ack got lost). */
  processed: Record<string, number>
}

const stateFile = () => join(app.getPath('userData'), 'webhooks.json')
let state: State | null = null

async function loadState(): Promise<State> {
  if (state) return state
  try {
    const s = JSON.parse(await readFile(stateFile(), 'utf8')) as Partial<State>
    state = { hooks: s.hooks ?? {}, pending: s.pending ?? [], processed: s.processed ?? {} }
  } catch {
    state = { hooks: {}, pending: [], processed: {} }
  }
  return state
}

let saving: Promise<void> = Promise.resolve()
function saveState(): Promise<void> {
  const s = state
  if (!s) return saving
  const now = Date.now()
  for (const [k, t] of Object.entries(s.processed)) if (now - t > REPLAY_TTL_MS) delete s.processed[k]
  const data = JSON.stringify(s)
  saving = saving
    .then(async () => {
      await mkdir(app.getPath('userData'), { recursive: true })
      const tmp = `${stateFile()}.${process.pid}.tmp`
      await writeFile(tmp, data, { mode: 0o600 })
      await rename(tmp, stateFile())
    })
    .catch((err) => console.error('[webhooks] saving state failed', err))
  return saving
}

const hookState = (s: State, id: string) => (s.hooks[id] ??= { seen: {}, windows: {} })

// ---- tokens, secrets, URLs -------------------------------------------------------

const tokens = new Map<string, string>()

async function tokenFor(id: string, create: boolean): Promise<string | null> {
  const cached = tokens.get(id)
  if (cached) return cached
  let t = await getSecret(tokenKey(id))
  if (!t && create) {
    t = randomBytes(24).toString('base64url')
    await setSecret(tokenKey(id), t)
  }
  if (t) tokens.set(id, t)
  return t
}

export async function regenerateToken(id: string) {
  const a = await getAutomation(id)
  if (!a || a.schedule.kind !== 'webhook') throw new Error('Not a webhook automation')
  tokens.delete(id)
  await setSecret(tokenKey(id), null)
  await tokenFor(id, true)
  await registerHooks()
}

export async function setSignatureSecret(id: string, secret: string | null) {
  const v = secret?.trim() || null
  if (v && v.length > 512) throw new Error('Signature secret is too long')
  await setSecret(sigKey(id), v)
}

/** "https://relay.example.com/" -> "https://relay.example.com"; http only for this machine. */
export function normalizeRelayUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '')
  if (!s) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('Relay URL is not a valid URL')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Relay URL must start with https://')
  if (u.search || u.hash) throw new Error('Relay URL must not have a query or fragment')
  return s
}

async function relayConfig(): Promise<{ url: string; secret: string } | null> {
  const s = await store.getSettings()
  let url = ''
  try {
    url = normalizeRelayUrl(s.webhookRelayUrl ?? '')
  } catch {
    return null
  }
  const secret = await getSecret(RELAY_SECRET)
  return url && secret ? { url, secret } : null
}

async function info(a: Automation): Promise<AutomationView['webhook']> {
  const s = await loadState()
  const settings = await store.getSettings()
  let base = ''
  try {
    base = normalizeRelayUrl(settings.webhookRelayUrl ?? '')
  } catch {
    /* shown as an error in Settings */
  }
  const token = await tokenFor(a.id, true)
  return {
    url: base && token ? `${base}/hooks/${a.id}/${token}` : undefined,
    hasSecret: !!(await getSecret(sigKey(a.id))),
    lastDelivery: s.hooks[a.id]?.last,
    pending: s.pending.filter((p) => p.automationId === a.id).length
  }
}

// ---- relay connection ---------------------------------------------------------------

let status: WebhookRelayStatus = { url: '', hasSecret: false, state: 'off', hooks: 0 }
let onStatus: (s: WebhookRelayStatus) => void = () => {}
let generation = 0
let conn: AbortController | null = null
let wake: (() => void) | null = null

function setStatus(p: Partial<WebhookRelayStatus>) {
  status = { ...status, ...p }
  if (status.state !== 'error') delete status.error
  onStatus(status)
}

export async function relayStatus(): Promise<WebhookRelayStatus> {
  const s = await store.getSettings()
  return { ...status, url: s.webhookRelayUrl ?? '', hasSecret: !!(await getSecret(RELAY_SECRET)) }
}

export async function setRelaySecret(secret: string | null) {
  const v = secret?.trim() || null
  if (v && v.length < 24) throw new Error('Use at least 24 characters (Generate makes a strong one)')
  await setSecret(RELAY_SECRET, v)
  restart()
}

async function relayFetch(cfg: { url: string; secret: string }, path: string, init: RequestInit = {}) {
  const res = await fetch(cfg.url + path, {
    ...init,
    headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(15_000)
  })
  if (res.status === 401) throw new RelayAuthError('The relay rejected the secret')
  if (!res.ok) throw new Error(`Relay answered ${res.status}`)
  return res
}
class RelayAuthError extends Error {}

/** Tell the relay which hooks exist (enabled webhook automations) and their token hashes. */
export async function registerHooks(): Promise<void> {
  const cfg = await relayConfig()
  if (!cfg) return
  const hooks: { id: string; tokenSha256: string }[] = []
  for (const a of await listAutomations()) {
    if (a.schedule.kind !== 'webhook' || !a.enabled) continue
    const t = await tokenFor(a.id, true)
    if (t) hooks.push({ id: a.id, tokenSha256: createHash('sha256').update(t).digest('hex') })
  }
  await relayFetch(cfg, '/client/hooks', { method: 'PUT', body: JSON.stringify({ hooks }) })
  setStatus({ hooks: hooks.length })
}

const sleep = (ms: number, gen: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      if (wake === done) wake = null
      resolve()
    }
    if (gen === generation) wake = done
  })

async function connectLoop(gen: number) {
  let backoff = 1000
  while (gen === generation) {
    const settings = await store.getSettings()
    status.url = settings.webhookRelayUrl ?? ''
    status.hasSecret = !!(await getSecret(RELAY_SECRET))
    const cfg = await relayConfig()
    if (!cfg) {
      const s = settings
      let error: string | undefined
      try {
        normalizeRelayUrl(s.webhookRelayUrl ?? '')
      } catch (e) {
        error = (e as Error).message
      }
      setStatus(error ? { state: 'error', error, connectedAt: undefined } : { state: 'off', connectedAt: undefined })
      return
    }
    const ctrl = new AbortController()
    conn = ctrl
    let watchdog: NodeJS.Timeout | undefined
    const alive = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => ctrl.abort(new Error('Relay went quiet')), WATCHDOG_MS)
    }
    try {
      setStatus({ state: 'connecting' })
      await registerHooks()
      alive()
      const res = await relayFetch(cfg, '/client/events', { headers: { accept: 'text/event-stream' }, signal: ctrl.signal })
      if (!res.body) throw new Error('Relay sent no stream')
      setStatus({ state: 'connected', connectedAt: Date.now() })
      backoff = 1000
      await readEvents(res.body, alive, (event, data) => {
        if (event === 'delivery') enqueue(JSON.parse(data) as RelayDelivery, cfg)
      })
      if (gen === generation) setStatus({ state: 'connecting', connectedAt: undefined })
    } catch (err) {
      if (gen !== generation) return
      const auth = err instanceof RelayAuthError
      setStatus({ state: 'error', error: friendly(err), connectedAt: undefined })
      if (auth) backoff = MAX_BACKOFF_MS
    } finally {
      clearTimeout(watchdog)
      if (conn === ctrl) conn = null
    }
    if (gen !== generation) return
    await sleep(backoff * (0.8 + Math.random() * 0.4), gen)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

function friendly(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } }
  const code = e?.cause?.code
  if (code === 'ENOTFOUND') return 'Relay host not found'
  if (code === 'ECONNREFUSED') return 'Relay refused the connection'
  if (e?.name === 'TimeoutError') return 'Relay did not answer in time'
  return e?.message ?? String(err)
}

async function readEvents(body: ReadableStream<Uint8Array>, alive: () => void, onEvent: (event: string, data: string) => void) {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    alive()
    buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        const c = line.indexOf(':')
        const field = c < 0 ? line : line.slice(0, c)
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length) onEvent(event, data.join('\n'))
    }
  }
}

/** Reconnect from scratch (settings changed, secret changed, Mac woke up). */
export function restart() {
  generation++
  conn?.abort()
  wake?.()
  void connectLoop(generation)
}

export async function reconnect() {
  restart()
}

// ---- deliveries ------------------------------------------------------------------------

let chain: Promise<void> = Promise.resolve()
const toAck = new Set<string>()
let ackTimer: NodeJS.Timeout | undefined

function enqueue(d: RelayDelivery, cfg: { url: string; secret: string }) {
  chain = chain
    .then(() => handle(d))
    .catch((err) => console.error('[webhooks] delivery failed', err))
    .then(() => {
      toAck.add(d.id)
      clearTimeout(ackTimer)
      ackTimer = setTimeout(() => void flushAcks(cfg), 150)
    })
}

async function flushAcks(cfg: { url: string; secret: string }) {
  const ids = [...toAck]
  if (!ids.length) return
  try {
    await relayFetch(cfg, '/client/ack', { method: 'POST', body: JSON.stringify({ ids }) })
    ids.forEach((id) => toAck.delete(id))
  } catch {
    // The relay re-sends unacked deliveries on the next connection; `processed` keeps them from running twice.
  }
}

/** Decide one delivery and remember the outcome. Exported for tests. */
export async function handle(d: RelayDelivery): Promise<WebhookDeliveryNote | null> {
  const s = await loadState()
  if (s.processed[d.id]) return null
  s.processed[d.id] = Date.now()
  setStatus({ lastDeliveryAt: Date.now() })
  const a = await getAutomation(String(d.hookId))
  if (!a || a.schedule.kind !== 'webhook') {
    await saveState()
    return null
  }
  const hs = hookState(s, a.id)
  if (!a.enabled) {
    hs.last = { at: Date.now(), outcome: 'paused', detail: 'The automation is paused' }
    await saveState()
    return hs.last
  }
  const decision = decide({
    trigger: a.schedule,
    delivery: d,
    secret: a.schedule.signature ? await getSecret(sigKey(a.id)) : null,
    state: hs,
    pending: s.pending,
    now: Date.now()
  })
  hs.last = decision.note
  if (decision.action === 'run') s.pending.push(decision.run)
  await saveState()
  if (decision.action === 'skip' && decision.history) await recordSkipped(a.id, decision.note.detail ?? decision.note.outcome)
  else notifyChanged()
  pump()
  return decision.note
}

// ---- running ---------------------------------------------------------------------------

const starting = new Set<string>()
let pumpTimer: NodeJS.Timeout | undefined
let changed: () => void = () => {}
const notifyChanged = () => changed()

let pumping = false
let pumpAgain = false

/** Start every pending run that is due and whose automation is free. One pass at a time. */
function pump() {
  if (pumping) {
    pumpAgain = true
    return
  }
  pumping = true
  void (async () => {
    try {
      do {
        pumpAgain = false
        await pumpOnce()
      } while (pumpAgain)
    } catch (err) {
      console.error('[webhooks] pump failed', err)
    } finally {
      pumping = false
    }
  })()
}

async function pumpOnce() {
  clearTimeout(pumpTimer)
  {
    const s = await loadState()
    const now = Date.now()
    let soonest = Infinity
    for (const p of [...s.pending]) {
      if (p.runAfter > now) {
        soonest = Math.min(soonest, p.runAfter)
        continue
      }
      if (starting.has(p.automationId) || isBusy(p.automationId)) {
        soonest = Math.min(soonest, now + 3000)
        continue
      }
      const a = await getAutomation(p.automationId)
      s.pending = s.pending.filter((x) => x !== p)
      if (!a || !a.enabled || a.schedule.kind !== 'webhook') {
        await saveState()
        continue
      }
      starting.add(a.id)
      await saveState()
      void runAutomation(a.id, 'webhook', { full: p.full, short: p.short }).finally(() => {
        starting.delete(a.id)
        pump()
      })
    }
    if (soonest < Infinity) pumpTimer = setTimeout(pump, Math.max(250, soonest - Date.now()))
  }
}

// ---- lifecycle ---------------------------------------------------------------------------

let syncTimer: NodeJS.Timeout | undefined

/** Automations changed: re-register hooks (debounced) and drop secrets of deleted ones. */
export function automationsChanged() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void sync(), 400)
}

async function sync() {
  const list = await listAutomations()
  const ids = new Set(list.filter((a) => a.schedule.kind === 'webhook').map((a) => a.id))
  for (const name of [...(await secretNames('webhook-token:')), ...(await secretNames('webhook-sig:'))]) {
    const id = name.slice(name.indexOf(':') + 1)
    if (!ids.has(id)) {
      tokens.delete(id)
      await setSecret(name, null)
    }
  }
  const s = await loadState()
  const before = s.pending.length
  s.pending = s.pending.filter((p) => ids.has(p.automationId))
  for (const id of Object.keys(s.hooks)) if (!ids.has(id)) delete s.hooks[id]
  if (before !== s.pending.length) await saveState()
  if (status.state === 'connected') await registerHooks().catch(() => {})
}

export function startWebhooks(opts: { onStatus: (s: WebhookRelayStatus) => void; changed: () => void }) {
  onStatus = (s) => opts.onStatus({ ...s })
  changed = opts.changed
  setWebhookBridge({ info, setSignatureSecret })
  restart()
  pump()
  powerMonitor.on('resume', () => setTimeout(restart, 2000))
}
