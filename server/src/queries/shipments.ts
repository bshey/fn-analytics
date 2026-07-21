import { z } from 'zod'
import type { QueryRegistry, Row } from '../registry.js'
import {
  T,
  zBaseFilters,
  sqlDate,
  grainExpr,
  kpiViewFilters,
  classifiedOrdersCTEs,
  classifiedChannelFilter,
  governedBookingsExpr,
  governedDueDateExpr,
  orderPartFilters,
  partsDecileFilter,
} from '../sql.js'
import { rng, periodsBetween, truncPeriod, daysAgoIso, MOCK_CHANNELS, CHANNEL_WEIGHT, MOCK_MATERIALS, MOCK_MFG_TYPES } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module A — Shipment Analytics. SQL follows the validated reference
// implementations (form_now_shipments_dashboard.html / ship_timing_distribution.html)
// and spec §8. Rates are NEVER pre-averaged: we return summed counts and
// weighted sums; the client re-derives rates.
// ---------------------------------------------------------------------------

const zShipExplorer = zBaseFilters.extend({
  breakdown: z.enum(['none', 'reporting_category', 'materials', 'manufacturing_types']).default('none'),
})

const zOrdersExplorer = zBaseFilters.extend({
  breakdown: z
    .enum(['none', 'reporting_category', 'manufacturing_location', 'materials', 'manufacturing_types'])
    .default('none'),
})

function shipBreakdownExpr(b: z.infer<typeof zShipExplorer>['breakdown']): string {
  return b === 'none' ? `'All'` : b
}

export const shipmentQueries: QueryRegistry = {
  /**
   * Ship-date cohort explorer — one flexible rollup off the governed KPI view.
   * Powers the A1 Metrics Explorer (ship cohort) and all A2 KPI cards/trends.
   */
  shipments_explorer: {
    description:
      'Governed KPI view metrics summed by period × breakdown. IMPORTANT: the view\'s date_key is the PROMISED SHIP (due) date, not the actual ship date — a period contains the orders that were due then. orders_due = all orders due in the period (shipped or not); orders_shipped = those that have shipped so far. Rates are re-derived client-side as SUM(on_time)/SUM(orders_shipped); a period is UNSETTLED while orders_due > orders_shipped — its on-time % only counts orders that already shipped (all of which are early/on-time for very recent dates), so it reads artificially high until every due order ships.',
    source: 'formlabs-data-sandbox.fcm.v_shipments_kpi (date_key = due date)',
    params: zShipExplorer,
    sql: (p) => `
SELECT
  CAST(${grainExpr('date_key', p.grain)} AS STRING) AS period,
  CAST(${shipBreakdownExpr(p.breakdown)} AS STRING) AS breakdown,
  SUM(n_orders) AS orders_due,
  SUM(n_orders_shipped) AS orders_shipped,
  SUM(n_orders_shipped_on_time) AS on_time,
  SUM(n_orders_shipped_within_36h) AS within_36h,
  SUM(n_unique_parts_shipped) AS unique_parts,
  SUM(qty_parts_shipped) AS parts,
  SUM(SAFE_CAST(sum_parts_volume_ml_shipped AS FLOAT64)) AS volume_ml,
  SUM(SAFE_CAST(revenue_from_shipped_orders AS FLOAT64)) AS revenue,
  SUM(SAFE_CAST(quoted_price_from_shipped_orders AS FLOAT64)) AS quoted,
  SUM(SAFE_CAST(bookings_from_shipped_orders AS FLOAT64)) AS bookings,
  SUM(IFNULL(avg_business_days_to_ship, 0) * n_orders_shipped) AS bizdays_weighted,
  SUM(IFNULL(average_days_late_ship, 0) * n_orders_shipped) AS dayslate_weighted
FROM ${T.shipmentsKpi}
WHERE date_key BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  AND date_key <= CURRENT_DATE()
  AND reporting_category IS NOT NULL
  ${kpiViewFilters(p)}
GROUP BY period, breakdown
HAVING orders_due > 0 OR orders_shipped > 0 OR parts > 0
ORDER BY period, breakdown`,
    mock: (p) => {
      const r = rng(`ship:${p.grain}:${p.breakdown}`)
      const periods = periodsBetween(p.start, p.end, p.grain)
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? [...(p.channels.length ? p.channels : MOCK_CHANNELS)]
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : [...MOCK_MFG_TYPES]
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const rows: Row[] = []
      for (const period of periods) {
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const shipped = Math.max(1, Math.round((30 + r() * 40) * w * scale))
          const onTimeRate = 0.3 + r() * 0.45
          const parts = shipped * (2 + Math.round(r() * 6))
          // Recent due-date cohorts are unsettled: some due orders haven't shipped yet.
          const unsettled = period >= daysAgoIso(12)
          rows.push({
            period,
            breakdown: g,
            orders_due: shipped + (unsettled ? Math.max(1, Math.round(shipped * (0.3 + r() * 0.5))) : Math.round(r() * 1.4)),
            orders_shipped: shipped,
            on_time: Math.round(shipped * onTimeRate),
            within_36h: Math.round(shipped * onTimeRate * 0.6),
            unique_parts: Math.round(parts * 0.6),
            parts,
            volume_ml: Math.round(parts * (8 + r() * 30)),
            revenue: Math.round(shipped * (180 + r() * 400)),
            quoted: Math.round(shipped * (200 + r() * 420)),
            bookings: Math.round(shipped * (190 + r() * 410)),
            bizdays_weighted: Math.round(shipped * (1.5 + r() * 3) * 10) / 10,
            dayslate_weighted: Math.round(shipped * (r() * 1.4 - 0.4) * 10) / 10,
          })
        }
      }
      return rows
    },
  },

  /**
   * Order-placed cohort explorer (spec §8.2 + §8.1 classification).
   * Bookings = subtotal + shipping + tax + credit at time of order, keyed by submitted_at.
   * Material/type filters apply via fcm_api_orderpart (any part matches).
   */
  orders_explorer: {
    description:
      "Order-placed cohort from fcm_api_order keyed by submitted_at: orders placed, bookings $, parts / unique parts / volume ordered. Bookings and channel classification use the governed f_orders rules verbatim — bookings is money recognized AT ORDER TIME regardless of shipment (amount charged; Xometry = subtotal; internal/PO orders = full value; external 100%-discounts = $0) — so numbers tie to Looker, and bookings exceeds revenue for recent periods where orders haven't all shipped. Excludes QUOTING only (like Looker). Material / mfg-type filters match orders where ANY part has the selected material/type; material/type breakdowns use the order's part list (multi-value orders roll up as 'Mixed'). Volume excludes part files above the plausibility cap (config maxPartVolumeMl, default 25L) — those are unit-scale upload artifacts, not real parts.",
    source: 'fcm_api_order + fcm_api_orderpart + fcm_api_partfile (+ medusa order/coupons for channel & bookings)',
    params: zOrdersExplorer,
    sql: (p, ctx) => {
      const breakdown =
        p.breakdown === 'none'
          ? `'All'`
          : p.breakdown === 'reporting_category'
            ? 'c.reporting_category'
            : p.breakdown === 'materials'
              ? `IFNULL(op.materials, 'Unknown')`
              : p.breakdown === 'manufacturing_types'
                ? `IFNULL(op.manufacturing_types, 'Unknown')`
                : `IFNULL(c.manufacturing_location, 'Unknown')`
      const dec = partsDecileFilter(p.partsBuckets, 'classified')
      return `
WITH ${classifiedOrdersCTEs(
        `o.status != 'QUOTING' AND o.submitted_at IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )}${dec.ctes},
