import type { Row } from '../../lib/api'
import { fmtInt, fmtMoney, fmtNum, fmtPct, fmtVolume, num0 } from '../../lib/format'

/** Summed row fields for a group of rows — rates are ALWAYS re-derived from these. */
export type Sums = Record<string, number>

export type MetricKind = 'count' | 'money' | 'volume' | 'rate' | 'days'

export interface MetricDef {
  key: string
  label: string
  kind: MetricKind
  /** Aggregate value from summed fields (rates = summed numerator / summed denominator). */
  compute: (s: Sums) => number | null
  /** Ranking / share-of-total weight. For rates & days this is the denominator (shipped orders). */
  weight: (s: Sums) => number
  format: (v: number | null | undefined) => string
  /** For rate metrics: the count fields behind the ratio, so tooltips can show "13/21". */
  parts?: { num: string; den: string }
  /** Extra tooltip context derived from the period's sums, e.g. "49 due · 15 unshipped". */
  tip?: (s: Sums) => string | null
  /** Metrics that read a different query than the active cohort's default. */
  route?: 'delivery' | 'placed' | 'shiplate' | 'shipdate' | 'partsmed' | 'quoted'
}

// Numeric fields returned by each explorer query (mock keys === SQL aliases).
export const SHIP_FIELDS = [
  'orders_due',
  'orders_shipped',
  'on_time',
  'within_36h',
  'unique_parts',
  'parts',
  'volume_ml',
  'revenue',
  'quoted',
  'bookings',
  'bizdays_weighted',
  'dayslate_weighted',
] as const

export const PLACED_FIELDS = [
  'orders_placed',
  'bookings',
  'parts_ordered',
  'unique_parts_ordered',
  'volume_ml_ordered',
] as const

export const DELIVERY_FIELDS = ['orders_due', 'delivered', 'delivered_on_time', 'delivered_max_1d_late'] as const

export const SHIP_LATE_FIELDS = ['orders_due', 'orders_shipped', 'shipped_on_time', 'shipped_max_1d_late'] as const

export const SHIP_DATE_FIELDS = ['orders_shipped'] as const

export const PARTS_MED_FIELDS = ['n_orders', 'median_parts', 'median_weighted'] as const

export const QUOTED_LEAD_FIELDS = ['n_orders', 'lead_weighted'] as const


const field =
  (f: string) =>
  (s: Sums): number =>
    s[f] ?? 0

const ratio =
  (numF: string, denF: string) =>
  (s: Sums): number | null =>
    (s[denF] ?? 0) > 0 ? (s[numF] ?? 0) / s[denF] : null

/**
 * Bookings = governed f_orders formula, recognized AT ORDER TIME (cohort =
 * submitted date). Offered on both cohort toggles; always routes to the
 * order-placed query so it matches Looker regardless of the active cohort.
 */
export const BOOKINGS_METRIC: MetricDef = {
  key: 'bookings',
  label: 'Bookings $ (at order)',
  kind: 'money',
  compute: field('bookings'),
  weight: field('bookings'),
  format: fmtMoney,
  route: 'placed',
}

/**
 * Orders placed / parts ordered — order-placed cohort (submitted date). Offered
 * on both cohort toggles like Bookings; always route to the order-placed query,
 * so from the ship cohort they show demand next to the shipping metrics.
 */
export const ORDERS_PLACED_METRIC: MetricDef = {
  key: 'orders_placed',
  label: 'Orders placed',
  kind: 'count',
  compute: field('orders_placed'),
  weight: field('orders_placed'),
  format: fmtInt,
  route: 'placed',
}

export const PARTS_ORDERED_METRIC: MetricDef = {
  key: 'parts_ordered',
  label: 'Parts ordered',
  kind: 'count',
  compute: field('parts_ordered'),
  weight: field('parts_ordered'),
  format: fmtInt,
  route: 'placed',
}

/**
 * Same count, two calendars. "By due date" reads the governed KPI view (a bar =
 * orders DUE then that have shipped — no weekend bars, recent bars climb as
 * cohorts settle). "By ship date" reads its own raw-order query bucketed by
 * UTC DATE(shipped_at) — the legacy Looker convention, verified to reproduce
 * its daily bars exactly. Settled multi-week totals reconcile between the two.
 */
export const SHIP_ACTUAL_METRIC: MetricDef = {
  key: 'orders_shipped_actual',
  label: 'Orders shipped (by ship date)',
  kind: 'count',
  compute: field('orders_shipped'),
  weight: field('orders_shipped'),
  format: fmtInt,
  route: 'shipdate',
}

