import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ColumnDef } from '@tanstack/react-table'
import { useDims, useNamedQuery, type Row } from '../../lib/api'
import { addDaysIso, todayIso } from '../../lib/dates'
import { isShippingDay } from '../predictor/rules'
import { mesOrderUrl, orderShortNo } from '../../components/MesOrder'
import { ChartCard } from '../../components/ChartCard'
import { MultiSelect } from '../../components/MultiSelect'
import { DataTable } from '../../components/DataTable'
import { Segmented } from '../../components/Segmented'
import { Skeleton, ErrorState } from '../../components/states'
import { ORDER_STATUS_COLORS, STATUS } from '../../lib/palette'
import { fmtDate, fmtDateTime, fmtInt, fmtMoney, fmtMoneyExact, fmtNum, num, num0 } from '../../lib/format'

// ---------------------------------------------------------------------------
// Module C — Order Deep-Dive. Identifier-driven: reads ?q= from the URL
// (preserving the filter bar's params), resolves it via order_search, and
// shows either a severity-ranked problem board (no q), a results list
// (multiple matches), or the full case view for one order.
// ---------------------------------------------------------------------------

const ISSUE_LEVEL: Record<string, 'critical' | 'warning'> = {
  TOTAL_BUILD_FAILURE: 'critical',
  PART_QUARANTINED: 'critical',
  PART_MISSING: 'critical',
  MANUFACTURING_ISSUE: 'critical',
  NEEDS_ATTENTION: 'warning',
  PART_NEEDS_REPRINT: 'warning',
  ORDER_PLACED_ON_HOLD: 'warning',
}