op AS (
  SELECT p.order_id,
         COUNT(DISTINCT p.part_file_id) AS n_unique_parts,
         SUM(p.quantity) AS parts,
         -- Volumes above the plausibility cap are unit-scale upload artifacts
         -- (meters parsed as mm → 10^9× volume); nothing over ~25L fits a printer.
         SUM(IF(SAFE_CAST(pf.volume_ml AS FLOAT64) <= ${ctx.exclusions.maxPartVolumeMl}, SAFE_CAST(pf.volume_ml AS FLOAT64), 0) * p.quantity) AS volume_ml,
         STRING_AGG(DISTINCT NULLIF(p.material, ''), ', ' ORDER BY NULLIF(p.material, '')) AS materials,
         STRING_AGG(DISTINCT NULLIF(p.manufacturing_type, ''), ', ' ORDER BY NULLIF(p.manufacturing_type, '')) AS manufacturing_types
  FROM ${T.orderPart} p
  LEFT JOIN ${T.partFile} pf ON pf.guid = p.part_file_id
  WHERE p.order_id IN (SELECT id FROM classified)
  GROUP BY p.order_id
)
SELECT
  CAST(${grainExpr('DATE(c.submitted_at)', p.grain)} AS STRING) AS period,
  CAST(${breakdown} AS STRING) AS breakdown,
  COUNT(*) AS orders_placed,
  SUM(${governedBookingsExpr('c', ctx.exclusions.revenueSentinelBillingId)}) AS bookings,
  SUM(IFNULL(op.parts, 0)) AS parts_ordered,
  SUM(IFNULL(op.n_unique_parts, 0)) AS unique_parts_ordered,
  SUM(IFNULL(op.volume_ml, 0)) AS volume_ml_ordered
FROM classified c
LEFT JOIN op ON op.order_id = c.id
WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
  ${orderPartFilters(p, 'c')}
  ${dec.cond('c')}
