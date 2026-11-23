import type { Mode, ProviderId, ProviderStatus, RouteDecision, Settings } from '@shared/types'
import { clip, decide } from './jev'

const CODE_RX =
  /\b(git|branch|commit|merge|rebase|pull request|PR|repo|bug|fix|refactor|test|build|deploy|linear|ticket|issue|[A-Z]{2,6}-\d+|function|component|typescript|python|code|lint|CI)\b/i

/**
 * Pick a mode (and thus engine) for a new conversation's first message.
 * Jev when the decision server is up; keyword heuristic otherwise.
 */
export async function route(
  prompt: string,
  modes: Mode[],
  providers: ProviderStatus[],
  fallbackProvider: ProviderId,
  settings: Settings
): Promise<RouteDecision> {
  const status = (id: ProviderId) => providers.find((p) => p.id === id)
  const usable = (m: Mode) =>
    !m.defaultProvider ||
    (status(m.defaultProvider)?.available && (m.defaultProvider !== 'ollama' || !!status('ollama')?.models?.length))
  const candidates = modes.filter(usable)

  const providerFor = (modeId: string): ProviderId => {
    const p = modes.find((m) => m.id === modeId)?.defaultProvider
    return p && status(p)?.available ? p : fallbackProvider
  }

  const answers = await decide(settings.jevUrl, clip(prompt), {
    mode: {
      type: 'choice',
      instructions: 'Which assistant mode should handle this request from the user?',
      criteria: Object.fromEntries(candidates.map((m) => [m.id, m.description]))
    }
  })
  const a = answers?.mode
  if (a && a.type === 'choice' && candidates.some((m) => m.id === a.choice)) {
    return {
      modeId: a.choice,
      provider: providerFor(a.choice),
      confidence: a.confidence ?? a.probabilities?.[a.choice] ?? 0,
      via: 'jev',
      probabilities: a.probabilities
    }
  }

  const modeId = CODE_RX.test(prompt) && candidates.some((m) => m.id === 'code') ? 'code' : 'general'
  return { modeId, provider: providerFor(modeId), confidence: 0.5, via: 'heuristic' }
}
