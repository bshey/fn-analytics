import { useMemo, useRef, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useFilters } from '../../lib/filters'
import { useAppConfig, useNamedQuery, type Row } from '../../lib/api'
import { ChartCard } from '../../components/ChartCard'
import { KpiCard } from '../../components/KpiCard'
import { DataTable } from '../../components/DataTable'
import { EChart, type EChartHandle } from '../../components/EChart'
import { MultiSelect } from '../../components/MultiSelect'
import { Segmented } from '../../components/Segmented'
import { seriesColor } from '../../lib/palette'
import { stackedBarDefaults, lineDefaults, gridDefaults } from '../../lib/echarts'
import { periodLabel, isCurrentPeriod, type Grain } from '../../lib/dates'
import { num, num0, fmtInt, fmtNum, fmtDate, fmtDateTime } from '../../lib/format'

// ---------------------------------------------------------------------------
// Module D — Stations, Quality & Operators.
// D1 station throughput + Tulip dwell · D2 quality/exceptions · D3 operators.
// Station-app data exists only since config stationAppDataSince (2026-07-02).
// ---------------------------------------------------------------------------

const STATION_TYPE_ORDER = ['POST_PROCESSING', 'FINISHING', 'QUARANTINE', 'SHIPPING'] as const
const STATION_TYPE_LABEL: Record<string, string> = {
  POST_PROCESSING: 'Post-processing',
  FINISHING: 'Finishing',
  QUARANTINE: 'Quarantine',
  SHIPPING: 'Shipping',
}

function typeLabel(t: string): string {
  return STATION_TYPE_LABEL[t] ?? t
}

/** Client-side mirror of the server's grainExpr truncation (week = Sunday). */
function truncPeriodIso(iso: string, grain: Grain): string {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  switch (grain) {
    case 'day':
      return iso
    case 'week':
      d.setUTCDate(d.getUTCDate() - d.getUTCDay())
      break
    case 'month':
      d.setUTCDate(1)
      break
    case 'quarter':
      d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3, 1)
      break
    case 'year':
      d.setUTCMonth(0, 1)
      break
  }
  return d.toISOString().slice(0, 10)
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

type ChartDatum = number | null | { value: number | null; itemStyle: { opacity: number } }

/** Dim the newest in-progress period's mark so it reads as provisional. */
function withProvisional(values: (number | null)[], periods: string[], grain: Grain): ChartDatum[] {
  return values.map((v, i) => (isCurrentPeriod(periods[i], grain) ? { value: v, itemStyle: { opacity: 0.55 } } : v))
}

function hasProvisional(periods: string[], grain: Grain): boolean {
  return periods.some((p) => isCurrentPeriod(p, grain))
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11px] leading-snug text-faint">{children}</p>
}

// ============================== D1 · Stations ===============================