GROUP BY period, breakdown
ORDER BY period, breakdown`
    },
    mock: (p) => {
      const r = rng(`placed:${p.grain}:${p.breakdown}`)
      const periods = periodsBetween(p.start, p.end, p.grain)
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? [...(p.channels.length ? p.channels : MOCK_CHANNELS)]
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : p.breakdown === 'manufacturing_types'
                ? [...MOCK_MFG_TYPES]
                : ['Somerville', 'Milwaukee']
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const rows: Row[] = []
      for (const period of periods) {
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const placed = Math.max(1, Math.round((36 + r() * 44) * w * scale))
          const parts = placed * (2 + Math.round(r() * 6))
          rows.push({
            period,
            breakdown: g,
            orders_placed: placed,
            bookings: Math.round(placed * (200 + r() * 430)),
            parts_ordered: parts,
            unique_parts_ordered: Math.round(parts * 0.6),
            volume_ml_ordered: Math.round(parts * (8 + r() * 30)),
          })
        }
      }
      return rows
    },
  },

  /**
   * Median parts per order — order-placed cohort. Medians can't be re-derived
   * from summed counts, so the SQL computes them per period × breakdown; the
   * client shows median_weighted ÷ n_orders, which is exact per cell and a
   * weighted approximation when groups fold into 'Other' or span a window.
   */
  parts_per_order: {
    description:
      "Median ordered part quantity per order, per period × breakdown, order-placed cohort (submitted_at, QUOTING excluded). median_weighted = median × n_orders so the client can weight-average across folded groups and windows (exact for a single period×group cell; a weighted approximation of 'median of the union' otherwise). Orders with zero part rows are excluded. Channel/material/mfg filters and the order-size decile filter apply.",
    source: 'fcm_api_order + fcm_api_orderpart (+ medusa order for channel classification)',
    params: zOrdersExplorer,
    sql: (p, ctx) => {
      const breakdown =
        p.breakdown === 'none'
          ? `'All'`
          : p.breakdown === 'reporting_category'
            ? 'c.reporting_category'
            : p.breakdown === 'materials'
              ? `IFNULL(op.materials, 'Unknown')`
              : p.breakdown === 'manufacturing_types'
                ? `IFNULL(op.manufacturing_types, 'Unknown')`
                : `IFNULL(c.manufacturing_location, 'Unknown')`
      const dec = partsDecileFilter(p.partsBuckets, 'classified')
      return `
WITH ${classifiedOrdersCTEs(
        `o.status != 'QUOTING' AND o.submitted_at IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )}${dec.ctes},
op AS (
  SELECT p.order_id,
         SUM(p.quantity) AS parts,
         STRING_AGG(DISTINCT NULLIF(p.material, ''), ', ' ORDER BY NULLIF(p.material, '')) AS materials,
         STRING_AGG(DISTINCT NULLIF(p.manufacturing_type, ''), ', ' ORDER BY NULLIF(p.manufacturing_type, '')) AS manufacturing_types
  FROM ${T.orderPart} p
  WHERE p.order_id IN (SELECT id FROM classified)
  GROUP BY p.order_id
)
SELECT
  CAST(${grainExpr('DATE(c.submitted_at)', p.grain)} AS STRING) AS period,
  CAST(${breakdown} AS STRING) AS breakdown,
  COUNT(*) AS n_orders,
  APPROX_QUANTILES(op.parts, 100)[OFFSET(50)] AS median_parts,
  APPROX_QUANTILES(op.parts, 100)[OFFSET(50)] * COUNT(*) AS median_weighted
FROM classified c
JOIN op ON op.order_id = c.id
WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
  ${orderPartFilters(p, 'c')}
  ${dec.cond('c')}
GROUP BY period, breakdown
ORDER BY period, breakdown`
    },
    mock: (p) => {
      const r = rng(`ppo:${p.grain}:${p.breakdown}`)
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? [...(p.channels.length ? p.channels : MOCK_CHANNELS)]
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : p.breakdown === 'manufacturing_types'
                ? [...MOCK_MFG_TYPES]
                : ['Somerville', 'Milwaukee']
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const n = Math.max(1, Math.round((36 + r() * 44) * w * scale))
          const median = Math.round(2 + r() * 8)
          rows.push({ period, breakdown: g, n_orders: n, median_parts: median, median_weighted: median * n })
        }
      }
      return rows
    },
  },

  /**
   * Quoted lead time — the SHIP promise made at order time: business days
   * (Mon–Fri, holidays not excluded) from submission to the governed
   * channel-aware due date. Order-placed cohort, so this tracks quoting
   * policy over time regardless of what production later did.
   */
  quoted_lead_time: {
    description:
      'Quoted lead time per period × breakdown, order-placed cohort (submitted_at, QUOTING excluded, ship_by required): business days (Mon–Fri, holidays not excluded) from order submission to the governed channel-aware due date (Xometry ship_by stored 23:59 ET). lead_weighted = summed lead days so the client derives the average as lead_weighted ÷ n_orders; median_lead rides along for CSV. Negative leads (due before submission — data errors) are dropped. Channel/material/mfg filters and the order-size decile filter apply.',
    source: 'fcm_api_order (+ f_orders classification, governed due-date rule)',
    params: zOrdersExplorer,
    sql: (p, ctx) => {
      const breakdown =
        p.breakdown === 'none'
          ? `'All'`
          : p.breakdown === 'reporting_category'
            ? 'c.reporting_category'
            : p.breakdown === 'materials'
              ? `IFNULL(op.materials, 'Unknown')`
              : p.breakdown === 'manufacturing_types'
                ? `IFNULL(op.manufacturing_types, 'Unknown')`
                : `IFNULL(c.manufacturing_location, 'Unknown')`
      const dec = partsDecileFilter(p.partsBuckets, 'classified')
      return `
WITH ${classifiedOrdersCTEs(
        `o.status != 'QUOTING' AND o.submitted_at IS NOT NULL AND o.ship_by IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )}${dec.ctes},
