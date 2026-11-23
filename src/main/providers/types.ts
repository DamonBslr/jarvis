import type { AgentEvent, ProviderStatus, RunRequest, Settings } from '@shared/types'

export interface RunHandle {
  cancel(): void
  /** Resolves when the run has fully ended (done, error or cancelled). */
  finished: Promise<void>
}

export interface ProviderContext {
  env: NodeJS.ProcessEnv
  settings: Settings
}

export interface Provider {
  id: RunRequest['provider']
  status(ctx: ProviderContext): Promise<ProviderStatus>
  run(req: RunRequest, ctx: ProviderContext, emit: (ev: AgentEvent) => void): RunHandle
}
