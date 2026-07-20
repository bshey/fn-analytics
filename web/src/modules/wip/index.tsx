import { useMemo, useRef, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { fmtDate, fmtInt, fmtMoney, fmtMoneyExact, num, num0 } from '../../lib/format'
import { addDaysIso, isCurrentPeriod, periodLabel, periodStart, todayIso, type Grain } from '../../lib/dates'
import { isShippingDay } from '../../lib/shippingDays'
import { ORDER_STATUS_COLORS, STATUS, seriesColor } from '../../lib/palette'
import { barDefaults, gridDefaults, lineDefaults, stackedBarDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { KpiCard } from '../../components/KpiCard'
import { DataTable } from '../../components/DataTable'
import { Modal } from '../../components/Modal'
import { MesOrder, orderShortNo } from '../../components/MesOrder'
import { EChart, type EChartHandle } from '../../components/EChart'
import { Segmented } from '../../components/Segmented'

// ---------------------------------------------------------------------------
// Module B — Throughput & WIP: live triage snapshot + pipeline event trends
// and end-of-day backlog series.
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ['QUOTING', 'ACCEPTED', 'PRINTING', 'ON_HOLD'] as const

const STATUS_LABELS: Record<string, string> = {
  QUOTING: 'Quoting',
  ACCEPTED: 'Accepted',
  PRINTING: 'Printing',
  ON_HOLD: 'On hold',
}

const AGE_BUCKETS = ['<1d', '1-2d', '3-5d', '6-10d', '10+d'] as const

function ageBucket(days: number): (typeof AGE_BUCKETS)[number] {
  if (days < 1) return '<1d'
  if (days <= 2) return '1-2d'
  if (days <= 5) return '3-5d'
  if (days <= 10) return '6-10d'
  return '10+d'
}

function bool(x: unknown): boolean {
  return x === true || x === 'true' || x === 1
}

/** Business days (Mon-Fri, excl. company holidays) elapsed since the promised ship date. */
function bizDaysOverdue(shipBy: string | null, today: string): number {
  if (!shipBy || shipBy >= today) return 0
  let n = 0
  for (let d = addDaysIso(shipBy, 1); d <= today && n < 260; d = addDaysIso(d, 1)) {
    if (isShippingDay(d)) n++
  }
  return n
}

interface SnapRow {
  internal_display_id: string
  source_display_id: string | null
  status: string
  reporting_category: string
  manufacturing_location: string
  bookings: number
  submitted_at: string | null
  accepted_at: string | null
  ship_by: string | null
  age_days: number
  past_due: boolean
  days_overdue: number
  biz_days_overdue: number
  last_event_at: string | null
  days_since_event: number | null
  last_event_type: string | null
  has_not_progressing: boolean
  n_parts: number
  n_unique_parts: number
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
}

function overdueColor(days: number): string | null {
  if (days >= 6) return STATUS.critical
  if (days >= 3) return STATUS.serious
  if (days >= 1) return STATUS.warning
  return null
}

/** Column set for the click-through order list modal. */
function modalColumns(): ColumnDef<SnapRow, any>[] {
  return [
    {
      accessorFn: (r) => orderShortNo(r.internal_display_id, r.source_display_id),
      id: 'order',
      header: 'Order',
      cell: ({ row }) => <MesOrder internalDisplayId={row.original.internal_display_id} details />,
    },
    { accessorKey: 'reporting_category', header: 'Channel' },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Dot color={ORDER_STATUS_COLORS[row.original.status] ?? '#898781'} />
          {STATUS_LABELS[row.original.status] ?? row.original.status}
        </span>
      ),
    },
    {
      accessorKey: 'bookings',
      header: '$',
      meta: { align: 'right' },
      cell: ({ row }) => fmtMoneyExact(row.original.bookings),
    },
    { accessorKey: 'n_parts', header: 'Parts', meta: { align: 'right' } },
    { accessorKey: 'age_days', header: 'Age (d)', meta: { align: 'right' } },
    {
      accessorKey: 'ship_by',
      header: 'Promised ship',
      cell: ({ row }) => fmtDate(row.original.ship_by),
    },
    { accessorKey: 'biz_days_overdue', header: 'Biz days over', meta: { align: 'right' } },
    {
      accessorKey: 'days_overdue',
      header: 'Days overdue',
      meta: { align: 'right' },
      cell: ({ row }) => {
        const d = row.original.days_overdue
        const c = overdueColor(d)
        return (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {c && <Dot color={c} />}
            {fmtInt(d)}
          </span>
        )
      },
    },
  ]
}