function StationsSection({ since, stationTypes }: { since: string; stationTypes: string[] }) {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const thru = useNamedQuery('floor_station_throughput', { ...queryParams, stationTypes })
  const [mode, setMode] = useState<'type' | 'station'>('type')
  const [dwellMode, setDwellMode] = useState<'window' | 'trend'>('window')
  const [dwellStage, setDwellStage] = useState<string>('')
  const dwell = useNamedQuery('pipeline_dwell', { ...queryParams, mode: dwellMode })
  const thruRef = useRef<EChartHandle>(null)
  const dwellRef = useRef<EChartHandle>(null)

  const thruRows = thru.data?.rows ?? []

  const thruChart = useMemo(() => {
    if (!thruRows.length) return null
    const periods = [...new Set(thruRows.map((r) => String(r.period)))].sort()
    const idx = new Map(periods.map((p, i) => [p, i]))

    let names: string[]
    let sums: Map<string, number[]>
    if (mode === 'type') {
      const known = new Set<string>(STATION_TYPE_ORDER)
      const hasUnknown = thruRows.some((r) => !known.has(String(r.station_type)))
      names = STATION_TYPE_ORDER.filter((t) => thruRows.some((r) => r.station_type === t)).map(typeLabel)
      if (hasUnknown) names.push('Other')
      sums = new Map(names.map((n) => [n, periods.map(() => 0)]))
      for (const r of thruRows) {
        const t = String(r.station_type)
        const arr = sums.get(known.has(t) ? typeLabel(t) : 'Other')
        if (arr) arr[idx.get(String(r.period))!] += num0(r.parts)
      }
    } else {
      const totals = new Map<string, number>()
      for (const r of thruRows) {
        const s = String(r.station)
        totals.set(s, (totals.get(s) ?? 0) + num0(r.parts))
      }
      const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
      const fold = ranked.length > 8
      const top = fold ? ranked.slice(0, 7) : ranked // 7 + 'Other' keeps the 8-series cap
      names = fold ? [...top, 'Other'] : top
      sums = new Map(names.map((n) => [n, periods.map(() => 0)]))
      for (const r of thruRows) {
        const s = String(r.station)
        const key = top.includes(s) ? s : fold ? 'Other' : s
        const arr = sums.get(key)
        if (arr) arr[idx.get(String(r.period))!] += num0(r.parts)
      }
    }

    const series = names.map((name) =>
      mode === 'type'
        ? { ...stackedBarDefaults, name, stack: 'parts', color: seriesColor(name), data: withProvisional(sums.get(name)!, periods, grain) }
        : { ...lineDefaults, name, color: seriesColor(name), data: withProvisional(sums.get(name)!, periods, grain) },
    )
    return {
      option: {
        tooltip: { trigger: 'axis' },
        ...(names.length >= 2 ? { legend: { top: 0 } } : {}),
        grid: gridDefaults,
        xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
        yAxis: { type: 'value' },
        series,
      },
      provisional: hasProvisional(periods, grain),
    }
  }, [thruRows, mode, grain])

  const dwellRows = dwell.data?.rows ?? []
  const stageLabel = (s: string) => s.replace(/^\d+\s*/, '')
  const dwellStages = useMemo(
    () => [...new Set(dwellRows.map((r) => String(r.stage)))].sort(),
    [dwellRows],
  )
  const activeStage = dwellStages.includes(dwellStage) ? dwellStage : (dwellStages[0] ?? '')

  const dwellChart = useMemo(() => {
    if (!dwellRows.length) return null
    if (dwellMode === 'window') {
      // One horizontal bar per production step, in process order (first step on top).
      const rows = [...dwellRows].sort((a, b) => String(b.stage).localeCompare(String(a.stage)))
      return {
        option: {
          tooltip: {
            trigger: 'item',
            formatter: (prm: { name?: string; value?: unknown; data?: { n?: number } }) =>
              `${prm.name}: <b>${Number(prm.value).toFixed(1)} h</b> <span style="color:#898781">(n=${prm.data?.n ?? '?'})</span>`,
          },
          grid: { ...gridDefaults, left: 12, top: 8 },
          xAxis: { type: 'value', axisLabel: { formatter: '{value} h' } },
          yAxis: { type: 'category', data: rows.map((r) => stageLabel(String(r.stage))) },
          series: [
            {
              type: 'bar',
              barMaxWidth: 16,
              itemStyle: { borderRadius: [0, 3, 3, 0] },
              color: seriesColor('Median hours'),
              data: rows.map((r) => ({ value: num0(r.median_hours), n: num0(r.n) })),
            },
          ],
        },
        provisional: false,
      }
    }
    // Trend: one line for the selected stage.
    const rows = dwellRows.filter((r) => String(r.stage) === activeStage)
    const periods = rows.map((r) => String(r.period))
    return {
      option: {
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (v == null ? '—' : `${Number(v).toFixed(1)} h`),
        },
        grid: gridDefaults,
        xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
        yAxis: { type: 'value', axisLabel: { formatter: '{value} h' } },
        series: [
          {
            ...lineDefaults,
            name: stageLabel(activeStage),
            color: seriesColor('Median hours'),
            connectNulls: true,
            data: withProvisional(rows.map((r) => num(r.median_hours)), periods, grain),
          },
        ],
      },
      provisional: hasProvisional(periods, grain),
    }
  }, [dwellRows, dwellMode, activeStage, grain])

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title="Parts processed per period"
        subtitle={mode === 'type' ? 'Stacked by station type' : 'Top stations (max 8, rest folded into Other)'}
        info={{
          definition:
            'SUM(part_quantity) over station-app events (sign-in/out excluded), grouped by period and station. Test stations are excluded via config/exclusions.json. Channel/material filters do not apply to floor events.',
          source: 'manufacturing_events_manufacturingevent + mes_station_station',
        }}
        csvRows={thruRows}
        csvName="station-throughput"
        chartRef={thruRef}
        isLoading={thru.isLoading}
        isFetching={thru.isFetching}
        error={thru.error}
        isEmpty={!thruRows.length}
        emptyText="No station-app activity in the selected range."
        actions={
          <Segmented
            size="sm"
            options={[
              { value: 'type', label: 'By type' },
              { value: 'station', label: 'By station' },
            ]}
            value={mode}
            onChange={setMode}
          />
        }
        height={300}
      >
        {thruChart && <EChart ref={thruRef} option={thruChart.option} height={300} />}
        {queryParams.start < since && (
          <p className="mt-1 rounded-md border border-warn/30 bg-amber-50 px-2 py-1 text-[11.5px] text-warn">
            Your range starts {fmtDate(queryParams.start)}, but station-app tracking only began {fmtDate(since)} —
            earlier periods have no data (this is why the chart starts at the go-live week).
          </p>
        )}
        <Caption>
          Station-app data since {fmtDate(since)} · test stations excluded.
          {thruChart?.provisional ? ' Newest period is provisional (still accumulating).' : ''}
        </Caption>
      </ChartCard>

      <ChartCard
        title="Pipeline dwell — order to ship"
        subtitle={
          dwellMode === 'window'
            ? 'Median hours at each pipeline stage, from order acceptance to shipment'
            : `Median hours: ${stageLabel(activeStage)}, by stage-completion period`
        }
        info={{
          definition:
            'The production pipeline broken into verified stage boundaries. Order level: accepted → DFM approved (all parts PASSED/AT_RISK_APPROVED) → cleared for production (print-queue entry), and ready-to-ship (last lot binned) → shipped. Build level: build queued → print start → print end (printer timestamps via Tulip) → wash/sift scan → lot split. Lot level: lot split → scan onto the finishing line / bin-ship line / quarantine line (three tracks), and quarantine → dispositioned (next routing event). Medians of per-entity elapsed hours; <0 or >30-day durations discarded; cohort = when the stage completed. Channel filter applies at order level; material & mfg-type filters apply exactly per part on lot stages, any-part on order/build stages. Build/lot stages exist since the station-app go-live (Jul 2, 2026); Form 4 print timestamps ~76% covered, Fuse X1 currently unlogged. Quarantine dwell is right-censored — undispositioned lots aren\'t counted yet.',
          source: 'fcm_api_order/orderpart/orderevent/printbuild + station-app events + Tulip master_table (every boundary verified against real data)',
        }}
        csvRows={dwellRows}
        csvName="pipeline-dwell"
        chartRef={dwellRef}
        isLoading={dwell.isLoading}
        isFetching={dwell.isFetching}
        error={dwell.error}
        isEmpty={!dwellRows.length}
        emptyText="No pipeline records in the selected range."
        height={360}
        actions={
          <>
            {dwellMode === 'trend' && (
              <select value={activeStage} onChange={(e) => setDwellStage(e.target.value)} title="Pipeline stage">
                {dwellStages.map((s) => (
                  <option key={s} value={s}>
                    {stageLabel(s)}
                  </option>
                ))}
              </select>
            )}
            <Segmented
              size="sm"
              options={[
                { value: 'window', label: 'By stage' },
                { value: 'trend', label: 'Trend' },
              ]}
              value={dwellMode}
              onChange={setDwellMode}
            />
          </>
        }
      >
        {dwellChart && <EChart ref={dwellRef} option={dwellChart.option} height={360} />}
        <Caption>
          Channel / material / mfg-type filters apply. Build &amp; lot stages exist since Jul 2, 2026 (station-app
          go-live); order stages go back further. Station-type filter doesn't apply here.
          {dwellChart?.provisional ? ' Newest period is provisional.' : ''}
        </Caption>
      </ChartCard>
    </div>
  )
}

