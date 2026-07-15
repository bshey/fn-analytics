import { useMemo, useRef, useState } from 'react'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel } from '../../lib/dates'
import { fmtInt, fmtPct, num0 } from '../../lib/format'
import { TIMING_BUCKETS, TIMING_COLORS } from '../../lib/palette'
import { gridDefaults, stackedBarDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { EChart, type EChartHandle } from '../../components/EChart'
import { Segmented } from '../../components/Segmented'
import { provisionalPoint, tooltipFormatter } from './metrics'

type Mode = 'counts' | 'pct'

/** A2 — stacked distribution of shipped orders by days early/late vs promise, per period. */
export function TimingDistribution() {
  const { queryParams } = useFilters()
  const [mode, setMode] = useState<Mode>('counts')
  const chartRef = useRef<EChartHandle>(null)

  const q = useNamedQuery('ship_timing_distribution', queryParams)
  const rows = (q.data?.rows ?? []) as Row[]

  const model = useMemo(() => {
    // period → bucket → n (channel filter is applied server-side; sum across channels).
    const byPeriod = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const period = String(r.period ?? '').slice(0, 10)
      const bucket = String(r.bucket ?? '')
      if (!period || !bucket) continue
      let m = byPeriod.get(period)
      if (!m) byPeriod.set(period, (m = new Map()))
      m.set(bucket, (m.get(bucket) ?? 0) + num0(r.n))
    }
    const periods = [...byPeriod.keys()].sort()
    const provisional = periods.map((p) => isCurrentPeriod(p, queryParams.grain))
    const totals = periods.map((p) => TIMING_BUCKETS.reduce((t, b) => t + (byPeriod.get(p)?.get(b) ?? 0), 0))

    // Keep the canonical diverging order; drop buckets empty across the whole window.
    const buckets = TIMING_BUCKETS.filter((b) => periods.some((p) => (byPeriod.get(p)?.get(b) ?? 0) > 0))

    const series = buckets.map((bucket) => ({
      ...stackedBarDefaults,
      stack: 'total',
      name: bucket,
      color: TIMING_COLORS[bucket],
      data: periods.map((p, i) => {
        const n = byPeriod.get(p)?.get(bucket) ?? 0
        const v = mode === 'pct' ? (totals[i] > 0 ? n / totals[i] : null) : n
        return provisionalPoint(v, provisional[i])
      }),
    }))

    const fmt = mode === 'pct' ? (v: number | null | undefined) => fmtPct(v ?? null) : (v: number | null | undefined) => fmtInt(v ?? null)
    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: buckets.length > 1, top: 0, type: 'scroll' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: tooltipFormatter(fmt) },
      xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, queryParams.grain)) },
      yAxis: {
        type: 'value',
        min: 0,
        max: mode === 'pct' ? 1 : undefined,
        axisLabel: { formatter: mode === 'pct' ? (v: number) => `${Math.round(v * 100)}%` : (v: number) => fmtInt(v) },
      },
      series,
    }

    // CSV always exports raw counts (shares can be re-derived).
    const csvRows = periods.map((p) => {
      const out: Record<string, unknown> = { period: p }
      for (const b of TIMING_BUCKETS) out[b] = byPeriod.get(p)?.get(b) ?? 0
      return out
    })

    return { option, csvRows, hasProvisional: provisional.some(Boolean), isEmpty: rows.length === 0 }
  }, [rows, mode, queryParams.grain])

  return (
    <ChartCard
      title="Ship-timing distribution"
      subtitle="Shipped orders bucketed by days early / late vs promised ship date, grouped by actual ship period"
      info={{
        definition:
          'Every shipped order bucketed by DATE_DIFF(ship date, due date, DAY) — calendar days, order-level, grouped by ACTUAL ship period (unlike the KPI view, which buckets by due date). The due date is channel-aware to match the governed f_orders rule: Xometry ship_by is stored at 23:59 ET, so a naive UTC date would grant Xometry orders an extra day. Channel, material and mfg-type filters all apply (material/type match any part on the order). "% of period" shares are re-derived from the period\'s summed counts.',
        source: q.data?.meta.source ?? 'fcm_api_order (+ medusa order for channel classification)',
      }}
      csvRows={model.csvRows}
      csvName="ship-timing-distribution"
      chartRef={chartRef}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      isEmpty={model.isEmpty}
      emptyText="No shipped orders in the selected filters."
      height={300}
      actions={
        <Segmented
          size="sm"
          options={[
            { value: 'counts', label: 'Counts' },
            { value: 'pct', label: '% of period' },
          ]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      <EChart ref={chartRef} option={model.option} height={280} />
      <p className="mt-1 text-[11.5px] text-faint">
        Calendar-day buckets, order-level.
        {model.hasProvisional ? ' Newest period is still in progress (faded) — warehouse lags ~1 day.' : ''}
      </p>
    </ChartCard>
  )
}
