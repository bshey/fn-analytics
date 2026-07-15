import { useMemo, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { todayIso } from '../../lib/dates'
import { fmtDate, fmtInt, fmtMoney, num } from '../../lib/format'
import { STATUS } from '../../lib/palette'
import { ChartCard } from '../../components/ChartCard'
import { KpiCard } from '../../components/KpiCard'
import { DataTable } from '../../components/DataTable'
import { Segmented } from '../../components/Segmented'
import { predictShip, rollToShippingDay, suggestQuote, BACKLOG_HIGH, type Backlog, type Prediction, type QuoteInput } from './rules'
import { MesOrder, orderShortNo } from '../../components/MesOrder'

const RISK_META: Record<Prediction['risk'], { label: string; color: string; rank: number }> = {
  'past-due': { label: 'Past due', color: STATUS.critical, rank: 0 },
  'likely-late': { label: 'Likely late', color: STATUS.serious, rank: 1 },
  'at-risk': { label: 'At risk', color: STATUS.warning, rank: 2 },
  'on-track': { label: 'On track', color: STATUS.good, rank: 3 },
}

interface PredictedRow {
  row: Row
  pred: Prediction
}

function RiskChip({ risk }: { risk: Prediction['risk'] }) {
  const m = RISK_META[risk]
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px]">
      <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  )
}