export const SHIP_METRICS: MetricDef[] = [
  {
    key: 'orders_shipped',
    label: 'Orders shipped (by due date)',
    kind: 'count',
    compute: field('orders_shipped'),
    weight: field('orders_shipped'),
    format: fmtInt,
    tip: (s) => {
      const due = s.orders_due ?? 0
      if (due <= 0) return null
      const unshipped = due - (s.orders_shipped ?? 0)
      return unshipped > 0 ? `of ${fmtInt(due)} due · ${fmtInt(unshipped)} unshipped` : `all ${fmtInt(due)} due shipped`
    },
  },
  SHIP_ACTUAL_METRIC,
  { key: 'orders_due', label: 'Orders due', kind: 'count', compute: field('orders_due'), weight: field('orders_due'), format: fmtInt },
  ORDERS_PLACED_METRIC,
  // Revenue = the governed formula recognized WHEN THE ORDER SHIPS. The view's
  // bookings_from_shipped_orders is identical to revenue (both gated on shipped),
  // so it is deliberately NOT offered — real Bookings (below) routes to the
  // order-placed query. Quoted $ removed at owner request.
  { key: 'revenue', label: 'Revenue $ (at ship)', kind: 'money', compute: field('revenue'), weight: field('revenue'), format: fmtMoney },
  BOOKINGS_METRIC,
  { key: 'parts', label: 'Parts shipped', kind: 'count', compute: field('parts'), weight: field('parts'), format: fmtInt },
  PARTS_ORDERED_METRIC,
  { key: 'unique_parts', label: 'Unique parts shipped', kind: 'count', compute: field('unique_parts'), weight: field('unique_parts'), format: fmtInt },
  { key: 'volume_ml', label: 'Volume shipped (mL)', kind: 'volume', compute: field('volume_ml'), weight: field('volume_ml'), format: fmtVolume },
  // OTS convention (owner decision): denominator = ALL orders due in the period,
  // so unshipped orders count as not on time — today starts at 0% and climbs.
  { key: 'on_time_pct', label: 'On-time ship %', kind: 'rate', compute: ratio('on_time', 'orders_due'), weight: field('orders_due'), format: (v) => fmtPct(v), parts: { num: 'on_time', den: 'orders_due' } },
  { key: 'within_36h_pct', label: 'Within-36h %', kind: 'rate', compute: ratio('within_36h', 'orders_shipped'), weight: field('orders_shipped'), format: (v) => fmtPct(v), parts: { num: 'within_36h', den: 'orders_shipped' } },
  { key: 'biz_days', label: 'Avg business days', kind: 'days', compute: ratio('bizdays_weighted', 'orders_shipped'), weight: field('orders_shipped'), format: (v) => fmtNum(v, 1) },
]

/**
 * OTD lives in the explorer's ship-cohort metric list but reads its own query
 * (delivery_kpis): cohort = QUOTED DELIVERY date, same undone-counts-against
 * convention as OTS. Web/PreForm parcels only; tracking since 2026-04-30.
 */
export const OTD_METRIC: MetricDef = {
  key: 'otd_pct',
  label: 'On-time delivery %',
  kind: 'rate',
  compute: ratio('delivered_on_time', 'orders_due'),
  weight: field('orders_due'),
  format: (v) => fmtPct(v),
  parts: { num: 'delivered_on_time', den: 'orders_due' },
  route: 'delivery',
}

/**
 * On-time ship % with one calendar day of tolerance. The KPI view has no
 * tolerance buckets, so this reads its own raw-order query (ship_late_kpis):
 * same governed due-date cohort and all-due denominator as OTS — unshipped
 * counts against. Always ≥ on-time ship % for the same window.
 */
export const SHIP_1D_METRIC: MetricDef = {
  key: 'ship_1d_pct',
  label: 'Shipped ≤1 day late %',
  kind: 'rate',
  compute: ratio('shipped_max_1d_late', 'orders_due'),
  weight: field('orders_due'),
  format: (v) => fmtPct(v),
  parts: { num: 'shipped_max_1d_late', den: 'orders_due' },
  route: 'shiplate',
}

/**
 * Same cohort/query/convention as OTD, but the numerator tolerates one calendar
 * day of lateness (quoted dates are calendar dates; carriers deliver Saturdays).
 * Always ≥ OTD for the same window. Undelivered still counts against.
 */
export const OTD_1D_METRIC: MetricDef = {
  key: 'otd_1d_pct',
  label: 'Arrived ≤1 day late %',
  kind: 'rate',
  compute: ratio('delivered_max_1d_late', 'orders_due'),
  weight: field('orders_due'),
  format: (v) => fmtPct(v),
  parts: { num: 'delivered_max_1d_late', den: 'orders_due' },
  route: 'delivery',
}

/**
 * Median parts per order — its own query (medians can't come from summed
 * counts). Exact per period×group cell; weight-averaged when groups fold into
 * 'Other' or the window table spans periods. Order-placed cohort.
 */
