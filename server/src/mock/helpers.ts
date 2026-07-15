import { CHANNELS, MFG_TYPES, type Grain } from '../sql.js'

/** Deterministic PRNG so mock data is stable across reloads. */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randInt(r: () => number, min: number, max: number): number {
  return Math.floor(r() * (max - min + 1)) + min
}

export function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]
}

function toDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Truncate a date to its period start (week = Sunday, mirroring WEEK(SUNDAY)). */
export function truncPeriod(dateStr: string, grain: Grain): string {
  const d = toDate(dateStr)
  switch (grain) {
    case 'day':
      return iso(d)
    case 'week': {
      const dow = d.getUTCDay()
      d.setUTCDate(d.getUTCDate() - dow)
      return iso(d)
    }
    case 'month':
      d.setUTCDate(1)
      return iso(d)
    case 'quarter':
      d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1)
      return iso(d)
    case 'year':
      d.setUTCMonth(0, 1)
      return iso(d)
  }
}

/** Distinct period-start strings covering [start, end] at the given grain, ascending. */
export function periodsBetween(start: string, end: string, grain: Grain): string[] {
  const out: string[] = []
  const endD = toDate(end)
  let cur = toDate(truncPeriod(start, grain))
  let guard = 0
  while (cur <= endD && guard++ < 2000) {
    out.push(iso(cur))
    const next = new Date(cur)
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
    cur = next
  }
  return out
}

export function daysAgoIso(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

export const MOCK_CHANNELS = CHANNELS
export const MOCK_MFG_TYPES = MFG_TYPES
export const MOCK_MATERIALS = [
  { code: 'FLGPGR05', name: 'Grey Pro' },
  { code: 'FLP12G01', name: 'Nylon 12 GF' },
  { code: 'FLTO2002', name: 'Tough 2000' },
  { code: 'FLP11B01', name: 'Nylon 11' },
  { code: 'FLRGWH01', name: 'Rigid White' },
  { code: 'FLCLEA04', name: 'Clear V4' },
] as const

/** Relative channel volume weights so mock data resembles reality. */
export const CHANNEL_WEIGHT: Record<string, number> = {
  'Web - Revenue Generating': 0.42,
  Xometry: 0.3,
  'PreForm - Revenue Generating': 0.14,
  'Web - Non-Revenue Generating': 0.09,
  'PreForm - Non-Revenue Generating': 0.05,
}

export const MOCK_OPERATORS = ['Alex Rivera', 'Sam Chen', 'Jordan Lee', 'Casey Kim', 'Morgan Diaz', 'Riley Novak']
export const MOCK_STATIONS = [
  { name: 'Finishing 1', type: 'FINISHING' },
  { name: 'Finishing 2', type: 'FINISHING' },
  { name: 'Finishing 3', type: 'FINISHING' },
  { name: 'Post Processing 1', type: 'POST_PROCESSING' },
  { name: 'Post Processing 2', type: 'POST_PROCESSING' },
  { name: 'Quarantine 1', type: 'QUARANTINE' },
  { name: 'Shipping 1', type: 'SHIPPING' },
  { name: 'Shipping 2', type: 'SHIPPING' },
]
