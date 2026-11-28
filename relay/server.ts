// Jarvis webhook relay: a tiny public endpoint for a desktop app behind NAT.
//
//   sender ──POST /hooks/<hookId>/<token>──▶ relay ──SSE /client/events──▶ Jarvis (outbound connection)
//                                              ◀──POST /client/ack────────
//
// - Jarvis registers its webhook automations (id + sha256 of the URL token) with PUT /client/hooks.
//   Requests for unknown hooks or with a wrong token get 404 and are never stored.
// - Accepted requests are queued on disk (bounded) until Jarvis acks them, so nothing is lost while the
//   Mac sleeps. The raw body and headers are forwarded untouched; Jarvis checks signatures, filters,
//   dedupe and age itself.
// - The client authenticates with RELAY_SECRET (Authorization: Bearer …). One client at a time.
// - Never logs payloads, tokens or URLs with tokens.
//
// Zero dependencies; runs with Node >= 23.6 directly (type stripping): node server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const env = process.env
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d)

const PORT = num(env.PORT, 8080)
const HOST = env.HOST ?? '0.0.0.0'
const SECRET = env.RELAY_SECRET ?? ''
const DATA_DIR = env.DATA_DIR ?? join(process.cwd(), 'data')
const MAX_BODY = num(env.MAX_BODY_BYTES, 1024 * 1024)
const QUEUE_MAX = num(env.QUEUE_MAX_ITEMS, 1000)
const QUEUE_MAX_PER_HOOK = num(env.QUEUE_MAX_PER_HOOK, 200)
const QUEUE_MAX_BYTES = num(env.QUEUE_MAX_BYTES, 64 * 1024 * 1024)
const QUEUE_TTL_MS = num(env.QUEUE_TTL_HOURS, 72) * 3600_000
const RATE_PER_MIN = num(env.RATE_LIMIT_PER_MIN, 120)
const AUTH_FAIL_PER_MIN = 20
const TRUST_PROXY = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true'
const PING_MS = num(env.PING_MS, 20_000)

if (SECRET.length < 24) {
  console.error('RELAY_SECRET must be set to a random string of at least 24 characters (e.g. openssl rand -base64 32).')
  process.exit(1)
}

// ---- types ------------------------------------------------------------------

interface Delivery {
  id: string
  hookId: string
  /** When the relay received it (epoch ms); Jarvis compares it with maxDeliveryAgeMinutes. */
  receivedAt: number
  method: string
  /** Lower-cased names; repeated headers joined with ", ". */
  headers: Record<string, string>
  query: Record<string, string>
  /** Raw body, base64 (signatures are computed over these exact bytes). */
  body: string
  size: number
}

interface Hook {
  id: string
  tokenSha256: string
}

// ---- state ------------------------------------------------------------------

const hooks = new Map<string, Buffer>()
let queue: Delivery[] = []
let queueBytes = 0

const hooksFile = () => join(DATA_DIR, 'hooks.json')
const queueFile = () => join(DATA_DIR, 'queue.json')

async function load() {
  await mkdir(DATA_DIR, { recursive: true })
  try {
    for (const h of JSON.parse(await readFile(hooksFile(), 'utf8')) as Hook[]) hooks.set(h.id, Buffer.from(h.tokenSha256, 'hex'))
  } catch {
    /* first start */
  }
  try {
    queue = JSON.parse(await readFile(queueFile(), 'utf8')) as Delivery[]
  } catch {
    queue = []
  }
  prune()
}

let writes: Promise<void> = Promise.resolve()
function persist(which: 'hooks' | 'queue'): Promise<void> {
  const data =
    which === 'hooks'
      ? JSON.stringify([...hooks].map(([id, h]) => ({ id, tokenSha256: h.toString('hex') })))
      : JSON.stringify(queue)
  const path = which === 'hooks' ? hooksFile() : queueFile()
  writes = writes
    .then(async () => {
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, data, { mode: 0o600 })
      await rename(tmp, path)
    })
    .catch((err) => console.error(`persist ${which} failed:`, err instanceof Error ? err.message : err))
  return writes
}

function recount() {
  queueBytes = queue.reduce((n, d) => n + d.body.length, 0)
}