op AS (
  SELECT p.order_id,
         STRING_AGG(DISTINCT NULLIF(p.material, ''), ', ' ORDER BY NULLIF(p.material, '')) AS materials,
         STRING_AGG(DISTINCT NULLIF(p.manufacturing_type, ''), ', ' ORDER BY NULLIF(p.manufacturing_type, '')) AS manufacturing_types
  FROM ${T.orderPart} p
  WHERE p.order_id IN (SELECT id FROM classified)
  GROUP BY p.order_id
),
bcal AS (
  SELECT d, ROW_NUMBER() OVER (ORDER BY d) AS idx
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(${sqlDate(p.start)}, INTERVAL 30 DAY), DATE_ADD(${sqlDate(p.end)}, INTERVAL 120 DAY))) AS d
  WHERE EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7)
),
base AS (
  SELECT c.id, c.reporting_category, c.manufacturing_location, DATE(c.submitted_at) AS sub_date,
         bd.idx - bs.idx AS lead_days
  FROM classified c
  JOIN bcal bs ON bs.d = (SELECT MIN(d) FROM bcal WHERE d >= DATE(c.submitted_at))
  JOIN bcal bd ON bd.d = (SELECT MIN(d) FROM bcal WHERE d >= ${governedDueDateExpr('c')})
)
SELECT
  CAST(${grainExpr('c.sub_date', p.grain)} AS STRING) AS period,
  CAST(${breakdown} AS STRING) AS breakdown,
  COUNT(*) AS n_orders,
  SUM(c.lead_days) AS lead_weighted,
  APPROX_QUANTILES(c.lead_days, 100)[OFFSET(50)] AS median_lead
FROM base c
LEFT JOIN op ON op.order_id = c.id
WHERE c.lead_days >= 0
  ${classifiedChannelFilter(p.channels, 'c')}
  ${orderPartFilters(p, 'c')}
  ${dec.cond('c')}
GROUP BY period, breakdown
ORDER BY period, breakdown`
    },
    mock: (p) => {
      const r = rng(`qlt:${p.grain}:${p.breakdown}`)
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? [...(p.channels.length ? p.channels : MOCK_CHANNELS)]
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : p.breakdown === 'manufacturing_types'
                ? [...MOCK_MFG_TYPES]
                : ['Somerville', 'Milwaukee']
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const n = Math.max(1, Math.round((36 + r() * 44) * w * scale))
          const avg = 4 + r() * 5
          rows.push({ period, breakdown: g, n_orders: n, lead_weighted: Math.round(avg * n), median_lead: Math.round(avg) })
        }
      }
      return rows
    },
  },

  /**
   * On-time DELIVERY — cohorted by the quoted delivery date the customer saw
   * at checkout (medusa metadata.estimated_delivery_dates[shipping option]),
   * with delivery detected from ShipStation SHIPPING_UPDATE events (status DE).
   */
  delivery_kpis: {
    description:
      "On-time delivery per period × breakdown, cohorted by the QUOTED DELIVERY date shown at checkout (medusa metadata.estimated_delivery_dates for the chosen shipping option). orders_due = orders promised delivery in the period (excl. cancelled/rejected/quoting and local pickup); delivered = those with a ShipStation 'delivered' tracking event; delivered_on_time = delivered on/before the quoted date (delivery date taken in America/New_York); delivered_max_1d_late = delivered no more than 1 calendar day after the quoted date (superset of on-time). OTD% = delivered_on_time ÷ orders_due — undelivered orders count as NOT on time, so recent periods start low and climb as packages land. Material / mfg-type filters match orders where ANY part has the selection; material/type breakdowns use the order's part list (multi-value orders roll up as 'Mixed'). Web/PreForm only (Xometry has no checkout delivery quote). Delivery tracking events exist since 2026-04-30.",
    source:
      'fcm_api_order + form_now_medusa_prod.order (quoted dates) + fcm_api_orderevent SHIPPING_UPDATE/ShipStation (delivered) + fcm_api_orderpart (material/type)',
    params: zShipExplorer,
    sql: (p, ctx) => {
      const breakdown =
        p.breakdown === 'none'
          ? `'All'`
          : p.breakdown === 'reporting_category'
            ? 'q.reporting_category'
            : p.breakdown === 'materials'
              ? `IFNULL(od.materials, 'Unknown')`
              : `IFNULL(od.manufacturing_types, 'Unknown')`
      const dec = partsDecileFilter(p.partsBuckets, 'promwin')
      return `
