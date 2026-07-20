import { useMemo, useRef, useState } from 'react'
import { useFormlabsGet, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel, periodStart } from '../../lib/dates'
import { fmtInt, fmtPct, num0 } from '../../lib/format'
import { STATUS } from '../../lib/palette'
import { gridDefaults, barDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { EmptyState } from '../../components/states'
import { EChart, type EChartHandle } from '../../components/EChart'
import { MultiSelect } from '../../components/MultiSelect'
import { Segmented } from '../../components/Segmented'
import { ratePoint, tooltipFormatter } from '../shipments/metrics'

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
    }
    const byPeriod = new Map<string, Bucket>()
    let tot: Bucket = { emails: 0, within: 0, replied: 0, pending: 0 }
    for (const r of filtered) {
      const at = num0(r.email_at) * 1000
      const period = periodStart(etDate(at), grain)
      let b = byPeriod.get(period)
      if (!b) byPeriod.set(period, (b = { emails: 0, within: 0, replied: 0, pending: 0 }))
      b.emails++
      tot.emails++
      if (r.replied_at) {
        b.replied++
        tot.replied++
        if (businessHours(at, num0(r.replied_at) * 1000, daySet, slaStart, slaEnd) <= thresholdH) {
          b.within++
          tot.within++
        }
      } else if (businessHours(at, now, daySet, slaStart, slaEnd) <= thresholdH) {
        b.pending++
        tot.pending++
      }
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

    return { option, csvRows, tot, nFiltered: filtered.length, hasProvisional: provisional.some(Boolean), isEmpty: filtered.length === 0 }
  }, [emails.data, grain, slaDays, slaStart, slaEnd, thresholdH, assignees, firstOnly, excludeFin, excludeXometry, excludeClosedNoReply, mode])

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
            'Every inbound customer email (customer-initiated EMAIL conversations from Intercom — Messenger chats and outbound emails are out of scope), bucketed by arrival period. An email counts as answered within SLA when the first HUMAN teammate reply after it lands within the threshold, counting only time inside the configured business window (ET). Fin/bot replies never stop the clock; internal notes don\'t count. Unanswered emails count in the denominator (recent periods start low and climb as replies land) — ones still under the threshold are "pending" and can still convert. "Exclude closed without reply" drops emails a TEAMMATE closed without replying to (an explicit no-response-needed disposition, e.g. a final thank-you note); bot or auto-closes never qualify, so real misses can\'t be hidden by inactivity auto-close. "First email only" keeps just each conversation\'s opening email. "Exclude Fin-resolved" drops conversations Fin answered/closed with no human reply ever. Xometry = any sender @*.xometry.com. Assignment is conversation-level. The global date range and grain apply; channel/material filters do not.',
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
          {toggle(excludeClosedNoReply, setExcludeClosedNoReply, 'Exclude closed without reply')}
        </div>
        {model.isEmpty ? (
          <EmptyState text="No inbound emails match the filters in this range — loosen a filter above or widen the date range." />
        ) : (
          <>
            <EChart ref={chartRef} option={model.option} height={300} />
            <p className="mt-1 text-[11.5px] text-faint">
              Window: {fmtInt(t.within)}/{fmtInt(t.emails)} within SLA ({t.emails > 0 ? fmtPct(t.within / t.emails) : '—'}) ·{' '}
              {fmtInt(t.emails - t.replied)} unanswered of which {fmtInt(t.pending)} still under threshold (can still convert).
              Unanswered emails count against the rate. First load fetches per-conversation threads from Intercom and can take a
              minute; it's cached after.
              {model.hasProvisional ? ' Newest period is still in progress (faded).' : ''}
            </p>
          </>
        )}
      </ChartCard>
    </div>
  )
}
