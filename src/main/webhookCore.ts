// What happens to one relayed webhook request: age, signature, filters, replay and coalescing.
// No Electron imports, so scripts/webhooks-test.mts can run it with plain tsx.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookDeliveryNote, WebhookSignature, WebhookTrigger } from '@shared/types'
import { DEFAULT_COALESCE_S, describeFilter, failingFilter, parseBody, payloadBlock, renderKey, type WebhookRequest } from '@shared/webhook'

/** What the relay forwards (see relay/server.ts). */
export interface RelayDelivery {
  id: string
  hookId: string
  receivedAt: number
  method: string
  headers: Record<string, string>
  query: Record<string, string>
  /** Raw body, base64. */
  body: string
  size: number
}

/** A run waiting to start. */
export interface PendingRun {
  automationId: string
  deliveryId: string
  receivedAt: number
  /** Not before this time (trailing coalesced runs wait for the window to close). */
  runAfter: number
  coalesceKey?: string
  /** Requests folded into this run. */
  merged: number
  full: string
  short: string
}

/** Per automation: replay keys seen and open coalesce windows. */
export interface HookState {
  seen: Record<string, number>
  windows: Record<string, number>
}

export const REPLAY_TTL_MS = 7 * 86400_000
const REPLAY_MAX = 1000

export function toRequest(d: RelayDelivery): { req: WebhookRequest; raw: Buffer } {
  const raw = Buffer.from(d.body, 'base64')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.headers ?? {})) headers[k.toLowerCase()] = String(v)
  return {
    raw,
    req: { method: d.method, headers, query: d.query ?? {}, body: parseBody(raw.toString('utf8'), headers['content-type']) }
  }
}

/** HMAC of the raw body against the signature header, in constant time. */
export function verifySignature(raw: Buffer, headers: Record<string, string>, sig: WebhookSignature, secret: string): boolean {
  const got = headers[sig.header.toLowerCase()]
  if (!got || !secret) return false
  if (sig.prefix && !got.startsWith(sig.prefix)) return false
  const digest = got.slice(sig.prefix.length).trim()
  const want = createHmac(sig.algorithm ?? 'sha256', secret).update(raw).digest()
  let given: Buffer
  if (sig.encoding === 'hex') {
    if (!/^[0-9a-fA-F]+$/.test(digest)) return false
    given = Buffer.from(digest, 'hex')
  } else {
    given = Buffer.from(digest, 'base64')
  }
  return given.length === want.length && timingSafeEqual(given, want)
}

export type Decision =
  | { action: 'skip'; note: WebhookDeliveryNote; /** also worth a line in the run history */ history?: boolean }
  | { action: 'run'; note: WebhookDeliveryNote; run: PendingRun }
  | { action: 'merged'; note: WebhookDeliveryNote; into: PendingRun }

/**
 * Decide what to do with a delivery. Mutates `state` (replay keys, windows) and, for merges, the pending run.
 * Coalescing: the first request for a key runs right away and opens a window; requests for the same key
 * inside the window fold into one follow-up run when it closes (with the latest payload), and a request
 * whose key already has a run waiting folds into that run.
 */
export function decide(input: {
  trigger: WebhookTrigger
  delivery: RelayDelivery
  secret: string | null
  state: HookState
  pending: PendingRun[]
  now: number
}): Decision {
  const { trigger, delivery: d, state, now } = input
  const at = now
  const { req, raw } = toRequest(d)

  if (trigger.maxDeliveryAgeMinutes && now - d.receivedAt > trigger.maxDeliveryAgeMinutes * 60_000) {
    const mins = Math.round((now - d.receivedAt) / 60_000)
    return { action: 'skip', history: true, note: { at, outcome: 'too-old', detail: `Held ${mins} min while Jarvis was offline (limit ${trigger.maxDeliveryAgeMinutes})` } }
  }
  if (trigger.signature) {
    if (!input.secret) return { action: 'skip', history: true, note: { at, outcome: 'bad-signature', detail: 'No signature secret stored for this automation' } }
    if (!verifySignature(raw, req.headers, trigger.signature, input.secret))
      return { action: 'skip', history: true, note: { at, outcome: 'bad-signature', detail: `Signature in ${trigger.signature.header} did not match` } }
  }
  const failed = failingFilter(req, trigger.filters)
  if (failed) return { action: 'skip', note: { at, outcome: 'filtered', detail: `Did not match: ${describeFilter(failed)}` } }

  prune(state, now)
  const replay = renderKey(trigger.dedupe?.replayKey, req)
  if (replay !== undefined) {
    if (state.seen[replay] !== undefined) return { action: 'skip', note: { at, outcome: 'duplicate', detail: `Replay of ${replay}` } }
    state.seen[replay] = now
  }

  const block = payloadBlock(req, { receivedAt: d.receivedAt, size: d.size, signatureHeader: trigger.signature?.header })
  const run: PendingRun = {
    automationId: d.hookId,
    deliveryId: d.id,
    receivedAt: d.receivedAt,
    runAfter: now,
    merged: 1,
    full: block.full,
    short: block.short
  }

  const key = renderKey(trigger.dedupe?.coalesceKey, req)
  if (key === undefined) return { action: 'run', run, note: { at, outcome: 'queued' } }
  run.coalesceKey = key

  const waiting = input.pending.find((p) => p.automationId === d.hookId && p.coalesceKey === key)
  if (waiting) {
    const merged = waiting.merged + 1
    const b = payloadBlock(req, { receivedAt: d.receivedAt, size: d.size, signatureHeader: trigger.signature?.header, merged })
    Object.assign(waiting, { merged, full: b.full, short: b.short, deliveryId: d.id, receivedAt: d.receivedAt })
    return { action: 'merged', into: waiting, note: { at, outcome: 'coalesced', detail: `Folded into the waiting run for ${key} (${merged} requests)` } }
  }
  const windowEnd = state.windows[key]
  if (windowEnd !== undefined && d.receivedAt < windowEnd) {
    run.runAfter = Math.max(windowEnd, now)
    return { action: 'run', run, note: { at, outcome: 'coalesced', detail: `Runs when the window for ${key} closes` } }
  }
  state.windows[key] = d.receivedAt + (trigger.dedupe?.coalesceWindowSeconds ?? DEFAULT_COALESCE_S) * 1000
  return { action: 'run', run, note: { at, outcome: 'queued' } }
}

function prune(state: HookState, now: number) {
  for (const [k, t] of Object.entries(state.seen)) if (now - t > REPLAY_TTL_MS) delete state.seen[k]
  const keys = Object.keys(state.seen)
  if (keys.length > REPLAY_MAX) {
    keys.sort((a, b) => state.seen[a] - state.seen[b])
    for (const k of keys.slice(0, keys.length - REPLAY_MAX)) delete state.seen[k]
  }
  for (const [k, end] of Object.entries(state.windows)) if (now - end > 3600_000) delete state.windows[k]
}
