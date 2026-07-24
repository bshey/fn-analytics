import { useMemo, useRef } from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { fmtInt, fmtMoneyExact, fmtPct, num0 } from '../../lib/format'
import { CATEGORICAL } from '../../lib/palette'
import { gridDefaults, barDefaults, lineDefaults } from '../../lib/echarts'
import { ChartCard } from '../../components/ChartCard'
import { DataTable } from '../../components/DataTable'
import { KpiCard } from '../../components/KpiCard'
import { EChart, type EChartHandle } from '../../components/EChart'

/**
 * Module H — Customers: revenue concentration. Governed order-time bookings
 * grouped by customer; Xometry rides as ONE counterparty (deselect its channel
 * for a direct-only view). Global date range + channel filter apply; grain and
 * material/type filters do not (noted in the ⓘ).
 */

const TOP_BARS = 20

interface Cust {
  rank: number
  email: string
  company: string
  channels: string
  bookings: number
  share: number
  cumShare: number
  n_orders: number
  first_order: string
  last_order: string
}

const displayName = (c: { company: string; email: string }) =>
  c.company || (c.email === '__xometry__' ? 'Xometry (marketplace)' : c.email)

export default function CustomersPage() {
  const { queryParams } = useFilters()
  const chartRef = useRef<EChartHandle>(null)
  const q = useNamedQuery('customer_concentration', queryParams)

  const model = useMemo(() => {
    const raw = ((q.data?.rows ?? []) as Row[])
      .map((r) => ({
        email: String(r.email ?? ''),
        company: String(r.company ?? ''),
        channels: String(r.channels ?? ''),
        bookings: num0(r.bookings),
        n_orders: num0(r.n_orders),
        first_order: String(r.first_order ?? ''),
        last_order: String(r.last_order ?? ''),
      }))
      .sort((a, b) => b.bookings - a.bookings)
    const total = raw.reduce((t, r) => t + r.bookings, 0)
    let cum = 0
    const custs: Cust[] = raw.map((r, i) => {
      cum += r.bookings
      return { ...r, rank: i + 1, share: total > 0 ? r.bookings / total : 0, cumShare: total > 0 ? cum / total : 0 }
    })
    const topShare = (n: number) => (custs.length ? custs[Math.min(n, custs.length) - 1].cumShare : null)

    const top = custs.slice(0, TOP_BARS)
    const option: Record<string, unknown> = {
      grid: { ...gridDefaults, bottom: 78 },
      legend: { show: true, top: 0 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = params as Array<{ dataIndex: number }>
          const c = top[arr[0]?.dataIndex]
          if (!c) return ''
          return (
            `<div style="font-weight:600;margin-bottom:2px">#${c.rank} ${displayName(c)}</div>` +
            `${fmtMoneyExact(c.bookings)} · ${fmtPct(c.share)} of revenue<br/>` +
            `cumulative top ${c.rank}: ${fmtPct(c.cumShare)} · ${fmtInt(c.n_orders)} order${c.n_orders === 1 ? '' : 's'}`
          )
        },
      },
      xAxis: {
        type: 'category',
        data: top.map((c) => displayName(c)),
        axisLabel: { rotate: 38, fontSize: 10.5, width: 110, overflow: 'truncate' },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` },
      },
      series: [
        { ...barDefaults, name: '% of revenue', color: CATEGORICAL[0], data: top.map((c) => c.share) },
        { ...lineDefaults, name: 'Cumulative %', color: CATEGORICAL[2], data: top.map((c) => c.cumShare) },
      ],
    }

    const csvRows = custs.map((c) => ({
      rank: c.rank,
      customer: displayName(c),
      email: c.email === '__xometry__' ? '' : c.email,
      channels: c.channels,
      bookings: Math.round(c.bookings * 100) / 100,
      pct_of_revenue: Math.round(c.share * 10000) / 100,
      cumulative_pct: Math.round(c.cumShare * 10000) / 100,
      orders: c.n_orders,
      first_order: c.first_order,
      last_order: c.last_order,
    }))

    return { custs, total, topShare, option, csvRows, isEmpty: custs.length === 0 }
  }, [q.data])

  const columns: ColumnDef<Cust, unknown>[] = useMemo(
    () => [
      { header: '#', accessorKey: 'rank', meta: { align: 'right' } },
      {
        header: 'Customer',
        id: 'customer',
        accessorFn: (r) => displayName(r),
        cell: ({ row }) => (
          <div className="max-w-[24rem]">
            <div className="truncate font-medium">{displayName(row.original)}</div>
            {row.original.email !== '__xometry__' && row.original.company && (
              <div className="truncate text-[11px] text-sub">{row.original.email}</div>
            )}
          </div>
        ),
        meta: { className: 'w-full' },
      },
      { header: 'Channels', accessorKey: 'channels', cell: ({ row }) => <span className="text-[11.5px]">{row.original.channels}</span> },
      {
        header: 'Bookings',
        accessorKey: 'bookings',
        cell: ({ row }) => fmtMoneyExact(row.original.bookings),
        meta: { align: 'right' },
      },
      { header: '% of rev', accessorKey: 'share', cell: ({ row }) => fmtPct(row.original.share), meta: { align: 'right' } },
      { header: 'Cum %', accessorKey: 'cumShare', cell: ({ row }) => fmtPct(row.original.cumShare), meta: { align: 'right' } },
      { header: 'Orders', accessorKey: 'n_orders', cell: ({ row }) => fmtInt(row.original.n_orders), meta: { align: 'right' } },
      { header: 'First order', accessorKey: 'first_order', meta: { className: 'whitespace-nowrap' } },
      { header: 'Last order', accessorKey: 'last_order', meta: { className: 'whitespace-nowrap' } },
    ],
    [],
  )

  const info = {
    definition:
      'Revenue concentration by customer: governed order-time bookings (submitted-date cohort, QUOTING excluded — same rules as the explorer, ties Looker) grouped by ordering email; company is the shipping name. Xometry is folded into ONE synthetic customer — it is a single paying counterparty, which is what concentration risk measures; deselect the Xometry channel for a direct-customer-only view. With NO channel filter the scope defaults to revenue-generating channels only (Web-RG, PreForm-RG, Xometry). Top-N share = the cumulative % of window revenue booked by the N largest customers. Caveats: a company ordering under several emails splits into several rows; grain and material/mfg-type filters do not apply here.',
    source: q.data?.meta.source ?? 'fcm_api_order (+ medusa order/coupons)',
  }

  const t = model.topShare
  const loading = q.isLoading
  const val = (s: string) => (loading ? '…' : s)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Revenue (bookings)" value={val(fmtMoneyExact(model.total))} hint="Governed order-time bookings in the window, current channel scope." />
        <KpiCard label="Customers" value={val(fmtInt(model.custs.length))} hint="Paying customers with ≥1 order in the window (Xometry counts as one)." />
        <KpiCard label="Top 1 share" value={val(fmtPct(t(1)))} hint="Largest customer's share of window revenue." />
        <KpiCard label="Top 3 share" value={val(fmtPct(t(3)))} />
        <KpiCard label="Top 5 share" value={val(fmtPct(t(5)))} />
        <KpiCard label="Top 10 share" value={val(fmtPct(t(10)))} />
      </div>

      <ChartCard
        title="Customer concentration"
        subtitle={`Top ${TOP_BARS} customers — individual and cumulative share of window revenue`}
        info={info}
        csvRows={model.csvRows}
        csvName="customer-concentration"
        chartRef={chartRef}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={model.isEmpty}
        emptyText="No customers in the selected range."
        height={380}
      >
        <EChart ref={chartRef} option={model.option} height={360} />
      </ChartCard>

      <ChartCard
        title="Customers"
        subtitle="Every customer in the window, largest first"
        info={info}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        isEmpty={model.isEmpty}
        emptyText="No customers in the selected range."
        height={480}
      >
        <DataTable
          data={model.custs}
          columns={columns}
          initialSort={[{ id: 'bookings', desc: true }]}
          csvName="customers"
          csvRows={model.csvRows}
          maxRows={300}
          fit
        />
        {model.custs.length > 300 && (
          <p className="mt-1 text-[11.5px] text-faint">Showing the top 300 of {fmtInt(model.custs.length)} customers — the CSV export includes everyone.</p>
        )}
      </ChartCard>
    </div>
  )
}
