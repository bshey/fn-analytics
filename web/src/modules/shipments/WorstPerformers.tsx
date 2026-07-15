import { useDims, useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { fmtInt, fmtPct } from '../../lib/format'
import { ChartCard } from '../../components/ChartCard'
import { SHIP_FIELDS, materialLabeler, pivotRows } from './metrics'

const MIN_DUE = 10

interface Worst {
  label: string
  pct: number
  n: number
}

function worstOf(rows: Row[], labelOf: (r: Row) => string): Worst | null {
  const { byLabel } = pivotRows(rows, SHIP_FIELDS, labelOf)
  let worst: Worst | null = null
  for (const [label, s] of byLabel) {
    // OTS convention: denominator = all orders due; unshipped count as not on time.
    const n = s.orders_due ?? 0
    if (n < MIN_DUE) continue
    const pct = (s.on_time ?? 0) / n
    if (!worst || pct < worst.pct) worst = { label, pct, n }
  }
  return worst
}

function pctCls(pct: number): string {
  return pct >= 0.9 ? 'text-good' : pct >= 0.7 ? 'text-warn' : 'text-bad'
}

/** A2 — callout: the worst on-time % this window by channel, material, and mfg type. */
export function WorstPerformers() {
  const { queryParams } = useFilters()
  const dims = useDims()

  const byChannel = useNamedQuery('shipments_explorer', { ...queryParams, breakdown: 'reporting_category' })
  const byMaterial = useNamedQuery('shipments_explorer', { ...queryParams, breakdown: 'materials' })
  const byType = useNamedQuery('shipments_explorer', { ...queryParams, breakdown: 'manufacturing_types' })

  const matLabel = materialLabeler(dims.data?.materials)
  const ident = (r: Row) => String(r.breakdown ?? 'Unknown')
  const groups: { dim: string; q: typeof byChannel; worst: Worst | null }[] = [
    { dim: 'By channel', q: byChannel, worst: worstOf((byChannel.data?.rows ?? []) as Row[], ident) },
    { dim: 'By material', q: byMaterial, worst: worstOf((byMaterial.data?.rows ?? []) as Row[], (r) => matLabel(String(r.breakdown ?? ''))) },
    { dim: 'By mfg type', q: byType, worst: worstOf((byType.data?.rows ?? []) as Row[], ident) },
  ]

  const isLoading = groups.some((g) => g.q.isLoading)
  const error = groups.find((g) => g.q.error)?.q.error ?? null
  const isEmpty = !isLoading && !error && groups.every((g) => (g.q.data?.rows?.length ?? 0) === 0)

  return (
    <ChartCard
      title="Worst on-time performers"
      subtitle={`Lowest on-time ship % this window per dimension (groups with ≥ ${MIN_DUE} orders due)`}
      info={{
        definition:
          `For each dimension (channel, material, manufacturing type), the group with the lowest window on-time ship % = SUM(shipped on time) ÷ SUM(ALL orders due), considering only groups with at least ${MIN_DUE} orders due. Unshipped orders count as not on time, so windows including recent due dates read low until those orders ship. Material combos on one order roll up as 'Mixed'. Rates are re-derived from summed counts.`,
        source: byChannel.data?.meta.source ?? 'formlabs-data-sandbox.fcm.v_shipments_kpi',
      }}
      isLoading={isLoading}
      isFetching={groups.some((g) => g.q.isFetching)}
      error={error}
      isEmpty={isEmpty}
      emptyText="No shipped orders in the selected filters."
      height={120}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {groups.map((g) => (
          <div key={g.dim} className="rounded-lg border border-line bg-page/60 px-3 py-2.5">
            <div className="label-xs">{g.dim}</div>
            {g.worst ? (
              <>
                <div className="mt-1 truncate text-[13px] font-medium" title={g.worst.label}>
                  {g.worst.label}
                </div>
                <div className="mt-0.5 text-[12.5px]">
                  <span className={`font-semibold tabular-nums ${pctCls(g.worst.pct)}`}>{fmtPct(g.worst.pct)}</span>
                  <span className="text-sub"> on-time · n={fmtInt(g.worst.n)}</span>
                </div>
              </>
            ) : (
              <div className="mt-1 text-[12.5px] text-faint">No group with ≥ {MIN_DUE} orders due.</div>
            )}
          </div>
        ))}
      </div>
    </ChartCard>
  )
}
