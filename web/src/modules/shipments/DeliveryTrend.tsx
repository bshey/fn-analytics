import { useMemo, useRef } from 'react'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel } from '../../lib/dates'
import { fmtPct, num0 } from '../../lib/format'
import { seriesColor } from '../../lib/palette'
import { gridDefaults, lineDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { EChart, type EChartHandle } from '../../components/EChart'
import { ratePoint, tooltipFormatter } from './metrics'

/**
 * A2 — on-time DELIVERY trend, cohorted by the quoted delivery date the
 * customer saw at checkout. Same convention as OTS: undelivered orders count
 * as not on time, so recent periods start low and climb as packages land.
 */
export function DeliveryTrend() {
  const { queryParams } = useFilters()
  const chartRef = useRef<EChartHandle>(null)
  const q = useNamedQuery('delivery_kpis', queryParams)
  const rows = (q.data?.rows ?? []) as Row[]

  const model = useMemo(() => {
    const periods = rows.map((r) => String(r.period ?? '').slice(0, 10)).filter(Boolean)
    const byPeriod = new Map(rows.map((r) => [String(r.period ?? '').slice(0, 10), r]))
    const provisional = periods.map((p) => {
      const r = byPeriod.get(p)
      return isCurrentPeriod(p, queryParams.grain) || (r ? num0(r.orders_due) > num0(r.delivered) : false)
    })
    const otd = (r: Row | undefined) => (r && num0(r.orders_due) > 0 ? num0(r.delivered_on_time) / num0(r.orders_due) : null)

    const windowDue = rows.reduce((a, r) => a + num0(r.orders_due), 0)
    const windowOnTime = rows.reduce((a, r) => a + num0(r.delivered_on_time), 0)
    const undelivered = windowDue - rows.reduce((a, r) => a + num0(r.delivered), 0)

    const option: Record<string, unknown> = {
      grid: gridDefaults,
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' }, formatter: tooltipFormatter((v) => fmtPct(v ?? null)) },
      xAxis: { type: 'category', boundaryGap: false, data: periods.map((p) => periodLabel(p, queryParams.grain)) },
      yAxis: { type: 'value', min: 0, max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
      series: [
        {
          ...lineDefaults,
          name: 'On-time delivery %',
          color: seriesColor('On-time delivery %'),
          connectNulls: false,
          data: periods.map((p, i) => {
            const r = byPeriod.get(p)
            return r ? ratePoint(num0(r.delivered_on_time), num0(r.orders_due), provisional[i]) : null
          }),
        },
      ],
    }
    const csvRows = rows.map((r) => ({
      period: r.period,
      orders_due_delivery: r.orders_due,
      delivered: r.delivered,
      delivered_on_time: r.delivered_on_time,
      otd_pct: otd(r),
    }))
    return {
      option,
      csvRows,
      isEmpty: rows.length === 0,
      hasProvisional: provisional.some(Boolean),
      windowOtd: windowDue > 0 ? windowOnTime / windowDue : null,
      undelivered,
    }
  }, [rows, queryParams.grain])

  return (
    <ChartCard
      title="On-time delivery trend (OTD)"
      subtitle={`Of orders promised delivery each period, the share delivered on time${
        model.windowOtd !== null ? ` — window OTD ${fmtPct(model.windowOtd)}` : ''
      }`}
      info={{
        definition:
          'OTD % = delivered on/before the quoted delivery date ÷ ALL orders whose quoted delivery fell in the period. The quote is what the customer saw at checkout (medusa estimated_delivery_dates for the chosen shipping speed); delivery comes from ShipStation "delivered" tracking events (date in America/New_York). Undelivered orders count as NOT on time, so recent periods start low and climb as packages land. Web/PreForm parcel orders only — Xometry and local pickup have no checkout delivery quote/tracking. Delivery tracking exists since Apr 30, 2026; earlier periods read ~0% and should be ignored.',
        source: q.data?.meta.source ?? 'fcm_api_order + medusa order + fcm_api_orderevent (ShipStation)',
      }}
      csvRows={model.csvRows}
      csvName="on-time-delivery-trend"
      chartRef={chartRef}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      isEmpty={model.isEmpty}
      emptyText="No orders with a quoted delivery date in the selected filters."
      height={300}
    >
      <EChart ref={chartRef} option={model.option} height={280} />
      {model.hasProvisional && (
        <p className="mt-1 text-[11.5px] text-faint">
          Faded points are unsettled: {model.undelivered.toLocaleString()} order
          {model.undelivered === 1 ? '' : 's'} in this window {model.undelivered === 1 ? 'is' : 'are'} not yet
          delivered and count as not on time. Delivery tracking exists since Apr 30, 2026.
        </p>
      )}
    </ChartCard>
  )
}
