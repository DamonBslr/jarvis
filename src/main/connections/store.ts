import { app } from 'electron'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Connection, ConnectionAuditEntry } from '@shared/types'
import { getSecret, setSecret } from '../secrets'
import type { AuthServer, OAuthClient, TokenSet } from './oauth'

/**
 * Connections are split in two:
 *  - connections.json (plain): id, name, URL, kind, policy, notes. Nothing secret.
 *  - the vault (secrets.json, encrypted with the macOS keychain via safeStorage): tokens, refresh tokens,
 *    OAuth client registrations and API keys, under `conn.<id>`. Only the main process ever reads them;
 *    agents get tools, never credentials.
 */

export type Credentials =
  | { kind: 'oauth'; server: AuthServer; client: OAuthClient; tokens: TokenSet; account?: string }
  | { kind: 'token'; token: string }

/** Server names agents already use; a connection can't take them. */
const RESERVED = new Set(['jarvis', 'browser', 'computer', 't3', 'claude', 'codex', 'ide'])
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/

const file = () => join(app.getPath('userData'), 'connections.json')
const auditFile = () => join(app.getPath('userData'), 'connections-audit.jsonl')
const AUDIT_MAX_BYTES = 1_000_000

let cache: Connection[] | null = null

export async function listConnections(): Promise<Connection[]> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8'))
    cache = Array.isArray(parsed) ? parsed.filter((c) => c && ID_RE.test(c.id)) : []
  } catch {
    cache = []
  }
  return cache!
}

export async function getConnection(id: string): Promise<Connection | undefined> {
  return (await listConnections()).find((c) => c.id === id)
}

async function writeAll(all: Connection[]) {
  cache = all
  await mkdir(app.getPath('userData'), { recursive: true })
  const tmp = `${file()}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8')
  await rename(tmp, file())
}

export async function saveConnection(c: Connection) {
  if (!ID_RE.test(c.id)) throw new Error('invalid connection id')
  const all = (await listConnections()).filter((x) => x.id !== c.id)
  await writeAll([...all, c].sort((a, b) => a.createdAt - b.createdAt))
}

export async function deleteConnection(id: string) {
  await writeAll((await listConnections()).filter((c) => c.id !== id))
  await setSecret(`conn.${id}`, null)
}

/** A free MCP server name for a display name: "Shortlist Jobs" -> "shortlist_jobs". */
export async function freeId(name: string): Promise<string> {
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 24)
  if (!base) base = 'service'
  const taken = new Set((await listConnections()).map((c) => c.id))
  let id = base
  for (let i = 2; RESERVED.has(id) || taken.has(id); i++) id = `${base}_${i}`
  return id
}

export async function getCredentials(id: string): Promise<Credentials | null> {
  const raw = await getSecret(`conn.${id}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

export async function setCredentials(id: string, creds: Credentials | null) {
  await setSecret(`conn.${id}`, creds ? JSON.stringify(creds) : null)
}

export async function touch(id: string) {
  const c = await getConnection(id)
  if (!c) return
  // At most one write a minute per connection.
  if (c.lastUsedAt && Date.now() - c.lastUsedAt < 60_000) return
  await saveConnection({ ...c, lastUsedAt: Date.now() })
}

// ---- audit log -------------------------------------------------------------------------------------

export async function audit(entry: ConnectionAuditEntry) {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    const size = await stat(auditFile()).then((s) => s.size, () => 0)
    if (size > AUDIT_MAX_BYTES) {
      // Keep the newer half.
      const lines = (await readFile(auditFile(), 'utf8')).split('\n').filter(Boolean)
      await writeFile(auditFile(), lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 })
    }
    await appendFile(auditFile(), JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch (err) {
    console.warn('[connections] audit write failed:', err)
  }
}

export async function readAudit(limit = 50): Promise<ConnectionAuditEntry[]> {
  try {
    const lines = (await readFile(auditFile(), 'utf8')).split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .reverse()
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ConnectionAuditEntry]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
