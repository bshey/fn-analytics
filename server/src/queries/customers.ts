import type { QueryRegistry, Row } from '../registry.js'
import { classifiedOrdersCTEs, classifiedChannelFilter, governedBookingsExpr, sqlDate, zBaseFilters } from '../sql.js'
import { rng } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module H — Customers. One row per paying customer over the window with
// governed order-time bookings, for concentration analysis. Xometry is folded
// into ONE synthetic customer ("Xometry marketplace"): its orders arrive under
// Formlabs intake accounts and the end customers are hidden, but more to the
// point Xometry is a single paying counterparty — which is exactly what
// concentration risk is about. Deselect the Xometry channel for a direct-only
// view. Customers are keyed by ordering email (company = shipping name), so a
// company ordering under several emails splits into several rows.
// ---------------------------------------------------------------------------

const RG_CHANNELS = ['Web - Revenue Generating', 'PreForm - Revenue Generating', 'Xometry']

export const customerQueries: QueryRegistry = {
  customer_concentration: {
    description:
      'Per-customer governed order-time bookings over the window (submitted-date cohort, QUOTING excluded — same bookings rules as the explorer, ties Looker). Customers are keyed by ordering email; company is the most descriptive shipping company name seen. Xometry orders fold into one synthetic "Xometry (marketplace)" customer — a single paying counterparty. With no channel filter the scope defaults to REVENUE-GENERATING channels only (Web-RG, PreForm-RG, Xometry); select channels explicitly to widen or narrow. Material/mfg-type filters and grain do not apply.',
    source: 'fcm_api_order (+ medusa order/coupons for channel & bookings)',
    params: zBaseFilters,
    sql: (p, ctx) => {
      const sentinel = ctx.exclusions.revenueSentinelBillingId
      const channelCond = p.channels.length
        ? classifiedChannelFilter(p.channels, 'c')
        : `AND c.reporting_category IN (${RG_CHANNELS.map((c) => `'${c}'`).join(', ')})`
      return `
WITH ${classifiedOrdersCTEs(
        `o.status != 'QUOTING' AND o.submitted_at IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}`,
        sentinel,
      )},
scoped AS (
  SELECT
    IF(c.reporting_category = 'Xometry', '__xometry__',
       LOWER(COALESCE(NULLIF(c.email, ''), NULLIF(c.medusa_email, ''), 'unknown'))) AS cust,
    IF(c.reporting_category = 'Xometry', 'Xometry (marketplace)', IFNULL(c.shipping_company_name, '')) AS company,
    c.reporting_category,
    DATE(c.submitted_at) AS d,
    ${governedBookingsExpr('c', sentinel)} AS b
  FROM classified c
  WHERE TRUE ${channelCond}
)
SELECT
  cust AS email,
  ANY_VALUE(company HAVING MAX LENGTH(company)) AS company,
  STRING_AGG(DISTINCT reporting_category ORDER BY reporting_category) AS channels,
  ROUND(SUM(b), 2) AS bookings,
  COUNT(*) AS n_orders,
  CAST(MIN(d) AS STRING) AS first_order,
  CAST(MAX(d) AS STRING) AS last_order
FROM scoped
GROUP BY cust
ORDER BY bookings DESC
LIMIT 5000`
    },
    mock: (p) => {
      const r = rng(`cust:${p.start}:${p.end}:${p.channels.join(',')}`)
      const rows: Row[] = []
      const wantXom = p.channels.length === 0 || p.channels.includes('Xometry')
      const wantDirect = p.channels.length === 0 || p.channels.some((c: string) => c !== 'Xometry')
      const names = ['Acme Prototyping', 'Bolt Dynamics', 'Cascade Labs', 'Drift Manufacturing', 'Ember Design', 'Fathom Robotics', 'Gale Aero', 'Harbor Medical']
      let direct = 0
      if (wantDirect) {
        const n = 220 + Math.round(r() * 60)
        for (let i = 0; i < n; i++) {
          // power-law-ish: a few whales, long thin tail — mirrors the real book
          const b = Math.round((12000 / Math.pow(i + 1.5, 0.85)) * (0.6 + r() * 0.8) * 100) / 100
          direct += b
          rows.push({
            email: `customer${i + 1}@example.com`,
            company: i < names.length ? names[i] : r() < 0.4 ? `Shop ${i + 1} LLC` : '',
            channels: r() < 0.85 ? 'Web - Revenue Generating' : 'PreForm - Revenue Generating',
            bookings: b,
            n_orders: Math.max(1, Math.round(r() * (i < 10 ? 20 : 4))),
            first_order: p.start,
            last_order: p.end,
          })
        }
      }
      if (wantXom) {
        rows.push({
          email: '__xometry__',
          company: 'Xometry (marketplace)',
          channels: 'Xometry',
          bookings: Math.round(direct * 0.7 * 100) / 100 || 250000,
          n_orders: 900,
          first_order: p.start,
          last_order: p.end,
        })
      }
      return rows.sort((a, b) => (b.bookings as number) - (a.bookings as number))
    },
  },
}