WITH ${classifiedOrdersCTEs(
        `o.status NOT IN ('CANCELLED', 'REJECTED', 'QUOTING')
    AND o.shipping_option_name IN ('GROUND', 'ONE_DAY', 'TWO_DAY')
    AND DATE(o.submitted_at) BETWEEN DATE_SUB(${sqlDate(p.start)}, INTERVAL 45 DAY) AND ${sqlDate(p.end)}
    ${orderPartFilters(p)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )},
promised AS (
  SELECT
    c.id,
    c.reporting_category,
    SAFE_CAST(CASE c.shipping_option_name
      WHEN 'GROUND' THEN JSON_VALUE(m.metadata, '$.estimated_delivery_dates.GROUND')
      WHEN 'ONE_DAY' THEN JSON_VALUE(m.metadata, '$.estimated_delivery_dates.ONE_DAY')
      WHEN 'TWO_DAY' THEN JSON_VALUE(m.metadata, '$.estimated_delivery_dates.TWO_DAY')
    END AS DATE) AS promised_delivery
  FROM classified c
  JOIN ${T.medusaOrder} m ON m.id = c.source_reference_id
),
op_dims AS (
  SELECT order_id,
    STRING_AGG(DISTINCT NULLIF(material, ''), ', ' ORDER BY NULLIF(material, '')) AS materials,
    STRING_AGG(DISTINCT NULLIF(manufacturing_type, ''), ', ' ORDER BY NULLIF(manufacturing_type, '')) AS manufacturing_types
  FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
delivered AS (
  SELECT order_id, MIN(timestamp) AS delivered_at
  FROM ${T.orderEvent}
  WHERE event_type = 'SHIPPING_UPDATE'
    AND source = 'ShipStation'
    AND UPPER(JSON_VALUE(event_data, '$.tracking_status.status_code')) = 'DE'
    AND DATE(timestamp) >= '2026-04-25'
  GROUP BY order_id
)${dec.ctes ? `,
promwin AS (
  SELECT id FROM promised
  WHERE promised_delivery BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
)` : ''}${dec.ctes}
SELECT
  CAST(${grainExpr('q.promised_delivery', p.grain)} AS STRING) AS period,
  CAST(${breakdown} AS STRING) AS breakdown,
  COUNT(*) AS orders_due,
  COUNTIF(d.delivered_at IS NOT NULL) AS delivered,
  COUNTIF(d.delivered_at IS NOT NULL AND DATE(d.delivered_at, 'America/New_York') <= q.promised_delivery) AS delivered_on_time,
  COUNTIF(d.delivered_at IS NOT NULL AND DATE(d.delivered_at, 'America/New_York') <= DATE_ADD(q.promised_delivery, INTERVAL 1 DAY)) AS delivered_max_1d_late
FROM promised q
LEFT JOIN op_dims od ON od.order_id = q.id
LEFT JOIN delivered d ON d.order_id = q.id
WHERE q.promised_delivery BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  ${classifiedChannelFilter(p.channels, 'q')}
  ${dec.cond('q')}
GROUP BY period, breakdown
ORDER BY period, breakdown`
    },
    mock: (p) => {
      const r = rng(`otd:${p.grain}:${p.breakdown}`)
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? (p.channels.length ? [...p.channels] : [...MOCK_CHANNELS]).filter((c: string) => !c.startsWith('Xometry'))
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : [...MOCK_MFG_TYPES]
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const due = Math.max(1, Math.round((40 + r() * 25) * w * scale))
          // Recent cohorts have packages still in transit.
          const recent = period >= daysAgoIso(10)
          const delivered = recent ? Math.round(due * (0.2 + r() * 0.4)) : Math.round(due * (0.93 + r() * 0.07))
          const delivered_on_time = Math.round(delivered * (0.55 + r() * 0.35))
          // ≤1-day-late is a superset of on-time: on-time plus ~half of the late deliveries.
          const delivered_max_1d_late = Math.min(delivered, delivered_on_time + Math.round((delivered - delivered_on_time) * (0.4 + r() * 0.35)))
          rows.push({ period, breakdown: g, orders_due: due, delivered, delivered_on_time, delivered_max_1d_late })
        }
      }
      return rows
    },
  },

  /**
   * Shipped ≤1-day-late — the governed KPI view has on-time counts but no
   * tolerance buckets, so this recomputes the due-date cohort from raw orders:
   * governed channel-aware due date (Xometry ship_by @ 23:59 ET), ship date in
   * UTC to match the view, denominator = ALL orders due (unshipped count against).
   */
  ship_late_kpis: {
    description:
      "Shipped-within-tolerance counts per period × breakdown, cohorted by the GOVERNED DUE date (channel-aware: Xometry ship_by is stored 23:59 ET). orders_due = all orders due in the period (excl. cancelled/rejected/quoting); orders_shipped = those shipped so far; shipped_on_time = shipped on/before the due date; shipped_max_1d_late = shipped no more than 1 calendar day after it (ship dates in UTC, matching the governed view). Rates divide by orders_due — unshipped orders count as late, so recent periods start low and climb as orders ship. Material/mfg filters match orders where ANY part has the selection; breakdowns use the order's part list (multi-value orders roll up as 'Mixed').",
    source: 'fcm_api_order (+ f_orders classification for channel) + fcm_api_orderpart (material/type)',
    params: zShipExplorer,
    sql: (p, ctx) => {
      const breakdown =
        p.breakdown === 'none'
          ? `'All'`
          : p.breakdown === 'reporting_category'
            ? 'q.reporting_category'
            : p.breakdown === 'materials'
              ? `IFNULL(od.materials, 'Unknown')`
              : `IFNULL(od.manufacturing_types, 'Unknown')`
      const dec = partsDecileFilter(p.partsBuckets, 'duewin')
      return `
WITH ${classifiedOrdersCTEs(
        `o.status NOT IN ('CANCELLED', 'REJECTED', 'QUOTING')
    AND o.ship_by IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN DATE_SUB(${sqlDate(p.start)}, INTERVAL 90 DAY) AND ${sqlDate(p.end)}
    ${orderPartFilters(p)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )},
op_dims AS (
  SELECT order_id,
    STRING_AGG(DISTINCT NULLIF(material, ''), ', ' ORDER BY NULLIF(material, '')) AS materials,
    STRING_AGG(DISTINCT NULLIF(manufacturing_type, ''), ', ' ORDER BY NULLIF(manufacturing_type, '')) AS manufacturing_types
  FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
due AS (
  SELECT c.id, c.reporting_category,
    ${governedDueDateExpr('c')} AS due_date,
    DATE(c.shipped_at) AS ship_date
  FROM classified c
)${dec.ctes ? `,
duewin AS (
  SELECT id FROM due
  WHERE due_date BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)} AND due_date <= CURRENT_DATE()
)` : ''}${dec.ctes}
SELECT
  CAST(${grainExpr('q.due_date', p.grain)} AS STRING) AS period,
  CAST(${breakdown} AS STRING) AS breakdown,
  COUNT(*) AS orders_due,
  COUNTIF(q.ship_date IS NOT NULL) AS orders_shipped,
  COUNTIF(q.ship_date IS NOT NULL AND q.ship_date <= q.due_date) AS shipped_on_time,
  COUNTIF(q.ship_date IS NOT NULL AND q.ship_date <= DATE_ADD(q.due_date, INTERVAL 1 DAY)) AS shipped_max_1d_late
FROM due q
LEFT JOIN op_dims od ON od.order_id = q.id
WHERE q.due_date BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  AND q.due_date <= CURRENT_DATE()
  ${classifiedChannelFilter(p.channels, 'q')}
  ${dec.cond('q')}
GROUP BY period, breakdown
ORDER BY period, breakdown`
    },
    mock: (p) => {
      const r = rng(`shiplate:${p.grain}:${p.breakdown}`)
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? [...(p.channels.length ? p.channels : MOCK_CHANNELS)]
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : [...MOCK_MFG_TYPES]
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const due = Math.max(1, Math.round((35 + r() * 30) * w * scale))
          // Recent due-date cohorts are unsettled: some due orders haven't shipped yet.
          const unsettled = period >= daysAgoIso(6)
          const orders_shipped = unsettled ? Math.round(due * (0.3 + r() * 0.5)) : Math.max(0, due - Math.round(r() * 1.4))
          const shipped_on_time = Math.round(orders_shipped * (0.55 + r() * 0.35))
          // ≤1-day-late is a superset of on-time: on-time plus roughly half the late ships.
          const shipped_max_1d_late = Math.min(orders_shipped, shipped_on_time + Math.round((orders_shipped - shipped_on_time) * (0.4 + r() * 0.4)))
          rows.push({ period, breakdown: g, orders_due: due, orders_shipped, shipped_on_time, shipped_max_1d_late })
        }
      }
      return rows
    },
  },

  /**
   * Orders shipped bucketed by ACTUAL ship date (UTC calendar day) — the legacy
   * Looker "Orders Shipped" convention. The governed KPI view cannot supply
   * this (date_key is the due date; it has no ship-date dimension), so this
   * counts raw orders. Verified to reproduce Looker's daily bars exactly
   * (Jul 2026, every settled day; ET bucketing ruled out).
   */
  shipped_by_ship_date: {
    description:
      "Orders shipped per period × breakdown, bucketed by the ACTUAL ship date as a UTC calendar day — matches the legacy Looker 'Orders Shipped' chart (which does not filter include_in_reporting). Weekend ships appear under the weekend day. Differs from the due-date-cohort explorer by design: every shipped order lands in exactly one bucket under each convention, so settled multi-week windows reconcile even though individual days differ. Material/mfg filters match orders where ANY part has the selection; breakdowns use the order's part list (multi-value orders roll up as 'Mixed').",
    source: 'fcm_api_order (+ f_orders classification for channel) + fcm_api_orderpart (material/type)',
    params: zShipExplorer,
    sql: (p, ctx) => {
      const breakdown =
        p.breakdown === 'none'
          ? `'All'`
          : p.breakdown === 'reporting_category'
            ? 'c.reporting_category'
            : p.breakdown === 'materials'
              ? `IFNULL(od.materials, 'Unknown')`
              : `IFNULL(od.manufacturing_types, 'Unknown')`
      const dec = partsDecileFilter(p.partsBuckets, 'classified')
      return `
WITH ${classifiedOrdersCTEs(
        `o.status = 'SHIPPED' AND o.shipped_at IS NOT NULL
    AND DATE(o.shipped_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
    AND DATE(o.shipped_at) <= CURRENT_DATE()
    ${orderPartFilters(p)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )}${dec.ctes},
op_dims AS (
  SELECT order_id,
    STRING_AGG(DISTINCT NULLIF(material, ''), ', ' ORDER BY NULLIF(material, '')) AS materials,
    STRING_AGG(DISTINCT NULLIF(manufacturing_type, ''), ', ' ORDER BY NULLIF(manufacturing_type, '')) AS manufacturing_types
  FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
)
SELECT
  CAST(${grainExpr('DATE(c.shipped_at)', p.grain)} AS STRING) AS period,
  CAST(${breakdown} AS STRING) AS breakdown,
  COUNT(*) AS orders_shipped
FROM classified c
LEFT JOIN op_dims od ON od.order_id = c.id
WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
  ${dec.cond('c')}
GROUP BY period, breakdown
ORDER BY period, breakdown`
    },
    mock: (p) => {
      const r = rng(`shipdate:${p.grain}:${p.breakdown}`)
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const groups =
        p.breakdown === 'none'
          ? ['All']
          : p.breakdown === 'reporting_category'
            ? [...(p.channels.length ? p.channels : MOCK_CHANNELS)]
            : p.breakdown === 'materials'
              ? MOCK_MATERIALS.map((m) => m.code)
              : [...MOCK_MFG_TYPES]
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        // Nothing ships on Sundays; Saturdays run light.
        const dow = new Date(`${period}T00:00:00Z`).getUTCDay()
        if (p.grain === 'day' && dow === 0) continue
        const dayFactor = p.grain === 'day' && dow === 6 ? 0.5 : 1
        for (const g of groups) {
          const w = p.breakdown === 'reporting_category' ? (CHANNEL_WEIGHT[g] ?? 0.1) : 1 / groups.length
          const shipped = Math.round((35 + r() * 30) * w * scale * dayFactor)
          if (shipped > 0) rows.push({ period, breakdown: g, orders_shipped: shipped })
        }
      }
      return rows
    },
  },

  /**
   * Late ships × production issues — of the orders that shipped LATE in each
   * period, how many hit an issue (build failure / reprint / quarantine /
   * mfg issue / QC-fail lot routing) during production? On-time counts ride
   * along so the UI can show the baseline issue rate for contrast.
   */
  ship_late_issues: {
    description:
      "Shipped orders per ACTUAL ship period split by late vs on-time (governed channel-aware due date; late = shipped at least 1 calendar day after it) and whether the order hit a production issue: any TOTAL_BUILD_FAILURE / PART_NEEDS_REPRINT / PART_QUARANTINED / MANUFACTURING_ISSUE order event, or any station-app QC-fail quarantine routing (Quarantine - Routing / QUARANTINED lot event; station events exist since 2026-07-02 — earlier periods rely on order events alone, so issue rates read slightly lower before go-live). late_with_issue ÷ late_orders = share of late ships that had a recorded issue; ontime_with_issue ÷ ontime_orders is the baseline for contrast. Channel, material and mfg-type filters all apply (material/type match any part on the order).",
    source: 'fcm_api_order + fcm_api_orderevent + manufacturing_events (station app) (+ medusa order for channel classification)',
    params: zBaseFilters,
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(
      `o.status = 'SHIPPED' AND o.shipped_at IS NOT NULL AND o.ship_by IS NOT NULL
    AND DATE(o.shipped_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
    AND DATE(o.shipped_at) <= CURRENT_DATE()`,
      ctx.exclusions.revenueSentinelBillingId,
    )},
iss AS (
  SELECT DISTINCT order_id FROM ${T.orderEvent}
  WHERE event_type IN ('TOTAL_BUILD_FAILURE', 'PART_NEEDS_REPRINT', 'PART_QUARANTINED', 'MANUFACTURING_ISSUE')
    AND order_id IN (SELECT id FROM classified)
  UNION DISTINCT
  SELECT DISTINCT order_id FROM ${T.mfgEvent}
  WHERE source = 'STATION_APP' AND event_type IN ('Quarantine - Routing', 'QUARANTINED')
    AND order_id IN (SELECT id FROM classified)
),
base AS (
  SELECT c.id, c.reporting_category,
         DATE(c.shipped_at) AS ship_date,
         DATE_DIFF(DATE(c.shipped_at), ${governedDueDateExpr('c')}, DAY) > 0 AS late,
         i.order_id IS NOT NULL AS has_issue
  FROM classified c
  LEFT JOIN iss i ON i.order_id = c.id
)
SELECT CAST(${grainExpr('ship_date', p.grain)} AS STRING) AS period,
       COUNTIF(late) AS late_orders,
       COUNTIF(late AND has_issue) AS late_with_issue,
       COUNTIF(NOT late) AS ontime_orders,
       COUNTIF(NOT late AND has_issue) AS ontime_with_issue
FROM base
WHERE TRUE ${classifiedChannelFilter(p.channels)}
  ${orderPartFilters(p, 'base')}
GROUP BY period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`lateiss:${p.grain}`)
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        const late = Math.max(1, Math.round((25 + r() * 40) * scale))
        const ontime = Math.max(2, Math.round((140 + r() * 60) * scale))
        rows.push({
          period,
          late_orders: late,
          late_with_issue: Math.round(late * (0.35 + r() * 0.35)),
          ontime_orders: ontime,
          ontime_with_issue: Math.round(ontime * (0.1 + r() * 0.15)),
        })
      }
      return rows
    },
  },

  /**
   * Ship-timing distribution (spec §8.3, corrected for the governed due-date rule).
   * Order-level calendar-day buckets vs the channel-aware promised ship date,
   * grouped period × channel × bucket. Periods are ACTUAL ship weeks.
   */
  ship_timing_distribution: {
    description:
      'Every shipped order bucketed by calendar days shipped early/on-time/late vs its promised ship date. Due date is channel-aware to match the governed f_orders view (Xometry ship_by is stored at 23:59 ET; a naive UTC date would grant Xometry an extra day). Calendar days, not business days, so late-bucket sizes can differ slightly from the KPI view\'s business-day days-late.',
    source: 'fcm_api_order (+ medusa order for channel classification); due-date rule from formlabs-data-sandbox.fcm.f_orders',
    params: zBaseFilters,
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(
      `o.status = 'SHIPPED' AND o.shipped_at IS NOT NULL AND o.ship_by IS NOT NULL
    AND DATE(o.shipped_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
    AND DATE(o.shipped_at) <= CURRENT_DATE()`,
      ctx.exclusions.revenueSentinelBillingId,
    )},
