import { addDaysIso } from '../../lib/dates'
import { num } from '../../lib/format'
import type { Row } from '../../lib/api'

/**
 * Anticipated-ship-date rules — empirical quantiles from
 * docs/late-shipment-analysis.md (§4), trained on shipped orders
 * Oct 2025 – Jul 2026 and backtested on June 2026 (holdout):
 * P50 coverage 47–56% (target 50%), P80 coverage 83–88% with the
 * backlog trigger active. All values are CALENDAR days remaining.
 *
 * Layer B: remaining days conditioned on age since acceptance (the hazard is
 * U-shaped — the tail re-expands past ~8 days). The print-start table overrides
 * the age table when it is tighter. Layer C replaces both once past due.
 * Re-fit quarterly or after capacity changes.
 */

interface Q {
  p50: number
  p80: number
  p90: number
}

/** Layer B — remaining days by age bucket (doc §4 rules 1–8, Apr–Jun regime for P80/P90). */
const AGE_RULES: Record<'FormNow' | 'Xometry', { maxAge: number; q: Q }[]> = {
  FormNow: [
    { maxAge: 1, q: { p50: 5, p80: 8, p90: 10 } },
    { maxAge: 3, q: { p50: 3, p80: 6, p90: 9 } },
    { maxAge: 7, q: { p50: 2, p80: 6, p90: 8 } },
    { maxAge: Infinity, q: { p50: 3, p80: 6, p90: 9 } },
  ],
  Xometry: [
    { maxAge: 1, q: { p50: 4, p80: 7, p90: 9 } },
    { maxAge: 3, q: { p50: 3, p80: 5, p90: 7 } },
    { maxAge: 7, q: { p50: 2, p80: 5, p90: 8 } },
    { maxAge: Infinity, q: { p50: 2, p80: 6, p90: 9 } },
  ],
}

/** Layer B — remaining days by days-since-first-ORDER_PRINTING (doc §4 rules 9–10). */
const PRINT_RULES: Record<'FormNow' | 'Xometry', { maxK: number; q: Q }[]> = {
  FormNow: [
    { maxK: 3, q: { p50: 2, p80: 5, p90: 8 } },
    { maxK: 6, q: { p50: 2, p80: 6, p90: 10 } },
    { maxK: Infinity, q: { p50: 2, p80: 7, p90: 13 } },
  ],
  Xometry: [
    { maxK: 3, q: { p50: 1, p80: 4, p90: 6 } },
    { maxK: 6, q: { p50: 1, p80: 4, p90: 7 } },
    { maxK: Infinity, q: { p50: 1, p80: 5, p90: 8 } },
  ],
}

/** Layer C — for past-due orders: days AFTER the due date (doc §4 rule 11). */
const PAST_DUE_RULES: Record<'FormNow' | 'Xometry', { withFailure: Q; clean: Q }> = {
  FormNow: { withFailure: { p50: 3, p80: 7, p90: 13 }, clean: { p50: 2, p80: 6, p90: 11 } },
  Xometry: { withFailure: { p50: 2, p80: 5, p90: 8 }, clean: { p50: 1, p80: 3, p90: 5 } },
}

/** Failure dose offsets (doc §3.4 / §4 rule 12 + dose table). */
function failureOffset(failEvents: number): Q {
  if (failEvents >= 8) return { p50: 3, p80: 8, p90: 10 }
  if (failEvents >= 4) return { p50: 2, p80: 4, p90: 5 }
  if (failEvents >= 1) return { p50: 1, p80: 2, p90: 3 }
  return { p50: 0, p80: 0, p90: 0 }
}

/** Backlog trigger thresholds (doc §3.5 / §6): family backlog in the top band → +2d at P80/P90. */
export const BACKLOG_HIGH = { sla: 120, sls: 70, total: 168 }

/**
 * Shipping happens Mon–Fri only (0 Sunday ships, 0.9% Saturday, historically),
 * and never on company holidays — a predicted date must land on a shipping day.
 * Holiday list mirrors dim_date.is_business_day for 2026.
 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
])

export function isShippingDay(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(iso)
}

/** Roll a predicted date forward to the next shipping day. */
export function rollToShippingDay(iso: string): string {
  let d = iso
  for (let i = 0; i < 10 && !isShippingDay(d); i++) d = addDaysIso(d, 1)
  return d
}

export interface Backlog {
  slaOpen: number
  slsOpen: number
  totalOpen: number
}

