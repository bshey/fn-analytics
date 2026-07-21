import { useEffect, useMemo, useState } from 'react'
import { useNamedQuery, type Row } from '../../lib/api'
import { useFilters } from '../../lib/filters'
import { fmtInt, fmtNum, fmtPct, num0 } from '../../lib/format'
import { ChartCard } from '../../components/ChartCard'
import { KpiCard } from '../../components/KpiCard'
import { Segmented } from '../../components/Segmented'
import { EmptyState } from '../../components/states'

// ---------------------------------------------------------------------------
// Lead Time Tuner — edit the quoting tier config, benchmark against actual
// ship performance over the globally-selected submit window, and simulate the
// outcome before touching MES. All math is client-side and instant.
// ---------------------------------------------------------------------------

interface TierRow {
  max: number
  days: number
}
interface MatAdj {
  code: string
  days: number
}
interface LtConfig {
  slaCount: TierRow[]
  slaVol: TierRow[]
  slsCount: TierRow[]
  slsVol: TierRow[]
  matAdj: MatAdj[]
  largeMm: number
  largeDays: number
}

/**
 * MES Quoting Configuration v10 (active Jul 18, 2026). Material codes use the
 * WAREHOUSE spellings (FLTO1502/FLTO1511/FLGPCO05 with letter O) — the MES
 * config screen shows FLT01502/FLT01511/FLGPC005 with zeros, which match no
 * shipped order ever; verify the engine's matching and fix the MES side.
 * Sanding (+1) is omitted: no Form Now order carries a sanding value.
 */
const V10: LtConfig = {
  slaCount: [
    { max: 1, days: 1 },
    { max: 2, days: 2 },
    { max: 9, days: 4 },
    { max: 18, days: 5 },
  ],
  slaVol: [
    { max: 50, days: 1 },
    { max: 100, days: 2 },
    { max: 310, days: 4 },
    { max: 679, days: 5 },
  ],
  slsCount: [
    { max: 1, days: 3 },
    { max: 16, days: 5 },
    { max: 50, days: 7 },
    { max: 271, days: 9 },
    { max: 504, days: 11 },
  ],
  slsVol: [
    { max: 50, days: 3 },
    { max: 800, days: 5 },
    { max: 1670, days: 7 },
    { max: 4149, days: 9 },
  ],
  matAdj: [
    { code: 'FLP12W01', days: 1 },
    { code: 'FLPA1101', days: 1 },
    { code: 'FLP11B01', days: 2 },
    { code: 'FLHTAM02', days: 1 },
    { code: 'FLFL8011', days: 2 },
    { code: 'FLELCL02', days: 2 },
    { code: 'FLRG1011', days: 1 },
    { code: 'FLFRGR01', days: 42 },
    { code: 'FLTO1502', days: 1 },
    { code: 'FLTO1511', days: 1 },
    { code: 'FLGPCO05', days: 2 },
    { code: 'FLP12T01', days: 1 },
  ],
  largeMm: 200,
  largeDays: 1,
}

const CONFIG_KEY = 'leadtime-tuner-config-v1'

function loadConfig(): LtConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* fall through */
  }
  return JSON.parse(JSON.stringify(V10))
}

/** Tier lookup: smallest row whose max >= v; overflow uses the top row's days. */
function tierIdx(rows: TierRow[], v: number): number {
  for (let i = 0; i < rows.length; i++) if (v <= rows[i].max) return i
  return rows.length - 1 // overflow — engine behavior above the top tier is unverified
}

interface Line {
  family: 'SLA' | 'SLS'
  qty: number
  vol: number
  material: string
  maxDim: number
}
interface Order {
  id: number
  submitted: string
  shipped: boolean
  actual: number | null
  quoted: number
  lines: Line[]
}

interface QuoteResult {
  days: number
  tierKey: string // constraining line's base tier, e.g. "SLA|count|2" / "SLS|tie|1"
  overflow: boolean
}

