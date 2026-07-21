import { useMemo, useRef, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useDims, useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel, priorRange } from '../../lib/dates'
import { fmtPct } from '../../lib/format'
import { seriesColor } from '../../lib/palette'
import { barDefaults, gridDefaults, lineDefaults, stackedBarDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { MultiSelect } from '../../components/MultiSelect'
import { DataTable } from '../../components/DataTable'
import { EChart, type EChartHandle } from '../../components/EChart'
import { Segmented } from '../../components/Segmented'
import {
  DELIVERY_FIELDS,
  OTD_1D_METRIC,
  OTD_METRIC,
  PARTS_MED_FIELDS,
  PARTS_MED_METRIC,
  QUOTED_LEAD_FIELDS,
  QUOTED_LEAD_METRIC,
  SHIP_1D_METRIC,
  SHIP_DATE_FIELDS,
  SHIP_LATE_FIELDS,
  PLACED_BREAKDOWNS,
  PLACED_FIELDS,
  PLACED_METRICS,
  SHIP_BREAKDOWNS,
  SHIP_FIELDS,
  SHIP_METRICS,
  axisFormatter,
  deltaParts,
  foldLabels,
  materialLabeler,
  pivotRows,
  provisionalPoint,
  ratePoint,
  tooltipFormatter,
  type MetricDef,
} from './metrics'

type StackMode = 'stacked' | 'grouped' | 'pct'

/** Order-size decile options: 1 = smallest 10% of orders by part quantity. */
const BUCKET_OPTIONS = Array.from({ length: 10 }, (_, i) => ({
  value: String(i + 1),
  label: `${i * 10}–${(i + 1) * 10}%`,
}))

interface BreakdownRow {
  label: string
  value: number | null
  share: number | null
  prior: number | null
  delta: number | null
}

/**
 * A1 — one configurable chart: Metric × Breakdown × global filters, driven by
 * the global cohort toggle (ship-date vs order-placed).
 */
export function MetricsExplorer() {
  const { filters, queryParams } = useFilters()
  const dims = useDims()
  const cohort = filters.cohort

  const [metricKey, setMetricKey] = useState<string>('orders_shipped')
  const [breakdownKey, setBreakdownKey] = useState<string>('reporting_category')
  const [stackMode, setStackMode] = useState<StackMode>('stacked')
  const chartRef = useRef<EChartHandle>(null)

  const metrics =
    cohort === 'ship'
      ? [...SHIP_METRICS, SHIP_1D_METRIC, OTD_METRIC, OTD_1D_METRIC, PARTS_MED_METRIC, QUOTED_LEAD_METRIC]
      : [...PLACED_METRICS, PARTS_MED_METRIC, QUOTED_LEAD_METRIC]
  const breakdowns = cohort === 'ship' ? SHIP_BREAKDOWNS : PLACED_BREAKDOWNS
  // Clamp state when the cohort toggle invalidates the current selection.
  const baseMetric: MetricDef = metrics.find((m) => m.key === metricKey) ?? metrics[0]
  const breakdown = breakdowns.find((b) => b.value === breakdownKey) ?? breakdowns[0]

  // Order-size decile filter (10 = largest 10% of orders by part quantity).
  const [partsBuckets, setPartsBuckets] = useState<string[]>([])
  const bucketsActive = partsBuckets.length > 0 && partsBuckets.length < 10
  // The governed KPI view is pre-aggregated per day×category, so per-order
  // filtering is impossible there. When the decile filter is active, the three
  // headline ship-cohort metrics reroute to their raw-order twins
  // (ship_late_kpis — validated to tie the view exactly); the remaining
  // view-backed metrics show an "unfiltered" warning instead of lying.
  const SHIPLATE_TWINS: Record<string, MetricDef> = {
    orders_shipped: { ...baseMetric, key: 'orders_shipped', route: 'shiplate' },
    orders_due: { ...baseMetric, key: 'orders_due', route: 'shiplate' },
    on_time_pct: {
      ...baseMetric,
      key: 'on_time_pct',
      route: 'shiplate',
      compute: (s) => ((s.orders_due ?? 0) > 0 ? (s.shipped_on_time ?? 0) / s.orders_due : null),
      parts: { num: 'shipped_on_time', den: 'orders_due' },
    },
  }
  const metric: MetricDef =
    bucketsActive && cohort === 'ship' && !baseMetric.route && SHIPLATE_TWINS[baseMetric.key]
      ? SHIPLATE_TWINS[baseMetric.key]
      : baseMetric
  const bucketsIgnored = bucketsActive && cohort === 'ship' && !metric.route

  // Some metrics read their own query regardless of the active cohort toggle:
  // OTD → delivery_kpis (quoted-delivery cohort); Shipped ≤1d late →
  // ship_late_kpis (governed due-date cohort recomputed from raw orders);
  // Orders shipped (by ship date) → shipped_by_ship_date (UTC ship-date buckets,
  // the legacy Looker convention); Bookings → orders_explorer (order-placed
  // cohort) so it always matches Looker.
  const effCohort: 'delivery' | 'placed' | 'ship' | 'shiplate' | 'shipdate' | 'partsmed' | 'quoted' =
    metric.route === 'delivery'
      ? 'delivery'
      : metric.route === 'shiplate'
        ? 'shiplate'
        : metric.route === 'shipdate'
          ? 'shipdate'
          : metric.route === 'partsmed'
            ? 'partsmed'
            : metric.route === 'quoted'
              ? 'quoted'
              : metric.route === 'placed'
                ? 'placed'
                : cohort === 'ship'
                  ? 'ship'
                  : 'placed'
  const fields =
    effCohort === 'delivery'
      ? DELIVERY_FIELDS
      : effCohort === 'shiplate'
        ? SHIP_LATE_FIELDS
        : effCohort === 'shipdate'
          ? SHIP_DATE_FIELDS
          : effCohort === 'partsmed'
            ? PARTS_MED_FIELDS
            : effCohort === 'quoted'
              ? QUOTED_LEAD_FIELDS
              : effCohort === 'placed'
                ? PLACED_FIELDS
                : SHIP_FIELDS
  const queryName =
    effCohort === 'delivery'
      ? 'delivery_kpis'
      : effCohort === 'shiplate'
        ? 'ship_late_kpis'
        : effCohort === 'shipdate'
          ? 'shipped_by_ship_date'
          : effCohort === 'partsmed'
            ? 'parts_per_order'
            : effCohort === 'quoted'
              ? 'quoted_lead_time'
              : effCohort === 'placed'
                ? 'orders_explorer'
                : 'shipments_explorer'
  const params = { ...queryParams, breakdown: breakdown.value, partsBuckets: partsBuckets.map(Number) }
  const q = useNamedQuery(queryName, params)
  const prior = priorRange(queryParams.start, queryParams.end)
  const qPrior = useNamedQuery(queryName, { ...params, start: prior.start, end: prior.end })

  const rows = (q.data?.rows ?? []) as Row[]
  const priorRows = (qPrior.data?.rows ?? []) as Row[]

  const model = useMemo(() => {
    const mapVal =
      breakdown.value === 'materials' ? materialLabeler(dims.data?.materials) : (raw: string) => (raw.trim() === '' ? 'Unknown' : raw)
    const labelOf = (r: Row) => mapVal(String(r.breakdown ?? 'All'))

    // Window sums per (unfolded) label — the breakdown table shows every group.
    const win = pivotRows(rows, fields, labelOf)
    const winPrior = pivotRows(priorRows, fields, labelOf)

    // Chart: fold the tail beyond 8 series into 'Other', rates re-derived after folding.
    const fold = foldLabels(win.byLabel, metric.weight, 8)
    const folded = pivotRows(rows, fields, (r) => fold.mapTo(labelOf(r)))

    const periods = folded.periods
    const provisional = periods.map((p) => isCurrentPeriod(p, queryParams.grain))
    const isBars = metric.kind !== 'rate' && metric.kind !== 'days'
    const multi = fold.order.length > 1
    const effMode: StackMode = !isBars ? 'grouped' : multi ? stackMode : 'stacked'

    // Per-period per-series metric values.
    const valueAt = (p: string, label: string): number | null => {
      const s = folded.byPeriod.get(p)?.get(label)
      return s ? metric.compute(s) : null
    }
    const periodTotals = periods.map((p) => {
      let t = 0
      for (const label of fold.order) t += valueAt(p, label) ?? 0
      return t
    })

    const seriesNames = fold.order
    const series = seriesNames.map((label) => {
      const displayName = breakdown.value === 'none' ? metric.label : label
      const data = periods.map((p, i) => {
        // Rate metrics carry their counts so the tooltip can show "13/21".
        if (metric.parts) {
          const s = folded.byPeriod.get(p)?.get(label)
          return s ? ratePoint(s[metric.parts.num] ?? 0, s[metric.parts.den] ?? 0, provisional[i]) : null
        }
        let v = valueAt(p, label)
        if (v !== null && effMode === 'pct') v = periodTotals[i] > 0 ? v / periodTotals[i] : null
        const pt = provisionalPoint(v, provisional[i])
        // Count metrics with a tip() carry extra context for the tooltip
        // (e.g. "of 49 due · 15 unshipped" on the due-date-cohort ship count).
        if (metric.tip && v !== null && effMode !== 'pct') {
          const s = folded.byPeriod.get(p)?.get(label)
          const tip = s ? metric.tip(s) : null
          if (tip) return typeof pt === 'object' && pt !== null ? { ...pt, tip } : { value: v, tip }
        }
        return pt
      })
      const base = !isBars ? { ...lineDefaults, connectNulls: false } : effMode === 'grouped' ? { ...barDefaults } : { ...stackedBarDefaults, stack: 'total' }
      return { ...base, name: displayName, color: seriesColor(breakdown.value === 'none' ? metric.label : label), data }
    })

    const valueFmt = effMode === 'pct' ? (v: number | null | undefined) => fmtPct(v ?? null) : metric.format
    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: series.length > 1, top: 0, type: 'scroll' },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: isBars ? 'shadow' : 'line' },
        formatter: tooltipFormatter(valueFmt),
      },
      xAxis: { type: 'category', boundaryGap: isBars, data: periods.map((p) => periodLabel(p, queryParams.grain)) },
      yAxis: {
        type: 'value',
        min: 0,
        max: metric.kind === 'rate' || effMode === 'pct' ? 1 : undefined,
        axisLabel: { formatter: effMode === 'pct' ? (v: number) => `${Math.round(v * 100)}%` : axisFormatter(metric.kind) },
      },
      series,
    }

    const csvRows = periods.map((p) => {
      const out: Record<string, unknown> = { period: p }
      for (const label of seriesNames) out[breakdown.value === 'none' ? metric.key : label] = valueAt(p, label)
      return out
    })

    // Breakdown table — unfolded groups, window totals + share + Δ vs prior window.
    const totalWeight = [...win.byLabel.values()].reduce((t, s) => t + metric.weight(s), 0)
    const tableRows: BreakdownRow[] = [...win.byLabel.entries()].map(([label, sums]) => {
      const value = metric.compute(sums)
      const priorSums = winPrior.byLabel.get(label)
      const priorVal = priorSums ? metric.compute(priorSums) : null
      return {
        label,
        value,
        share: totalWeight > 0 ? metric.weight(sums) / totalWeight : null,
        prior: priorVal,
        delta: value !== null && priorVal !== null ? value - priorVal : null,
      }
    })

    return { option, csvRows, tableRows, isBars, multi, hasProvisional: provisional.some(Boolean), isEmpty: rows.length === 0 }
  }, [rows, priorRows, metric, breakdown, stackMode, queryParams.grain, dims.data?.materials, fields])

  const columns = useMemo<ColumnDef<BreakdownRow, unknown>[]>(
    () => [
      { header: breakdown.groupHeader, accessorKey: 'label' },
      {
        header: metric.label,
        id: 'value',
        accessorFn: (r) => r.value ?? -Infinity,
        cell: ({ row }) => metric.format(row.original.value),
        meta: { align: 'right' },
      },
      {
        header: metric.kind === 'rate' || metric.kind === 'days' ? 'Share of denominator' : 'Share',
        id: 'share',
        accessorFn: (r) => r.share ?? -1,
        cell: ({ row }) => (row.original.share !== null ? fmtPct(row.original.share) : '—'),
        meta: { align: 'right' },
      },
      {
        header: 'Prior window',
        id: 'prior',
        accessorFn: (r) => r.prior ?? -Infinity,
        cell: ({ row }) => metric.format(row.original.prior),
        meta: { align: 'right' },
      },
      {
        header: 'Δ vs prior',
        id: 'delta',
        accessorFn: (r) => r.delta ?? -Infinity,
        cell: ({ row }) => {
          const d = deltaParts(metric, row.original.value, row.original.prior)
          return d ? <span className={d.cls}>{d.text}</span> : <span className="text-faint">—</span>
        },
        meta: { align: 'right' },
      },
    ],
    [metric, breakdown.groupHeader],
  )

  const info =
    effCohort === 'quoted'
      ? {
          definition: `Average quoted lead time by ${queryParams.grain}: business days (Mon-Fri, holidays not excluded) from order submission to the governed channel-aware due date (Xometry ship_by stored 23:59 ET) — the ship promise made at order time, keyed to the order-placed cohort so it tracks quoting policy regardless of what production later did. Averages are derived from summed lead-days ÷ orders (never averaged rates). Channel/material/mfg filters and the order-size percentile filter apply.`,
          source: q.data?.meta.source ?? 'fcm_api_order (+ f_orders classification)',
        }
      : effCohort === 'partsmed'
      ? {
          definition: `Median ordered part quantity per order by ${queryParams.grain}, order-placed cohort (submitted_at, QUOTING excluded). Medians are computed in SQL per period and group; when groups fold into 'Other' or the window table spans periods, the shown value is the order-count-weighted average of group medians (an approximation — exact within any single period x group). Channel/material/mfg filters and the order-size percentile filter apply.`,
          source: q.data?.meta.source ?? 'fcm_api_order + fcm_api_orderpart',
        }
      : effCohort === 'shipdate'
      ? {
          definition: `Orders shipped by ${queryParams.grain}, bucketed by the ACTUAL ship date (UTC calendar day) — the legacy Looker 'Orders Shipped' convention, and this series reproduces Looker's daily bars exactly. Weekend ships show under the weekend day. This differs from 'Orders shipped (by due date)' BY DESIGN: that series buckets by the governed promised-ship date, so the same order can land on a different day in each chart. Every shipped order appears exactly once under each convention — settled multi-week totals reconcile even though individual days differ. Channel, material and mfg-type filters all apply; breakdowns use the order's parts (multi-value orders roll up as 'Mixed').`,
          source: q.data?.meta.source ?? 'fcm_api_order (+ f_orders classification) + fcm_api_orderpart',
        }
      : effCohort === 'shiplate'
      ? {
          definition: `Shipped ≤1 day late % by ${queryParams.grain}, cohorted by the GOVERNED DUE date (channel-aware: Xometry ship_by is stored 23:59 ET). Numerator = orders shipped no more than 1 calendar day after their due date (ship dates in UTC, matching the governed view); denominator = ALL orders due in the period — unshipped orders count as late, so recent periods start low and climb as orders ship. Always ≥ the strict on-time ship %. Channel, material and mfg-type filters all apply; breakdowns use the order's parts (multi-value orders roll up as 'Mixed').`,
          source: q.data?.meta.source ?? 'fcm_api_order (+ f_orders classification) + fcm_api_orderpart',
        }
      : effCohort === 'delivery'
      ? {
          definition: `${metric.label} by ${queryParams.grain}, cohorted by the QUOTED DELIVERY date the customer saw at checkout. OTD % = delivered on/before the quoted date ÷ ALL orders promised delivery in the period; 'Arrived ≤1 day late %' relaxes the numerator to delivered no more than 1 CALENDAR day after the quoted date (quotes are calendar dates and carriers deliver Saturdays), so it is always ≥ OTD. Undelivered orders count against both, so recent periods start low and climb. Web/PreForm parcel orders only (Xometry and local pickup have no checkout quote/tracking); delivery tracking exists since Apr 30, 2026 — ignore earlier periods. Material/type filters and breakdowns use the order's parts; multi-value orders roll up as 'Mixed'.`,
          source: q.data?.meta.source ?? 'fcm_api_order + medusa order + fcm_api_orderevent (ShipStation)',
        }
      : effCohort === 'ship'
        ? {
            definition: `${metric.label} by ${queryParams.grain}, due-date cohort: the governed KPI view buckets orders by their PROMISED SHIP date, so a period contains the shipped orders that were due then. Counts, $ and volume are summed from the view; rates are re-derived from summed counts (never averaged); on-time ship % divides by ALL orders due (unshipped count against, so recent periods read low and climb); avg business days = Σ(avg_business_days_to_ship × shipped) ÷ Σ(shipped). Revenue is recognized when the order ships. Material combos on one order roll up as 'Mixed'. Share = group's portion of the window total. Day-level bars will NOT match the legacy Looker 'Orders Shipped' chart, which buckets by actual ship date — pick 'Orders shipped (by ship date)' for a Looker-matching series.`,
            source: q.data?.meta.source ?? 'formlabs-data-sandbox.fcm.v_shipments_kpi',
          }
        : {
            definition: `${metric.label} by ${queryParams.grain}, order-placed cohort keyed by submitted_at (QUOTING excluded, matching Looker). Bookings and channel classification replicate the governed f_orders rules exactly: bookings = money recognized AT ORDER TIME regardless of shipment (amount charged; Xometry = subtotal; internal/PO orders = full value; external 100%-discounts = $0). Channel, material and mfg-type filters all apply; material/type breakdowns use the order's parts (multi-value orders roll up as 'Mixed'). Volume ordered excludes part files above the plausibility cap in config/exclusions.json (default 25 L) — larger recorded volumes are unit-scale upload artifacts (e.g. meters parsed as mm), not real parts. Share = group's portion of the window total.`,
            source: q.data?.meta.source ?? 'fcm_api_order + fcm_api_orderpart + fcm_api_partfile (+ medusa order/coupons)',
          }

  return (
    <ChartCard
      title="Metrics Explorer"
      subtitle={
        effCohort === 'shipdate'
          ? 'Actual ship date (UTC calendar day) — matches the legacy Looker Orders Shipped chart'
          : effCohort === 'shiplate'
          ? 'Governed due-date cohort — shipped within 1 day of promise, unshipped count against'
          : effCohort === 'delivery'
          ? 'Quoted-delivery-date cohort — Web/PreForm parcels, tracking since Apr 30, 2026'
          : effCohort === 'ship'
            ? 'Due-date cohort (orders bucketed by promised ship date) — governed KPI view'
            : 'Order-placed cohort (keyed by submitted date) — bookings recognized at order, ties to Looker'
      }
      info={info}
      csvRows={model.csvRows}
      csvName={`explorer-${cohort}-${metric.key}-${breakdown.value}`}
      chartRef={chartRef}
      isLoading={q.isLoading}
      isFetching={q.isFetching || qPrior.isFetching}
      error={q.error}
      isEmpty={model.isEmpty}
      emptyText="No data for the selected filters."
      height={420}
      actions={
        <>
          <MultiSelect label="Order size %ile" options={BUCKET_OPTIONS} selected={partsBuckets} onChange={setPartsBuckets} />
          <select value={baseMetric.key} onChange={(e) => setMetricKey(e.target.value)} title="Metric">
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={breakdown.value} onChange={(e) => setBreakdownKey(e.target.value)} title="Breakdown">
            {breakdowns.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          {model.isBars && model.multi && (
            <Segmented
              size="sm"
              options={[
                { value: 'stacked', label: 'Stacked' },
                { value: 'grouped', label: 'Grouped' },
                { value: 'pct', label: '100%' },
              ]}
              value={stackMode}
              onChange={setStackMode}
            />
          )}
        </>
      }
    >
      <EChart ref={chartRef} option={model.option} height={320} />
      {bucketsActive && bucketsIgnored && (
        <p className="mt-1 rounded-md border border-warn/30 bg-amber-50 px-2 py-1 text-[11.5px] text-warn">
          The order-size percentile filter is NOT applied to this metric — it reads the governed pre-aggregated view,
          which has no per-order detail. Orders shipped, Orders due and On-time ship % switch to a raw-order
          computation automatically; the other ship-cohort metrics show unfiltered values.
        </p>
      )}
      {bucketsActive && !bucketsIgnored && (
        <p className="mt-1 text-[11.5px] text-faint">
          Order-size percentile filter active: {partsBuckets.length} of 10 deciles. Percentiles are computed over the
          orders in the current window and cohort (by total ordered part quantity).
        </p>
      )}
      {model.hasProvisional && (
        <p className="mt-1 text-[11.5px] text-faint">
          Newest period is still in progress (shown faded) — warehouse data lags ~1 day.
        </p>
      )}
      <div className="mt-3">
        <DataTable
          data={model.tableRows}
          columns={columns}
          initialSort={[{ id: 'value', desc: true }]}
          csvName={`explorer-breakdown-${cohort}-${metric.key}-${breakdown.value}`}
          emptyText="No data for the selected filters."
        />
      </div>
    </ChartCard>
  )
}
