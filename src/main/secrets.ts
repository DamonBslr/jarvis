import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Secrets encrypted with the OS keychain (safeStorage) — never stored in plain settings. */
const file = () => join(app.getPath('userData'), 'secrets.json')

async function readAll(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file(), 'utf8'))
  } catch {
    return {}
  }
}

export async function getSecret(name: string): Promise<string | null> {
  const enc = (await readAll())[name]
  if (!enc || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

let writes: Promise<unknown> = Promise.resolve()

/** Read-modify-write of one file: writes run one after another so concurrent saves don't drop each other. */
export function setSecret(name: string, value: string | null): Promise<void> {
  const job = writes.then(async () => {
    if (value && !safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable; refusing to store secret')
    const all = await readAll()
    if (value) all[name] = safeStorage.encryptString(value).toString('base64')
    else delete all[name]
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(file(), JSON.stringify(all), { mode: 0o600 })
  })
  writes = job.catch(() => {})
  return job
}

/** Names of stored secrets starting with a prefix (values stay encrypted). */
export async function secretNames(prefix: string): Promise<string[]> {
  return Object.keys(await readAll()).filter((k) => k.startsWith(prefix))
}