function modalCsvRows(rows: SnapRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    order: orderShortNo(r.internal_display_id, r.source_display_id),
    internal_id: r.internal_display_id,
    channel: r.reporting_category,
    status: r.status,
    bookings: r.bookings,
    parts: r.n_parts,
    age_days: r.age_days,
    promised_ship_by: r.ship_by,
    days_overdue: r.days_overdue,
    biz_days_overdue: r.biz_days_overdue,
  }))
}

// ---------------------------------------------------------------------------
// Pipeline event trend card (one per entity family)
// ---------------------------------------------------------------------------

const FAMILY_EVENTS: Record<string, string[]> = {
  order: ['Order accepted', 'In production', 'Order shipped'],
  build: ['Build submitted', 'Print started', 'Print complete', 'Wash/sift scan'],
  lot: ['Lot created', 'Cure started', 'Finishing started', 'Binned / ready to ship'],
}

const FAMILY_ENTITY_LABEL: Record<string, string> = { order: 'Orders', build: 'Builds', lot: 'Lots' }

function EventTrendCard({
  family,
  title,
  subtitle,
  definition,
  queryParams,
  grain,
}: {
  family: 'order' | 'build' | 'lot'
  title: string
  subtitle: string
  definition: string
  queryParams: Record<string, unknown>
  grain: Grain
}) {
  const [units, setUnits] = useState<'entities' | 'parts'>('entities')
  const chartRef = useRef<EChartHandle>(null)
  const q = useNamedQuery('wip_event_trends', { ...queryParams, family })
  const rows = (q.data?.rows ?? []) as Row[]

  const model = useMemo(() => {
    const periods = [...new Set(rows.map((r) => String(r.period)))].sort()
    const byKey = new Map<string, number>()
    for (const r of rows) byKey.set(`${r.period}|${r.event}`, num0(units === 'entities' ? r.entities : r.parts))
    const events = FAMILY_EVENTS[family].filter((e) => periods.some((p) => (byKey.get(`${p}|${e}`) ?? 0) > 0))
    const option = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0 },
      grid: gridDefaults,
      xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
      yAxis: { type: 'value' },
      series: events.map((e) => ({
        ...stackedBarDefaults,
        name: e,
        stack: 'ev',
        color: seriesColor(e),
        data: periods.map((p) => {
          const v = byKey.get(`${p}|${e}`) ?? 0
          return isCurrentPeriod(p, grain) ? { value: v, itemStyle: { opacity: 0.55 } } : v
        }),
      })),
    }
    return { option, hasProvisional: periods.some((p) => isCurrentPeriod(p, grain)) }
  }, [rows, units, family, grain])

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      info={{
        definition,
        source: q.data?.meta.source ?? 'wip_event_trends',
      }}
      csvRows={rows as Record<string, unknown>[]}
      csvName={`wip_events_${family}`}
      chartRef={chartRef}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      isEmpty={rows.length === 0}
      emptyText="No events in the selected range."
      actions={
        <Segmented
          size="sm"
          options={[
            { value: 'entities', label: FAMILY_ENTITY_LABEL[family] },
            { value: 'parts', label: 'Parts' },
          ]}
          value={units}
          onChange={(v) => setUnits(v as 'entities' | 'parts')}
        />
      }
    >
      <EChart ref={chartRef} option={model.option} height={300} />
      {model.hasProvisional && (
        <p className="mt-1 text-[11.5px] text-faint">
          Newest period is still in progress — shown faded, provisional (warehouse lags ~1 day).
        </p>
      )}
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// Backlog-over-time card
// ---------------------------------------------------------------------------