/** Drop expired deliveries and ones for hooks that are no longer registered. */
function prune(): boolean {
  const before = queue.length
  const now = Date.now()
  queue = queue.filter((d) => now - d.receivedAt < QUEUE_TTL_MS && hooks.has(d.hookId))
  recount()
  return queue.length !== before
}

// ---- helpers ----------------------------------------------------------------

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest()
const SECRET_HASH = sha256(SECRET)
const DUMMY = sha256('no-such-hook')

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra
  })
  res.end(JSON.stringify(body))
}

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    // The proxy in front (Traefik/Caddy/nginx) appends the address it saw; take the last hop.
    const xff = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (xff.length) return xff[xff.length - 1]
  }
  return req.socket.remoteAddress ?? 'unknown'
}

const windows = new Map<string, { start: number; n: number }>()
/** Fixed one-minute window per key. */
function limited(key: string, perMin: number): boolean {
  const now = Date.now()
  const w = windows.get(key)
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, n: 1 })
    return false
  }
  w.n++
  return w.n > perMin
}
setInterval(() => {
  const now = Date.now()
  for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k)
}, 60_000).unref()

function authed(req: IncomingMessage): boolean {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))
  return !!m && timingSafeEqual(sha256(m[1]), SECRET_HASH)
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) return reject(new TooLarge())
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new TooLarge())
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req, 256 * 1024)
  return raw.length ? JSON.parse(raw.toString('utf8')) : {}
}

const HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-forwarded-server',
  'x-real-ip'
])

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP.has(k)) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

const HOOK_ID = /^[A-Za-z0-9_-]{1,64}$/
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/** Constant-time: always compares against something, so unknown ids and wrong tokens look alike. */
function tokenOk(hookId: string, token: string): boolean {
  const want = hooks.get(hookId)
  const ok = timingSafeEqual(sha256(token), want ?? DUMMY)
  return ok && !!want
}

// ---- the connected Jarvis ----------------------------------------------------

interface Client {
  res: ServerResponse
  sent: Set<string>
  ping: NodeJS.Timeout
}
let client: Client | null = null

function push(c: Client, d: Delivery) {
  if (c.sent.has(d.id)) return
  c.sent.add(d.id)
  c.res.write(`id: ${d.id}\nevent: delivery\ndata: ${JSON.stringify(d)}\n\n`)
}

