// Schedule math for automations: npx tsx scripts/automations-test.mts
import { nextRunAt, CATCH_UP_MS } from '../src/shared/schedule'
import type { AutomationSchedule } from '../src/shared/types'

let failed = 0
const ok = (cond: unknown, msg: string) => {
  if (!cond) failed++
  console.log(cond ? 'PASS' : 'FAIL', msg)
}
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const auto = (schedule: AutomationSchedule, p: { lastRunAt?: number; armedAt?: number; enabled?: boolean } = {}) => ({
  enabled: p.enabled ?? true,
  schedule,
  lastRunAt: p.lastRunAt,
  armedAt: p.armedAt ?? 0
})

// 2026-11-30 is a Monday.
const weekdays: AutomationSchedule = { kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }
const monMorning = at(2026, 11, 30, 7)
ok(nextRunAt(auto(weekdays, { armedAt: monMorning - 3600_000 }), monMorning) === at(2026, 11, 30, 8, 30), 'daily: next slot later today')
ok(
  nextRunAt(auto(weekdays, { lastRunAt: at(2026, 11, 30, 8, 30) }), at(2026, 11, 30, 9)) === at(2026, 12, 1, 8, 30),
  'daily: after running today, next is tomorrow'
)
const friEvening = at(2026, 12, 4, 20)
ok(nextRunAt(auto(weekdays, { lastRunAt: at(2026, 12, 4, 8, 30) }), friEvening) === at(2026, 12, 7, 8, 30), 'daily: skips the weekend')
// Woke up at 10:00, slot was 08:30 and never ran: due now (catch-up window).
const tenAm = at(2026, 11, 30, 10)
const caught = nextRunAt(auto(weekdays, { armedAt: at(2026, 11, 29, 12) }), tenAm)
ok(caught === at(2026, 11, 30, 8, 30) && caught! <= tenAm, 'daily: missed slot within window is due')
// Woke up in the evening: today's slot is skipped.
const evening = at(2026, 11, 30, 8, 30) + CATCH_UP_MS + 60_000
ok(nextRunAt(auto(weekdays, { armedAt: at(2026, 11, 29, 12) }), evening) === at(2026, 12, 1, 8, 30), 'daily: too late to catch up, waits for tomorrow')
// Saved at 09:00 today: the 08:30 slot must not fire retroactively.
ok(nextRunAt(auto(weekdays, { armedAt: at(2026, 11, 30, 9) }), at(2026, 11, 30, 9, 1)) === at(2026, 12, 1, 8, 30), 'daily: armedAt blocks past slots')

const every30: AutomationSchedule = { kind: 'interval', minutes: 30 }
ok(nextRunAt(auto(every30, { lastRunAt: 1_000_000 }), 1_000_000) === 1_000_000 + 30 * 60_000, 'interval: last + period')
ok(nextRunAt(auto(every30, { armedAt: 5_000_000 })) === 5_000_000 + 30 * 60_000, 'interval: counts from arming when never run')

const once: AutomationSchedule = { kind: 'once', at: 9_000_000 }
ok(nextRunAt(auto(once), 1) === 9_000_000, 'once: pending')
ok(nextRunAt(auto(once, { lastRunAt: 9_000_500 })) === undefined, 'once: done after it ran')
ok(nextRunAt(auto(once, { enabled: false })) === undefined, 'paused: no next run')

console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