function s(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

/** Whole-day difference a − b for ISO date/timestamp strings (date part only). */
function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`)
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null
  return Math.round((ta - tb) / 86400000)
}

function parseDetails(raw: unknown): [string, string][] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return []
    return Object.entries(v)
      .filter(([, val]) => val !== null && val !== undefined && val !== '')
      .slice(0, 8)
      .map(([k, val]) => [k, typeof val === 'object' ? JSON.stringify(val) : String(val)])
  } catch {
    return []
  }
}

function StatusChip({ status }: { status: string }) {
  const color = ORDER_STATUS_COLORS[status] ?? '#898781'
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-white px-2 py-0.5 text-[11px] font-medium">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {status || '—'}
    </span>
  )
}


// ---------------------------------------------------------------------------

export default function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = (searchParams.get('q') ?? '').trim()
  const [input, setInput] = useState(q)
  useEffect(() => setInput(q), [q])

  // PRESERVE all other search params (the global filter bar persists its state in the URL).
  const setQ = (v: string) => {
    const next = new URLSearchParams(window.location.search)
    const clean = v.trim()
    if (clean) next.set('q', clean)
    else next.delete('q')
    setSearchParams(next)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setQ(input.replace(/[^A-Za-z0-9@._ -]/g, '').slice(0, 80))
  }

  const search = useNamedQuery('order_search', { q }, { enabled: q.length > 0 })
  const matches = (search.data?.rows ?? []) as Row[]
  // Substring search can catch siblings (FN-1234 also matches FN-12345) — an
  // exact id match always wins so board deep-links land directly on the order.
  const exact =
    matches.find((r) =>
      [r.source_display_id, r.internal_display_id, r.id].some(
        (v) => String(v ?? '').toLowerCase() === q.toLowerCase(),
      ),
    ) ?? null
  const single =
    q && !search.isLoading && !search.error ? (matches.length === 1 ? matches[0] : exact) : null

  return (
    <div className="space-y-4">
      <div>
        <form onSubmit={submit} className="card flex items-center gap-2 p-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search an order — FN-1234, MSB id, order id, medusa order_…, Xometry id, customer email, or part GUID"
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-[13px] outline-none focus:border-accent"
            aria-label="Order search"
          />
          <button type="submit" className="btn btn-accent shrink-0">
            Search
          </button>
          {q && (
            <button type="button" className="btn shrink-0" onClick={() => setQ('')}>
              Clear
            </button>
          )}
        </form>
        <p className="mt-1 px-1 text-[11.5px] text-faint">
          Identifier-driven page — the global filter bar (dates / channels) does not scope these results.
        </p>
      </div>

      {!q && <ProblemBoard />}

      {q && search.isLoading && (
        <div className="card p-4">
          <Skeleton height={220} />
        </div>
      )}
      {q && search.error && (
        <div className="card p-4">
          <ErrorState error={search.error} />
        </div>
      )}
      {q && !search.isLoading && !search.error && matches.length === 0 && (
        <div className="card p-8 text-center text-[13px] text-faint">
          No orders match “{q}”. Try an FN-#### id, MSB id, email, or part GUID.
        </div>
      )}
      {q && matches.length > 1 && !single && <SearchResults q={q} rows={matches} onOpen={setQ} />}
      {single && <OrderDeepDive key={s(single.id)} summary={single} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Problem orders triage board (no q)
// ---------------------------------------------------------------------------

const PROBLEM_STATUSES = [
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'PRINTING', label: 'Printing' },
  { value: 'ON_HOLD', label: 'On hold' },
]

/** Business days (Mon-Fri, excl. company holidays) elapsed since the promised ship date. */
function bizDaysOverdue(shipBy: string | null, today: string): number {
  if (!shipBy || shipBy >= today) return 0
  let n = 0
  for (let d = addDaysIso(shipBy, 1); d <= today && n < 260; d = addDaysIso(d, 1)) {
    if (isShippingDay(d)) n++
  }
  return n
}

const DUE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All orders' },
  { value: 'range', label: 'Due in range…' },
  { value: 'overdue', label: 'Overdue (any)' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `>${i + 1} bd overdue` })),
]

/**
 * Customer loyalty tier, purely by lifetime revenue (LTV): bronze $1k+,
 * silver $5k+, gold $10k+ with an extra crown per additional $10k (max 5).
 * The ↻ repeat marker (>1 order) only shows below the bronze threshold.
 */
function custTier(orders: number, ltv: number): { glyphs: string; color: string; name: string } | null {
  if (ltv > 10000)
    return { glyphs: '\u265B'.repeat(Math.min(5, Math.floor(ltv / 10000))), color: '#d4af37', name: 'Gold customer' }
  if (ltv >= 5000) return { glyphs: '\u265B', color: '#a8a9ad', name: 'Silver customer' }
  if (ltv >= 1000) return { glyphs: '\u265B', color: '#cd7f32', name: 'Bronze customer' }
  if (orders > 1) return { glyphs: '\u21BB', color: '#898781', name: 'Repeat customer' }
  return null
}

function ProblemBoard() {
  const res = useNamedQuery('problem_orders', { channels: [] })
  const allRows = (res.data?.rows ?? []) as Row[]
  const [statusSel, setStatusSel] = useState<string[]>([])
  const [channelSel, setChannelSel] = useState<string[]>([])
  const [materialSel, setMaterialSel] = useState<string[]>([])
  const [typeSel, setTypeSel] = useState<string[]>([])
  const [dueFilter, setDueFilter] = useState('all')
  const [manualQueue, setManualQueue] = useState('all')
  const today = todayIso()
  const [dueFrom, setDueFrom] = useState(today)
  const [dueTo, setDueTo] = useState(addDaysIso(today, 7))
  const dims = useDims()
  const matName = useMemo(() => {
    const map = new Map((dims.data?.materials ?? []).map((m) => [m.code, m.name]))
    return (code: string) => map.get(code) ?? code
  }, [dims.data])
  const channelOptions = useMemo(
    () => [...new Set(allRows.map((r) => s(r.reporting_category)).filter(Boolean))].sort(),
    [allRows],
  )
  const materialOptions = useMemo(
    () =>
      [...new Set(allRows.flatMap((r) => s(r.materials).split(', ').filter(Boolean)))].sort((a, b) =>
        matName(a).localeCompare(matName(b)),
      ),
    [allRows, matName],
  )
  const typeOptions = useMemo(
    () => [...new Set(allRows.flatMap((r) => s(r.mfg_types).split(', ').filter(Boolean)))].sort(),
    [allRows],
  )
  const rows = useMemo(
    () =>
      allRows
        .filter((r) => !statusSel.length || statusSel.includes(s(r.status)))
        .filter((r) => !channelSel.length || channelSel.includes(s(r.reporting_category)))
        .filter((r) => !materialSel.length || s(r.materials).split(', ').some((m) => materialSel.includes(m)))
        .filter((r) => !typeSel.length || s(r.mfg_types).split(', ').some((t) => typeSel.includes(t)))
        .filter((r) => {
          if (dueFilter === 'all') return true
          const shipBy = s(r.ship_by)
          if (!shipBy) return false
          if (dueFilter === 'range') return shipBy >= dueFrom && shipBy <= dueTo
          if (dueFilter === 'overdue') return shipBy < today
          return bizDaysOverdue(shipBy, today) > Number(dueFilter)
        })
        .filter((r) =>
          manualQueue === 'all' ? true : manualQueue === 'hide' ? num0(r.parts_manual_queue) === 0 : num0(r.parts_manual_queue) > 0,
        ),
    [allRows, statusSel, channelSel, materialSel, typeSel, dueFilter, dueFrom, dueTo, today, manualQueue],
  )

  const columns = useMemo<ColumnDef<Row, any>[]>(
    () => [
      {
        id: 'order',
        header: 'Order',
        accessorFn: (r) => orderShortNo(r.internal_display_id, r.id),
        cell: ({ row }) => {
          const no = orderShortNo(row.original.internal_display_id, row.original.id)
          return (
            <a
              href={mesOrderUrl(no)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent hover:underline"
              title="Open in MES (new tab)"
            >
              {no}↗
            </a>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => s(r.status),
        cell: ({ row }) => <StatusChip status={s(row.original.status)} />,
      },
      { id: 'channel', header: 'Channel', accessorFn: (r) => s(r.reporting_category) },
      {
        id: 'ship_by',
        header: 'Ship by',
        accessorFn: (r) => s(r.ship_by) || '9999-12-31',
        cell: ({ row }) => fmtDate(row.original.ship_by),
      },
      {
        id: 'days_overdue',
        header: 'Days overdue',
        accessorFn: (r) => num0(r.days_overdue),
        cell: ({ getValue }) => fmtInt(getValue() as number),
        meta: { align: 'right' },
      },
      {
        id: 'email',
        header: 'Customer',
        accessorFn: (r) => s(r.email),
        cell: ({ row }) => {
          const email = s(row.original.email)
          if (!email) return <span className="text-faint">—</span>
          const orders = num0(row.original.cust_orders)
          const ltv = num0(row.original.cust_ltv)
          const tier = custTier(orders, ltv)
          return (
            <span className="group relative inline-flex max-w-[210px] items-center gap-1 text-[12px]">
              <span className="truncate">{email}</span>
              {tier && (
                <span className="shrink-0 text-[12px] leading-none" style={{ color: tier.color }}>
                  {tier.glyphs}
                </span>
              )}
              <span className="invisible absolute left-0 top-5 z-30 w-52 rounded-lg border border-line bg-white p-2.5 text-left shadow-xl group-hover:visible">
                <span className="block truncate text-[12px] font-medium">{email}</span>
                {tier && (
                  <span className="mt-0.5 block text-[11.5px]" style={{ color: tier.color }}>
                    {tier.glyphs} {tier.name}
                  </span>
                )}
                <span className="mt-1 flex justify-between text-[12px]">
                  <span className="text-sub">Lifetime orders</span>
                  <span className="tabular-nums">{fmtInt(orders)}</span>
                </span>
                <span className="flex justify-between text-[12px]">
                  <span className="text-sub">LTV</span>
                  <span className="tabular-nums">{fmtMoney(ltv)}</span>
                </span>
              </span>
            </span>
          )
        },
      },
      {
        id: 'materials',
        header: 'Material',
        accessorFn: (r) => s(r.materials),
        cell: ({ row }) => {
          const m = s(row.original.materials)
          if (!m) return <span className="text-faint">—</span>
          if (!m.includes(',')) {
            return (
              <span className="block max-w-[150px] truncate text-[12px]" title={`${matName(m)} (${m})`}>
                {matName(m)}
              </span>
            )
          }
          let detail: { code: string; n_lines: number; n_parts: number }[] = []
          try {
            detail = JSON.parse(s(row.original.materials_detail) || '[]')
          } catch {
            detail = []
          }
          return (
            <span className="group relative inline-block cursor-help text-[12px] underline decoration-dotted underline-offset-2">
              Mixed
              <span className="invisible absolute left-0 top-5 z-30 w-64 rounded-lg border border-line bg-white p-2.5 text-left shadow-xl group-hover:visible">
                {detail.map((d) => (
                  <span key={d.code} className="flex items-baseline justify-between gap-3 py-0.5">
                    <span className="truncate text-[12px]" title={d.code}>
                      {matName(d.code)}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-sub">
                      {fmtInt(d.n_lines)} line{d.n_lines === 1 ? '' : 's'} · {fmtInt(d.n_parts)} pcs
                    </span>
                  </span>
                ))}
              </span>
            </span>
          )
        },
      },
      {
        id: 'ready',
        header: 'Ready / parts',
        accessorFn: (r) => (num0(r.parts_total) > 0 ? num0(r.parts_ready) / num0(r.parts_total) : -1),
        cell: ({ row }) => {
          const ready = num0(row.original.parts_ready)
          const total = num0(row.original.parts_total)
          if (total <= 0) return <span className="text-faint">—</span>
          return (
            <span
              className="tabular-nums"
              title="Ready-to-ship parts (in binned lots, or progressed through MES-only lots the floor scans never logged) / total ordered part quantity. Floor scans lag the floor, so this is a lower bound."
            >
              {fmtInt(ready)}/{fmtInt(total)}
            </span>
          )
        },
        meta: { align: 'right' },
      },
      {
        id: 'yield',
        header: 'Yield',
        accessorFn: (r) => (num0(r.parts_printed) > 0 ? num0(r.parts_alive) / num0(r.parts_printed) : -1),
        cell: ({ row }) => {
          const alive = num0(row.original.parts_alive)
          const printed = num0(row.original.parts_printed)
          if (printed <= 0) return <span className="text-faint">—</span>
          return (
            <span className="tabular-nums" title={`${fmtInt(alive)} in production or ready / ${fmtInt(printed)} printed`}>
              {Math.round((alive / printed) * 100)}%
            </span>
          )
        },
        meta: { align: 'right' },
      },
      {
        id: 'bookings',
        header: 'Bookings',
        accessorFn: (r) => num0(r.bookings),
        cell: ({ getValue }) => fmtMoney(getValue() as number),
        meta: { align: 'right' },
      },
    ],
    [matName],
  )

  return (
    <ChartCard
      title="Order Table"
      subtitle="All open production orders, oldest due date first — order numbers open MES in a new tab. The global date range does not apply."
      info={{
        definition:
          "Every open production order (ACCEPTED / PRINTING / ON_HOLD), ordered by governed due date (oldest first). Customer stats match on email across the customer's non-cancelled orders: order count and LTV (lifetime bookings). Lagging stage = the earliest pipeline stage with outstanding work (no build yet → printing → wash/lot split → post-processing → quarantine → ready to ship); build/lot signals exist since station-app go-live (Jul 2, 2026) and Fuse X1 prints are unlogged in Tulip, so some orders can over-read as 'Printing'. Yield = (parts printed − scrap − parts parked in quarantine) ÷ parts printed, where printed = build part quantity on print-complete builds, scrap = Tulip lot original-minus-current quantity, and quarantine = parts in lots whose latest scan is still Quarantine-Routing; printed parts not yet scanned into a lot are presumed alive. Manual print queue = part quantity in print builds still PENDING that never fired an ORDER_PRINTING event (builds that missed their print and need manual re-queueing). This is live WIP; the global date range does not apply.",
        source: 'fcm_api_order/orderevent/orderpart/printbuild + medusa (email) + station app + Tulip (refreshed every 5 min)',
      }}
      csvRows={rows}
      csvName="problem_orders"
      actions={
        <>
          <select
            className="rounded border border-line bg-white px-1.5 py-1 text-[12px]"
            value={dueFilter}
            onChange={(e) => setDueFilter(e.target.value)}
            title="Filter by due date: a window, overdue, or more than N business days overdue"
          >
            {DUE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {dueFilter === 'range' && (
            <>
              <input type="date" className="rounded border border-line bg-white px-1.5 py-0.5 text-[12px]" value={dueFrom} onChange={(e) => setDueFrom(e.target.value)} />
              <span className="text-[11px] text-faint">–</span>
              <input type="date" className="rounded border border-line bg-white px-1.5 py-0.5 text-[12px]" value={dueTo} onChange={(e) => setDueTo(e.target.value)} />
            </>
          )}
          <MultiSelect label="Channel" options={channelOptions.map((c) => ({ value: c, label: c }))} selected={channelSel} onChange={setChannelSel} />
          <MultiSelect label="Type" options={typeOptions.map((t) => ({ value: t, label: t }))} selected={typeSel} onChange={setTypeSel} />
          <MultiSelect label="Material" options={materialOptions.map((c) => ({ value: c, label: matName(c) }))} selected={materialSel} onChange={setMaterialSel} />
          <MultiSelect label="Status" options={PROBLEM_STATUSES} selected={statusSel} onChange={setStatusSel} />
          <select
            className="rounded border border-line bg-white px-1.5 py-1 text-[12px]"
            value={manualQueue}
            onChange={(e) => setManualQueue(e.target.value)}
            title="Manual print queue = parts in print builds still PENDING that never fired a print event (need manual re-queueing)"
          >
            <option value="all">Manual queue: all</option>
            <option value="hide">Hide manual queue</option>
            <option value="only">Only manual queue</option>
          </select>
        </>
      }
      isLoading={res.isLoading}
      isFetching={res.isFetching}
      error={res.error}
      isEmpty={rows.length === 0}
      emptyText="No open orders — nothing to triage."
    >
      <DataTable
        data={rows}
        columns={columns}
        fit
        initialSort={[{ id: 'ship_by', desc: false }]}
      />
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// Multiple-match results list
// ---------------------------------------------------------------------------

function SearchResults({ q, rows, onOpen }: { q: string; rows: Row[]; onOpen: (q: string) => void }) {
  const columns = useMemo<ColumnDef<Row, any>[]>(
    () => [
      {
        id: 'order',
        header: 'Order',
        accessorFn: (r) => orderShortNo(r.internal_display_id, r.id),
        cell: ({ row }) => {
          const no = orderShortNo(row.original.internal_display_id, row.original.id)
          return (
            <a
              href={mesOrderUrl(no)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-accent hover:underline"
              title="Open in MES (new tab)"
            >
              {no}↗
            </a>
          )
        },
      },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => s(r.status),
        cell: ({ row }) => <StatusChip status={s(row.original.status)} />,
      },
      { id: 'channel', header: 'Channel', accessorFn: (r) => s(r.reporting_category) },
      {
        id: 'submitted',
        header: 'Submitted',
        accessorFn: (r) => s(r.submitted_at),
        cell: ({ row }) => fmtDateTime(row.original.submitted_at),
      },
      {
        id: 'shipped',
        header: 'Shipped',
        accessorFn: (r) => s(r.shipped_at),
        cell: ({ row }) => fmtDateTime(row.original.shipped_at),
      },
      {
        id: 'bookings',
        header: 'Bookings',
        accessorFn: (r) => num0(r.bookings),
        cell: ({ getValue }) => fmtMoneyExact(getValue() as number),
        meta: { align: 'right' },
      },
      { id: 'email', header: 'Email', accessorFn: (r) => s(r.email) },
    ],
    [onOpen],
  )

  return (
    <ChartCard
      title="Search results"
      subtitle={`${rows.length} orders match “${q}” (newest 25 shown) — click one to open it`}
      info={{
        definition:
          'Case-insensitive contains-match across FN id, MSB id, numeric order id, medusa reference, Xometry id, customer email, and part/file GUIDs. Bookings = subtotal + shipping + tax + credit.',
        source: 'fcm_api_order + medusa order + fcm_api_orderpart',
      }}
      csvRows={rows}
      csvName="order_search_results"
      isEmpty={rows.length === 0}
    >
      <DataTable
        data={rows}
        columns={columns}
        initialSort={[{ id: 'submitted', desc: true }]}
        onRowClick={(r) => onOpen(s(r.internal_display_id) || s(r.id))}
      />
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// Deep-dive: header + timeline + parts + Tulip
// ---------------------------------------------------------------------------

function OrderDeepDive({ summary }: { summary: Row }) {
  const id = num0(summary.id)
  const internalId = s(summary.internal_display_id)
  const tulipIdOk = /^[A-Za-z0-9-]+$/.test(internalId)

  const detail = useNamedQuery('order_detail', { id })
  const timeline = useNamedQuery('order_timeline', { id })
  const parts = useNamedQuery('order_parts', { id })
  const tulip = useNamedQuery('order_tulip', { internalDisplayId: internalId }, { enabled: tulipIdOk })

  const d = (detail.data?.rows?.[0] ?? null) as Row | null

  return (
    <div className="space-y-4">
      <DeepDiveHeader summary={summary} detail={d} isLoading={detail.isLoading} error={detail.error} />
      <TimelineCard res={timeline} />
      <PartsCard res={parts} />
      <TulipCard res={tulip} enabled={tulipIdOk} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="label-xs">{label}</div>
      <div className="mt-0.5 text-[13px]">{children}</div>
    </div>
  )
}

function shipVerdict(d: Row): { color: string; text: string } | null {
  const shipBy = s(d.ship_by)
  const shippedAt = s(d.shipped_at)
  const status = s(d.status)
  if (shippedAt && shipBy) {
    const late = num(d.days_late) ?? daysBetween(shippedAt, shipBy)
    if (late === null) return null
    if (late > 0) {
      return { color: late >= 3 ? STATUS.critical : STATUS.serious, text: `Shipped ${late}d late (promised ${fmtDate(shipBy)})` }
    }
    if (late === 0) return { color: STATUS.good, text: `Shipped on time (${fmtDate(shipBy)})` }
    return { color: STATUS.good, text: `Shipped ${-late}d early (promised ${fmtDate(shipBy)})` }
  }
  if (shipBy && !['CANCELLED', 'REJECTED', 'SHIPPED'].includes(status)) {
    const over = daysBetween(todayIso(), shipBy)
    if (over === null) return null
    if (over > 0) {
      return { color: over >= 3 ? STATUS.critical : STATUS.warning, text: `Not shipped — ${over}d past promised ${fmtDate(shipBy)}` }
    }
    return { color: STATUS.good, text: `In progress — due ${fmtDate(shipBy)}` }
  }
  return null
}

function DeepDiveHeader({
  summary,
  detail,
  isLoading,
  error,
}: {
  summary: Row
  detail: Row | null
  isLoading: boolean
  error: (Error & { hint?: string }) | null
}) {
  if (error) {
    return (
      <div className="card p-4">
        <ErrorState error={error} />
      </div>
    )
  }
  if (isLoading || !detail) {
    return (
      <div className="card p-4">
        <Skeleton height={180} />
      </div>
    )
  }

  const d = detail
  const verdict = shipVerdict(d)
  const subtotal = num0(d.subtotal)
  const shipping = num0(d.shipping_cost)
  const tax = num0(d.tax_cost)
  const credit = num0(d.credit_balance_applied)
  const total = subtotal + shipping + tax + credit
  const reorderOf = s(d.reorder_of_order_id)

  const lifecycle: [string, unknown][] = [
    ['Created', d.created_at],
    ['Submitted', d.submitted_at],
    ['Accepted', d.accepted_at],
    ['Started processing', d.started_processing_at],
    ['Printed', d.printed_at],
    ['Shipped', d.shipped_at],
  ]
  if (d.cancelled_at) lifecycle.push(['Cancelled', d.cancelled_at])

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-[18px] font-bold tracking-tight">#{orderShortNo(d.internal_display_id, d.id)}</h2>
        <a
          href={mesOrderUrl(orderShortNo(d.internal_display_id, d.id))}
          target="_blank"
          rel="noreferrer"
          className="text-[12.5px] font-medium text-accent hover:underline"
        >
          Open in MES ↗
        </a>
        <span className="font-mono text-[12px] text-sub">{s(d.internal_display_id) || '—'}</span>
        <StatusChip status={s(d.status)} />
        {verdict && (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: verdict.color }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: verdict.color }} />
            {verdict.text}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 lg:grid-cols-6">
        <Field label="Channel">{s(d.reporting_category) || '—'}</Field>
        <Field label="Location">{s(d.manufacturing_location) || '—'}</Field>
        <Field label="Lead time">{num(d.lead_time_days) !== null ? `${fmtInt(num(d.lead_time_days))} days` : '—'}</Field>
        <Field label="Promised ship">{d.ship_by ? fmtDate(d.ship_by) : '—'}</Field>
        <Field label="Customer">
          <span className="break-all">{s(d.email) || '—'}</span>
        </Field>
        <Field label="Reorder of">{reorderOf ? `order ${reorderOf}` : '—'}</Field>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_260px]">
        <div>
          <div className="label-xs mb-1.5">Lifecycle</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-line bg-page/60 p-3 sm:grid-cols-3 lg:grid-cols-6">
            {lifecycle.map(([label, v]) => (
              <div key={label}>
                <div className="text-[10.5px] font-medium uppercase tracking-wide text-faint">{label}</div>
                <div className="mt-0.5 text-[12px] tabular-nums">{v ? fmtDateTime(v) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="label-xs mb-1.5">Money</div>
          <div className="rounded-lg border border-line bg-page/60 p-3 text-[12.5px]">
            {[
              ['Subtotal', subtotal],
              ['Shipping', shipping],
              ['Tax', tax],
              ['Credit applied', credit],
            ].map(([label, v]) => (
              <div key={label as string} className="flex justify-between py-0.5">
                <span className="text-sub">{label}</span>
                <span className="tabular-nums">{fmtMoneyExact(v as number)}</span>
              </div>
            ))}
            <div className="mt-1 flex justify-between border-t border-line pt-1.5 font-semibold">
              <span>Total (bookings)</span>
              <span className="tabular-nums">{fmtMoneyExact(total)}</span>
            </div>
            <div className="flex justify-between py-0.5 text-sub">
              <span>Amount charged</span>
              <span className="tabular-nums">{fmtMoneyExact(num(d.amount_charged))}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

type TimelineRes = ReturnType<typeof useNamedQuery>

function tsVal(v: unknown): number {
  const t = Date.parse(s(v))
  return Number.isNaN(t) ? 0 : t
}

function TimelineCard({ res }: { res: TimelineRes }) {
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const rows = (res.data?.rows ?? []) as Row[]
  const sorted = useMemo(() => {
    const arr = [...rows].sort((a, b) => tsVal(a.ts) - tsVal(b.ts))
    return order === 'newest' ? arr.reverse() : arr
  }, [rows, order])

  return (
    <ChartCard
      title="Timeline"
      subtitle="Order-system events and station-app floor scans, interleaved (floor data exists since Jul 2, 2026)"
      info={{
        definition:
          'Every event for this order merged chronologically from two sources: fcm_api_orderevent (lifecycle, issues, holds — badge “Order system”) and manufacturing_events_manufacturingevent (floor scans with station / operator / lot — badge “Floor”). Issue events are flagged with a colored left border: red = quarantine / build failure / missing part / manufacturing issue, amber = needs attention / reprint / hold.',
        source: 'fcm_api_orderevent + manufacturing_events_manufacturingevent + station/operator registries',
      }}
      csvRows={sorted}
      csvName="order_timeline"
      isLoading={res.isLoading}
      isFetching={res.isFetching}
      error={res.error}
      isEmpty={rows.length === 0}
      emptyText="No events recorded for this order."
      actions={
        <Segmented
          size="sm"
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
          ]}
          value={order}
          onChange={setOrder}
        />
      }
    >
      <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
        {sorted.map((e, i) => (
          <TimelineEntry key={`${s(e.ts)}-${s(e.event_type)}-${i}`} e={e} />
        ))}
      </div>
    </ChartCard>
  )
}

function TimelineEntry({ e }: { e: Row }) {
  const type = s(e.event_type)
  const level = ISSUE_LEVEL[type]
  const details = parseDetails(e.details)
  const isFloor = s(e.src) === 'floor'
  const floorMeta = [s(e.station), s(e.operator)].filter(Boolean).join(' · ')
  const qty = num(e.part_quantity)
  const lot = s(e.lot_guid)

  return (
    <div
      className="rounded-lg border border-line bg-white px-3 py-2"
      style={{ borderLeft: `3px solid ${level ? STATUS[level] : 'transparent'}` }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="w-30 shrink-0 text-[11.5px] tabular-nums text-sub">{fmtDateTime(e.ts)}</span>
        <span
          className={`rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${
            isFloor ? 'border-accent/30 bg-accent/5 text-accent' : 'border-line bg-page text-sub'
          }`}
        >
          {isFloor ? 'Floor' : 'Order system'}
        </span>
        <span className="text-[12.5px] font-semibold">{type || 'EVENT'}</span>
        {level && (
          <span className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: STATUS[level] }}>
            {level === 'critical' ? 'Issue' : 'Attention'}
          </span>
        )}
      </div>

      {(floorMeta || qty !== null || lot) && (
        <div className="mt-1 text-[12px] text-sub">
          {floorMeta}
          {qty !== null && `${floorMeta ? ' · ' : ''}${fmtInt(qty)} part${qty === 1 ? '' : 's'}`}
          {lot && (
            <>
              {' · lot '}
              <span className="font-mono text-[11px]">{lot}</span>
            </>
          )}
        </div>
      )}

      {details.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
          {details.map(([k, v]) => (
            <span key={k} className="text-[11.5px]">
              <span className="font-mono text-faint">{k}:</span> <span className="text-ink">{v}</span>
            </span>
          ))}
        </div>
      )}

      {(e.needs_attention === true || s(e.assigned_to_dept)) && (
        <div className="mt-1 text-[11.5px]" style={{ color: e.resolved_at ? undefined : STATUS.warning }}>
          {s(e.assigned_to_dept) && <>Assigned to {s(e.assigned_to_dept)}</>}
          {e.resolved_at ? (
            <span className="text-sub">{s(e.assigned_to_dept) ? ' · ' : ''}resolved {fmtDateTime(e.resolved_at)}</span>
          ) : (
            <span>{s(e.assigned_to_dept) ? ' · ' : ''}unresolved</span>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Parts & builds
// ---------------------------------------------------------------------------

function PartsCard({ res }: { res: TimelineRes }) {
  const rows = (res.data?.rows ?? []) as Row[]
  const columns = useMemo<ColumnDef<Row, any>[]>(
    () => [
      {
        id: 'part_guid',
        header: 'Part GUID',
        accessorFn: (r) => s(r.part_guid),
        cell: ({ getValue }) => <span className="font-mono text-[11.5px]">{(getValue() as string) || '—'}</span>,
      },
      {
        id: 'part_file_id',
        header: 'Part file',
        accessorFn: (r) => s(r.part_file_id),
        cell: ({ getValue }) => <span className="font-mono text-[11.5px]">{(getValue() as string) || '—'}</span>,
      },
      {
        id: 'quantity',
        header: 'Qty',
        accessorFn: (r) => num0(r.quantity),
        cell: ({ getValue }) => fmtInt(getValue() as number),
        meta: { align: 'right' },
      },
      {
        id: 'volume_ml',
        header: 'Volume (mL)',
        accessorFn: (r) => num0(r.volume_ml),
        cell: ({ getValue }) => fmtNum(getValue() as number, 1),
        meta: { align: 'right' },
      },
      {
        id: 'n_builds',
        header: 'Builds',
        accessorFn: (r) => num0(r.n_builds),
        cell: ({ getValue }) => fmtInt(getValue() as number),
        meta: { align: 'right' },
      },
      {
        id: 'build_ids',
        header: 'Build ids',
        accessorFn: (r) => s(r.build_ids),
        cell: ({ getValue }) => <span className="font-mono text-[11.5px]">{(getValue() as string) || '—'}</span>,
      },
    ],
    [],
  )

  return (
    <ChartCard
      title="Parts & builds"
      subtitle="Every part on the order and the print builds it was placed on"
      info={{
        definition:
          'One row per order part: part GUID, source part file, ordered quantity, single-part volume (mL), and the print build ids that included the part (a part appears on multiple builds after a reprint).',
        source: 'fcm_api_orderpart × fcm_api_partfile + fcm_api_printbuildpart',
      }}
      csvRows={rows}
      csvName="order_parts"
      isLoading={res.isLoading}
      isFetching={res.isFetching}
      error={res.error}
      isEmpty={rows.length === 0}
      emptyText="No parts recorded on this order."
    >
      <DataTable data={rows} columns={columns} />
    </ChartCard>
  )
}

// ---------------------------------------------------------------------------
// Tulip (shop floor)
// ---------------------------------------------------------------------------

const TULIP_ISSUE_STATUSES = new Set(['Quarantine', 'QC Failed', 'Complete Build Failure'])

function TulipCard({ res, enabled }: { res: TimelineRes; enabled: boolean }) {
  const rows = (res.data?.rows ?? []) as Row[]
  const columns = useMemo<ColumnDef<Row, any>[]>(
    () => [
      { id: 'part_no', header: 'Part no', accessorFn: (r) => s(r.part_no) },
      {
        id: 'status',
        header: 'Status',
        accessorFn: (r) => s(r.status),
        cell: ({ getValue }) => {
          const v = getValue() as string
          const bad = TULIP_ISSUE_STATUSES.has(v) || v.startsWith('Waiting to Repeat')
          return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              {bad && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS.critical }} />}
              {v || '—'}
            </span>
          )
        },
      },
      {
        id: 'quantity',
        header: 'Qty',
        accessorFn: (r) => num0(r.quantity),
        cell: ({ getValue }) => fmtInt(getValue() as number),
        meta: { align: 'right' },
      },
      { id: 'material', header: 'Material', accessorFn: (r) => s(r.material) },
      { id: 'manufacturing_type', header: 'Mfg type', accessorFn: (r) => s(r.manufacturing_type) },
      {
        id: 'printer_sn',
        header: 'Printer SN',
        accessorFn: (r) => s(r.printer_sn),
        cell: ({ getValue }) => <span className="font-mono text-[11.5px]">{(getValue() as string) || '—'}</span>,
      },
      {
        id: 'print_start',
        header: 'Print start',
        accessorFn: (r) => s(r.print_start),
        cell: ({ row }) => fmtDateTime(row.original.print_start),
      },
      {
        id: 'print_finished',
        header: 'Print finished',
        accessorFn: (r) => s(r.print_finished),
        cell: ({ row }) => fmtDateTime(row.original.print_finished),
      },
      {
        id: 'shipping_label_created',
        header: 'Label created',
        accessorFn: (r) => s(r.shipping_label_created),
        cell: ({ row }) => fmtDateTime(row.original.shipping_label_created),
      },
      {
        id: 'due_date',
        header: 'Due',
        accessorFn: (r) => s(r.due_date),
        cell: ({ row }) => fmtDate(row.original.due_date),
      },
      {
        id: 'updated_at',
        header: 'Updated',
        accessorFn: (r) => s(r.updated_at),
        cell: ({ row }) => fmtDateTime(row.original.updated_at),
      },
    ],
    [],
  )

  return (
    <ChartCard
      title="Shop floor (Tulip)"
      subtitle="Per-lot pipeline status from the Tulip manufacturing app"
      info={{
        definition:
          'Tulip master_table lots whose order number equals this order’s MSB id: pipeline status (Lot Created → Wash → Cure → Sift → Mediablast → Finishing → Inspection → Binned → Shipped, plus Quarantine / QC Failed), printer serial, print start/finish, shipping-label timestamp and due date. Newer orders may have no Tulip records yet.',
        source: 'formcloud_manufacturing.master_table (Tulip)',
      }}
      csvRows={rows}
      csvName="order_tulip"
      isLoading={enabled && res.isLoading}
      isFetching={res.isFetching}
      error={enabled ? res.error : null}
      isEmpty={!enabled || rows.length === 0}
      emptyText="No Tulip records — normal for newer orders."
    >
      <DataTable data={rows} columns={columns} />
    </ChartCard>
  )
}
