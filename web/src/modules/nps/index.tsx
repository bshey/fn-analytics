import { useMemo, useRef, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useFormlabsGet, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel, periodStart } from '../../lib/dates'
import { fmtDate, fmtDateTime, fmtInt, num0 } from '../../lib/format'
import { STATUS } from '../../lib/palette'
import { gridDefaults, barDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { DataTable } from '../../components/DataTable'
import { HoverReveal } from '../../components/HoverReveal'
import { KpiCard } from '../../components/KpiCard'
import { Modal } from '../../components/Modal'
import { EmptyState } from '../../components/states'
import { EChart, type EChartHandle } from '../../components/EChart'

const MES_URL = 'https://fcm-mes.formlabs.com/orders/'

/** Compact money: $342, $2.1k. */
function fmtK(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`
}

function scoreBand(nps: number): { label: string; color: string } {
  if (nps >= 9) return { label: 'promoter', color: STATUS.good }
  if (nps >= 7) return { label: 'passive', color: STATUS.warning }
  return { label: 'detractor', color: STATUS.critical }
}

/** Standard NPS: %promoters (9-10) − %detractors (0-6), in [-100, 100]. */
function npsOf(rows: Row[]): { nps: number | null; n: number; promoters: number; passives: number; detractors: number } {
  let promoters = 0
  let passives = 0
  let detractors = 0
  for (const r of rows) {
    const s = num0(r.nps)
    if (s >= 9) promoters++
    else if (s >= 7) passives++
    else detractors++
  }
  const n = rows.length
  return { nps: n ? Math.round(((promoters - detractors) / n) * 100) : null, n, promoters, passives, detractors }
}

export default function NpsPage() {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const chartRef = useRef<EChartHandle>(null)
  const [modalPeriod, setModalPeriod] = useState<string | null>(null)
  const [photo, setPhoto] = useState<Row | null>(null)

  const q = useFormlabsGet('nps_responses', {}, { staleMs: 10 * 60_000 })
  const rows = useMemo(() => (q.data?.rows ?? []) as Row[], [q.data])

  const kpis = useMemo(() => {
    const nowS = Math.floor(Date.now() / 1000)
    const d30 = rows.filter((r) => num0(r.recorded_at) >= nowS - 30 * 86400)
    const prev30 = rows.filter((r) => {
      const at = num0(r.recorded_at)
      return at >= nowS - 60 * 86400 && at < nowS - 30 * 86400
    })
    return { all: npsOf(rows), d30: npsOf(d30), prev30: npsOf(prev30) }
  }, [rows])

  const model = useMemo(() => {
    const startS = Math.floor(new Date(`${queryParams.start}T00:00:00Z`).getTime() / 1000)
    const endS = Math.floor(new Date(`${queryParams.end}T23:59:59Z`).getTime() / 1000)
    const inRange = rows.filter((r) => num0(r.recorded_at) >= startS && num0(r.recorded_at) <= endS)
    const byPeriod = new Map<string, Row[]>()
    for (const r of inRange) {
      const period = periodStart(new Date(num0(r.recorded_at) * 1000).toISOString().slice(0, 10), grain)
      let list = byPeriod.get(period)
      if (!list) byPeriod.set(period, (list = []))
      list.push(r)
    }
    const periods = [...byPeriod.keys()].sort()
    const provisional = periods.map((p) => isCurrentPeriod(p, grain))
    const stats = periods.map((p) => npsOf(byPeriod.get(p)!))

    const option: Record<string, unknown> = {
      grid: gridDefaults,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (prm: unknown) => {
          const p = (Array.isArray(prm) ? prm[0] : prm) as { dataIndex: number; axisValueLabel?: string }
          const s = stats[p.dataIndex]
          if (!s) return ''
          return `<div style="font-weight:600">${p.axisValueLabel}</div>NPS <b>${s.nps}</b> <span style="color:#898781">(n=${s.n}: ${s.promoters}P / ${s.passives}N / ${s.detractors}D)</span>`
        },
      },
      xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
      yAxis: { type: 'value', min: -100, max: 100 },
      series: [
        {
          ...barDefaults,
          name: 'NPS',
          data: periods.map((p, i) => ({
            value: stats[i].nps,
            itemStyle: {
              color: (stats[i].nps ?? 0) >= 0 ? STATUS.good : STATUS.critical,
              opacity: provisional[i] ? 0.45 : 1,
              borderRadius: (stats[i].nps ?? 0) >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3],
            },
          })),
        },
      ],
    }

    const csvRows = periods.map((p, i) => ({
      period: p,
      nps: stats[i].nps,
      responses: stats[i].n,
      promoters: stats[i].promoters,
      passives: stats[i].passives,
      detractors: stats[i].detractors,
    }))

    return { option, csvRows, periods, byPeriod, isEmpty: inRange.length === 0 }
  }, [rows, queryParams.start, queryParams.end, grain])

  const respColumns: ColumnDef<Row, unknown>[] = useMemo(
    () => [
      {
        header: 'Date',
        id: 'recorded_at',
        accessorFn: (r) => num0(r.recorded_at),
        cell: ({ row }) => fmtDateTime(new Date(num0(row.original.recorded_at) * 1000).toISOString()),
        meta: { className: 'whitespace-nowrap' },
      },
      {
        header: 'Score',
        id: 'nps',
        accessorFn: (r) => num0(r.nps),
        cell: ({ row }) => {
          const s = num0(row.original.nps)
          const b = scoreBand(s)
          return (
            <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: b.color }} title={b.label}>
              {s}
            </span>
          )
        },
        meta: { align: 'right' },
      },
      {
        header: 'Customer',
        id: 'email',
        accessorFn: (r) => String(r.email ?? ''),
        cell: ({ row }) => {
          const r = row.original
          const email = String(r.email || '—')
          const n = r.cust_orders === null || r.cust_orders === undefined ? null : num0(r.cust_orders)
          const ltv = r.cust_ltv === null || r.cust_ltv === undefined ? null : num0(r.cust_ltv)
          return (
            <span className="whitespace-nowrap">
              {email}
              {n !== null && ltv !== null && (
                <span className="text-faint" title={`${fmtInt(n)} lifetime order${n === 1 ? '' : 's'} · ${fmtK(ltv)} LTV`}>
                  {' '}· {fmtInt(n)}× / {fmtK(ltv)}
                </span>
              )}
            </span>
          )
        },
      },
      {
        header: 'Order',
        id: 'order',
        accessorFn: (r) => num0(r.order_bookings),
        cell: ({ row }) => {
          const ref = String(row.original.order_ref ?? '')
          const id = row.original.order_fcm_id
          const b = row.original.order_bookings
          if (!ref) return <span className="text-faint">—</span>
          return (
            <span className="whitespace-nowrap tabular-nums">
              {id ? (
                <a href={`${MES_URL}${id}`} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline" title="Open in MES">
                  {ref} ↗
                </a>
              ) : (
                ref
              )}
              {b !== null && b !== undefined && (
                <span className="text-faint" title="Order bookings"> · {fmtK(num0(b))}</span>
              )}
            </span>
          )
        },
      },
      {
        header: 'Comment',
        accessorKey: 'comment',
        cell: ({ row }) => {
          const v = String(row.original.comment ?? '').trim()
          return v ? (
            <span className="block max-w-[46rem] whitespace-pre-wrap break-words text-[12.5px] leading-snug">{v}</span>
          ) : (
            <span className="text-faint">—</span>
          )
        },
        meta: { className: 'w-full' },
      },
      {
        header: 'Photo',
        id: 'photo',
        cell: ({ row }) =>
          row.original.file_id ? (
            <button
              className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-accent hover:bg-page"
              onClick={() => setPhoto(row.original)}
              title={String(row.original.file_name ?? '')}
            >
              {String(row.original.file_type ?? '').startsWith('video') ? 'Video' : 'Photo'}
            </button>
          ) : null,
      },
    ],
    [],
  )

  const modalItems = modalPeriod ? (model.byPeriod.get(modalPeriod) ?? []) : []
  const fmtNps = (v: number | null) => (v === null ? '—' : String(v))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="NPS — all time"
          value={fmtNps(kpis.all.nps)}
          hint={`${fmtInt(kpis.all.n)} responses since Dec 2025 · ${fmtInt(kpis.all.promoters)}P / ${fmtInt(kpis.all.passives)}N / ${fmtInt(kpis.all.detractors)}D`}
        />
        <KpiCard
          label="NPS — trailing 30 days"
          value={fmtNps(kpis.d30.nps)}
          current={kpis.d30.nps}
          prior={kpis.prev30.nps}
          deltaLabel="vs prior 30d"
          hint={`${fmtInt(kpis.d30.n)} responses`}
        />
      </div>

      <ChartCard
        title="NPS over time"
        subtitle="Net Promoter Score per period — % promoters (9–10) minus % detractors (0–6)"
        info={{
          definition:
            'Responses to the "How likely are you to recommend Form Now" question of the Form Now Customer Order Survey (Qualtrics), bucketed by response date using the global date range and grain. NPS per period = share of promoters (9–10) minus share of detractors (0–6), from −100 to +100; the tooltip shows the response count and promoter/passive/detractor split — treat thin periods (n under ~10) as anecdotes, not trends. Click a bar to list that period\'s responses. The static cards above are all-time and trailing-30-days regardless of the range. Channel/material filters do not apply.',
          source: q.data?.meta.source ?? 'Qualtrics API',
        }}
        csvRows={model.csvRows}
        csvName="nps-trend"
        chartRef={chartRef}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        height={340}
      >
        {model.isEmpty ? (
          <EmptyState text="No survey responses in the selected date range." />
        ) : (
          <>
            <EChart
              ref={chartRef}
              option={model.option}
              height={280}
              onClick={(params) => {
                const idx = (params as { dataIndex?: number }).dataIndex
                if (idx !== undefined && model.periods[idx]) setModalPeriod(model.periods[idx])
              }}
            />
            <p className="mt-1 text-[11.5px] text-faint">
              Click a bar to see that period's responses. Newest period is provisional (faded).
            </p>
          </>
        )}
      </ChartCard>

      <ChartCard
        title="All responses"
        subtitle="Every survey response, newest first — all time"
        info={{
          definition:
            'Every response to the Form Now Customer Order Survey: score (green = promoter 9–10, amber = passive 7–8, red = detractor 0–6), respondent email annotated with lifetime orders × and LTV $ (governed bookings summed over the customer\'s non-cancelled orders, matched on the order\'s medusa email), improvement comment (hover for full text), the order it came from with its bookings $ (links to MES when the reference resolves against the warehouse — requires VPN at load time), and any uploaded photo/video (opens in a modal, streamed through the app so no Qualtrics login is needed). The Order column sorts by order $, Customer by email.',
          source: q.data?.meta.source ?? 'Qualtrics API',
        }}
        csvRows={rows}
        csvName="nps-responses"
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={rows.length === 0}
        emptyText="No survey responses yet."
        height={520}
      >
        <DataTable data={rows} columns={respColumns} initialSort={[{ id: 'recorded_at', desc: true }]} csvName="nps-responses" fit />
      </ChartCard>

      {modalPeriod && (
        <Modal title={`NPS responses — ${periodLabel(modalPeriod, grain)} (${fmtInt(modalItems.length)})`} onClose={() => setModalPeriod(null)}>
          <DataTable data={modalItems} columns={respColumns} initialSort={[{ id: 'recorded_at', desc: false }]} csvName={`nps-${modalPeriod}`} fit />
        </Modal>
      )}

      {photo && (
        <Modal
          title={`${String(photo.file_name ?? 'Attachment')} — ${String(photo.email || 'unknown')} (${fmtDate(new Date(num0(photo.recorded_at) * 1000).toISOString())})`}
          onClose={() => setPhoto(null)}
        >
          {String(photo.file_type ?? '').startsWith('video') ? (
            <video controls className="max-h-[70vh] w-full rounded-lg" src={`/api/nps_file?rid=${photo.response_id}&fid=${photo.file_id}`} />
          ) : (
            <img
              className="mx-auto max-h-[70vh] rounded-lg"
              src={`/api/nps_file?rid=${photo.response_id}&fid=${photo.file_id}`}
              alt={String(photo.file_name ?? 'uploaded photo')}
            />
          )}
        </Modal>
      )}
    </div>
  )
}