export const PARTS_MED_METRIC: MetricDef = {
  key: 'median_parts_per_order',
  label: 'Median parts per order',
  kind: 'count',
  compute: ratio('median_weighted', 'n_orders'),
  weight: field('n_orders'),
  format: (v) => fmtNum(v, 1),
  route: 'partsmed',
}

/**
 * Quoted lead time — the ship promise made at order time (submitted → governed
 * due date, business days Mon–Fri). Order-placed cohort; average per period.
 */
export const QUOTED_LEAD_METRIC: MetricDef = {
  key: 'quoted_lead_days',
  label: 'Quoted lead time (biz days)',
  kind: 'days',
  compute: ratio('lead_weighted', 'n_orders'),
  weight: field('n_orders'),
  format: (v) => fmtNum(v, 1),
  route: 'quoted',
}

export const PLACED_METRICS: MetricDef[] = [
  ORDERS_PLACED_METRIC,
  BOOKINGS_METRIC,
  PARTS_ORDERED_METRIC,
  { key: 'unique_parts_ordered', label: 'Unique parts ordered', kind: 'count', compute: field('unique_parts_ordered'), weight: field('unique_parts_ordered'), format: fmtInt },
  { key: 'volume_ml_ordered', label: 'Volume ordered (mL)', kind: 'volume', compute: field('volume_ml_ordered'), weight: field('volume_ml_ordered'), format: fmtVolume },
]

export interface BreakdownOption {
  value: string
  label: string
  /** Table header for the group column. */
  groupHeader: string
}

export const SHIP_BREAKDOWNS: BreakdownOption[] = [
  { value: 'none', label: 'No breakdown', groupHeader: 'Group' },
  { value: 'reporting_category', label: 'By channel', groupHeader: 'Channel' },
  { value: 'materials', label: 'By material', groupHeader: 'Material' },
  { value: 'manufacturing_types', label: 'By mfg type', groupHeader: 'Mfg type' },
]

export const PLACED_BREAKDOWNS: BreakdownOption[] = [
  { value: 'none', label: 'No breakdown', groupHeader: 'Group' },
  { value: 'reporting_category', label: 'By channel', groupHeader: 'Channel' },
  { value: 'materials', label: 'By material', groupHeader: 'Material' },
  { value: 'manufacturing_types', label: 'By mfg type', groupHeader: 'Mfg type' },
  { value: 'manufacturing_location', label: 'By location', groupHeader: 'Location' },
]

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export function addRow(acc: Sums, row: Row, fields: readonly string[]): void {
  for (const f of fields) acc[f] = (acc[f] ?? 0) + num0(row[f])
}

/** Sum every listed field across all rows (window totals). */
export function windowSums(rows: Row[], fields: readonly string[]): Sums {
  const acc: Sums = {}
  for (const r of rows) addRow(acc, r, fields)
  return acc
}

/**
 * A due-date cohort is unsettled while some orders due in it haven't shipped:
 * its on-time % counts only already-shipped orders (all early/on-time for very
 * recent dates), so it reads artificially high until the cohort settles.
 */
export function isUnsettled(s: Sums | undefined): boolean {
  if (!s) return false
  return (s.orders_due ?? 0) > (s.orders_shipped ?? 0)
}

export interface Pivot {
  /** Sorted ascending ISO period starts present in the data. */
  periods: string[]
  /** period → label → summed fields. */
  byPeriod: Map<string, Map<string, Sums>>
  /** label → window-summed fields. */
  byLabel: Map<string, Sums>
}

export function pivotRows(rows: Row[], fields: readonly string[], labelOf: (r: Row) => string): Pivot {
  const byPeriod = new Map<string, Map<string, Sums>>()
  const byLabel = new Map<string, Sums>()
  for (const r of rows) {
    const period = String(r.period ?? '').slice(0, 10)
    if (!period) continue
    const label = labelOf(r)
    let periodMap = byPeriod.get(period)
    if (!periodMap) byPeriod.set(period, (periodMap = new Map()))
    let cell = periodMap.get(label)
    if (!cell) periodMap.set(label, (cell = {}))
    addRow(cell, r, fields)
    let win = byLabel.get(label)
    if (!win) byLabel.set(label, (win = {}))
    addRow(win, r, fields)
  }
  return { periods: [...byPeriod.keys()].sort(), byPeriod, byLabel }
}

/**
 * Cap series at `max`: keep the top (max-1) labels by weight, fold the tail into
 * 'Other'. Returns display order (descending weight, 'Other' last) and a mapper.
 */
