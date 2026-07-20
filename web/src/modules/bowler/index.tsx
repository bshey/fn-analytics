import { useEffect, useMemo, useState } from 'react'
import { useFormlabsGet, useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { businessHours, etDate } from '../../lib/bizhours'
import { isCurrentPeriod, periodLabel, periodStart } from '../../lib/dates'
import { fmtInt, fmtNum, fmtPct, num0 } from '../../lib/format'
import { ChartCard } from '../../components/ChartCard'
import { downloadCsv } from '../../lib/csv'

/**
 * Bowler chart — metrics × periods with an editable Plan per metric and
 * plan-attainment coloring on every Actual cell. Counts come from the
 * registered queries; every rate is derived here from summed counts.
 */

interface MetricDef {
  key: string
  label: string
  def: string
  /** 'pct' renders 0..1 as %, 'num' renders raw with the given decimals. */
  kind: 'pct' | 'num'
  decimals?: number
  direction: 'up' | 'down'
  defaultPlan: number | null
  /** Near-miss band in metric units (0.05 = 5 pts for pct metrics). */
  nearBand: number
  filtersApply: boolean
  /** Value for a period, from the period-keyed row maps. null = no data. */
  value: (period: string) => number | null
  /** Tooltip detail for a cell (counts behind the rate). */
  detail?: (period: string) => string
}

const CELL = {
  good: 'rgba(12,163,12,0.16)',
  near: 'rgba(250,178,25,0.20)',
  bad: 'rgba(208,59,59,0.16)',
}

const PLANS_KEY = 'bowler-plans-v1'

function loadPlans(): Record<string, number | null> {
  try {
    return JSON.parse(localStorage.getItem(PLANS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export default function BowlerPage() {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain

  const placed = useNamedQuery('orders_explorer', { ...queryParams, breakdown: 'none' })
  const ship = useNamedQuery('shipments_explorer', { ...queryParams, breakdown: 'none' })
  const days = useNamedQuery('bowler_ship_days', queryParams)
  const util = useNamedQuery('bowler_utilization', queryParams)
  const yld = useNamedQuery('bowler_yield', queryParams)
  const nps = useFormlabsGet('nps_responses', {}, { staleMs: 10 * 60_000 })
  const csEmails = useFormlabsGet('cs_emails', { start: queryParams.start, end: queryParams.end }, { staleMs: 10 * 60_000 })
  const rmaDenom = useNamedQuery('bowler_rma', queryParams)
  const rmaTickets = useFormlabsGet('rma_tickets', { start: queryParams.start, end: queryParams.end }, { staleMs: 10 * 60_000 })

  const [plans, setPlans] = useState<Record<string, number | null>>(loadPlans)
  useEffect(() => {
    localStorage.setItem(PLANS_KEY, JSON.stringify(plans))
  }, [plans])

  const model = useMemo(() => {
    const toMap = (rows: Row[] | undefined): Map<string, Row> => {
      const m = new Map<string, Row>()
      for (const r of rows ?? []) m.set(String(r.period).slice(0, 10), r)
      return m
    }
    const mPlaced = toMap(placed.data?.rows)
    const mShip = toMap(ship.data?.rows)
    const mDays = toMap(days.data?.rows)
    const mUtil = toMap(util.data?.rows)
    const mYield = toMap(yld.data?.rows)
    const mRmaDenom = toMap(rmaDenom.data?.rows)
    // Ship-date cohort: tickets attribute to the period their origin order
    // shipped; tickets without a resolvable shipped origin are excluded.
    const rmaTicketsByPeriod = new Map<string, number>()
    for (const t of ((rmaTickets.data?.rows ?? []) as Row[])) {
      if (!t.origin_shipped_at) continue
      const period = periodStart(String(t.origin_shipped_at).slice(0, 10), grain)
      rmaTicketsByPeriod.set(period, (rmaTicketsByPeriod.get(period) ?? 0) + 1)
    }

    // NPS: trailing 30 days ending at each period's end (rolling window).
    const npsRows = ((nps.data?.rows ?? []) as Row[]).slice().sort((a, b) => num0(a.recorded_at) - num0(b.recorded_at))
    const periodEndS = (period: string): number => {
      const d = new Date(`${period}T00:00:00Z`)
      switch (grain) {
        case 'day': d.setUTCDate(d.getUTCDate() + 1); break
        case 'week': d.setUTCDate(d.getUTCDate() + 7); break
        case 'month': d.setUTCMonth(d.getUTCMonth() + 1); break
        case 'quarter': d.setUTCMonth(d.getUTCMonth() + 3); break
        case 'year': d.setUTCFullYear(d.getUTCFullYear() + 1); break
      }
      return Math.floor(d.getTime() / 1000)
    }
    // Email response ≤2 business hours, fixed spec: Mon–Fri 07:30–16:00 ET,
    // Xometry/Formlabs senders, Fin-resolved and human-closed-without-reply
    // excluded. Same math as the Customer Service view, threshold pinned at 2.
    const CS_DAYS = new Set([1, 2, 3, 4, 5])
    const csByPeriod = new Map<string, { emails: number; within: number }>()
    {
      const nowMs = Date.now()
      for (const r of ((csEmails.data?.rows ?? []) as Row[])) {
        if (r.xometry || r.fin_resolved || r.closed_no_reply) continue
        if (/@(?:[a-z0-9-]+\.)*formlabs\.com$/i.test(String(r.sender ?? ''))) continue
        const at = num0(r.email_at) * 1000
        const period = periodStart(etDate(at), grain)
        let b = csByPeriod.get(period)
        if (!b) csByPeriod.set(period, (b = { emails: 0, within: 0 }))
        b.emails++
        if (r.replied_at && businessHours(at, num0(r.replied_at) * 1000, CS_DAYS, '07:30', '16:00') <= 2) b.within++
        else if (!r.replied_at && businessHours(at, nowMs, CS_DAYS, '07:30', '16:00') > 2) {
          // counted in denominator only — an unanswered email past threshold is a miss
        }
      }
    }

    const npsTrailing30 = (period: string): { nps: number | null; n: number } => {
      const end = Math.min(periodEndS(period), Math.floor(Date.now() / 1000))
      const start = end - 30 * 86400
      let p = 0, d = 0, n = 0
      for (const r of npsRows) {
        const at = num0(r.recorded_at)
        if (at < start) continue
        if (at >= end) break
        const s = num0(r.nps)
        if (s >= 9) p++
        else if (s <= 6) d++
        n++
      }
      return n ? { nps: Math.round(((p - d) / n) * 100), n } : { nps: null, n: 0 }
    }

    const ratio = (m: Map<string, Row>, numF: string, denF: string) => (period: string): number | null => {
      const r = m.get(period)
      if (!r) return null
      const den = num0(r[denF])
      return den > 0 ? num0(r[numF]) / den : null
    }
    const counts = (m: Map<string, Row>, numF: string, denF: string, label: string) => (period: string): string => {
      const r = m.get(period)
      return r ? `${fmtInt(num0(r[numF]))}/${fmtInt(num0(r[denF]))} ${label}` : ''
    }

    const metrics: MetricDef[] = [
      {
        key: 'orders_placed', label: 'Orders placed', kind: 'num', decimals: 0, direction: 'up', defaultPlan: null, nearBand: 0, filtersApply: true,
        def: 'Orders placed in the period (submitted_at cohort, QUOTING excluded — matches Looker). Channel/material/mfg filters apply.',
        value: (p) => (mPlaced.has(p) ? num0(mPlaced.get(p)!.orders_placed) : null),
      },
      {
        key: 'parts_ordered', label: 'Parts ordered', kind: 'num', decimals: 0, direction: 'up', defaultPlan: null, nearBand: 0, filtersApply: true,
        def: 'Part quantity ordered in the period (submitted_at cohort). Channel/material/mfg filters apply.',
        value: (p) => (mPlaced.has(p) ? num0(mPlaced.get(p)!.parts_ordered) : null),
      },
      {
        key: 'median_days', label: 'Median biz days to ship', kind: 'num', decimals: 0, direction: 'down', defaultPlan: 3, nearBand: 1, filtersApply: true,
        def: 'Median business days (Mon–Fri) from order to ship, revenue-generating orders only, cohorted by the governed DUE date (same period basis as OTS). Unsettled recent cohorts reflect only their already-shipped orders. Filters apply.',
        value: (p) => (mDays.has(p) ? num0(mDays.get(p)!.median_bizdays) : null),
        detail: (p) => (mDays.has(p) ? `${fmtInt(num0(mDays.get(p)!.n_shipped))} orders shipped` : ''),
      },
      {
        key: 'avg_days', label: 'Avg biz days to ship', kind: 'num', decimals: 1, direction: 'down', defaultPlan: null, nearBand: 1, filtersApply: true,
        def: 'Mean business days (Mon–Fri) from order to ship — same governed due-date cohort as the median row. The mean runs above the median when a few very late orders drag it. Filters apply.',
        value: (p) => (mDays.has(p) ? num0(mDays.get(p)!.avg_bizdays) : null),
        detail: (p) => (mDays.has(p) ? `${fmtInt(num0(mDays.get(p)!.n_shipped))} orders shipped` : ''),
      },
      {
        key: 'ots', label: '% On-time shipping', kind: 'pct', direction: 'up', defaultPlan: 0.9, nearBand: 0.05, filtersApply: true,
        def: 'Governed OTS: shipped on/before the channel-aware due date ÷ ALL orders due in the period — unshipped count against (stricter than the manual sheet, which divided by shipped; settled weeks converge). Filters apply.',
        value: ratio(mShip, 'on_time', 'orders_due'),
        detail: counts(mShip, 'on_time', 'orders_due', 'due'),
      },
      {
        key: 'h36', label: '% Shipped ≤36h', kind: 'pct', direction: 'up', defaultPlan: 0.85, nearBand: 0.05, filtersApply: true,
        def: 'Orders shipped within 36 hours ÷ orders shipped, due-date cohort (governed view). Filters apply.',
        value: ratio(mShip, 'within_36h', 'orders_shipped'),
        detail: counts(mShip, 'within_36h', 'orders_shipped', 'shipped'),
      },
      {
        key: 'util_sla', label: '% Utilization — SLA', kind: 'pct', direction: 'up', defaultPlan: 0.4, nearBand: 0.05, filtersApply: false,
        def: 'Form 4 + Form 4L active seconds ÷ their healthy-fleet capacity (fleet minus printers marked down — a fixed assumption inside v_utilization_daily). Filters do not apply.',
        value: ratio(mUtil, 'sla_active_seconds', 'sla_healthy_capacity_seconds'),
      },
      {
        key: 'util_sls', label: '% Utilization — SLS', kind: 'pct', direction: 'up', defaultPlan: 0.4, nearBand: 0.05, filtersApply: false,
        def: 'Fuse 1+ active seconds ÷ their healthy-fleet capacity (fleet minus printers marked down — a fixed assumption inside v_utilization_daily). Filters do not apply.',
        value: ratio(mUtil, 'sls_active_seconds', 'sls_healthy_capacity_seconds'),
      },
      {
        key: 'yield', label: 'Part yield %', kind: 'pct', direction: 'up', defaultPlan: 0.8, nearBand: 0.05, filtersApply: false,
        def: 'Parts shipped ÷ parts attempted (v_yield_daily, ship/cancel-date cohort). Weighted by quantity, so reads a few pts below the manual sheet (which averaged sliced percentages). Recent periods drift for ~2–3 weeks as reprint attempts land. Filters do not apply.',
        value: ratio(mYield, 'parts_shipped', 'parts_attempted'),
        detail: counts(mYield, 'parts_shipped', 'parts_attempted', 'attempted'),
      },
      {
        key: 'rma_orders', label: 'RMA % (orders)', kind: 'pct', direction: 'down', defaultPlan: 0.03, nearBand: 0.01, filtersApply: false,
        def: 'Ship-date cohort: customer-facing RMA tickets (Intercom "Form Now RMA" + "Xometry RMA") attributed to the period their origin order SHIPPED ÷ orders shipped that period — of orders shipped this period, how many came back. Cohorts younger than ~3 weeks are still accumulating (ship→RMA lag 8d median, p90 20d). Order-level — tickets carry no part quantities; ticket types ramped up early 2026, so Jan–Mar read low. See the RMA tab for the full picture. Filters do not apply.',
        value: (p) => {
          const orders = num0(mRmaDenom.get(p)?.orders_shipped)
          const t = rmaTicketsByPeriod.get(p) ?? 0
          return orders > 0 ? t / orders : null
        },
        detail: (p) => `${fmtInt(rmaTicketsByPeriod.get(p) ?? 0)}/${fmtInt(num0(mRmaDenom.get(p)?.orders_shipped))} orders`,
      },
      {
        key: 'cs_2h', label: '% Emails answered ≤2 biz hrs', kind: 'pct', direction: 'up', defaultPlan: 0.8, nearBand: 0.1, filtersApply: false,
        def: 'Inbound customer emails (Intercom) answered by a human within 2 business hours, counting Mon–Fri 07:30–16:00 ET only. Excludes Xometry and Formlabs senders, Fin-resolved conversations, and emails a teammate closed without replying. Unanswered emails past the threshold count as misses. Fixed spec — the Customer Service page has the adjustable version. Filters do not apply.',
        value: (p) => {
          const b = csByPeriod.get(p)
          return b && b.emails > 0 ? b.within / b.emails : null
        },
        detail: (p) => {
          const b = csByPeriod.get(p)
          return b ? `${fmtInt(b.within)}/${fmtInt(b.emails)} emails` : ''
        },
      },
      {
        key: 'nps_t30', label: 'NPS — trailing 30d', kind: 'num', decimals: 0, direction: 'up', defaultPlan: 40, nearBand: 10, filtersApply: false,
        def: 'NPS over the 30 days ending at each period\'s close (%promoters − %detractors, rolling window — adjacent columns overlap by design). Hover shows the response count. Filters do not apply.',
        value: (p) => npsTrailing30(p).nps,
        detail: (p) => `${fmtInt(npsTrailing30(p).n)} responses in window`,
      },
    ]

    const periodSet = new Set<string>()
    for (const m of [mPlaced, mShip, mDays, mUtil, mYield]) for (const p of m.keys()) periodSet.add(p)
    const periods = [...periodSet].sort()

    return { metrics, periods }
  }, [placed.data, ship.data, days.data, util.data, yld.data, nps.data, csEmails.data, rmaDenom.data, rmaTickets.data, grain, queryParams.start, queryParams.end])

  const fmtVal = (m: MetricDef, v: number | null): string => {
    if (v === null) return '—'
    if (m.kind === 'pct') return fmtPct(v)
    return m.decimals === 0 ? fmtInt(v) : fmtNum(v, m.decimals ?? 1)
  }
  const planOf = (m: MetricDef): number | null => (plans[m.key] === undefined ? m.defaultPlan : plans[m.key])
  const cellColor = (m: MetricDef, v: number | null): string | undefined => {
    const plan = planOf(m)
    if (v === null || plan === null) return undefined
    const meets = m.direction === 'up' ? v >= plan : v <= plan
    if (meets) return CELL.good
    return Math.abs(v - plan) <= m.nearBand ? CELL.near : CELL.bad
  }

  const isLoading = placed.isLoading || ship.isLoading
  const anyError = placed.error || ship.error

  const exportCsv = () => {
    const rows = model.metrics.map((m) => {
      const out: Record<string, unknown> = { metric: m.label, plan: planOf(m) }
      for (const p of model.periods) out[p] = m.value(p)
      return out
    })
    downloadCsv('bowler', rows)
  }

  return (
    <ChartCard
      title="Bowler Chart"
      subtitle={`Plan vs actual per ${grain} — edit any Plan to recolor its row (saved in this browser)`}
      info={{
        definition:
          'The ops bowler: each metric per period from the global date range and grain, colored against your editable Plan (green = meets plan, amber = within the near-miss band, red = miss). Channel/material/mfg filters apply only to the order-based rows (marked in each metric\'s hover). Rates are derived from summed counts per period, never averaged percentages. The newest period is provisional (faded). Hover any cell for the counts behind it; hover a metric name for its exact definition.',
        source: 'orders/shipments queries + v_utilization_daily + v_yield_daily + fcm_api_rmapart + v_labor_daily + Qualtrics NPS',
      }}
      isLoading={isLoading}
      error={anyError ?? null}
      height={480}
      actions={
        <button className="btn !px-2 !py-1 text-[11.5px]" onClick={exportCsv}>
          CSV
        </button>
      }
    >
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse bg-white text-[12.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 border-b border-r border-line bg-[#fafbfc] px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-sub">Metric</th>
              <th className="border-b border-r border-line bg-[#fafbfc] px-2 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-sub">Plan</th>
              {model.periods.map((p) => (
                <th key={p} className="whitespace-nowrap border-b border-r border-line/70 bg-[#fafbfc] px-3 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-sub last:border-r-0">
                  {periodLabel(p, grain)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.metrics.map((m) => {
              const plan = planOf(m)
              return (
                <tr key={m.key} className="border-b border-line/70 last:border-b-0">
                  <td className="sticky left-0 z-10 max-w-[15rem] border-r border-line bg-white px-3 py-2 font-medium" title={m.def}>
                    {m.label}
                    {!m.filtersApply && <span className="text-faint" title="Global channel/material filters do not apply"> ◦</span>}
                  </td>
                  <td className="border-r border-line px-2 py-2 text-center">
                    <input
                      type="number"
                      step={m.kind === 'pct' ? 1 : 0.5}
                      value={plan === null ? '' : m.kind === 'pct' ? Math.round(plan * 1000) / 10 : plan}
                      placeholder="—"
                      onChange={(e) => {
                        const raw = e.target.value
                        setPlans((cur) => ({
                          ...cur,
                          [m.key]: raw === '' ? null : m.kind === 'pct' ? Number(raw) / 100 : Number(raw),
                        }))
                      }}
                      className="w-16 rounded-md border border-line px-1 py-0.5 text-center text-[12px] tabular-nums"
                      title={m.kind === 'pct' ? 'Plan in % (e.g. 90)' : 'Plan value'}
                    />
                  </td>
                  {model.periods.map((p) => {
                    const v = m.value(p)
                    const bg = cellColor(m, v)
                    const provisional = isCurrentPeriod(p, grain)
                    const detail = m.detail?.(p)
                    const csRow = m.key === 'cs_2h'
                    const display =
                      v === null && csRow && csEmails.isLoading
                        ? '…'
                        : v === null && csRow && csEmails.error
                          ? '!'
                          : fmtVal(m, v)
                    const cellTitle =
                      v === null && csRow && csEmails.isLoading
                        ? 'Loading Intercom threads — first load of a new range takes a minute or two'
                        : v === null && csRow && csEmails.error
                          ? `Intercom fetch failed: ${csEmails.error.message}`
                          : detail || undefined
                    return (
                      <td
                        key={p}
                        className={`whitespace-nowrap border-r border-line/70 px-3 py-2 text-center tabular-nums last:border-r-0 ${provisional ? 'opacity-60' : ''} ${
                          v === null && csRow && csEmails.isLoading ? 'text-faint' : ''
                        }`}
                        style={bg ? { backgroundColor: bg } : undefined}
                        title={cellTitle}
                      >
                        {display}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 space-y-0.5 text-[11.5px] text-faint">
        <p>
          ◦ = global filters don't apply to that row. Newest period is provisional (faded). Plans are stored in this
          browser; percent plans are entered as whole numbers (90 = 90%).
        </p>
        {csEmails.isLoading && (
          <p>Email row is loading Intercom threads — the first load of a new date range takes a minute or two.</p>
        )}
        {csEmails.error && (
          <p className="rounded-md border border-warn/30 bg-amber-50 px-2 py-1 text-warn">
            Email row failed to load: {csEmails.error.message}
            {csEmails.error.hint ? ` — ${csEmails.error.hint}` : ''}
          </p>
        )}
      </div>
    </ChartCard>
  )
}