// ============================== D2 · Quality ================================

const EXCEPTION_SERIES: { key: string; name: string }[] = [
  { key: 'quarantined', name: 'Part quarantined' },
  { key: 'reprints', name: 'Part needs reprint' },
  { key: 'build_failures', name: 'Total build failure' },
]

function QualitySection() {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const exceptions = useNamedQuery('floor_quality_exceptions', queryParams)
  const outcomes = useNamedQuery('floor_quality_outcomes', queryParams)
  const [exMode, setExMode] = useState<'counts' | 'rate'>('counts')
  const exRef = useRef<EChartHandle>(null)
  const outRef = useRef<EChartHandle>(null)

  const exRows = exceptions.data?.rows ?? []
  const exChart = useMemo(() => {
    if (!exRows.length) return null
    const periods = exRows.map((r) => String(r.period))
    const series = EXCEPTION_SERIES.map(({ key, name }) => ({
      ...lineDefaults,
      name,
      color: seriesColor(name),
      connectNulls: false,
      data: withProvisional(
        exRows.map((r) => {
          const c = num0(r[key])
          if (exMode === 'counts') return c
          const shipped = num0(r.parts_shipped)
          return shipped > 0 ? Math.round((c / shipped) * 100 * 100) / 100 : null
        }),
        periods,
        grain,
      ),
    }))
    return {
      option: {
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) =>
            v == null ? '—' : exMode === 'counts' ? fmtInt(Number(v)) : `${Number(v).toFixed(2)} / 100 parts`,
        },
        legend: { top: 0 },
        grid: gridDefaults,
        xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
        yAxis: { type: 'value', ...(exMode === 'rate' ? { name: 'per 100 parts shipped', nameTextStyle: { fontSize: 10 } } : {}) },
        series,
      },
      provisional: hasProvisional(periods, grain),
    }
  }, [exRows, exMode, grain])

  const outRows = outcomes.data?.rows ?? []
  const OUT_SERIES: { key: string; name: string }[] = [
    { key: 'good', name: 'Good (Shipped/Binned)' },
    { key: 'quarantine', name: 'Quarantine' },
    { key: 'qc_failed', name: 'QC Failed' },
    { key: 'build_failure', name: 'Complete Build Failure' },
  ]
  const outChart = useMemo(() => {
    if (!outRows.length) return null
    const periods = outRows.map((r) => String(r.period))
    const totals = outRows.map((r) => OUT_SERIES.reduce((acc, s) => acc + num0(r[s.key]), 0))
    const series = OUT_SERIES.map(({ key, name }) => ({
      ...stackedBarDefaults,
      name,
      stack: 'mix',
      color: seriesColor(name),
      data: withProvisional(
        outRows.map((r, i) => (totals[i] > 0 ? Math.round((num0(r[key]) / totals[i]) * 1000) / 10 : null)),
        periods,
        grain,
      ),
    }))
    return {
      option: {
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (v == null ? '—' : `${Number(v).toFixed(1)}%`),
        },
        legend: { top: 0 },
        grid: gridDefaults,
        xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
        yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
        series,
      },
      provisional: hasProvisional(periods, grain),
    }
  }, [outRows, grain])

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title="Production exceptions"
        subtitle="Quarantine, reprint & build-failure events over time"
        info={{
          definition:
            'Counts of PART_QUARANTINED, PART_NEEDS_REPRINT and TOTAL_BUILD_FAILURE order events per period. Rate = events ÷ parts shipped in the same period × 100 (approximate — the shipped parts are not the same population as the excepted parts). Global channel/material filters are not applied.',
          source: 'fcm_api_orderevent + formlabs-data-sandbox.fcm.v_shipments_kpi',
        }}
        csvRows={exRows}
        csvName="quality-exceptions"
        chartRef={exRef}
        isLoading={exceptions.isLoading}
        isFetching={exceptions.isFetching}
        error={exceptions.error}
        isEmpty={!exRows.length}
        actions={
          <Segmented
            size="sm"
            options={[
              { value: 'counts', label: 'Counts' },
              { value: 'rate', label: 'Rate' },
            ]}
            value={exMode}
            onChange={setExMode}
          />
        }
        height={300}
      >
        {exChart && <EChart ref={exRef} option={exChart.option} height={300} />}
        <Caption>
          {exMode === 'rate'
            ? 'Approximate rate: exception events ÷ parts shipped in the same period × 100 — different populations, treat as directional.'
            : 'Event counts from the order log; not filtered by channel or material.'}
          {exChart?.provisional ? ' Newest period is provisional.' : ''}
        </Caption>
      </ChartCard>

      <ChartCard
        title="Tulip lot outcomes"
        subtitle="Share of lots by final status (100% stacked)"
        info={{
          definition:
            "Lots grouped by last-update period and latest Tulip status: Good = 'Shipped' or 'Binned'; failure buckets = 'Quarantine', 'QC Failed', 'Complete Build Failure'. In-progress statuses excluded. Share = bucket ÷ (good + failed) per period.",
          source: 'formcloud_manufacturing.master_table (Tulip)',
        }}
        csvRows={outRows}
        csvName="tulip-outcomes"
        chartRef={outRef}
        isLoading={outcomes.isLoading}
        isFetching={outcomes.isFetching}
        error={outcomes.error}
        isEmpty={!outRows.length}
        height={300}
      >
        {outChart && <EChart ref={outRef} option={outChart.option} height={300} />}
        <Caption>
          Approximate first-pass yield: lots count by their latest status — reworked lots that later shipped count as
          good, and quarantined lots may still recover.
          {outChart?.provisional ? ' Newest period is provisional.' : ''}
        </Caption>
      </ChartCard>
    </div>
  )
}