export interface Prediction {
  p50: string
  p80: string
  p90: string
  risk: 'on-track' | 'at-risk' | 'likely-late' | 'past-due'
  drivers: string[]
}

function backlogHigh(family: string, b: Backlog): boolean {
  if (family === 'SLA') return b.slaOpen >= BACKLOG_HIGH.sla || b.totalOpen >= BACKLOG_HIGH.total
  if (family === 'SLS' || family === 'Mixed') return b.slsOpen >= BACKLOG_HIGH.sls || b.totalOpen >= BACKLOG_HIGH.total
  return b.totalOpen >= BACKLOG_HIGH.total
}

function pickRule<T extends { q: Q }>(rules: (T & { maxAge?: number; maxK?: number })[], v: number): Q {
  for (const r of rules) if (v <= (r.maxAge ?? r.maxK ?? Infinity)) return r.q
  return rules[rules.length - 1].q
}

/** Predict from a predictor_features row. `today` = ISO date (ET). */
export function predictShip(row: Row, today: string): Prediction {
  const channel = (String(row.channel) === 'Xometry' ? 'Xometry' : 'FormNow') as 'FormNow' | 'Xometry'
  const family = String(row.family ?? 'Unknown')
  const age = num(row.age_days) ?? 0
  const daysSincePrint = num(row.days_since_print)
  const failEvents = num(row.fail_events) ?? 0
  const onHold = row.on_hold === true
  const dueDate = row.due_date ? String(row.due_date).slice(0, 10) : null
  const daysPastDue = num(row.days_past_due)
  const backlog: Backlog = {
    slaOpen: num(row.sla_open) ?? 0,
    slsOpen: num(row.sls_open) ?? 0,
    totalOpen: num(row.total_open) ?? 0,
  }
  const lotsBinned = num(row.lots_binned) ?? 0
  const lotsPendingBin = num(row.lots_pending_bin) ?? 0
  const lotsQuarantined = num(row.lots_quarantined) ?? 0
  const lotsSeen = num(row.lots_seen) ?? 0
  const drivers: string[] = []

  // ----- Floor-state override: all lots binned = ready to ship ---------------
  // Historically 100% of shipped orders had their last Binned event before
  // shipping, median 47 minutes before — an all-binned order ships on the next
  // truck regardless of age or history.
  const allBinned = lotsBinned > 0 && lotsBinned >= lotsPendingBin && lotsBinned >= lotsSeen - lotsQuarantined && !onHold
  if (allBinned) {
    drivers.push(`all ${lotsBinned} lot${lotsBinned === 1 ? '' : 's'} binned — ready to ship`)
    const p50d = rollToShippingDay(today)
    const p80d = rollToShippingDay(addDaysIso(today, 1))
    const p90d = rollToShippingDay(addDaysIso(today, 2))
    const risk: Prediction['risk'] =
      dueDate && daysPastDue !== null && daysPastDue > 0 ? 'past-due' : dueDate && p80d > dueDate ? 'at-risk' : 'on-track'
    if (daysPastDue !== null && daysPastDue > 0) drivers.push(`${daysPastDue}d past due`)
    return { p50: p50d, p80: p80d, p90: p90d, risk, drivers }
  }

  // ----- Layer C: already past due — measured from the due date --------------
  if (dueDate && daysPastDue !== null && daysPastDue > 0) {
    const c = PAST_DUE_RULES[channel][failEvents > 0 ? 'withFailure' : 'clean']
    if (failEvents > 0) drivers.push(`${failEvents} failure event${failEvents === 1 ? '' : 's'}`)
    drivers.push(`${daysPastDue}d past due`)
    if (onHold) drivers.push('on hold')
    // For orders far past due, `due + C` goes stale — the age-conditioned rule
    // (the re-expanded ≥8d tail) becomes the binding estimate. Take the later
    // of the two per quantile; an order also can't ship before today.
    const floor = pickRule(AGE_RULES[channel], Math.max(age, 8))
    const q = (cDays: number, floorDays: number) => {
      const fromDue = addDaysIso(dueDate, cDays)
      const fromToday = addDaysIso(today, floorDays)
      const later = fromDue > fromToday ? fromDue : fromToday
      return later < today ? today : later
    }
    if (lotsQuarantined > 0) drivers.push(`${lotsQuarantined} lot${lotsQuarantined === 1 ? '' : 's'} in quarantine`)
    return {
      p50: rollToShippingDay(q(c.p50, Math.min(floor.p50, 2))),
      p80: rollToShippingDay(q(c.p80, floor.p80)),
      p90: rollToShippingDay(q(c.p90, floor.p90)),
      risk: 'past-due',
      drivers,
    }
  }

  // ----- Layer B: open, not yet due ------------------------------------------
  const ageQ = pickRule(AGE_RULES[channel], age)
  let base = ageQ
  if (daysSincePrint !== null && daysSincePrint >= 0) {
    const printQ = pickRule(PRINT_RULES[channel], daysSincePrint)
    // Print-start is the stronger absorbing signal — take the tighter estimate.
    if (printQ.p80 < base.p80) {
      base = printQ
      drivers.push(`printing started ${daysSincePrint}d ago`)
    }
  }

  let { p50, p80, p90 } = base

  const fo = failureOffset(failEvents)
  if (fo.p80 > 0) {
    p50 += fo.p50
    p80 += fo.p80
    p90 += fo.p90
    drivers.push(`${failEvents} failure event${failEvents === 1 ? '' : 's'} (+${fo.p80}d P80)`)
  }

  if (channel === 'FormNow' && (family === 'SLS' || family === 'Mixed')) {
    p50 += 1
    p80 += 2
    p90 += 2
    drivers.push(`${family} (+2d P80)`)
  }

  if (onHold) {
    p50 += 1
    p80 += 3
    p90 += 4
    drivers.push('on hold (+3d P80)')
  }

  if (lotsQuarantined > 0) {
    p50 += 1
    p80 += 2
    p90 += 3
    drivers.push(`${lotsQuarantined} lot${lotsQuarantined === 1 ? '' : 's'} in quarantine (+2d P80)`)
  }

  if (backlogHigh(family, backlog)) {
    p80 += 2
    p90 += 2
    drivers.push('high backlog (+2d P80)')
  }

  // Partially binned = late-stage (the all-binned case returned above): cap
  // the P50 at 2 remaining days.
  if (lotsBinned > 0) {
    p50 = Math.min(p50, 2)
    drivers.push(`${lotsBinned}/${Math.max(lotsSeen, lotsBinned)} lots binned`)
  }

  const p50d = rollToShippingDay(addDaysIso(today, p50))
  const p80d = rollToShippingDay(addDaysIso(today, p80))
  const p90d = rollToShippingDay(addDaysIso(today, p90))

  let risk: Prediction['risk'] = 'on-track'
  if (dueDate) {
    if (p50d > dueDate) risk = 'likely-late'
    else if (p80d > dueDate) risk = 'at-risk'
  }
  return { p50: p50d, p80: p80d, p90: p90d, risk, drivers }
}

