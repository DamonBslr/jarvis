// When automations run. Pure, so main and tests share it.
import type { Automation } from './types'

/** A daily slot missed (asleep, app closed) still runs if we are back within this window. */
export const CATCH_UP_MS = 6 * 3600_000
export const MIN_INTERVAL_MIN = 1

/** When this automation runs next (<= now means due). undefined: off, a webhook, or a one-off that already ran. */
export function nextRunAt(a: Pick<Automation, 'enabled' | 'schedule' | 'lastRunAt' | 'armedAt'>, now = Date.now()): number | undefined {
  if (!a.enabled) return undefined
  const last = Math.max(a.lastRunAt ?? 0, a.armedAt ?? 0)
  const s = a.schedule
  switch (s.kind) {
    case 'interval':
      return last + Math.max(MIN_INTERVAL_MIN, s.minutes) * 60_000
    case 'webhook':
      return undefined // runs when a request arrives, never on a clock
    case 'once':
      return (a.lastRunAt ?? 0) >= s.at ? undefined : s.at
    case 'daily': {
      const [h, m] = s.time.split(':').map(Number)
      for (let d = 0; d <= 7; d++) {
        const slot = new Date(now)
        slot.setDate(slot.getDate() + d)
        slot.setHours(h, m, 0, 0)
        const t = slot.getTime()
        if (!s.days.includes(slot.getDay()) || t <= last) continue
        // Missed today's slot: catch up after sleep, but don't fire a morning briefing in the evening.
        if (t <= now && now - t >= CATCH_UP_MS) continue
        return t
      }
      return undefined
    }
  }
}