/** Layer A quote helper — interactive promise suggestion. */
function QuoteHelper({ backlog }: { backlog: Backlog }) {
  const [channel, setChannel] = useState<QuoteInput['channel']>('FormNow')
  const [family, setFamily] = useState<QuoteInput['family']>('SLA')
  const [qtyBucket, setQtyBucket] = useState<QuoteInput['qtyBucket']>('small')
  const today = todayIso()
  const { q, drivers } = suggestQuote({ channel, family, qtyBucket }, backlog)

  return (
    <ChartCard
      title="Quote helper"
      subtitle="Suggested promise for a new order, from the acceptance-time rules (Layer A)"
      info={{
        definition:
          'Base = historical accepted→ship quantiles per channel (trained Oct 2025–May 2026), adjusted for size, family mix and the live backlog trigger. Quote the P80 date; P50 is the likely date. Calendar days. See docs/late-shipment-analysis.md §4 Layer A.',
        source: 'docs/late-shipment-analysis.md — backtest: P80 coverage 83–88% with the backlog trigger',
      }}
      height={200}
    >
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <Segmented
          size="sm"
          options={[
            { value: 'FormNow', label: 'Form Now' },
            { value: 'Xometry', label: 'Xometry' },
          ]}
          value={channel}
          onChange={setChannel}
        />
        <Segmented
          size="sm"
          options={[
            { value: 'SLA', label: 'SLA' },
            { value: 'SLS', label: 'SLS' },
            { value: 'Mixed', label: 'Mixed' },
          ]}
          value={family}
          onChange={setFamily}
        />
        <Segmented
          size="sm"
          options={[
            { value: 'small', label: '≤5 pcs' },
            { value: 'medium', label: '6–20' },
            { value: 'large', label: '21–100' },
            { value: 'xl', label: '100+' },
          ]}
          value={qtyBucket}
          onChange={setQtyBucket}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="card px-4 py-3">
          <div className="label-xs">Likely (P50)</div>
          <div className="mt-1 text-xl font-semibold">{fmtDate(rollToShippingDay(addDays(today, q.p50)))}</div>
          <div className="text-[11.5px] text-faint">{q.p50} days</div>
        </div>
        <div className="card border-accent/40 px-4 py-3">
          <div className="label-xs text-accent">Quote this (P80)</div>
          <div className="mt-1 text-xl font-semibold">{fmtDate(rollToShippingDay(addDays(today, q.p80)))}</div>
          <div className="text-[11.5px] text-faint">{q.p80} days</div>
        </div>
        <div className="card px-4 py-3">
          <div className="label-xs">Conservative (P90)</div>
          <div className="mt-1 text-xl font-semibold">{fmtDate(rollToShippingDay(addDays(today, q.p90)))}</div>
          <div className="text-[11.5px] text-faint">{q.p90} days</div>
        </div>
      </div>
      {drivers.length > 0 && <p className="mt-2 text-[11.5px] text-sub">Adjustments: {drivers.join(' · ')}</p>}
    </ChartCard>
  )
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function PredictorPage() {
  const { queryParams } = useFilters()
  const q = useNamedQuery('predictor_features', { channels: queryParams.channels })
  const rows = (q.data?.rows ?? []) as Row[]
  const today = todayIso()
  const [search, setSearch] = useState('')

  const model = useMemo(() => {
    const predicted: PredictedRow[] = rows.map((row) => ({ row, pred: predictShip(row, today) }))
    predicted.sort((a, b) => RISK_META[a.pred.risk].rank - RISK_META[b.pred.risk].rank || String(a.pred.p80).localeCompare(String(b.pred.p80)))
    const backlog: Backlog = rows.length
      ? { slaOpen: num(rows[0].sla_open) ?? 0, slsOpen: num(rows[0].sls_open) ?? 0, totalOpen: num(rows[0].total_open) ?? 0 }
      : { slaOpen: 0, slsOpen: 0, totalOpen: 0 }
    const counts = { 'past-due': 0, 'likely-late': 0, 'at-risk': 0, 'on-track': 0 } as Record<Prediction['risk'], number>
    let atRiskValue = 0
    for (const p of predicted) {
      counts[p.pred.risk]++
      if (p.pred.risk !== 'on-track') atRiskValue += num(p.row.bookings) ?? 0
    }
    const csvRows = predicted.map(({ row, pred }) => ({
      order: orderShortNo(row.internal_display_id, row.id),
      msb: row.internal_display_id,
      channel: row.channel,
      family: row.family,
      status: row.status,
      qty: row.qty,
      due: row.due_date,
      predicted_p50: pred.p50,
      predicted_p80: pred.p80,
      predicted_p90: pred.p90,
      risk: pred.risk,
      drivers: pred.drivers.join('; '),
    }))
    return { predicted, backlog, counts, atRiskValue, csvRows }
  }, [rows, today])

  const needle = search.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return []
    return model.predicted.filter(({ row }) =>
      [orderShortNo(row.internal_display_id, row.id), row.internal_display_id, row.source_display_id, row.id].some(
        (v) => String(v ?? '').toLowerCase().includes(needle),
      ),
    )
  }, [model.predicted, needle])

  const columns = useMemo<ColumnDef<PredictedRow, unknown>[]>(
    () => [
      {
        header: 'Order',
        id: 'order',
        accessorFn: (r) => orderShortNo(r.row.internal_display_id, r.row.id),
        cell: ({ row }) => <MesOrder internalDisplayId={row.original.row.internal_display_id} id={row.original.row.id} details />,
      },
      { header: 'Channel', id: 'channel', accessorFn: (r) => String(r.row.reporting_category ?? r.row.channel) },
      { header: 'Family', id: 'family', accessorFn: (r) => String(r.row.family) },
      { header: 'Status', id: 'status', accessorFn: (r) => String(r.row.status) },
      { header: 'Qty', id: 'qty', accessorFn: (r) => num(r.row.qty) ?? 0, cell: ({ row }) => fmtInt(num(row.original.row.qty)), meta: { align: 'right' } },
      { header: 'Age', id: 'age', accessorFn: (r) => num(r.row.age_days) ?? 0, cell: ({ row }) => `${num(row.original.row.age_days) ?? 0}d`, meta: { align: 'right' } },
      { header: 'Due', id: 'due', accessorFn: (r) => String(r.row.due_date ?? ''), cell: ({ row }) => fmtDate(row.original.row.due_date) },
      { header: 'Predicted (P50)', id: 'p50', accessorFn: (r) => r.pred.p50, cell: ({ row }) => fmtDate(row.original.pred.p50) },
      {
        header: 'Predicted (P80)',
        id: 'p80',
        accessorFn: (r) => r.pred.p80,
        cell: ({ row }) => <span className="font-medium">{fmtDate(row.original.pred.p80)}</span>,
      },
      { header: 'Risk', id: 'risk', accessorFn: (r) => RISK_META[r.pred.risk].rank, cell: ({ row }) => <RiskChip risk={row.original.pred.risk} /> },
      {
        header: 'Drivers',
        id: 'drivers',
        accessorFn: (r) => r.pred.drivers.join('; '),
        cell: ({ row }) => <span className="text-[12px] text-sub">{row.original.pred.drivers.join(' · ') || '—'}</span>,
      },
      { header: '$', id: 'bookings', accessorFn: (r) => num(r.row.bookings) ?? 0, cell: ({ row }) => fmtMoney(num(row.original.row.bookings)), meta: { align: 'right' } },
    ],
    [],
  )

  const b = model.backlog
  const backlogNote =
    b.slsOpen >= BACKLOG_HIGH.sls || b.slaOpen >= BACKLOG_HIGH.sla || b.totalOpen >= BACKLOG_HIGH.total

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold">Ship Date Predictor</h2>
          <p className="text-[12px] text-sub">
            Anticipated ship dates for every open production order — empirical rules from{' '}
            <span className="font-mono text-[11px]">docs/late-shipment-analysis.md</span>, backtested on June 2026
            (P80 coverage 83–88%). Channel filter applies; other global filters don't.
          </p>
        </div>
      </div>

      {backlogNote && (
        <p className="rounded-lg border border-warn/30 bg-amber-50 px-3 py-1.5 text-[12px] text-warn">
          Backlog trigger active — SLA {b.slaOpen} open (threshold {BACKLOG_HIGH.sla}), SLS {b.slsOpen} (threshold{' '}
          {BACKLOG_HIGH.sls}), total {b.totalOpen} (threshold {BACKLOG_HIGH.total}). P80/P90 predictions include +2
          days for affected families; quotes should too.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="Open orders" value={String(model.predicted.length)} hint="Production orders: ACCEPTED / PRINTING / ON_HOLD" />
        <KpiCard label="Past due" value={String(model.counts['past-due'])} hint="Due date already missed — Layer C predictions from due date" />
        <KpiCard label="Likely late" value={String(model.counts['likely-late'])} hint="Predicted P50 ship date after the due date" />
        <KpiCard label="At risk" value={String(model.counts['at-risk'])} hint="On track at P50 but predicted P80 after the due date" />
        <KpiCard label="$ not on-track" value={fmtMoney(model.atRiskValue)} hint="Bookings value of past-due + likely-late + at-risk orders" />
      </div>

      <QuoteHelper backlog={model.backlog} />

      <ChartCard
        title="Order lookup — anticipated ship date"
        subtitle="Search by internal number (MSB last 5). P80 is the date to communicate; P50 is the likely date."
        info={{
          definition:
            'Layer B rules: remaining time conditioned on order age (the hazard is U-shaped) with the print-start override when tighter; a floor-state override when all lots are binned (ready to ship = next truck); offsets for failure events (dose-escalating), SLS/Mixed on Form Now, holds, quarantined lots, and the live backlog trigger. Layer C replaces these once an order is past due. Predicted dates always roll forward to the next shipping day (Mon–Fri, holidays excluded). Trained on Oct 2025–Jul 2026 shipped orders; June 2026 holdout backtest: P50 coverage 47–56%, P80 83–88% with backlog trigger. Re-fit quarterly.',
          source: 'predictor_features (live) × docs/late-shipment-analysis.md §4',
        }}
        csvRows={model.csvRows}
        csvName="ship-date-predictions"
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={!rows.length}
        emptyText="No open production orders match the selected channels."
        height={420}
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search an open order — internal number (e.g. 19374), MSB id, or order id…"
          className="mb-3 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none focus:border-accent"
          aria-label="Order search"
        />
        {!needle && (
          <p className="py-8 text-center text-[13px] text-faint">
            Type an order number to see its predicted ship dates. The CSV button exports predictions for all{' '}
            {model.predicted.length.toLocaleString()} open orders.
          </p>
        )}
        {needle && matches.length === 0 && (
          <p className="py-8 text-center text-[13px] text-faint">No open production order matches “{search.trim()}”.</p>
        )}
        {matches.length > 0 && (
          <DataTable data={matches} columns={columns} maxRows={50} emptyText="No matches." />
        )}
      </ChartCard>
    </div>
  )
}
