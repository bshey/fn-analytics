import { useMemo } from 'react'
import { useNamedQuery, type Row } from '../../lib/api'
import { addDaysIso, todayIso } from '../../lib/dates'
import { fmtMoneyExact } from '../../lib/format'
import { ChartCard } from '../../components/ChartCard'

// ---------------------------------------------------------------------------
// Financials — the owner's weekly bookings tables, computed live. Both tables
// are governed order-time bookings; "Revenue Generating" is the RG-channel
// subset (incl. Xometry). Windows are fixed to the last COMPLETE Sun–Sat week
// and the 30 days ending that Saturday — the global date range does not apply.
// ---------------------------------------------------------------------------

const RG = ['Web - Revenue Generating', 'PreForm - Revenue Generating', 'Xometry']
const ALL = [
  'Web - Revenue Generating',
  'Web - Non-Revenue Generating',
  'PreForm - Revenue Generating',
  'PreForm - Non-Revenue Generating',
  'Xometry',
]

/** Most recent completed Sat (yesterday counts if yesterday was Saturday). */
function lastSaturday(): string {
  let d = addDaysIso(todayIso(), -1)
  for (let i = 0; i < 7; i++) {
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === 6) return d
    d = addDaysIso(d, -1)
  }
  return d
}

function FinTable({
  title,
  channels,
  week,
  month,
  weekLabel,
}: {
  title: string
  channels: string[]
  week: Map<string, number>
  month: Map<string, number>
  weekLabel: string
}) {
  const rows = channels.map((ch) => ({
    ch,
    w: week.get(ch) ?? 0,
    m: month.get(ch) ?? 0,
  }))
  const tw = rows.reduce((t, r) => t + r.w, 0)
  const tm = rows.reduce((t, r) => t + r.m, 0)
  const cell = 'border-r border-line/70 px-3 py-1.5 text-right tabular-nums last:border-r-0'
  return (
    <div>
      <h4 className="mb-1.5 text-[12.5px] font-semibold">{title}</h4>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse bg-white text-[12.5px]">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wide text-sub">
              <th className="border-b border-r border-line bg-[#fafbfc] px-3 py-1.5 text-left">Channel</th>
              <th className="border-b border-r border-line bg-[#fafbfc] px-3 py-1.5 text-right" title={weekLabel}>
                Last week
              </th>
              <th className="border-b border-r border-line bg-[#fafbfc] px-3 py-1.5 text-right">Last 30 days</th>
              <th className="border-b border-line bg-[#fafbfc] px-3 py-1.5 text-right" title="Last 30 days × 12">
                Run rate
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ch} className="border-b border-line/60">
                <td className="border-r border-line/70 px-3 py-1.5">{r.ch}</td>
                <td className={cell}>{fmtMoneyExact(r.w)}</td>
                <td className={cell}>{fmtMoneyExact(r.m)}</td>
                <td className={cell}>{fmtMoneyExact(r.m * 12)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="border-r border-line/70 px-3 py-1.5">TOTAL</td>
              <td className={cell}>{fmtMoneyExact(tw)}</td>
              <td className={cell}>{fmtMoneyExact(tm)}</td>
              <td className={cell}>{fmtMoneyExact(tm * 12)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function Financials() {
  const satEnd = lastSaturday()
  const weekStart = addDaysIso(satEnd, -6)
  const monthStart = addDaysIso(satEnd, -29)

  const base = { grain: 'week', breakdown: 'reporting_category', channels: [], mfgTypes: [], materials: [] }
  const wk = useNamedQuery('orders_explorer', { ...base, start: weekStart, end: satEnd })
  const mo = useNamedQuery('orders_explorer', { ...base, start: monthStart, end: satEnd })

  const model = useMemo(() => {
    const agg = (rows: Row[] | undefined): Map<string, number> => {
      const m = new Map<string, number>()
      for (const r of rows ?? []) {
        const ch = String(r.breakdown)
        m.set(ch, (m.get(ch) ?? 0) + Number(r.bookings ?? 0))
      }
      return m
    }
    return { week: agg(wk.data?.rows), month: agg(mo.data?.rows) }
  }, [wk.data, mo.data])

  const weekLabel = `${weekStart} → ${satEnd}`

  return (
    <ChartCard
      title="Financials"
      subtitle={`Bookings by channel — last complete week (${weekLabel}) and the 30 days ending ${satEnd}`}
      info={{
        definition:
          'Governed order-time bookings (amount recognized when the order is placed — ties Looker to the dollar), keyed by submitted date. "Revenue Generating Financials" is the revenue-generating subset (Web-RG, PreForm-RG, Xometry); "Operating Financials" includes the non-revenue channels. Last week = the most recent COMPLETE Sunday–Saturday week; Last 30 days = the 30 calendar days ending that same Saturday; Run rate = last-30-days × 12. These windows are fixed — the global date range and filters do not apply. Note: recent cohorts can grow slightly after the fact as quotes convert to accepted orders.',
        source: wk.data?.meta.source ?? 'fcm_api_order (+ medusa classification) — order-placed cohort',
      }}
      isLoading={wk.isLoading || mo.isLoading}
      isFetching={wk.isFetching || mo.isFetching}
      error={wk.error ?? mo.error ?? null}
      height={300}
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <FinTable title="Revenue Generating Financials" channels={RG} week={model.week} month={model.month} weekLabel={weekLabel} />
        <FinTable title="Operating Financials" channels={ALL} week={model.week} month={model.month} weekLabel={weekLabel} />
      </div>
    </ChartCard>
  )
}