export function foldLabels(
  byLabel: Map<string, Sums>,
  weight: (s: Sums) => number,
  max = 8,
): { order: string[]; mapTo: (label: string) => string } {
  const ranked = [...byLabel.entries()].sort((a, b) => weight(b[1]) - weight(a[1])).map(([l]) => l)
  if (ranked.length <= max) return { order: ranked, mapTo: (l) => l }
  const keep = ranked.slice(0, max - 1)
  const keepSet = new Set(keep)
  return { order: [...keep, 'Other'], mapTo: (l) => (keepSet.has(l) ? l : 'Other') }
}

/**
 * Material breakdown values from the KPI view are comma-joined SKU lists.
 * Single codes map to friendly names via /api/dims; multi-code combos → 'Mixed'.
 */
export function materialLabeler(materials?: { code: string; name: string }[]): (raw: string) => string {
  const byCode = new Map((materials ?? []).map((m) => [m.code, m.name]))
  return (raw: string) => {
    const v = raw.trim()
    if (!v) return 'Unknown'
    if (v.includes(',')) return 'Mixed'
    return byCode.get(v) ?? v
  }
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

export function axisFormatter(kind: MetricKind): (v: number) => string {
  switch (kind) {
    case 'rate':
      return (v) => `${Math.round(v * 100)}%`
    case 'money':
      return (v) => fmtMoney(v)
    case 'volume':
      return (v) => fmtVolume(v)
    case 'days':
      return (v) => String(v)
    default:
      return (v) => fmtInt(v)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Axis-trigger tooltip listing every series value with the metric's formatter.
 * Data points built with ratePoint() also show their counts: "70.8% (17/24)".
 */
export function tooltipFormatter(fmt: (v: number | null | undefined) => string): (params: unknown) => string {
  return (params: unknown) => {
    const arr = (Array.isArray(params) ? params : [params]) as Array<{
      marker?: string
      seriesName?: string
      value?: unknown
      data?: unknown
      axisValueLabel?: string
    }>
    const title = escapeHtml(arr[0]?.axisValueLabel ?? '')
    const lines = arr
      .filter((p) => p.value !== null && p.value !== undefined && p.value !== '')
      .map((p) => {
        const d = p.data as { num?: unknown; den?: unknown; tip?: unknown } | null | undefined
        const counts =
          d && typeof d === 'object' && typeof d.num === 'number' && typeof d.den === 'number'
            ? ` <span style="color:#898781">(${fmtInt(d.num)}/${fmtInt(d.den)})</span>`
            : ''
        const tip =
          d && typeof d === 'object' && typeof d.tip === 'string' && d.tip
            ? ` <span style="color:#898781">${escapeHtml(d.tip)}</span>`
            : ''
        return `${p.marker ?? ''} ${escapeHtml(p.seriesName ?? '')}&nbsp;&nbsp;<b>${fmt(Number(p.value))}</b>${counts}${tip}`
      })
    if (!lines.length) return ''
    return `<div style="font-weight:600;margin-bottom:2px">${title}</div>${lines.join('<br/>')}`
  }
}

/** Wrap a data point so the in-progress (provisional) period renders at reduced opacity. */
export function provisionalPoint(
  v: number | null,
  provisional: boolean,
): number | null | { value: number; itemStyle: { opacity: number } } {
  if (v === null || !provisional) return v
  return { value: v, itemStyle: { opacity: 0.45 } }
}

/**
 * A rate data point carrying its counts, so the tooltip can show "70.8% (17/24)".
 * Also applies the provisional fade.
 */
export function ratePoint(
  num: number,
  den: number,
  provisional: boolean,
): { value: number; num: number; den: number; itemStyle?: { opacity: number } } | null {
  if (den <= 0) return null
  const pt: { value: number; num: number; den: number; itemStyle?: { opacity: number } } = {
    value: num / den,
    num,
    den,
  }
  if (provisional) pt.itemStyle = { opacity: 0.45 }
  return pt
}

/** Signed, colored Δ text for a metric (percentage points for rates; lower-is-better for days). */
export function deltaParts(
  metric: MetricDef,
  cur: number | null,
  prior: number | null,
): { text: string; cls: string } | null {
  if (cur === null || prior === null || !Number.isFinite(cur) || !Number.isFinite(prior)) return null
  const diff = cur - prior
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
  const mag =
    metric.kind === 'rate'
      ? `${Math.abs(diff * 100).toFixed(1)} pts`
      : metric.kind === 'days'
        ? Math.abs(diff).toFixed(1)
        : metric.format(Math.abs(diff))
  const eps = metric.kind === 'rate' ? 0.0005 : Math.abs(prior) * 0.002
  const good = metric.kind === 'days' ? diff < 0 : diff > 0
  const cls = Math.abs(diff) <= eps ? 'text-sub' : good ? 'text-good' : 'text-bad'
  return { text: `${sign}${mag}`, cls }
}