cat AS (
  SELECT c.id, c.shipped_at, c.reporting_category,
    DATE_DIFF(DATE(c.shipped_at), ${governedDueDateExpr('c')}, DAY) AS days_late
  FROM classified c
),
bucketed AS (
  SELECT *,
    CASE WHEN days_late <= -3 THEN '3+ days early'
         WHEN days_late BETWEEN -2 AND -1 THEN '1-2 days early'
         WHEN days_late = 0 THEN 'On time'
         WHEN days_late BETWEEN 1 AND 2 THEN '1-2 days late'
         WHEN days_late BETWEEN 3 AND 5 THEN '3-5 days late'
         ELSE '6+ days late' END AS bucket
  FROM cat
)
SELECT CAST(${grainExpr('DATE(shipped_at)', p.grain)} AS STRING) AS period,
       reporting_category, bucket, COUNT(*) AS n
FROM bucketed
WHERE TRUE ${classifiedChannelFilter(p.channels)}
  ${orderPartFilters(p, 'bucketed')}
GROUP BY period, reporting_category, bucket
ORDER BY period`,
    mock: (p) => {
      const r = rng(`timing:${p.grain}`)
      const periods = periodsBetween(p.start, p.end, p.grain)
      const channels = p.channels.length ? p.channels : [...MOCK_CHANNELS]
      const buckets: [string, number][] = [
        ['3+ days early', 0.1],
        ['1-2 days early', 0.18],
        ['On time', 0.32],
        ['1-2 days late', 0.2],
        ['3-5 days late', 0.12],
        ['6+ days late', 0.08],
      ]
      const scale = p.grain === 'day' ? 1 / 7 : p.grain === 'week' ? 1 : p.grain === 'month' ? 4.3 : p.grain === 'quarter' ? 13 : 52
      const rows: Row[] = []
      for (const period of periods) {
        for (const ch of channels) {
          const total = Math.max(2, Math.round((30 + r() * 40) * (CHANNEL_WEIGHT[ch] ?? 0.1) * scale))
          for (const [bucket, share] of buckets) {
            const n = Math.round(total * share * (0.6 + r() * 0.8))
            if (n > 0) rows.push({ period, reporting_category: ch, bucket, n })
          }
        }
      }
      return rows
    },
  },
}