// ============================= D3 · Operators ===============================

interface SessionRow {
  id: string
  operator: string
  station: string
  stationType: string
  startedAt: string
  endedAt: string
  hours: number
  parts: number
  actions: number
  lots: number
}

interface OperatorRow {
  rank: number | null
  lowN: boolean
  operator: string
  sessions: number
  hours: number
  parts: number
  lots: number
  partsPerHour: number | null
  lotsPerHour: number | null
}

const MIN_RANK_SESSIONS = 2
const MIN_HOURS = 0.05

function OperatorsSection({ since, stationTypes }: { since: string; stationTypes: string[] }) {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const q = useNamedQuery('floor_sessions', { ...queryParams, stationTypes })
  const trendRef = useRef<EChartHandle>(null)

  const sessions = useMemo<SessionRow[]>(
    () =>
      (q.data?.rows ?? []).map((r: Row) => ({
        id: String(r.session_id ?? ''),
        operator: String(r.operator ?? ''),
        station: String(r.station ?? ''),
        stationType: String(r.station_type ?? ''),
        startedAt: String(r.started_at ?? ''),
        endedAt: String(r.ended_at ?? ''),
        hours: num0(r.session_hours),
        parts: num0(r.parts_processed),
        actions: num0(r.actions),
        lots: num0(r.lots),
      })),
    [q.data],
  )

  const { kpis, leaderboard, trend } = useMemo(() => {
    const byOp = new Map<string, { sessions: number; hours: number; parts: number; lots: number }>()
    for (const s of sessions) {
      const cur = byOp.get(s.operator) ?? { sessions: 0, hours: 0, parts: 0, lots: 0 }
      cur.sessions += 1
      cur.hours += s.hours
      cur.parts += s.parts
      cur.lots += s.lots
      byOp.set(s.operator, cur)
    }

    const rates = sessions.filter((s) => s.hours >= MIN_HOURS).map((s) => s.parts / s.hours)
    const kpis = {
      operators: byOp.size,
      sessions: sessions.length,
      parts: sessions.reduce((a, s) => a + s.parts, 0),
      medianRate: median(rates),
    }

    // Leaderboard: parts/hour = SUM(parts)/SUM(hours) per operator (never averaged rates).
    const rows: OperatorRow[] = [...byOp.entries()].map(([operator, a]) => ({
      rank: null,
      lowN: a.sessions < MIN_RANK_SESSIONS,
      operator,
      sessions: a.sessions,
      hours: Math.round(a.hours * 10) / 10,
      parts: a.parts,
      lots: a.lots,
      partsPerHour: a.hours >= MIN_HOURS ? Math.round((a.parts / a.hours) * 10) / 10 : null,
      lotsPerHour: a.hours >= MIN_HOURS ? Math.round((a.lots / a.hours) * 100) / 100 : null,
    }))
    rows.sort((a, b) => (b.partsPerHour ?? -1) - (a.partsPerHour ?? -1))
    let rank = 0
    for (const r of rows) if (!r.lowN) r.rank = ++rank

    // Trend: parts/hour per period for the top 6 operators by parts processed.
    const topOps = [...byOp.entries()]
      .sort((a, b) => b[1].parts - a[1].parts)
      .slice(0, 6)
      .map(([op]) => op)
    const periodSet = new Set<string>()
    const cell = new Map<string, { parts: number; hours: number }>()
    for (const s of sessions) {
      if (!topOps.includes(s.operator)) continue
      const period = truncPeriodIso(s.startedAt.slice(0, 10), grain)
      periodSet.add(period)
      const key = `${period}|${s.operator}`
      const c = cell.get(key) ?? { parts: 0, hours: 0 }
      c.parts += s.parts
      c.hours += s.hours
      cell.set(key, c)
    }
    const periods = [...periodSet].sort()
    const trend = {
      periods,
      series: topOps.map((op) => ({
        name: op,
        data: periods.map((p) => {
          const c = cell.get(`${p}|${op}`)
          return c && c.hours >= MIN_HOURS ? Math.round((c.parts / c.hours) * 10) / 10 : null
        }),
      })),
    }
    return { kpis, leaderboard: rows, trend }
  }, [sessions, grain])

  const trendChart = useMemo(() => {
    if (!trend.periods.length) return null
    return {
      option: {
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (v == null ? '—' : `${Number(v).toFixed(1)} parts/h`),
        },
        ...(trend.series.length >= 2 ? { legend: { top: 0 } } : {}),
        grid: gridDefaults,
        xAxis: { type: 'category', data: trend.periods.map((p) => periodLabel(p, grain)) },
        yAxis: { type: 'value' },
        series: trend.series.map((s) => ({
          ...lineDefaults,
          name: s.name,
          color: seriesColor(s.name),
          connectNulls: false,
          data: withProvisional(s.data, trend.periods, grain),
        })),
      },
      provisional: hasProvisional(trend.periods, grain),
    }
  }, [trend, grain])

  const trendCsv = useMemo(
    () =>
      trend.series.flatMap((s) =>
        trend.periods.map((p, i) => ({ period: p, operator: s.name, parts_per_hour: s.data[i] })),
      ),
    [trend],
  )

  const dim = (lowN: boolean) => (lowN ? 'text-faint' : '')
  const leaderboardCols: ColumnDef<OperatorRow, any>[] = [
    {
      header: '#',
      accessorKey: 'rank',
      cell: (c) =>
        c.row.original.lowN ? (
          <span className="rounded bg-page px-1.5 py-0.5 text-[10.5px] text-faint">low n</span>
        ) : (
          c.row.original.rank
        ),
    },
    {
      header: 'Operator',
      accessorKey: 'operator',
      cell: (c) => <span className={dim(c.row.original.lowN)}>{c.row.original.operator}</span>,
    },
    {
      header: 'Sessions (n)',
      accessorKey: 'sessions',
      meta: { align: 'right' },
      cell: (c) => <span className={dim(c.row.original.lowN)}>{fmtInt(c.row.original.sessions)}</span>,
    },
    {
      header: 'Hours',
      accessorKey: 'hours',
      meta: { align: 'right' },
      cell: (c) => <span className={dim(c.row.original.lowN)}>{fmtNum(c.row.original.hours, 1)}</span>,
    },
    {
      header: 'Parts',
      accessorKey: 'parts',
      meta: { align: 'right' },
      cell: (c) => <span className={dim(c.row.original.lowN)}>{fmtInt(c.row.original.parts)}</span>,
    },
    {
      header: 'Parts/hr',
      accessorKey: 'partsPerHour',
      meta: { align: 'right' },
      cell: (c) => <span className={dim(c.row.original.lowN)}>{fmtNum(c.row.original.partsPerHour, 1)}</span>,
    },
    {
      header: 'Lots/hr',
      accessorKey: 'lotsPerHour',
      meta: { align: 'right' },
      cell: (c) => <span className={dim(c.row.original.lowN)}>{fmtNum(c.row.original.lotsPerHour, 2)}</span>,
    },
  ]

  const sessionCols: ColumnDef<SessionRow, any>[] = [
    { header: 'Operator', accessorKey: 'operator' },
    { header: 'Station', accessorKey: 'station' },
    { header: 'Type', accessorKey: 'stationType', cell: (c) => typeLabel(c.row.original.stationType) },
    { header: 'Started', accessorKey: 'startedAt', cell: (c) => fmtDateTime(c.row.original.startedAt) },
    { header: 'Hours', accessorKey: 'hours', meta: { align: 'right' }, cell: (c) => fmtNum(c.row.original.hours, 2) },
    { header: 'Parts', accessorKey: 'parts', meta: { align: 'right' }, cell: (c) => fmtInt(c.row.original.parts) },
    { header: 'Actions', accessorKey: 'actions', meta: { align: 'right' }, cell: (c) => fmtInt(c.row.original.actions) },
    { header: 'Lots', accessorKey: 'lots', meta: { align: 'right' }, cell: (c) => fmtInt(c.row.original.lots) },
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-white px-3.5 py-2.5 text-[12.5px] text-sub">
        <span className="font-medium text-ink">Station-app instrumented stations only</span> · data since{' '}
        {fmtDate(since)} · excludes test stations &amp; non-line operators (config/exclusions.json)
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Active operators" value={fmtInt(kpis.operators)} hint="Distinct operators with a session in range" />
        <KpiCard label="Sessions" value={fmtInt(kpis.sessions)} hint="Sign-in → sign-out sessions in range" />
        <KpiCard label="Parts processed" value={fmtInt(kpis.parts)} hint="SUM(part_quantity) across session events" />
        <KpiCard
          label="Median parts/hour"
          value={kpis.medianRate == null ? '—' : fmtNum(kpis.medianRate, 1)}
          hint="Median of per-session parts ÷ hours (sessions ≥ 3 min)"
        />
      </div>

      <ChartCard
        title="Operator leaderboard"
        subtitle={`Parts per hour · ranked only with ≥ ${MIN_RANK_SESSIONS} sessions`}
        info={{
          definition:
            'Per operator over the selected range: sessions, hours = SUM(session hours), parts = SUM(part_quantity), parts/hr = SUM(parts) ÷ SUM(hours) (never an average of rates), lots/hr likewise. Operators with fewer than 2 sessions are shown greyed and unranked — the sample is too small to rank.',
          source: 'manufacturing_events_manufacturingevent + mes_station_operator + mes_station_station',
        }}
        csvRows={leaderboard as unknown as Row[]}
        csvName="operator-leaderboard"
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={!leaderboard.length}
        emptyText="No operator sessions in the selected range."
        height={260}
      >
        <DataTable data={leaderboard} columns={leaderboardCols} emptyText="No operator sessions in the selected range." />
      </ChartCard>

      <ChartCard
        title="Parts/hour trend by operator"
        subtitle="Top 6 operators by parts processed"
        info={{
          definition:
            'Per period and operator: SUM(parts) ÷ SUM(session hours) from station-app sessions (rate re-derived from sums, not averaged). Only the top 6 operators by total parts are shown.',
          source: 'manufacturing_events_manufacturingevent + mes_station_operator',
        }}
        csvRows={trendCsv}
        csvName="operator-trend"
        chartRef={trendRef}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={!trend.periods.length}
        emptyText="No operator sessions in the selected range."
        height={300}
      >
        {trendChart && <EChart ref={trendRef} option={trendChart.option} height={300} />}
        <Caption>
          Small samples — station-app data since {fmtDate(since)}; interpret short histories with care.
          {trendChart?.provisional ? ' Newest period is provisional.' : ''}
        </Caption>
      </ChartCard>

      <ChartCard
        title="Recent sessions"
        subtitle="Newest first"
        info={{
          definition:
            'One row per station-app session: started_at = first event, hours = (last − first event) in minutes ÷ 60, parts = SUM(part_quantity) of non-sign events, actions = non-sign event count, lots = distinct lots touched.',
          source: 'manufacturing_events_manufacturingevent + mes_station_operator + mes_station_station',
        }}
        csvRows={sessions as unknown as Row[]}
        csvName="operator-sessions"
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={!sessions.length}
        emptyText="No operator sessions in the selected range."
        height={260}
      >
        <DataTable
          data={sessions}
          columns={sessionCols}
          maxRows={15}
          emptyText="No operator sessions in the selected range."
        />
      </ChartCard>
    </div>
  )
}