const BACKLOG_FIELDS: Record<string, { entities: string; parts: string }> = {
  order: { entities: 'open_orders', parts: 'order_parts' },
  build: { entities: 'open_builds', parts: 'build_parts' },
  lot: { entities: 'open_lots', parts: 'lot_parts' },
}

const LATE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All orders' },
  { value: 'late', label: 'Late (past due)' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `>${i + 1} bd late` })),
]

function BacklogCard({ queryParams, grain }: { queryParams: Record<string, unknown>; grain: Grain }) {
  const [entity, setEntity] = useState<'order' | 'build' | 'lot'>('order')
  const [units, setUnits] = useState<'entities' | 'parts'>('entities')
  const [lateFilter, setLateFilter] = useState('all')
  const chartRef = useRef<EChartHandle>(null)
  const q = useNamedQuery('wip_backlog_series', { ...queryParams, lateFilter })
  const rows = (q.data?.rows ?? []) as Row[]
  const lateLabel = LATE_OPTIONS.find((o) => o.value === lateFilter)?.label ?? 'All orders'

  const model = useMemo(() => {
    const field = BACKLOG_FIELDS[entity][units]
    // Bucket daily EOD values into the selected grain and AVERAGE them (a
    // backlog is a level, not a flow — summing days would double-count).
    const buckets = new Map<string, { sum: number; n: number }>()
    for (const r of rows) {
      const key = periodStart(String(r.date), grain)
      const b = buckets.get(key) ?? { sum: 0, n: 0 }
      b.sum += num0(r[field])
      b.n += 1
      buckets.set(key, b)
    }
    const periods = [...buckets.keys()].sort()
    const values = periods.map((p) => {
      const b = buckets.get(p)!
      return Math.round((b.sum / b.n) * 10) / 10
    })
    const label = `${FAMILY_ENTITY_LABEL[entity]}${units === 'parts' ? ' — parts' : ''}${entity === 'order' && lateFilter !== 'all' ? ` (${lateLabel.toLowerCase()})` : ''}`
    const option = {
      tooltip: { trigger: 'axis' },
      grid: gridDefaults,
      xAxis: { type: 'category', boundaryGap: false, data: periods.map((p) => periodLabel(p, grain)) },
      yAxis: { type: 'value', min: 0 },
      series: [
        {
          ...lineDefaults,
          name: `Avg EOD backlog — ${label.toLowerCase()}`,
          color: seriesColor(label),
          areaStyle: { opacity: 0.08 },
          data: periods.map((p, i) =>
            isCurrentPeriod(p, grain) ? { value: values[i], itemStyle: { opacity: 0.55 } } : values[i],
          ),
        },
      ],
    }
    const csvRows = periods.map((p, i) => ({ period: p, [`avg_${field}`]: values[i] }))
    return { option, csvRows }
  }, [rows, entity, units, grain, lateFilter, lateLabel])

  return (
    <ChartCard
      title="Backlog over time"
      subtitle="Open backlog at end of each day (11:59pm ET) — averaged within coarser grains"
      info={{
        definition:
          'For each day, the count open at 23:59 America/New_York: orders = accepted but not yet shipped (cancelled/rejected excluded); builds = print build created but print not yet complete (wash scan used as fallback end; a build with no recorded end stays open); lots = split but not yet binned. The lateness dropdown restricts the ORDER series to orders that were late AS OF that day — late = governed due date before the day; >N bd = more than N business days (Mon\u2013Fri, excl. company holidays) past due on that day. Builds/lots ignore the lateness cut (due dates are order-level). Parts = order part quantity / build part quantity / Tulip lot quantity. At week/month/quarter grain the chart shows the AVERAGE of the daily end-of-day values, never a sum. Build and lot tracking exists since station-app go-live (Jul 2, 2026) — earlier days read 0 for those series. Channel, material and mfg-type filters apply.',
        source: q.data?.meta.source ?? 'wip_backlog_series',
      }}
      csvRows={model.csvRows}
      csvName={`backlog_${entity}_${units}${lateFilter === 'all' ? '' : `_${lateFilter}`}`}
      chartRef={chartRef}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      isEmpty={rows.length === 0}
      emptyText="No backlog data in the selected range."
      actions={
        <>
          <select
            className="rounded border border-line bg-white px-1.5 py-1 text-[12px] disabled:opacity-40"
            value={lateFilter}
            onChange={(e) => setLateFilter(e.target.value)}
            disabled={entity !== 'order'}
            title={entity === 'order' ? 'Restrict to orders late as of each day' : 'Lateness cut applies to the Orders series only'}
          >
            {LATE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Segmented
            size="sm"
            options={[
              { value: 'order', label: 'Orders' },
              { value: 'build', label: 'Builds' },
              { value: 'lot', label: 'Lots' },
            ]}
            value={entity}
            onChange={(v) => setEntity(v as 'order' | 'build' | 'lot')}
          />
          <Segmented
            size="sm"
            options={[
              { value: 'entities', label: 'Count' },
              { value: 'parts', label: 'Parts' },
            ]}
            value={units}
            onChange={(v) => setUnits(v as 'entities' | 'parts')}
          />
        </>
      }
    >
      <EChart ref={chartRef} option={model.option} height={320} />
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WipPage() {
  const { queryParams } = useFilters()

  const snapshot = useNamedQuery('wip_snapshot', { channels: queryParams.channels })
  const [pastDueDays, setPastDueDays] = useState(3)
  const [modal, setModal] = useState<{ title: string; rows: SnapRow[] } | null>(null)

  const today = todayIso()
  const rows: SnapRow[] = useMemo(
    () =>
      (snapshot.data?.rows ?? []).map((r) => ({
        internal_display_id: String(r.internal_display_id ?? ''),
        source_display_id: r.source_display_id ? String(r.source_display_id) : null,
        status: String(r.status ?? ''),
        reporting_category: String(r.reporting_category ?? ''),
        manufacturing_location: String(r.manufacturing_location ?? ''),
        bookings: num0(r.bookings),
        submitted_at: r.submitted_at ? String(r.submitted_at) : null,
        accepted_at: r.accepted_at ? String(r.accepted_at) : null,
        ship_by: r.ship_by ? String(r.ship_by) : null,
        age_days: num0(r.age_days),
        past_due: bool(r.past_due),
        days_overdue: num0(r.days_overdue),
        biz_days_overdue: bizDaysOverdue(r.ship_by ? String(r.ship_by) : null, today),
        last_event_at: r.last_event_at ? String(r.last_event_at) : null,
        days_since_event: num(r.days_since_event),
        last_event_type: r.last_event_type ? String(r.last_event_type) : null,
        has_not_progressing: bool(r.has_not_progressing),
        n_parts: num0(r.n_parts),
        n_unique_parts: num0(r.n_unique_parts),
      })),
    [snapshot.data, today],
  )

  const pastDueRows = useMemo(() => rows.filter((r) => r.past_due), [rows])
  // Strictly MORE than the threshold, in BUSINESS days (Mon-Fri excl.
  // holidays): '>1 bd' excludes orders exactly one working day overdue, and a
  // weekend never adds lateness.
  const pastDuePlusRows = useMemo(
    () => rows.filter((r) => r.biz_days_overdue > pastDueDays).sort((a, b) => b.biz_days_overdue - a.biz_days_overdue),
    [rows, pastDueDays],
  )
  const openDollars = rows.reduce((acc, r) => acc + r.bookings, 0)
  const onHoldCount = rows.filter((r) => r.status === 'ON_HOLD').length

  const openList = (title: string, list: SnapRow[]) => {
    if (list.length) setModal({ title, rows: list })
  }

  // ---- funnel (click a bar → order list) ----
  const funnelCounts = OPEN_STATUSES.map((s) => rows.filter((r) => r.status === s).length)
  const funnelRef = useRef<EChartHandle>(null)
  const funnelOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { ...gridDefaults, top: 28 },
    xAxis: { type: 'category', data: OPEN_STATUSES.map((s) => STATUS_LABELS[s]) },
    yAxis: { type: 'value' },
    series: [
      {
        ...barDefaults,
        name: 'Open orders',
        barMaxWidth: 56,
        cursor: 'pointer',
        data: OPEN_STATUSES.map((s, i) => ({
          value: funnelCounts[i],
          itemStyle: { color: ORDER_STATUS_COLORS[s], borderRadius: [3, 3, 0, 0] },
        })),
        label: { show: true, position: 'top', fontSize: 12, fontWeight: 600, formatter: '{c}' },
      },
    ],
  }
  const onFunnelClick = (params: unknown) => {
    const p = params as { name?: string }
    const status = OPEN_STATUSES.find((s) => STATUS_LABELS[s] === p.name)
    if (status) openList(`${STATUS_LABELS[status]} — open orders`, rows.filter((r) => r.status === status))
  }

  // ---- aging histogram (click a segment → order list) ----
  const agingRef = useRef<EChartHandle>(null)
  const agingCounts = new Map<string, number>()
  for (const r of rows) {
    const key = `${ageBucket(r.age_days)}|${r.status}`
    agingCounts.set(key, (agingCounts.get(key) ?? 0) + 1)
  }
  const agingOption = {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { top: 0 },
    grid: gridDefaults,
    xAxis: { type: 'category', data: [...AGE_BUCKETS] },
    yAxis: { type: 'value' },
    series: OPEN_STATUSES.map((s) => ({
      ...stackedBarDefaults,
      name: STATUS_LABELS[s],
      stack: 'age',
      color: ORDER_STATUS_COLORS[s],
      cursor: 'pointer',
      data: AGE_BUCKETS.map((b) => agingCounts.get(`${b}|${s}`) ?? 0),
    })),
  }
  const onAgingClick = (params: unknown) => {
    const p = params as { seriesName?: string; name?: string }
    const status = OPEN_STATUSES.find((s) => STATUS_LABELS[s] === p.seriesName)
    if (!status || !p.name) return
    openList(
      `${STATUS_LABELS[status]}, age ${p.name} — open orders`,
      rows.filter((r) => r.status === status && ageBucket(r.age_days) === p.name),
    )
  }
  const agingCsv = AGE_BUCKETS.map((b) => ({
    age_bucket: b,
    ...Object.fromEntries(OPEN_STATUSES.map((s) => [s, agingCounts.get(`${b}|${s}`) ?? 0])),
  }))

  const snapshotAsOf = snapshot.data?.meta.retrievedAt
  const grain = queryParams.grain as Grain
  const trendParams = queryParams as unknown as Record<string, unknown>
  const columns = useMemo(() => modalColumns(), [])

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-sub">
        Live snapshot — the global date range applies to the event trends and backlog charts.
        {snapshotAsOf && <span className="text-faint"> Snapshot fetched {new Date(snapshotAsOf).toLocaleTimeString()}.</span>}
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard
          label="Open orders"
          value={snapshot.isLoading ? '…' : fmtInt(rows.length)}
          hint="Orders in QUOTING / ACCEPTED / PRINTING / ON_HOLD right now"
        />
        <KpiCard
          label="Open $"
          value={snapshot.isLoading ? '…' : fmtMoney(openDollars)}
          hint="Bookings (subtotal + shipping + tax + credit) across open orders"
        />
        <KpiCard
          label="Past due"
          value={snapshot.isLoading ? '…' : fmtInt(pastDueRows.length)}
          hint="Open orders whose promised ship_by date is before today (at least 1 day overdue)"
        />
        <div
          className="card cursor-pointer px-4 py-3.5"
          title={`Open orders MORE than ${pastDueDays} business day${pastDueDays === 1 ? '' : 's'} (Mon\u2013Fri, excl. company holidays) past their promised ship date — click for the list`}
          onClick={() => openList(`Past due more than ${pastDueDays} business day${pastDueDays === 1 ? '' : 's'} — open orders`, pastDuePlusRows)}
        >
          <div className="flex items-center justify-between gap-1">
            <span className="label-xs">Past due</span>
            <select
              className="rounded border border-line bg-white px-1 py-0.5 text-[11px]"
              value={pastDueDays}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setPastDueDays(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => (
                <option key={d} value={d}>
                  &gt;{d} bd
                </option>
              ))}
            </select>
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {snapshot.isLoading ? '…' : fmtInt(pastDuePlusRows.length)}
          </div>
        </div>
        <KpiCard
          label="On hold"
          value={snapshot.isLoading ? '…' : fmtInt(onHoldCount)}
          hint="Open orders currently in ON_HOLD"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="WIP funnel"
          subtitle="Open orders by pipeline status — click a bar for the order list"
          info={{
            definition:
              'Count of currently open orders in each status, in pipeline order Quoting → Accepted → Printing, with On hold shown last. Point-in-time; the global date range does not apply. Click a bar to list the orders in that status.',
            source: 'wip_snapshot — fcm_api_order (+ medusa order for channel)',
          }}
          csvRows={OPEN_STATUSES.map((s, i) => ({ status: s, open_orders: funnelCounts[i] }))}
          csvName="wip_funnel"
          chartRef={funnelRef}
          isLoading={snapshot.isLoading}
          isFetching={snapshot.isFetching}
          error={snapshot.error}
          isEmpty={rows.length === 0}
          emptyText="No open orders for the selected filters."
          height={300}
        >
          <EChart ref={funnelRef} option={funnelOption} height={300} onClick={onFunnelClick} />
        </ChartCard>

        <ChartCard
          title="WIP aging"
          subtitle="Open orders by age, split by status — click a segment for the order list"
          info={{
            definition:
              'Open orders bucketed by age in days (since accepted_at, falling back to submitted_at then created_at), stacked by current status. Computed from the live WIP snapshot. Click any bar segment to list the orders in that age × status bucket.',
            source: 'wip_snapshot — fcm_api_order (+ medusa order for channel)',
          }}
          csvRows={agingCsv}
          csvName="wip_aging"
          chartRef={agingRef}
          isLoading={snapshot.isLoading}
          isFetching={snapshot.isFetching}
          error={snapshot.error}
          isEmpty={rows.length === 0}
          emptyText="No open orders for the selected filters."
          height={300}
        >
          <EChart ref={agingRef} option={agingOption} height={300} onClick={onAgingClick} />
        </ChartCard>
      </div>

      <EventTrendCard
        family="order"
        title="Order events"
        subtitle="Orders accepted → in production → shipped, per period"
        definition="Count of order milestones per period: accepted (accepted_at), in production (first ORDER_PRINTING event on the order), shipped (shipped_at). Toggle between order counts and the part quantity those orders carry. Uses the global date range, grain and filters; an order appears once per milestone it reached in the period."
        queryParams={trendParams}
        grain={grain}
      />
      <EventTrendCard
        family="build"
        title="Build events"
        subtitle="Builds submitted → printed → washed, per period"
        definition="Count of print-build milestones per period: submitted (print build created), print started / print complete (Tulip print timestamps, linked via the station-app lot↔build bridge), wash/sift scan (Tulip wash end or sift start). Toggle between build counts and the part quantity in those builds. Print/wash coverage exists since station-app go-live (Jul 2, 2026); Form 4 print timestamps ≈76% covered, Fuse X1 currently unlogged."
        queryParams={trendParams}
        grain={grain}
      />
      <EventTrendCard
        family="lot"
        title="Lot events"
        subtitle="Lots created → cured → finished → binned, per period"
        definition="Count of lot milestones per period from station-app scans: created (LOT_SPLIT), cure started, finishing started, binned / ready to ship (first occurrence per lot). Toggle between lot counts and the lot's part quantity (from Tulip; falls back to 1 when unknown). Station-app data exists since Jul 2, 2026."
        queryParams={trendParams}
        grain={grain}
      />

      <BacklogCard queryParams={trendParams} grain={grain} />

      {modal && (
        <Modal title={`${modal.title} (${modal.rows.length})`} onClose={() => setModal(null)}>
          <DataTable
            data={modal.rows}
            columns={columns}
            initialSort={[{ id: 'days_overdue', desc: true }]}
            maxRows={100}
            csvName="wip_bucket_orders"
            emptyText="No orders in this bucket."
          />
        </Modal>
      )}
    </div>
  )
}
