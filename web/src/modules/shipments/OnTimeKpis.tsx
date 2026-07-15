import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { priorRange } from '../../lib/dates'
import { fmtInt, fmtMoney, fmtNum, fmtPct } from '../../lib/format'
import { KpiCard } from '../../components/KpiCard'
import { SHIP_FIELDS, isUnsettled, windowSums, type Sums } from './metrics'

const SOURCE_HINT =
  'Source: v_shipments_kpi (orders bucketed by their promised-ship/due date), window totals vs the equal-length prior window.'

function rate(s: Sums, num: string, den = 'orders_shipped'): number | null {
  return (s[den] ?? 0) > 0 ? (s[num] ?? 0) / s[den] : null
}

/**
 * A2 KPI cards — all re-derived from summed counts / weighted sums of the
 * ship-date explorer (breakdown none); never averaged averages.
 */
export function OnTimeKpis() {
  const { queryParams } = useFilters()
  const params = { ...queryParams, breakdown: 'none' }
  const cur = useNamedQuery('shipments_explorer', params)
  const pw = priorRange(queryParams.start, queryParams.end)
  const pri = useNamedQuery('shipments_explorer', { ...params, start: pw.start, end: pw.end })

  const s = windowSums((cur.data?.rows ?? []) as Row[], SHIP_FIELDS)
  const p = windowSums((pri.data?.rows ?? []) as Row[], SHIP_FIELDS)
  const havePrior = !pri.isLoading && !pri.error && (pri.data?.rows?.length ?? 0) > 0

  // OTS = on-time ÷ ALL orders due (unshipped count as not on time — owner convention).
  const onTime = rate(s, 'on_time', 'orders_due')
  const onTimePrior = havePrior ? rate(p, 'on_time', 'orders_due') : null
  const within36 = rate(s, 'within_36h')
  const within36Prior = havePrior ? rate(p, 'within_36h') : null
  const bizDays = rate(s, 'bizdays_weighted')
  const bizDaysPrior = havePrior ? rate(p, 'bizdays_weighted') : null
  const daysLate = rate(s, 'dayslate_weighted')
  const daysLatePrior = havePrior ? rate(p, 'dayslate_weighted') : null
  const shipped = s.orders_shipped ?? 0
  const revenue = s.revenue ?? 0

  const loading = cur.isLoading
  const val = (f: string) => (loading ? '…' : f)
  const unshipped = Math.max(0, (s.orders_due ?? 0) - (s.orders_shipped ?? 0))
  const unsettled = !loading && isUnsettled(s)

  return (
    <div>
      {unsettled && (
        <p className="mb-2 rounded-lg border border-warn/30 bg-amber-50 px-3 py-1.5 text-[12px] text-warn">
          Provisional window: {unshipped.toLocaleString()} order{unshipped === 1 ? '' : 's'} due in this window
          {unshipped === 1 ? ' has' : ' have'} not shipped yet and currently count{unshipped === 1 ? 's' : ''} as not
          on time. On-time ship % starts at 0% each morning and climbs as due orders ship.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        label="On-time ship %"
        value={val(fmtPct(onTime))}
        current={onTime}
        prior={onTimePrior}
        pctPoints
        hint={`SUM(shipped on time) ÷ SUM(ALL orders due in the window) — orders that haven't shipped count as not on time, so recent windows start low and climb as orders ship. Includes a small drag from rejected/abandoned orders that never ship. ${SOURCE_HINT}`}
      />
      <KpiCard
        label="Within-36h %"
        value={val(fmtPct(within36))}
        current={within36}
        prior={within36Prior}
        pctPoints
        hint={`SUM(shipped within 36h of clear-for-production) ÷ SUM(shipped). ${SOURCE_HINT}`}
      />
      <KpiCard
        label="Avg business days to ship"
        value={val(fmtNum(bizDays, 1))}
        current={bizDays}
        prior={bizDaysPrior}
        invertGood
        hint={`Shipped-order-weighted mean of avg_business_days_to_ship. Median business days is omitted: the view exposes per-day medians, which cannot be aggregated across days. ${SOURCE_HINT}`}
      />
      <KpiCard
        label="Avg days late"
        value={val(fmtNum(daysLate, 1))}
        current={daysLate}
        prior={daysLatePrior}
        invertGood
        hint={`Shipped-order-weighted mean of average_days_late_ship (negative = early). ${SOURCE_HINT}`}
      />
      <KpiCard
        label="Orders shipped"
        value={val(fmtInt(shipped))}
        current={shipped}
        prior={havePrior ? (p.orders_shipped ?? 0) : null}
        hint={`SUM(n_orders_shipped) across the window. ${SOURCE_HINT}`}
      />
      <KpiCard
        label="Revenue"
        value={val(fmtMoney(revenue))}
        current={revenue}
        prior={havePrior ? (p.revenue ?? 0) : null}
        hint={`SUM(revenue_from_shipped_orders) across the window. ${SOURCE_HINT}`}
      />
      </div>
    </div>
  )
}
