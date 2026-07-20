import { useMemo, useRef, useState } from 'react'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel } from '../../lib/dates'
import { fmtInt, fmtPct, num0 } from '../../lib/format'
import { STATUS } from '../../lib/palette'
import { gridDefaults, stackedBarDefaults, lineDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { EChart, type EChartHandle } from '../../components/EChart'
import { Segmented } from '../../components/Segmented'
import { provisionalPoint, ratePoint, tooltipFormatter } from './metrics'

type Mode = 'counts' | 'pct'

/** A2 — of the orders that shipped LATE each period, how many hit a production issue. */
export function LateIssues() {
  const { queryParams } = useFilters()
  const [mode, setMode] = useState<Mode>('pct')
  const chartRef = useRef<EChartHandle>(null)

  const q = useNamedQuery('ship_late_issues', queryParams)
  const rows = (q.data?.rows ?? []) as Row[]

  const model = useMemo(() => {
    const sorted = [...rows].sort((a, b) => String(a.period).localeCompare(String(b.period)))
    const periods = sorted.map((r) => String(r.period).slice(0, 10))
    const provisional = periods.map((p) => isCurrentPeriod(p, queryParams.grain))

    const totals = sorted.reduce<{ late: number; lateIssue: number; ontime: number; ontimeIssue: number }>(
      (t, r) => ({
        late: t.late + num0(r.late_orders),
        lateIssue: t.lateIssue + num0(r.late_with_issue),
        ontime: t.ontime + num0(r.ontime_orders),
        ontimeIssue: t.ontimeIssue + num0(r.ontime_with_issue),
      }),
      { late: 0, lateIssue: 0, ontime: 0, ontimeIssue: 0 },
    )

    const series =
      mode === 'counts'
        ? [
            {
              ...stackedBarDefaults,
              stack: 'late',
              name: 'Late, with issue',
              color: STATUS.critical,
              data: sorted.map((r, i) => provisionalPoint(num0(r.late_with_issue), provisional[i])),
            },
            {
              ...stackedBarDefaults,
              stack: 'late',
              name: 'Late, no recorded issue',
              color: STATUS.warning,
              data: sorted.map((r, i) => provisionalPoint(num0(r.late_orders) - num0(r.late_with_issue), provisional[i])),
            },
          ]
        : [
            {
              ...stackedBarDefaults,
              name: 'Late ships with issue %',
              color: STATUS.critical,
              data: sorted.map((r, i) => ratePoint(num0(r.late_with_issue), num0(r.late_orders), provisional[i])),
            },
            {
              ...lineDefaults,
              name: 'On-time ships with issue % (baseline)',
              color: STATUS.warning,
              data: sorted.map((r, i) => ratePoint(num0(r.ontime_with_issue), num0(r.ontime_orders), provisional[i])),
            },
          ]

    const fmt = mode === 'pct' ? (v: number | null | undefined) => fmtPct(v ?? null) : (v: number | null | undefined) => fmtInt(v ?? null)
    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: true, top: 0, type: 'scroll' },
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

    const csvRows = sorted.map((r) => ({
      period: r.period,
      late_orders: r.late_orders,
      late_with_issue: r.late_with_issue,
      ontime_orders: r.ontime_orders,
      ontime_with_issue: r.ontime_with_issue,
    }))

    return { option, csvRows, totals, hasProvisional: provisional.some(Boolean), isEmpty: rows.length === 0 }
  }, [rows, mode, queryParams.grain])

  const t = model.totals
  return (
    <ChartCard
      title="Late ships × production issues"
      subtitle="Of the orders that shipped late each period, how many hit a recorded production issue"
      info={{
        definition:
          'Shipped orders grouped by ACTUAL ship period. Late = shipped at least 1 calendar day after the governed channel-aware due date (Xometry ship_by stored 23:59 ET). An order "has an issue" if it ever fired a TOTAL_BUILD_FAILURE, PART_NEEDS_REPRINT, PART_QUARANTINED or MANUFACTURING_ISSUE order event, or any of its lots was QC-fail routed to the quarantine line (station app; those events exist since Jul 2, 2026, so earlier periods rely on order events alone and read slightly lower). The % view divides by that period\'s LATE ships only, with the on-time ships\' issue rate as a baseline line — if the red bars sit far above the baseline, issues are a driver of lateness rather than background noise. Channel, material and mfg-type filters all apply (any part on the order matches).',
        source: q.data?.meta.source ?? 'fcm_api_order + fcm_api_orderevent + manufacturing_events (station app)',
      }}
      csvRows={model.csvRows}
      csvName="late-ships-issues"
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
            { value: 'pct', label: '% of late' },
            { value: 'counts', label: 'Counts' },
          ]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      <EChart ref={chartRef} option={model.option} height={280} />
      <p className="mt-1 text-[11.5px] text-faint">
        Window totals: {fmtInt(t.lateIssue)}/{fmtInt(t.late)} late ships had an issue (
        {t.late > 0 ? fmtPct(t.lateIssue / t.late) : '—'}) vs {fmtInt(t.ontimeIssue)}/{fmtInt(t.ontime)} on-time (
        {t.ontime > 0 ? fmtPct(t.ontimeIssue / t.ontime) : '—'}).
        {model.hasProvisional ? ' Newest period is still in progress (faded).' : ''}
      </p>
    </ChartCard>
  )
}
