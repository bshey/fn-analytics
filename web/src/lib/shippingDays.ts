/**
 * Shipping happens Mon–Fri only (0 Sunday ships, 0.9% Saturday, historically),
 * and never on company holidays. Holiday list mirrors dim_date.is_business_day
 * for 2026 — extend annually.
 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
])

export function isShippingDay(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(iso)
}
