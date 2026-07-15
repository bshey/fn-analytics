export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year'

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface DatePreset {
  key: string
  label: string
  range: () => { start: string; end: string }
}

export const DATE_PRESETS: DatePreset[] = [
  { key: '4w', label: 'Last 4 weeks', range: () => ({ start: addDaysIso(todayIso(), -28), end: todayIso() }) },
  { key: '12w', label: 'Last 12 weeks', range: () => ({ start: addDaysIso(todayIso(), -84), end: todayIso() }) },
  { key: '26w', label: 'Last 26 weeks', range: () => ({ start: addDaysIso(todayIso(), -182), end: todayIso() }) },
  { key: '52w', label: 'Last 52 weeks', range: () => ({ start: addDaysIso(todayIso(), -364), end: todayIso() }) },
  {
    key: 'qtd',
    label: 'Quarter to date',
    range: () => {
      const d = new Date()
      const start = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1))
      return { start: start.toISOString().slice(0, 10), end: todayIso() }
    },
  },
  {
    key: 'ytd',
    label: 'Year to date',
    range: () => ({ start: `${new Date().getUTCFullYear()}-01-01`, end: todayIso() }),
  },
]

/** The equally-sized window immediately before [start, end] — for period-over-period deltas. */
export function priorRange(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00Z`).getTime()
  const e = new Date(`${end}T00:00:00Z`).getTime()
  const days = Math.max(1, Math.round((e - s) / 86400000) + 1)
  return { start: addDaysIso(start, -days), end: addDaysIso(start, -1) }
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Human label for a period-start ISO date at a grain: "Jun 7", "Jun 2026", "Q2 2026", "2026". */
export function periodLabel(iso: string, grain: Grain): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  switch (grain) {
    case 'day':
    case 'week':
      return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`
    case 'month':
      return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`
    case 'quarter':
      return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
    case 'year':
      return String(d.getUTCFullYear())
  }
}

/** Start-of-period ISO date for client-side bucketing; weeks start Sunday (matches SQL WEEK(SUNDAY)). */
export function periodStart(iso: string, grain: Grain): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  switch (grain) {
    case 'day':
      return iso
    case 'week':
      d.setUTCDate(d.getUTCDate() - d.getUTCDay())
      break
    case 'month':
      d.setUTCDate(1)
      break
    case 'quarter':
      d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1)
      break
    case 'year':
      d.setUTCMonth(0, 1)
      break
  }
  return d.toISOString().slice(0, 10)
}

/** True when this period is still accumulating data (label it provisional). */
export function isCurrentPeriod(iso: string, grain: Grain): boolean {
  const now = new Date()
  const d = new Date(`${iso}T00:00:00Z`)
  const next = new Date(d)
  switch (grain) {
    case 'day':
      next.setUTCDate(next.getUTCDate() + 1)
      break
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7)
      break
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + 1)
      break
    case 'quarter':
      next.setUTCMonth(next.getUTCMonth() + 3)
      break
    case 'year':
      next.setUTCFullYear(next.getUTCFullYear() + 1)
      break
  }
  return now >= d && now < next
}
