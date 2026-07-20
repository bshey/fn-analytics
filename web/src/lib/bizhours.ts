/**
 * Business-hours math in America/New_York. The two-offset trick turns an ET
 * wall time into an exact epoch across DST without a timezone library.
 */

const ET_WALL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function etDate(ms: number): string {
  return ET_WALL.format(ms).slice(0, 10)
}

const epochCache = new Map<string, number>()

/** Epoch ms for an ET wall time "YYYY-MM-DD" + "HH:MM". */
function etEpoch(date: string, hm: string): number {
  const key = `${date}T${hm}`
  const hit = epochCache.get(key)
  if (hit !== undefined) return hit
  for (const off of ['-05:00', '-04:00']) {
    const t = Date.parse(`${date}T${hm}:00${off}`)
    if (ET_WALL.format(t).replace(', ', 'T') === key) {
      epochCache.set(key, t)
      return t
    }
  }
  const fallback = Date.parse(`${date}T${hm}:00-05:00`)
  epochCache.set(key, fallback)
  return fallback
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** ISO weekday (Mon=1..Sun=7) of a calendar date string. */
function isoDow(date: string): number {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Hours of [fromMs, toMs] that fall inside the active window on selected days. */
export function businessHours(fromMs: number, toMs: number, days: Set<number>, startHM: string, endHM: string): number {
  if (toMs <= fromMs) return 0
  let total = 0
  let d = etDate(fromMs)
  const endD = etDate(toMs)
  for (let i = 0; i < 800; i++) {
    if (days.has(isoDow(d))) {
      const ws = etEpoch(d, startHM)
      const we = etEpoch(d, endHM)
      total += Math.max(0, Math.min(toMs, we) - Math.max(fromMs, ws))
    }
    if (d === endD) break
    d = nextDate(d)
  }
  return total / 3_600_000
}
