import { useMemo, useRef, useState } from 'react'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel } from '../../lib/dates'
import { fmtPct } from '../../lib/format'
import { seriesColor } from '../../lib/palette'
import { gridDefaults, lineDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { EChart, type EChartHandle } from '../../components/EChart'
import { Segmented } from '../../components/Segmented'
import { SHIP_FIELDS, isUnsettled, pivotRows, ratePoint, tooltipFormatter, type Sums } from './metrics'

type Mode = 'overall' | 'channel'

function rate(s: Sums | undefined, num: string, den: string): number | null {
  if (!s || (s[den] ?? 0) <= 0) return null
  return (s[num] ?? 0) / s[den]!
}

/** A2 — on-time trend lines. Overall shows on-time % + within-36h %; by-channel shows on-time % per reporting category. */
export function OnTimeTrend() {
  const { queryParams } = useFilters()
  const [mode, setMode] = useState<Mode>('overall')
  const chartRef = useRef<EChartHandle>(null)

  const overall = useNamedQuery('shipments_explorer', { ...queryParams, breakdown: 'none' })
  const byChannel = useNamedQuery('shipments_explorer', { ...queryParams, breakdown: 'reporting_category' })
  const active = mode === 'overall' ? overall : byChannel
  const rows = (active.data?.rows ?? []) as Row[]

  const model = useMemo(() => {
    const pv = pivotRows(rows, SHIP_FIELDS, (r) => String(r.breakdown ?? 'All'))
    const periods = pv.periods
    // Provisional = period still in progress OR its due-date cohort has unshipped
    // orders (on-time % only counts shipped orders, so it reads high until settled).
    const provisional = periods.map((p) => {
      if (isCurrentPeriod(p, queryParams.grain)) return true
      const total: Sums = {}
      for (const cell of pv.byPeriod.get(p)?.values() ?? []) {
        total.orders_due = (total.orders_due ?? 0) + (cell.orders_due ?? 0)
        total.orders_shipped = (total.orders_shipped ?? 0) + (cell.orders_shipped ?? 0)
      }
      return isUnsettled(total)
    })

    let series: Record<string, unknown>[]
    let csvRows: Record<string, unknown>[]
    if (mode === 'overall') {
      // OTS = on-time ÷ ALL due orders (unshipped count against); 36h stays ÷ shipped.
      const defs = [
        { name: 'On-time ship %', num: 'on_time', den: 'orders_due' },
        { name: 'Within-36h % (of shipped)', num: 'within_36h', den: 'orders_shipped' },
      ]
      series = defs.map((d) => ({
        ...lineDefaults,
        name: d.name,
        color: seriesColor(d.name),
        connectNulls: false,
        data: periods.map((p, i) => {
          const s = pv.byPeriod.get(p)?.get('All')
          return s ? ratePoint(s[d.num] ?? 0, s[d.den] ?? 0, provisional[i]) : null
        }),
      }))
      csvRows = periods.map((p) => ({
        period: p,
        on_time_ship_pct: rate(pv.byPeriod.get(p)?.get('All'), 'on_time', 'orders_due'),
        within_36h_pct: rate(pv.byPeriod.get(p)?.get('All'), 'within_36h', 'orders_shipped'),
      }))
    } else {
      // Rank channels by shipped volume; ≤ 5 channels exist so no folding needed.
      const channels = [...pv.byLabel.entries()]
        .sort((a, b) => (b[1].orders_shipped ?? 0) - (a[1].orders_shipped ?? 0))
        .map(([l]) => l)
      series = channels.map((ch) => ({
        ...lineDefaults,
        name: ch,
        color: seriesColor(ch),
        connectNulls: false,
        data: periods.map((p, i) => {
          const s = pv.byPeriod.get(p)?.get(ch)
          return s ? ratePoint(s.on_time ?? 0, s.orders_due ?? 0, provisional[i]) : null
        }),
      }))
      csvRows = periods.map((p) => {
        const out: Record<string, unknown> = { period: p }
        for (const ch of channels) out[ch] = rate(pv.byPeriod.get(p)?.get(ch), 'on_time', 'orders_due')
        return out
      })
    }

    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: series.length > 1, top: 0, type: 'scroll' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: tooltipFormatter((v) => fmtPct(v ?? null)) },
      xAxis: { type: 'category', boundaryGap: false, data: periods.map((p) => periodLabel(p, queryParams.grain)) },
      yAxis: { type: 'value', min: 0, max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
      series,
    }
    return { option, csvRows, hasProvisional: provisional.some(Boolean), isEmpty: rows.length === 0 }
  }, [rows, mode, queryParams.grain])

  return (
    <ChartCard
      title="On-time ship trend"
      subtitle="Of all orders due each period, the share that shipped on time"
      info={{
        definition:
          mode === 'overall'
            ? 'On-time ship % = SUM(shipped on time) ÷ SUM(ALL orders due in the period) — orders that have not shipped count as NOT on time, so the current period starts at 0% and climbs as due orders ship (owner convention). Within-36h % = SUM(shipped within 36h) ÷ SUM(shipped). Re-derived from summed counts per period, never averaged. Periods bucket orders by their PROMISED SHIP (due) date, matching the governed view.'
            : 'On-time ship % per reporting category = SUM(shipped on time) ÷ SUM(ALL orders due) within each channel per period (period = promised-ship date). Unshipped orders count as not on time, so recent periods read low and climb.',
        source: active.data?.meta.source ?? 'formlabs-data-sandbox.fcm.v_shipments_kpi',
      }}
      csvRows={model.csvRows}
      csvName={`on-time-trend-${mode}`}
      chartRef={chartRef}
      isLoading={active.isLoading}
      isFetching={active.isFetching}
      error={active.error}
      isEmpty={model.isEmpty}
      emptyText="No shipped orders in the selected filters."
      height={300}
      actions={
        <Segmented
          size="sm"
          options={[
            { value: 'overall', label: 'Overall' },
            { value: 'channel', label: 'By channel' },
          ]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      <EChart ref={chartRef} option={model.option} height={280} />
      {model.hasProvisional && (
        <p className="mt-1 text-[11.5px] text-faint">
          Faded points are unsettled: orders due in those periods haven't all shipped yet and count as not on time, so
          the rate starts low and climbs as they ship. Judge only solid points.
        </p>
      )}
    </ChartCard>
  )
}