function quoteOrder(o: Order, cfg: LtConfig): QuoteResult {
  const adjMap = new Map(cfg.matAdj.map((m) => [m.code, m.days]))
  let best = -1
  let bestKey = ''
  let overflow = false
  for (const l of o.lines) {
    const counts = l.family === 'SLS' ? cfg.slsCount : cfg.slaCount
    const vols = l.family === 'SLS' ? cfg.slsVol : cfg.slaVol
    const ci = tierIdx(counts, l.qty)
    const vi = tierIdx(vols, l.vol)
    const cd = counts[ci]?.days ?? 0
    const vd = vols[vi]?.days ?? 0
    const base = Math.max(cd, vd)
    const adj = (adjMap.get(l.material) ?? 0) + (l.maxDim > cfg.largeMm ? cfg.largeDays : 0)
    const days = base + adj
    if (days > best) {
      best = days
      const basis = cd === vd ? 'tie' : cd > vd ? 'count' : 'vol'
      const idx = cd >= vd ? ci : vi
      bestKey = `${l.family}|${basis}|${idx}`
      overflow =
        (l.qty > counts[counts.length - 1].max && cd >= vd) || (l.vol > vols[vols.length - 1].max && vd >= cd)
    }
  }
  return { days: Math.max(0, best), tierKey: bestKey, overflow }
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

const PCTS = [
  { value: '0.75', label: 'P75' },
  { value: '0.8', label: 'P80' },
  { value: '0.85', label: 'P85' },
  { value: '0.9', label: 'P90' },
]

export default function LeadTimePage() {
  const { queryParams } = useFilters()
  const q = useNamedQuery('leadtime_lines', queryParams)

  const [cfg, setCfg] = useState<LtConfig>(loadConfig)
  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
  }, [cfg])
  const [pct, setPct] = useState('0.8')

  const orders = useMemo((): { orders: Order[]; excludedShortage: number } => {
    const byId = new Map<number, Order>()
    for (const r of (q.data?.rows ?? []) as Row[]) {
      const id = num0(r.order_id)
      let o = byId.get(id)
      if (!o) {
        byId.set(
          id,
          (o = {
            id,
            submitted: String(r.submitted),
            shipped: !!r.shipped,
            actual: r.actual_bizdays === null || r.actual_bizdays === undefined ? null : num0(r.actual_bizdays),
            quoted: num0(r.quoted_bizdays),
            lines: [],
          }),
        )
      }
      o.lines.push({
        family: r.family === 'SLS' ? 'SLS' : 'SLA',
        qty: num0(r.qty),
        vol: num0(r.line_volume_ml),
        material: String(r.material ?? ''),
        maxDim: num0(r.max_dim_mm),
      })
    }
    const all = [...byId.values()]
    // FLFRGR01's +42 shortage adder makes those orders policy outliers, not
    // production signal — exclude from calibration entirely.
    const excluded = all.filter((o) => o.lines.some((l) => l.material === 'FLFRGR01'))
    return { orders: all.filter((o) => !excluded.includes(o)), excludedShortage: excluded.length }
  }, [q.data])

  const model = useMemo(() => {
    const target = Number(pct)
    const list = orders.orders
    const shipped = list.filter((o) => o.shipped && o.actual !== null)
    const settled = list.length ? shipped.length / list.length : 0

    // Bucket shipped orders by their constraining base tier under the CURRENT config.
    interface Bucket {
      actuals: number[]
      overflow: number
    }
    const buckets = new Map<string, Bucket>()
    for (const o of shipped) {
      const qr = quoteOrder(o, cfg)
      let b = buckets.get(qr.tierKey)
      if (!b) buckets.set(qr.tierKey, (b = { actuals: [], overflow: 0 }))
      b.actuals.push(o.actual!)
      if (qr.overflow) b.overflow++
    }

    // Tier table rows with recommendations.
    interface TierView {
      key: string
      family: 'SLA' | 'SLS'
      basis: 'count' | 'vol' | 'tie'
      idx: number
      label: string
      current: number
      n: number
      p50: number | null
      p80: number | null
      p90: number | null
      rec: number | null
    }
    const tierViews: TierView[] = []
    const families: ['SLA' | 'SLS', TierRow[], TierRow[]][] = [
      ['SLA', cfg.slaCount, cfg.slaVol],
      ['SLS', cfg.slsCount, cfg.slsVol],
    ]
    for (const [family, counts, vols] of families) {
      for (const [basis, rows] of [
        ['count', counts],
        ['vol', vols],
        ['tie', counts],
      ] as ['count' | 'vol' | 'tie', TierRow[]][]) {
        rows.forEach((row, idx) => {
          const key = `${family}|${basis}|${idx}`
          const b = buckets.get(key)
          const sorted = b ? [...b.actuals].sort((x, y) => x - y) : []
          const rec = sorted.length >= 3 ? Math.max(1, Math.ceil(quantile(sorted, target))) : null
          tierViews.push({
            key,
            family,
            basis,
            idx,
            label:
              basis === 'tie'
                ? `≤${row.max} parts (count = volume tie)`
                : basis === 'count'
                  ? `≤${row.max} parts`
                  : `≤${fmtInt(row.max)} mL`,
            current: row.days,
            n: sorted.length,
            p50: sorted.length ? quantile(sorted, 0.5) : null,
            p80: sorted.length ? quantile(sorted, 0.8) : null,
            p90: sorted.length ? quantile(sorted, 0.9) : null,
            rec,
          })
        })
      }
    }

    // Simulation: current (V10) vs proposed (cfg) quotes against actuals.
    const sim = (config: LtConfig) => {
      let onTime = 0
      let quoteSum = 0
      for (const o of shipped) {
        const days = quoteOrder(o, config).days
        quoteSum += days
        if (o.actual! <= days) onTime++
      }
      return { ots: shipped.length ? onTime / shipped.length : null, avgQuote: shipped.length ? quoteSum / shipped.length : null }
    }
    const simProposed = sim(cfg)
    const simCurrent = sim(V10)

    // Actual observed promise performance (quoted_bizdays from ship_by) as reality anchor.
    const realOnTime = shipped.length ? shipped.filter((o) => o.actual! <= o.quoted).length / shipped.length : null
    const realAvgQuote = shipped.length ? shipped.reduce((t, o) => t + o.quoted, 0) / shipped.length : null

    let shorter = 0
    let longer = 0
    for (const o of shipped) {
      const a = quoteOrder(o, cfg).days
      const b = quoteOrder(o, V10).days
      if (a < b) shorter++
      else if (a > b) longer++
    }

    return { shipped: shipped.length, total: list.length, settled, tierViews, simProposed, simCurrent, realOnTime, realAvgQuote, shorter, longer }
  }, [orders, cfg, pct])

  const setTier = (family: 'SLA' | 'SLS', basis: 'count' | 'vol', idx: number, patch: Partial<TierRow>) => {
    setCfg((c) => {
      const next = JSON.parse(JSON.stringify(c)) as LtConfig
      const rows = family === 'SLA' ? (basis === 'count' ? next.slaCount : next.slaVol) : basis === 'count' ? next.slsCount : next.slsVol
      rows[idx] = { ...rows[idx], ...patch }
      return next
    })
  }

  const applyRecs = () => {
    setCfg((c) => {
      const next = JSON.parse(JSON.stringify(c)) as LtConfig
      for (const t of model.tierViews) {
        if (t.rec === null || t.basis === 'tie') continue
        const rows = t.family === 'SLA' ? (t.basis === 'count' ? next.slaCount : next.slaVol) : t.basis === 'count' ? next.slsCount : next.slsVol
        if (rows[t.idx]) rows[t.idx].days = t.rec
      }
      return next
    })
  }

  const dirty = JSON.stringify(cfg) !== JSON.stringify(V10)
  const numInput = (value: number, onChange: (v: number) => void, width = 'w-16') => (
    <input
      type="number"
      value={value}
      min={0}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (Number.isFinite(v) && v >= 0) onChange(v)
      }}
      className={`${width} rounded-md border border-line px-1.5 py-0.5 text-center text-[12px] tabular-nums`}
    />
  )

  const tierEditor = (family: 'SLA' | 'SLS', basis: 'count' | 'vol', rows: TierRow[]) => (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="text-[10.5px] uppercase tracking-wide text-sub">
          <th className="px-2 py-1 text-left">{basis === 'count' ? 'Max parts' : 'Max mL'}</th>
          <th className="px-2 py-1 text-center">Days</th>
          <th className="px-2 py-1 text-center" title="Recommendation at the selected percentile from this window's orders constrained by this tier">Rec</th>
          <th className="px-2 py-1 text-right">n · P50/P80/P90</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => {
          const t = model.tierViews.find((v) => v.family === family && v.basis === basis && v.idx === idx)
          const danger = t && t.p80 !== null && row.days < t.p80
          const slack = t && t.p90 !== null && row.days > t.p90 + 1
          return (
            <tr key={idx} className="border-t border-line/60">
              <td className="px-2 py-1">{numInput(row.max, (v) => setTier(family, basis, idx, { max: v }), 'w-20')}</td>
              <td className="px-2 py-1 text-center">{numInput(row.days, (v) => setTier(family, basis, idx, { days: v }))}</td>
              <td className="px-2 py-1 text-center">
                {t?.rec !== null && t?.rec !== undefined ? (
                  <button
                    className={`rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${
                      t.rec < row.days ? 'bg-green-100 text-green-900' : t.rec > row.days ? 'bg-red-100 text-red-900' : 'bg-black/5 text-sub'
                    }`}
                    onClick={() => setTier(family, basis, idx, { days: t.rec! })}
                    title="Click to apply this recommendation"
                  >
                    {t.rec}
                  </button>
                ) : (
                  <span className="text-faint" title="Fewer than 3 constrained orders in this window">—</span>
                )}
              </td>
              <td className={`whitespace-nowrap px-2 py-1 text-right tabular-nums ${danger ? 'text-bad' : slack ? 'text-good' : 'text-sub'}`}>
                {t && t.n > 0 ? `${t.n} · ${t.p50}/${t.p80}/${t.p90}` : '0'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  const ties = model.tierViews.filter((t) => t.basis === 'tie' && t.n > 0)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard
          label="Benchmark cohort"
          value={fmtInt(model.total)}
          hint={`orders submitted in window · ${fmtPct(model.settled)} shipped${orders.excludedShortage ? ` · ${orders.excludedShortage} FLFRGR01 excluded` : ''}`}
        />
        <KpiCard
          label="Actual OTS (real quotes)"
          value={model.realOnTime !== null ? fmtPct(model.realOnTime) : '—'}
          hint={`avg real quote ${model.realAvgQuote !== null ? fmtNum(model.realAvgQuote, 1) : '—'} biz days`}
        />
        <KpiCard
          label="Simulated OTS — v10 config"
          value={model.simCurrent.ots !== null ? fmtPct(model.simCurrent.ots) : '—'}
          hint={`avg quote ${model.simCurrent.avgQuote !== null ? fmtNum(model.simCurrent.avgQuote, 1) : '—'} biz days`}
        />
        <KpiCard
          label="Simulated OTS — proposed"
          value={model.simProposed.ots !== null ? fmtPct(model.simProposed.ots) : '—'}
          current={model.simProposed.ots}
          prior={model.simCurrent.ots}
          pctPoints
          deltaLabel="vs v10"
          hint={`avg quote ${model.simProposed.avgQuote !== null ? fmtNum(model.simProposed.avgQuote, 1) : '—'} biz days`}
        />
        <KpiCard
          label="Orders quoted shorter"
          value={fmtInt(model.shorter)}
          hint={`${fmtInt(model.longer)} longer than v10 under proposal`}
        />
      </div>

      {model.settled < 0.9 && model.total > 0 && (
        <p className="rounded-md border border-warn/30 bg-amber-50 px-3 py-1.5 text-[12px] text-warn">
          Only {fmtPct(model.settled)} of this window's orders have shipped — the unshipped tail is disproportionately
          the SLOW orders, so percentiles and recommendations read optimistically fast. Widen the window or wait for the
          cohort to settle before acting on recommendations.
        </p>
      )}

      <ChartCard
        title="Lead Time Tuner"
        subtitle="Edit the tier config, benchmark against the selected window's actual ship performance, simulate before touching MES"
        info={{
          definition:
            'Replicates the MES quoting engine per line item — MAX(part-count tier, volume tier) for the line\'s family, plus material and large-part adjustments; the order\'s quote is its worst line, and overflow beyond the top tier uses the top tier\'s days (engine behavior there is unverified). The benchmark cohort is orders SUBMITTED in the global date range — pick last week when caught up, or a wider stable range. Recommendations per tier = the selected percentile of actual production business days (Mon–Fri) over the orders that tier constrains under the current editor config (minimum 3 orders). Simulated OTS replays every shipped order against a config in production-days space; day-boundary conventions (~noon ET submission cutoff) cancel when comparing configs, and ~10% of real quotes carry manual overrides the simulator can\'t see. Tie rows (count and volume tiers produce equal days — ~40% of orders) can\'t be changed by one table alone. Material codes use warehouse spellings — the MES config screen shows FLT01502/FLT01511/FLGPC005 with zeros, which match no order ever; verify in MES. Sanding is omitted (never fires on Form Now). FLFRGR01 (+42) orders are excluded from calibration.',
          source: q.data?.meta.source ?? 'fcm_api_order/orderpart/partfile (Form Now)',
        }}
        isLoading={q.isLoading}
        isFetching={q.isFetching}
        error={q.error}
        height={620}
        actions={
          <>
            <span className="text-[11px] text-faint">Target</span>
            <Segmented size="sm" options={PCTS} value={pct} onChange={setPct} />
            <button className="btn !px-2 !py-1 text-[11.5px]" onClick={applyRecs} title="Set every tier's days to its recommendation">
              Apply all recs
            </button>
            <button
              className="btn !px-2 !py-1 text-[11.5px]"
              onClick={() => setCfg(JSON.parse(JSON.stringify(V10)))}
              disabled={!dirty}
              title="Reset the editor to the active MES config (v10)"
            >
              Reset to v10
            </button>
          </>
        }
      >
        {model.total === 0 && !q.isLoading ? (
          <EmptyState text="No Form Now orders submitted in the selected window." />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-3">
              <h4 className="text-[12.5px] font-semibold">SLA thresholds</h4>
              <div className="rounded-lg border border-line p-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-sub">Part count</div>
                {tierEditor('SLA', 'count', cfg.slaCount)}
              </div>
              <div className="rounded-lg border border-line p-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-sub">Volume mL (per line item)</div>
                {tierEditor('SLA', 'vol', cfg.slaVol)}
              </div>
              <h4 className="pt-1 text-[12.5px] font-semibold">SLS thresholds</h4>
              <div className="rounded-lg border border-line p-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-sub">Part count</div>
                {tierEditor('SLS', 'count', cfg.slsCount)}
              </div>
              <div className="rounded-lg border border-line p-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-sub">Volume mL (per line item)</div>
                {tierEditor('SLS', 'vol', cfg.slsVol)}
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="text-[12.5px] font-semibold">Risk adjustments</h4>
              <div className="rounded-lg border border-line p-2">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="text-[10.5px] uppercase tracking-wide text-sub">
                      <th className="px-2 py-1 text-left">Material</th>
                      <th className="px-2 py-1 text-center">+Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfg.matAdj.map((m, i) => (
                      <tr key={m.code} className="border-t border-line/60">
                        <td className="px-2 py-1 font-mono text-[11.5px]">{m.code}</td>
                        <td className="px-2 py-1 text-center">
                          {numInput(m.days, (v) =>
                            setCfg((c) => {
                              const next = JSON.parse(JSON.stringify(c)) as LtConfig
                              next.matAdj[i].days = v
                              return next
                            }),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 flex items-center gap-2 border-t border-line/60 px-2 pt-2 text-[12px]">
                  <span>Large part &gt;</span>
                  {numInput(cfg.largeMm, (v) => setCfg((c) => ({ ...c, largeMm: v })), 'w-20')}
                  <span>mm →</span>
                  {numInput(cfg.largeDays, (v) => setCfg((c) => ({ ...c, largeDays: v })))}
                  <span>days</span>
                </div>
              </div>
              {ties.length > 0 && (
                <div className="rounded-lg border border-line p-2">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-sub" title="Orders whose count and volume tiers produce the same days — lowering one table alone won't change these quotes">
                    Count/volume ties (change BOTH tables to move these)
                  </div>
                  <table className="w-full border-collapse text-[12px]">
                    <tbody>
                      {ties.map((t) => (
                        <tr key={t.key} className="border-t border-line/60">
                          <td className="px-2 py-1">{t.family} · {t.label}</td>
                          <td className="px-2 py-1 text-center">{t.current}d now · rec {t.rec ?? '—'}</td>
                          <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-sub">{t.n} · {t.p50}/{t.p80}/{t.p90}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11.5px] leading-snug text-faint">
                Red n·P50/P80/P90 = current days below this window's P80 (quote is underwater). Green = more than a day
                of slack beyond P90 (cut candidate). Rec buttons apply one tier; "Apply all recs" applies every
                non-tie tier at the selected percentile. Edits live in this browser only — transcribe final values
                into MES Config → Quoting and save a new version there.
              </p>
            </div>
          </div>
        )}
      </ChartCard>
    </div>
  )
}
