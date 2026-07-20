import { useMemo, useRef, useState } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useFormlabsGet, useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { isCurrentPeriod, periodLabel, periodStart } from '../../lib/dates'
import { fmtDateTime, fmtInt, fmtPct, num0 } from '../../lib/format'
import { STATUS, CHANNEL_COLORS } from '../../lib/palette'
import { gridDefaults, barDefaults, stackedBarDefaults, lineDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { DataTable } from '../../components/DataTable'
import { HoverReveal } from '../../components/HoverReveal'
import { Modal } from '../../components/Modal'
import { EmptyState } from '../../components/states'
import { EChart, type EChartHandle } from '../../components/EChart'
import { Segmented } from '../../components/Segmented'
import { ratePoint, tooltipFormatter } from '../shipments/metrics'

const MES_URL = 'https://fcm-mes.formlabs.com/orders/'

type Mode = 'pct' | 'counts'

export default function RmaPage() {
  const { filters, queryParams } = useFilters()
  const grain = filters.grain
  const chartRef = useRef<EChartHandle>(null)
  const [mode, setMode] = useState<Mode>('pct')
  const [modalPeriod, setModalPeriod] = useState<string | null>(null)

  const tickets = useFormlabsGet('rma_tickets', { start: queryParams.start, end: queryParams.end }, { staleMs: 10 * 60_000 })
  const denom = useNamedQuery('bowler_rma', queryParams)

  const model = useMemo(() => {
    const tRows = (tickets.data?.rows ?? []) as Row[]
    const dRows = (denom.data?.rows ?? []) as Row[]
    const mDenom = new Map(dRows.map((r) => [String(r.period).slice(0, 10), r]))

    interface Bucket {
      fn: number
      xom: number
      items: Row[]
    }
    const byPeriod = new Map<string, Bucket>()
    for (const t of tRows) {
      const period = periodStart(new Date(num0(t.created_at) * 1000).toISOString().slice(0, 10), grain)
      let b = byPeriod.get(period)
      if (!b) byPeriod.set(period, (b = { fn: 0, xom: 0, items: [] }))
      if (t.rma_type === 'Xometry') b.xom++
      else b.fn++
      b.items.push(t)
    }

    const periodSet = new Set<string>([...byPeriod.keys(), ...mDenom.keys()])
    const periods = [...periodSet].sort()
    const provisional = periods.map((p) => isCurrentPeriod(p, grain))

    const ticketsOf = (p: string) => {
      const b = byPeriod.get(p)
      return b ? b.fn + b.xom : 0
    }
    const ordersOf = (p: string) => num0(mDenom.get(p)?.orders_shipped)
    const partLevel = (p: string): number | null => {
      const d = mDenom.get(p)
      if (!d) return null
      const shipped = num0(d.parts_shipped)
      return shipped > 0 ? num0(d.rma_parts_scored) / shipped : null
    }

    const series =
      mode === 'pct'
        ? [
            {
              ...barDefaults,
              name: 'Orders with an RMA ticket %',
              color: STATUS.serious,
              data: periods.map((p, i) => ratePoint(ticketsOf(p), ordersOf(p), provisional[i])),
            },
            {
              ...lineDefaults,
              name: 'Part-level RMA % (back-office form — lapsed 6/23)',
              color: '#898781',
              connectNulls: false,
              data: periods.map((p, i) => {
                const v = partLevel(p)
                return v === null ? null : provisional[i] ? { value: v, itemStyle: { opacity: 0.45 } } : v
              }),
            },
          ]
        : [
            {
              ...stackedBarDefaults,
              stack: 'rma',
              name: 'Form Now RMA tickets',
              color: CHANNEL_COLORS['Web - Revenue Generating'] ?? '#b99b5f',
              data: periods.map((p, i) => {
                const v = byPeriod.get(p)?.fn ?? 0
                return provisional[i] ? { value: v, itemStyle: { opacity: 0.45 } } : v
              }),
            },
            {
              ...stackedBarDefaults,
              stack: 'rma',
              name: 'Xometry RMA tickets',
              color: CHANNEL_COLORS['Xometry'] ?? '#5470c6',
              data: periods.map((p, i) => {
                const v = byPeriod.get(p)?.xom ?? 0
                return provisional[i] ? { value: v, itemStyle: { opacity: 0.45 } } : v
              }),
            },
          ]

    const fmt = mode === 'pct' ? (v: number | null | undefined) => fmtPct(v ?? null) : (v: number | null | undefined) => fmtInt(v ?? null)
    const option: Record<string, unknown> = {
      grid: gridDefaults,
      legend: { show: true, top: 0, type: 'scroll' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: tooltipFormatter(fmt) },
      xAxis: { type: 'category', data: periods.map((p) => periodLabel(p, grain)) },
      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: { formatter: mode === 'pct' ? (v: number) => `${Math.round(v * 1000) / 10}%` : (v: number) => fmtInt(v) },
      },
      series,
    }

    const csvRows = periods.map((p) => {
      const b = byPeriod.get(p)
      const d = mDenom.get(p)
      return {
        period: p,
        fn_rma_tickets: b?.fn ?? 0,
        xometry_rma_tickets: b?.xom ?? 0,
        orders_shipped: num0(d?.orders_shipped),
        parts_shipped: num0(d?.parts_shipped),
        backoffice_rma_parts_scored: num0(d?.rma_parts_scored),
      }
    })

    const totals = {
      tickets: tRows.length,
      fn: tRows.filter((t) => t.rma_type !== 'Xometry').length,
      orders: dRows.reduce((t, r) => t + num0(r.orders_shipped), 0),
    }

    return { option, csvRows, periods, byPeriod, totals, isEmpty: tRows.length === 0 && dRows.length === 0 }
  }, [tickets.data, denom.data, grain, mode])

  const ticketColumns: ColumnDef<Row, unknown>[] = useMemo(
    () => [
      {
        header: 'Created',
        id: 'created_at',
        accessorFn: (r) => num0(r.created_at),
        cell: ({ row }) => fmtDateTime(new Date(num0(row.original.created_at) * 1000).toISOString()),
        meta: { className: 'whitespace-nowrap' },
      },
      { header: 'Type', accessorKey: 'rma_type' },
      {
        header: 'Title',
        accessorKey: 'title',
        cell: ({ row }) => <HoverReveal text={String(row.original.title ?? '')} className="block max-w-[34rem] truncate" />,
        meta: { className: 'w-full' },
      },
      {
        header: 'Origin order',
        id: 'origin',
        accessorFn: (r) => num0(r.origin_order_id),
        cell: ({ row }) => {
          const id = row.original.origin_order_id
          return id ? (
            <a href={`${MES_URL}${id}`} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
              {String(id)} ↗
            </a>
          ) : (
            <span className="text-faint">—</span>
          )
        },
      },
      {
        header: 'RMA order',
        id: 'rma_order',
        accessorFn: (r) => num0(r.rma_order_id),
        cell: ({ row }) => {
          const id = row.original.rma_order_id
          return id ? (
            <a href={`${MES_URL}${id}`} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
              {String(id)} ↗
            </a>
          ) : (
            <span className="text-faint">—</span>
          )
        },
      },
      { header: 'State', accessorKey: 'state' },
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
    ],
    [],
  )

  const allTickets = (tickets.data?.rows ?? []) as Row[]
  const modalItems = modalPeriod ? (model.byPeriod.get(modalPeriod)?.items ?? []) : []

  return (
    <div className="space-y-3">
      <ChartCard
        title="RMA rate"
        subtitle="Customer-facing RMA tickets (Intercom) vs orders shipped, by period"
        info={{
          definition:
            'Order-level RMA rate: "Form Now RMA" + "Xometry RMA" Intercom tickets created in the period ÷ orders shipped that period (actual ship date). The gray line is the historical part-level rate (back-office RMA Submission form parts, quality-score filter, ÷ parts shipped) — that form lapsed on Jun 23, 2026, so the line goes quiet even though RMAs continue as tickets. Coverage caveats: the customer-facing ticket types ramped up in early 2026 (Jan–Mar undercount ~30% vs the back-office form where both ran), and tickets carry no part quantities, so order-level is the honest continuing unit. Counts mode stacks tickets by channel. Click a bar for the period\'s tickets. Global date range and grain apply; channel/material filters do not.',
          source: 'Intercom tickets + fcm_api_rmapart + fcm_api_order/orderpart',
        }}
        csvRows={model.csvRows}
        csvName="rma-rate"
        chartRef={chartRef}
        isLoading={tickets.isLoading || denom.isLoading}
        isFetching={tickets.isFetching || denom.isFetching}
        error={tickets.error ?? denom.error ?? null}
        height={360}
        actions={
          <Segmented
            size="sm"
            options={[
              { value: 'pct', label: '% of orders' },
              { value: 'counts', label: 'Counts' },
            ]}
            value={mode}
            onChange={setMode}
          />
        }
      >
        {model.isEmpty ? (
          <EmptyState text="No RMA tickets or shipments in the selected range." />
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
              Click a bar to list that period's tickets. Window: {fmtInt(model.totals.tickets)} tickets (
              {fmtInt(model.totals.fn)} Form Now / {fmtInt(model.totals.tickets - model.totals.fn)} Xometry) over{' '}
              {fmtInt(model.totals.orders)} orders shipped. Newest period is provisional (faded).
            </p>
          </>
        )}
      </ChartCard>

      <ChartCard
        title="RMA tickets"
        subtitle="Every RMA ticket in the selected range, newest first"
        info={{
          definition:
            'All "Form Now RMA" and "Xometry RMA" Intercom tickets created in the global date range: title (hover for full text), the origin order and the reprint/RMA order (both open MES in a new tab), ticket state, and a link to the ticket in Intercom.',
          source: 'Intercom tickets',
        }}
        csvRows={allTickets}
        csvName="rma-tickets"
        isLoading={tickets.isLoading}
        isFetching={tickets.isFetching}
        error={tickets.error}
        isEmpty={allTickets.length === 0}
        emptyText="No RMA tickets in the selected range."
        height={480}
      >
        <DataTable data={allTickets} columns={ticketColumns} initialSort={[{ id: 'created_at', desc: true }]} csvName="rma-tickets" fit />
      </ChartCard>

      {modalPeriod && (
        <Modal title={`RMA tickets — ${periodLabel(modalPeriod, grain)} (${fmtInt(modalItems.length)})`} onClose={() => setModalPeriod(null)}>
          <DataTable data={modalItems} columns={ticketColumns} initialSort={[{ id: 'created_at', desc: false }]} csvName={`rma-${modalPeriod}`} fit />
        </Modal>
      )}
    </div>
  )
}