// ---------------------------------------------------------------------------
// Layer A — quote helper: promise suggestions at acceptance time
// (doc §4 Layer A; base = train-window accepted→ship quantiles).
// ---------------------------------------------------------------------------

export interface QuoteInput {
  channel: 'FormNow' | 'Xometry'
  family: 'SLA' | 'SLS' | 'Mixed'
  qtyBucket: 'small' | 'medium' | 'large' | 'xl' // ≤5 / 6–20 / 21–100 / 100+
}

export function suggestQuote(inp: QuoteInput, backlog: Backlog): { q: Q; drivers: string[] } {
  const base: Q = inp.channel === 'FormNow' ? { p50: 5, p80: 8, p90: 12 } : { p50: 4, p80: 6, p90: 7 }
  const q = { ...base }
  const drivers: string[] = []
  if (inp.qtyBucket === 'large') {
    q.p80 += 1
    q.p90 += 2
    drivers.push('qty 21–100 (+1d P80)')
  }
  if (inp.qtyBucket === 'xl') {
    const bump = inp.family === 'SLS' ? 6 : 2
    q.p80 += bump
    q.p90 += bump + 2
    drivers.push(`qty 100+ ${inp.family === 'SLS' ? 'SLS ' : ''}(+${bump}d P80)`)
  }
  if (inp.family === 'Mixed') {
    q.p80 += 2
    q.p90 += 2
    drivers.push('mixed SLA+SLS (+2d P80)')
  }
  if (backlogHigh(inp.family, backlog)) {
    q.p80 += 2
    q.p90 += 2
    drivers.push('high backlog (+2d P80)')
  }
  return { q, drivers }
}