function openStream(req: IncomingMessage, res: ServerResponse) {
  if (client) {
    // A newer connection wins (the Mac woke up, or Jarvis restarted before the old socket timed out).
    clearInterval(client.ping)
    client.res.end()
  }
  req.socket.setTimeout(0)
  req.socket.setNoDelay(true)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  const c: Client = { res, sent: new Set(), ping: setInterval(() => res.write(': ping\n\n'), PING_MS) }
  client = c
  res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ hooks: hooks.size, queued: queue.length })}\n\n`)
  for (const d of queue) push(c, d)
  console.log(`client connected (${queue.length} queued)`)
  const close = () => {
    clearInterval(c.ping)
    if (client === c) {
      client = null
      console.log('client disconnected')
    }
  }
  req.on('close', close)
  res.on('close', close)
}

// ---- routes -------------------------------------------------------------------

async function handleHook(req: IncomingMessage, res: ServerResponse, hookId: string, token: string, query: URLSearchParams) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    // URL checks from webhook senders and humans: say whether the URL is live, store nothing.
    return tokenOk(hookId, token) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' })
  }
  if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) return send(res, 405, { error: 'method not allowed' }, { allow: 'POST, PUT, PATCH, GET' })
  if (!tokenOk(hookId, token)) {
    req.resume()
    return send(res, 404, { error: 'not found' })
  }
  let body: Buffer
  try {
    body = await readBody(req, MAX_BODY)
  } catch (err) {
    if (err instanceof TooLarge) return send(res, 413, { error: `body over ${MAX_BODY} bytes` }, { connection: 'close' })
    throw err
  }
  prune()
  const b64 = body.toString('base64')
  const perHook = queue.reduce((n, d) => n + (d.hookId === hookId ? 1 : 0), 0)
  if (queue.length >= QUEUE_MAX || perHook >= QUEUE_MAX_PER_HOOK || queueBytes + b64.length > QUEUE_MAX_BYTES) {
    console.log(`queue full, rejected delivery for ${hookId}`)
    return send(res, 503, { error: 'queue full, try again later' }, { 'retry-after': '600' })
  }
  const d: Delivery = {
    id: randomBytes(12).toString('base64url'),
    hookId,
    receivedAt: Date.now(),
    method: req.method!,
    headers: forwardedHeaders(req),
    query: Object.fromEntries(query),
    body: b64,
    size: body.length
  }
  queue.push(d)
  queueBytes += b64.length
  await persist('queue')
  if (client) push(client, d)
  console.log(`delivery ${d.id} for ${hookId}: ${d.size} bytes, ${client ? 'pushed' : 'queued (client offline)'}`)
  send(res, 202, { ok: true, id: d.id, delivered: !!client })
}

async function handleClient(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/client/events' && req.method === 'GET') return openStream(req, res)
  if (path === '/client/hooks' && req.method === 'PUT') {
    const body = await readJson(req)
    const list = Array.isArray(body?.hooks) ? (body.hooks as Hook[]) : null
    if (!list || list.length > 500) return send(res, 400, { error: 'hooks: array of {id, tokenSha256}, at most 500' })
    const next = new Map<string, Buffer>()
    for (const h of list) {
      if (!HOOK_ID.test(String(h?.id)) || !/^[0-9a-f]{64}$/.test(String(h?.tokenSha256))) return send(res, 400, { error: 'invalid hook entry' })
      next.set(h.id, Buffer.from(h.tokenSha256, 'hex'))
    }
    hooks.clear()
    for (const [k, v] of next) hooks.set(k, v)
    await persist('hooks')
    if (prune()) await persist('queue')
    return send(res, 200, { ok: true, hooks: hooks.size, queued: queue.length })
  }
  if (path === '/client/ack' && req.method === 'POST') {
    const body = await readJson(req)
    const ids = new Set(Array.isArray(body?.ids) ? body.ids.map(String) : [])
    const before = queue.length
    queue = queue.filter((d) => !ids.has(d.id))
    if (queue.length !== before) {
      recount()
      await persist('queue')
    }
    return send(res, 200, { ok: true, removed: before - queue.length, queued: queue.length })
  }
  if (path === '/client/status' && req.method === 'GET')
    return send(res, 200, { ok: true, hooks: hooks.size, queued: queue.length, connected: !!client })
  return send(res, 404, { error: 'not found' })
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://relay')
    const path = url.pathname
    const ip = clientIp(req)

    if (path === '/healthz' || path === '/') return send(res, 200, { ok: true, service: 'jarvis-relay' })

    const hook = /^\/hooks\/([^/]+)\/([^/]+)\/?$/.exec(path)
    if (hook) {
      if (limited(`ip:${ip}`, RATE_PER_MIN)) return send(res, 429, { error: 'rate limited' }, { 'retry-after': '60' })
      const [, hookId, token] = hook
      if (!HOOK_ID.test(hookId) || !TOKEN.test(token)) return send(res, 404, { error: 'not found' })
      return await handleHook(req, res, hookId, token, url.searchParams)
    }

    if (path.startsWith('/client/')) {
      if (!authed(req)) {
        req.resume()
        if (limited(`auth:${ip}`, AUTH_FAIL_PER_MIN)) return send(res, 429, { error: 'rate limited' }, { 'retry-after': '60' })
        return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      }
      return await handleClient(req, res, path)
    }
    send(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('request failed:', err instanceof Error ? err.message : err)
    send(res, err instanceof SyntaxError ? 400 : 500, { error: err instanceof SyntaxError ? 'invalid JSON' : 'internal error' })
  }
})
server.headersTimeout = 15_000
server.requestTimeout = 30_000

setInterval(() => {
  if (prune()) void persist('queue')
}, 10 * 60_000).unref()

await load()
server.listen(PORT, HOST, () => console.log(`jarvis-relay listening on ${HOST}:${PORT} (${hooks.size} hooks, ${queue.length} queued)`))

const stop = () => {
  console.log('shutting down')
  if (client) client.res.end()
  server.close()
  void writes.finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