// ================================ Page ======================================

type Section = 'stations' | 'quality' | 'operators'

const STATION_TYPE_OPTIONS = STATION_TYPE_ORDER.map((t) => ({ value: t, label: STATION_TYPE_LABEL[t] ?? t }))

export default function FloorPage() {
  const [section, setSection] = useState<Section>('stations')
  const [stationTypes, setStationTypes] = useState<string[]>([])
  const cfg = useAppConfig()
  const since = cfg.data?.stationAppDataSince ?? '2026-07-02'

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold">Floor &amp; Operators</h2>
          <p className="text-[12px] text-sub">Station throughput, quality signals and operator productivity</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelect
            label="Station type"
            options={STATION_TYPE_OPTIONS}
            selected={stationTypes}
            onChange={setStationTypes}
          />
          <Segmented
            options={[
              { value: 'stations', label: 'Station throughput' },
              { value: 'quality', label: 'Quality' },
              { value: 'operators', label: 'Operators' },
            ]}
            value={section}
            onChange={setSection}
          />
        </div>
      </div>
      {stationTypes.length > 0 && (
        <p className="mb-3 rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] text-sub">
          Filtering to {stationTypes.map((t) => STATION_TYPE_LABEL[t] ?? t).join(', ')} — applies to station-app data
          (throughput &amp; operators). Quality and Tulip dwell aren't station-scoped.
        </p>
      )}
      {section === 'stations' && <StationsSection since={since} stationTypes={stationTypes} />}
      {section === 'quality' && <QualitySection />}
      {section === 'operators' && <OperatorsSection since={since} stationTypes={stationTypes} />}
    </div>
  )
}
