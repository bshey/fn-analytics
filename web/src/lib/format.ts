export function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString()
}

export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${Math.round(v / 1000).toLocaleString()}k`
  return `$${Math.round(v).toLocaleString()}`
}

export function fmtMoneyExact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `$${Math.round(v).toLocaleString()}`
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

export function fmtVolume(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)} L`
  return `${Math.round(v).toLocaleString()} mL`
}

/** Coerce Redash values (numbers often arrive as strings) to a finite number or null. */
export function num(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

export function num0(x: unknown): number {
  return num(x) ?? 0
}

/**
 * BigQuery CAST(TIMESTAMP AS STRING) yields civil format ("2026-07-08 15:45:00+00"),
 * which Date.parse handles inconsistently across engines — normalize to ISO-8601.
 */
export function parseTs(x: unknown): Date {
  let s = String(x)
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T')
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z' // no offset → BigQuery means UTC
  return new Date(s)
}

export function fmtDateTime(x: unknown): string {
  if (!x) return '—'
  const d = parseTs(x)
  if (Number.isNaN(d.getTime())) return String(x)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtDate(x: unknown): string {
  if (!x) return '—'
  const s = String(x).slice(0, 10)
  const d = new Date(`${s}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return String(x)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
