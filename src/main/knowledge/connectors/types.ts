import type { ConnectorId, ConnectorInfo, Settings } from '@shared/types'
import type { ProjectIndex } from '../store'

export interface SyncContext {
  env: NodeJS.ProcessEnv
  settings: Settings
  projects: ProjectIndex
  /** Last successful sync of this connector (0 = first run). */
  since: number
  log(message: string): void
}

/** Activity per repo root, for project discovery. */
export interface RepoActivity {
  root: string
  sessions: number
  lastAt: number
  t3ProjectId?: string
}

export interface Connector {
  id: ConnectorId
  name: string
  reads: string
  detect(env: NodeJS.ProcessEnv, settings: Settings): Promise<Pick<ConnectorInfo, 'available' | 'detail' | 'account' | 'setup'>>
  /** Pull new/changed items into the store. Returns how many changed. */
  sync(ctx: SyncContext): Promise<number>
  /** Repos this source has seen activity in (agent sessions), for discovery. */
  activity?(env: NodeJS.ProcessEnv, settings: Settings, sinceMs: number): Promise<RepoActivity[]>
}

export const DAY = 86_400_000

export const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+\n/g, '\n').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export const oneLine = (s: string | undefined, n: number) => clip((s ?? '').replace(/\s+/g, ' '), n)
