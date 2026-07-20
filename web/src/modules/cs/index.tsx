import { useMemo, useRef, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useFormlabsGet, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel, periodStart } from '../../lib/dates'
import { fmtDateTime, fmtInt, fmtNum, fmtPct, num0 } from '../../lib/format'
import { STATUS } from '../../lib/palette'
import { gridDefaults, barDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { DataTable } from '../../components/DataTable'
import { HoverReveal } from '../../components/HoverReveal'
import { Modal } from '../../components/Modal'
import { EmptyState } from '../../components/states'
import { EChart, type EChartHandle } from '../../components/EChart'
import { MultiSelect } from '../../components/MultiSelect'
import { Segmented } from '../../components/Segmented'
import { ratePoint, tooltipFormatter } from '../shipments/metrics'

interface CsItem extends Row {
  status: 'within' | 'missed' | 'pending'
  bh_hours: number
}

const SCORE_COLORS: Record<number, string> = {
  1: '#B2182B',
  2: STATUS.serious,
  3: STATUS.warning,
  4: '#8fce8f',
  5: STATUS.good,
}

// ---------------------------------------------------------------------------
// Business-hours math in America/New_York. The two-offset trick turns an ET
// wall time into an exact epoch across DST without a timezone library.
// ---------------------------------------------------------------------------

const ET_WALL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function etDate(ms: number): string {
  return ET_WALL.format(ms).slice(0, 10)
}

const epochCache = new Map<string, number>()

/** Epoch ms for an ET wall time "YYYY-MM-DD" + "HH:MM". */
function etEpoch(date: string, hm: string): number {
  const key = `${date}T${hm}`
  const hit = epochCache.get(key)
  if (hit !== undefined) return hit
  for (const off of ['-05:00', '-04:00']) {
    const t = Date.parse(`${date}T${hm}:00${off}`)
    if (ET_WALL.format(t).replace(', ', 'T') === key) {
      epochCache.set(key, t)
      return t
    }
  }
  const fallback = Date.parse(`${date}T${hm}:00-05:00`)
  epochCache.set(key, fallback)
  return fallback
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** ISO weekday (Mon=1..Sun=7) of a calendar date string. */
function isoDow(date: string): number {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay()
  return dow === 0 ? 7 : dow
}

/** Hours of [fromMs, toMs] that fall inside the active window on selected days. */
function businessHours(fromMs: number, toMs: number, days: Set<number>, startHM: string, endHM: string): number {
  if (toMs <= fromMs) return 0
  let total = 0
  let d = etDate(fromMs)
  const endD = etDate(toMs)
  for (let i = 0; i < 800; i++) {
    if (days.has(isoDow(d))) {
      const ws = etEpoch(d, startHM)
      const we = etEpoch(d, endHM)
      total += Math.max(0, Math.min(toMs, we) - Math.max(fromMs, ws))
    }
    if (d === endD) break
    d = nextDate(d)
  }
  return total / 3_600_000
}

// ---------------------------------------------------------------------------

type Mode = 'pct' | 'counts'

export default function CsPage() {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const chartRef = useRef<EChartHandle>(null)

  // SLA config — active business hours + time-to-first-human-response threshold.
  const [slaDays, setSlaDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [slaStart, setSlaStart] = useState('08:00')
  const [slaEnd, setSlaEnd] = useState('17:00')
  const [thresholdH, setThresholdH] = useState(4)
  // Filters.
  const [assignees, setAssignees] = useState<string[]>([])
  const [firstOnly, setFirstOnly] = useState(false)
  const [excludeFin, setExcludeFin] = useState(true)
  const [excludeXometry, setExcludeXometry] = useState(true)
  const [excludeFormlabs, setExcludeFormlabs] = useState(false)
  const [excludeClosedNoReply, setExcludeClosedNoReply] = useState(true)
  const [mode, setMode] = useState<Mode>('pct')

  const emails = useFormlabsGet('cs_emails', { start: queryParams.start, end: queryParams.end }, { staleMs: 10 * 60_000 })
  const admins = useFormlabsGet('cs_admins', {}, { staleMs: 60 * 60_000 })

  const adminOptions = useMemo(() => {
    const rows = (admins.data?.rows ?? []) as { id?: unknown; name?: unknown }[]
    return [
      { value: 'none', label: 'Unassigned' },
      ...rows.map((a) => ({ value: String(a.id), label: String(a.name) })).sort((a, b) => a.label.localeCompare(b.label)),
    ]
  }, [admins.data])

  const model = useMemo(() => {
    const rows = (emails.data?.rows ?? []) as Row[]
    const daySet = new Set(slaDays)
    const now = Date.now()

    const filtered = rows.filter((r) => {
      if (excludeXometry && r.xometry) return false
      if (excludeFormlabs && /@(?:[a-z0-9-]+\.)*formlabs\.com$/i.test(String(r.sender ?? ''))) return false
      if (excludeFin && r.fin_resolved) return false
      if (excludeClosedNoReply && r.closed_no_reply) return false
      if (firstOnly && !r.first) return false
      if (assignees.length) {
        const a = r.assignee === null || r.assignee === undefined ? 'none' : String(r.assignee)
        if (!assignees.includes(a)) return false
      }
      return true
    })

    interface Bucket {
      emails: number
      within: number
      replied: number
      pending: number
      items: CsItem[]
    }
    const byPeriod = new Map<string, Bucket>()
    let tot = { emails: 0, within: 0, replied: 0, pending: 0 }
    for (const r of filtered) {
      const at = num0(r.email_at) * 1000
      const period = periodStart(etDate(at), grain)
      let b = byPeriod.get(period)
      if (!b) byPeriod.set(period, (b = { emails: 0, within: 0, replied: 0, pending: 0, items: [] }))
      b.emails++
      tot.emails++
      let status: CsItem['status'] = 'missed'
      let bh: number
      if (r.replied_at) {
        b.replied++
        tot.replied++
        bh = businessHours(at, num0(r.replied_at) * 1000, daySet, slaStart, slaEnd)
        if (bh <= thresholdH) {
          status = 'within'
          b.within++
          tot.within++
        }
      } else {
        bh = businessHours(at, now, daySet, slaStart, slaEnd)
        if (bh <= thresholdH) {
          status = 'pending'
          b.pending++
          tot.pending++
        }
      }
      b.items.push({ ...r, status, bh_hours: Math.round(bh * 10) / 10 })
    }

    const periods = [...byPeriod.keys()].sort()
    const provisional = periods.map((p) => isCurrentPeriod(p, grain))
    const series =
      mode === 'pct'
        ? [
            {
              ...barDefaults,
              name: `Replied within SLA %`,
              color: STATUS.good,
              data: periods.map((p, i) => ratePoint(byPeriod.get(p)!.within, byPeriod.get(p)!.emails, provisional[i])),
            },
          ]
        : [
            {
              ...barDefaults,
              itemStyle: { ...barDefaults.itemStyle },
              name: 'Within SLA',
              color: STATUS.good,
              data: periods.map((p, i) => {
                const b = byPeriod.get(p)!
                return { value: b.within, itemStyle: provisional[i] ? { opacity: 0.45 } : undefined }
              }),
            },
            {
              ...barDefaults,
              name: 'Missed / not yet replied',
              color: STATUS.serious,
              data: periods.map((p, i) => {
                const b = byPeriod.get(p)!
                return { value: b.emails - b.within, itemStyle: provisional[i] ? { opacity: 0.45 } : undefined }
              }),
            },
          ]

    const fmt = mode === 'pct' ? (v: number | null | undefined) => fmtPct(v ?? null) : (v: number | null | undefined) => fmtInt(v ?? null)
    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: mode === 'counts', top: 0 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: tooltipFormatter(fmt) },
      xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
      yAxis: {
        type: 'value',
        min: 0,
        max: mode === 'pct' ? 1 : undefined,
        axisLabel: { formatter: mode === 'pct' ? (v: number) => `${Math.round(v * 100)}%` : (v: number) => fmtInt(v) },
      },
      series,
    }

    const csvRows = periods.map((p) => {
      const b = byPeriod.get(p)!
      return { period: p, emails: b.emails, within_sla: b.within, replied: b.replied, pending_under_threshold: b.pending }
    })

    const itemsByPeriod = new Map(periods.map((p) => [p, byPeriod.get(p)!.items]))
    return { option, csvRows, tot, periods, itemsByPeriod, hasProvisional: provisional.some(Boolean), isEmpty: filtered.length === 0 }
  }, [emails.data, grain, slaDays, slaStart, slaEnd, thresholdH, assignees, firstOnly, excludeFin, excludeXometry, excludeFormlabs, excludeClosedNoReply, mode])

  const [modalPeriod, setModalPeriod] = useState<string | null>(null)
  const onBarClick = (params: unknown) => {
    const idx = (params as { dataIndex?: number }).dataIndex
    if (idx !== undefined && model.periods[idx]) setModalPeriod(model.periods[idx])
  }
  const modalItems = modalPeriod ? (model.itemsByPeriod.get(modalPeriod) ?? []) : []
  const STATUS_BADGE: Record<CsItem['status'], { label: string; color: string }> = {
    within: { label: 'within SLA', color: STATUS.good },
    missed: { label: 'missed', color: STATUS.critical },
    pending: { label: 'pending', color: '#898781' },
  }
  const modalColumns: ColumnDef<CsItem, unknown>[] = [
    {
      header: 'Received (ET)',
      id: 'email_at',
      accessorFn: (r) => num0(r.email_at),
      cell: ({ row }) => fmtDateTime(new Date(num0(row.original.email_at) * 1000).toISOString()),
      meta: { className: 'whitespace-nowrap' },
    },
    { header: 'Sender', accessorKey: 'sender', cell: ({ row }) => String(row.original.sender || '—') },
    {
      header: 'Subject',
      accessorKey: 'subject',
      cell: ({ row }) => <span className="block max-w-[26rem] truncate" title={String(row.original.subject)}>{String(row.original.subject)}</span>,
      meta: { className: 'w-full' },
    },
    {
      header: 'Response (biz h)',
      id: 'bh_hours',
      accessorFn: (r) => r.bh_hours,
      cell: ({ row }) => {
        const it = row.original
        const b = STATUS_BADGE[it.status]
        return (
          <span className="tabular-nums">
            {it.replied_at ? `${fmtNum(it.bh_hours, 1)} h` : `${fmtNum(it.bh_hours, 1)} h waiting`}{' '}
            <span className="rounded px-1 py-0.5 text-[10.5px] font-medium text-white" style={{ backgroundColor: b.color }}>
              {b.label}
            </span>
          </span>
        )
      },
      meta: { align: 'right' },
    },
    {
      header: '',
      id: 'open',
      cell: ({ row }) =>
        row.original.url ? (
          <a
            href={String(row.original.url)}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] font-medium text-accent hover:underline"
            title="Open in Intercom"
          >
            Intercom ↗
          </a>
        ) : null,
    },
  ]

  const t = model.tot
  const toggle = (checked: boolean, set: (v: boolean) => void, label: string) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-sub">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="accent-accent" />
      {label}
    </label>
  )

  return (
    <div className="space-y-3">
      <ChartCard
        title="Email response SLA"
        subtitle={`% of inbound customer emails answered by a human within ${thresholdH} business hour${thresholdH === 1 ? '' : 's'} (${slaStart}–${slaEnd} ET)`}
        info={{
          definition:
            'Every inbound customer email (customer-initiated EMAIL conversations from Intercom — Messenger chats and outbound emails are out of scope), bucketed by arrival period. An email counts as answered within SLA when the first HUMAN teammate reply after it lands within the threshold, counting only time inside the configured business window (ET). Fin/bot replies never stop the clock; internal notes don\'t count. Unanswered emails count in the denominator (recent periods start low and climb as replies land) — ones still under the threshold are "pending" and can still convert. "Exclude closed without reply" drops emails a TEAMMATE closed without replying to (an explicit no-response-needed disposition, e.g. a final thank-you note); bot or auto-closes never qualify, so real misses can\'t be hidden by inactivity auto-close. "First email only" keeps just each conversation\'s opening email. "Exclude Fin-resolved" drops conversations Fin answered/closed with no human reply ever. Xometry = any sender @*.xometry.com; "Exclude Formlabs senders" drops @*.formlabs.com senders (mostly sales@ forwarding customer emails in — roughly 40% of inbound, so expect volumes to drop when enabled). Assignment is conversation-level. The global date range and grain apply; channel/material filters do not.',
          source: emails.data?.meta.source ?? 'Intercom API (api.intercom.io)',
        }}
        csvRows={model.csvRows}
        csvName="cs-email-sla"
        chartRef={chartRef}
        isLoading={emails.isLoading}
        isFetching={emails.isFetching}
        error={emails.error}
        height={380}
        actions={
          <Segmented
            size="sm"
            options={[
              { value: 'pct', label: '% within SLA' },
              { value: 'counts', label: 'Counts' },
            ]}
            value={mode}
            onChange={setMode}
          />
        }
      >
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-sub">SLA:</span>
            <div className="flex overflow-hidden rounded-md border border-line" title="Active business days">
              {(['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const).map((label, i) => (
                <button
                  key={i}
                  onClick={() =>
                    setSlaDays((cur) => (cur.includes(i + 1) ? (cur.length > 1 ? cur.filter((x) => x !== i + 1) : cur) : [...cur, i + 1].sort()))
                  }
                  className={`px-1.5 py-0.5 text-[11px] font-medium ${
                    slaDays.includes(i + 1) ? 'bg-accent/15 text-accent' : 'bg-white text-faint hover:text-sub'
                  } ${i > 0 ? 'border-l border-line' : ''}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="time"
              value={slaStart}
              max={slaEnd}
              onChange={(e) => e.target.value && e.target.value < slaEnd && setSlaStart(e.target.value)}
              className="rounded-md border border-line px-1 py-0.5 text-[11.5px]"
              title="Business hours start (ET)"
            />
            <span className="text-[11px] text-faint">–</span>
            <input
              type="time"
              value={slaEnd}
              min={slaStart}
              onChange={(e) => e.target.value && e.target.value > slaStart && setSlaEnd(e.target.value)}
              className="rounded-md border border-line px-1 py-0.5 text-[11.5px]"
              title="Business hours end (ET)"
            />
            <span className="text-[11px] text-faint">respond within</span>
            <input
              type="number"
              min={0.5}
              max={100}
              step={0.5}
              value={thresholdH}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v > 0 && v <= 100) setThresholdH(v)
              }}
              className="w-16 rounded-md border border-line px-1.5 py-0.5 text-[12px]"
              title="Time to first human response threshold (business hours)"
            />
            <span className="text-[11px] text-faint">biz hours</span>
          </div>
          <MultiSelect label="Assignee" options={adminOptions} selected={assignees} onChange={setAssignees} />
          {toggle(firstOnly, setFirstOnly, 'First email of thread only')}
          {toggle(excludeFin, setExcludeFin, 'Exclude Fin-resolved')}
          {toggle(excludeXometry, setExcludeXometry, 'Exclude Xometry')}
          {toggle(excludeFormlabs, setExcludeFormlabs, 'Exclude Formlabs senders')}
          {toggle(excludeClosedNoReply, setExcludeClosedNoReply, 'Exclude closed without reply')}
        </div>
        {model.isEmpty ? (
          <EmptyState text="No inbound emails match the filters in this range — loosen a filter above or widen the date range." />
        ) : (
          <>
            <EChart ref={chartRef} option={model.option} height={300} onClick={onBarClick} />
            <p className="mt-1 text-[11.5px] text-faint">
              Click a bar to list that period's emails.{' '}
              Window: {fmtInt(t.within)}/{fmtInt(t.emails)} within SLA ({t.emails > 0 ? fmtPct(t.within / t.emails) : '—'}) ·{' '}
              {fmtInt(t.emails - t.replied)} unanswered of which {fmtInt(t.pending)} still under threshold (can still convert).
              Unanswered emails count against the rate. First load fetches per-conversation threads from Intercom and can take a
              minute; it's cached after.
              {model.hasProvisional ? ' Newest period is still in progress (faded).' : ''}
            </p>
          </>
        )}
      </ChartCard>
      {modalPeriod && (
        <Modal
          title={`Inbound emails — ${periodLabel(modalPeriod, grain)} (${fmtInt(modalItems.length)})`}
          onClose={() => setModalPeriod(null)}
        >
          <DataTable
            data={modalItems}
            columns={modalColumns}
            initialSort={[{ id: 'email_at', desc: false }]}
            csvName={`cs-emails-${modalPeriod}`}
            fit
          />
          <p className="mt-2 text-[11px] text-faint">
            Response time in business hours under the current SLA window; the same filters as the chart apply.
            Links open the conversation in the Intercom inbox.
          </p>
        </Modal>
      )}
      <CsatCard adminsById={new Map(adminOptions.map((a) => [a.value, a.label]))} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// CSAT — conversation ratings from the "rate your conversation" workflow.
// ---------------------------------------------------------------------------

function CsatCard({ adminsById }: { adminsById: Map<string, string> }) {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const chartRef = useRef<EChartHandle>(null)
  const [mode, setMode] = useState<'counts' | 'avg'>('counts')
  const [modalPeriod, setModalPeriod] = useState<string | null>(null)

  const q = useFormlabsGet('cs_ratings', { start: queryParams.start, end: queryParams.end }, { staleMs: 10 * 60_000 })

  const model = useMemo(() => {
    const rows = (q.data?.rows ?? []) as Row[]
    interface Bucket {
      byScore: number[]
      sum: number
      n: number
      items: Row[]
    }
    const byPeriod = new Map<string, Bucket>()
    let sum = 0
    let promoters = 0
    let remarks = 0
    for (const r of rows) {
      const period = periodStart(etDate(num0(r.rated_at) * 1000), grain)
      let b = byPeriod.get(period)
      if (!b) byPeriod.set(period, (b = { byScore: [0, 0, 0, 0, 0, 0], sum: 0, n: 0, items: [] }))
      const score = Math.min(5, Math.max(1, num0(r.rating)))
      b.byScore[score]++
      b.sum += score
      b.n++
      b.items.push(r)
      sum += score
      if (score >= 4) promoters++
      if (String(r.remark ?? '').trim()) remarks++
    }
    const periods = [...byPeriod.keys()].sort()
    const provisional = periods.map((p) => isCurrentPeriod(p, grain))
    const total = rows.length

    const series =
      mode === 'counts'
        ? [5, 4, 3, 2, 1]
            .filter((s) => periods.some((p) => byPeriod.get(p)!.byScore[s] > 0))
            .map((s) => ({
              ...barDefaults,
              stack: 'ratings',
              name: `${s}★`,
              color: SCORE_COLORS[s],
              data: periods.map((p, i) => ({
                value: byPeriod.get(p)!.byScore[s],
                itemStyle: provisional[i] ? { opacity: 0.45 } : undefined,
              })),
            }))
        : [
            {
              type: 'line' as const,
              symbol: 'circle' as const,
              symbolSize: 7,
              lineStyle: { width: 2 },
              name: 'Avg rating',
              color: STATUS.good,
              connectNulls: false,
              data: periods.map((p, i) => {
                const b = byPeriod.get(p)!
                const v = b.n > 0 ? Math.round((b.sum / b.n) * 100) / 100 : null
                return provisional[i] && v !== null ? { value: v, itemStyle: { opacity: 0.45 } } : v
              }),
            },
          ]

    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: mode === 'counts', top: 0 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
      yAxis:
        mode === 'avg'
          ? { type: 'value', min: 1, max: 5 }
          : { type: 'value', min: 0, axisLabel: { formatter: (v: number) => fmtInt(v) } },
      series,
    }

    const csvRows = periods.map((p) => {
      const b = byPeriod.get(p)!
      return {
        period: p,
        ratings: b.n,
        avg: b.n ? Math.round((b.sum / b.n) * 100) / 100 : null,
        r1: b.byScore[1],
        r2: b.byScore[2],
        r3: b.byScore[3],
        r4: b.byScore[4],
        r5: b.byScore[5],
      }
    })

    return {
      option,
      csvRows,
      periods,
      itemsByPeriod: new Map(periods.map((p) => [p, byPeriod.get(p)!.items])),
      total,
      avg: total ? Math.round((sum / total) * 100) / 100 : null,
      csat: total ? promoters / total : null,
      remarks,
      isEmpty: total === 0,
    }
  }, [q.data, grain, mode])

  const modalItems = modalPeriod ? (model.itemsByPeriod.get(modalPeriod) ?? []) : []
  const modalColumns: ColumnDef<Row, unknown>[] = [
    {
      header: 'Rated (ET)',
      id: 'rated_at',
      accessorFn: (r) => num0(r.rated_at),
      cell: ({ row }) => fmtDateTime(new Date(num0(row.original.rated_at) * 1000).toISOString()),
      meta: { className: 'whitespace-nowrap' },
    },
    {
      header: 'Score',
      id: 'rating',
      accessorFn: (r) => num0(r.rating),
      cell: ({ row }) => {
        const s = num0(row.original.rating)
        return (
          <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: SCORE_COLORS[s] ?? '#898781' }}>
            {s}★
          </span>
        )
      },
      meta: { align: 'right' },
    },
    { header: 'Teammate', id: 'teammate', accessorFn: (r) => String(r.teammate ?? ''), cell: ({ row }) => adminsById.get(String(row.original.teammate)) ?? '—' },
    { header: 'Sender', accessorKey: 'sender', cell: ({ row }) => String(row.original.sender || '—') },
    {
      header: 'Remark',
      accessorKey: 'remark',
      cell: ({ row }) => <HoverReveal text={String(row.original.remark ?? '')} className="block max-w-[22rem] truncate" />,
      meta: { className: 'w-full' },
    },
    {
      header: '',
      id: 'open',
      cell: ({ row }) =>
        row.original.url ? (
          <a href={String(row.original.url)} target="_blank" rel="noreferrer" className="text-[12px] font-medium text-accent hover:underline">
            Intercom ↗
          </a>
        ) : null,
    },
  ]

  return (
    <ChartCard
      title="CSAT — conversation ratings"
      subtitle="Ratings left after teammates close a conversation (workflow live since Jul 20, 2026)"
      info={{
        definition:
          'Conversation ratings (1–5) collected by the "rate your conversation" workflow, bucketed by when the rating was left. Counts view stacks ratings by score; Avg view plots the mean per period. CSAT in the caption = share of 4–5 ratings, the standard definition. All channels are included, and ratings are attributed to the teammate Intercom credits (usually the closer). Ratings only exist where customers respond — expect small n at first; the workflow went live Jul 20, 2026, so earlier periods are legitimately empty. Click a bar for individual ratings including remarks. The global date range and grain apply.',
        source: q.data?.meta.source ?? 'Intercom API (api.intercom.io)',
      }}
      csvRows={model.csvRows}
      csvName="cs-csat"
      chartRef={chartRef}
      isLoading={q.isLoading}
      isFetching={q.isFetching}
      error={q.error}
      height={340}
      actions={
        <Segmented
          size="sm"
          options={[
            { value: 'counts', label: 'Counts' },
            { value: 'avg', label: 'Avg score' },
          ]}
          value={mode}
          onChange={setMode}
        />
      }
    >
      {model.isEmpty ? (
        <EmptyState text="No ratings in this range yet — the CSAT workflow is newly live; responses will appear here as customers reply." />
      ) : (
        <>
          <EChart
            ref={chartRef}
            option={model.option}
            height={260}
            onClick={(params) => {
              const idx = (params as { dataIndex?: number }).dataIndex
              if (idx !== undefined && model.periods[idx]) setModalPeriod(model.periods[idx])
            }}
          />
          <p className="mt-1 text-[11.5px] text-faint">
            Click a bar for individual ratings. Window: {fmtInt(model.total)} rating{model.total === 1 ? '' : 's'} · avg{' '}
            {model.avg ?? '—'} · CSAT (4–5 share) {model.csat !== null ? fmtPct(model.csat) : '—'} · {fmtInt(model.remarks)} with
            remarks.
          </p>
        </>
      )}
      {modalPeriod && (
        <Modal title={`Ratings — ${periodLabel(modalPeriod, grain)} (${fmtInt(modalItems.length)})`} onClose={() => setModalPeriod(null)}>
          <DataTable data={modalItems} columns={modalColumns} initialSort={[{ id: 'rated_at', desc: false }]} csvName={`cs-ratings-${modalPeriod}`} fit />
        </Modal>
      )}
    </ChartCard>
  )
}
