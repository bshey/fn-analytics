interface Props {
  label: string
  /** Already-formatted value ("94.2%", "$12.4k"). */
  value: string
  /** Current & prior raw numbers for the delta; omit prior to hide the delta. */
  current?: number | null
  prior?: number | null
  /** When a decrease is good (days late, stuck count). */
  invertGood?: boolean
  /** Show the delta as percentage points ("+2.1 pts") instead of a raw diff. */
  pctPoints?: boolean
  deltaLabel?: string
  hint?: string
}

export function KpiCard({ label, value, current, prior, invertGood, pctPoints, deltaLabel = 'vs prior period', hint }: Props) {
  let delta: { text: string; cls: string } | null = null
  if (current !== undefined && current !== null && prior !== undefined && prior !== null && Number.isFinite(prior)) {
    const diff = current - prior
    const eps = pctPoints ? 0.0005 : Math.abs(prior) * 0.002
    const good = invertGood ? diff < 0 : diff > 0
    const cls = Math.abs(diff) <= eps ? 'text-sub' : good ? 'text-good' : 'text-bad'
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '—'
    const mag = pctPoints ? `${Math.abs(diff * 100).toFixed(1)} pts` : Math.abs(diff) >= 100 ? Math.round(Math.abs(diff)).toLocaleString() : Math.abs(diff).toFixed(1)
    delta = { text: `${arrow} ${mag} ${deltaLabel}`, cls }
  }
  return (
    <div className="card px-4 py-3.5" title={hint}>
      <div className="label-xs">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {delta && <div className={`mt-0.5 text-[12px] ${delta.cls}`}>{delta.text}</div>}
    </div>
  )
}
