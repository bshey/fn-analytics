import type { QueryRegistry } from '../registry.js'
import {
  T,
  zBaseFilters,
  sqlDate,
  grainExpr,
  classifiedOrdersCTEs,
  classifiedChannelFilter,
  orderPartFilters,
  governedDueDateExpr,
} from '../sql.js'
import { rng, periodsBetween } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module F — Bowler Chart. Per-period counts for the ops bowler; every rate is
// derived client-side from summed counts (never averaged percentages).
// Orders placed / parts ordered / OTS / ≤36h reuse orders_explorer and
// shipments_explorer — only the metrics without an existing query live here.
// ---------------------------------------------------------------------------

const RMAPART = '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_rmapart`'
const UTIL_DAILY = '`formlabs-data-sandbox.fcm.v_utilization_daily`'
const YIELD_DAILY = '`formlabs-data-sandbox.fcm.v_yield_daily`'
const LABOR_DAILY = '`formlabs-data-sandbox.fcm.v_labor_daily`'

const GRAIN_SCALE: Record<string, number> = { day: 1 / 7, week: 1, month: 4.3, quarter: 13, year: 52 }

export const bowlerQueries: QueryRegistry = {
  /**
   * Median/avg business days from order to ship, revenue-generating only,
   * cohorted by the GOVERNED DUE date (channel-aware) so columns line up with
   * OTS. Only shipped orders carry a duration, so unsettled recent cohorts
   * skew toward their faster orders — treat them as provisional. Business
   * days = Mon–Fri; holidays are not excluded (matches the manual sheet's
   * simple day math and keeps the calendar CTE self-contained).
   */
  bowler_ship_days: {
    description:
      'Median and mean business days (Mon–Fri, holidays not excluded) from order submission to ship, cohorted by the GOVERNED DUE date (channel-aware: Xometry ship_by stored 23:59 ET) — the same period basis as OTS. Revenue-generating orders only. Unshipped due orders carry no duration, so unsettled recent cohorts reflect only their already-shipped (faster) orders. Median computed in SQL per period; n = shipped orders in the cohort. Channel/material/mfg filters apply.',
    source: 'fcm_api_order (+ f_orders classification, governed due-date rule)',
    params: zBaseFilters,
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(
      `o.status = 'SHIPPED' AND o.shipped_at IS NOT NULL AND o.submitted_at IS NOT NULL AND o.ship_by IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN DATE_SUB(${sqlDate(p.start)}, INTERVAL 90 DAY) AND ${sqlDate(p.end)}`,
      ctx.exclusions.revenueSentinelBillingId,
    )},
bcal AS (
  SELECT d, ROW_NUMBER() OVER (ORDER BY d) AS idx
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(${sqlDate(p.start)}, INTERVAL 120 DAY), DATE_ADD(${sqlDate(p.end)}, INTERVAL 30 DAY))) AS d
  WHERE EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7)
),
base AS (
  SELECT c.id, c.reporting_category, ${governedDueDateExpr('c')} AS due_date,
         bs.idx AS ship_idx, bo.idx AS order_idx
  FROM classified c
  JOIN bcal bs ON bs.d = (SELECT MIN(d) FROM bcal WHERE d >= DATE(c.shipped_at))
  JOIN bcal bo ON bo.d = (SELECT MIN(d) FROM bcal WHERE d >= DATE(c.submitted_at))
  WHERE c.reporting_category NOT LIKE '%Non-Revenue%'
    AND ${governedDueDateExpr('c')} BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
    AND ${governedDueDateExpr('c')} <= CURRENT_DATE()
)
SELECT CAST(${grainExpr('due_date', p.grain)} AS STRING) AS period,
       COUNT(*) AS n_shipped,
       APPROX_QUANTILES(ship_idx - order_idx, 100)[OFFSET(50)] AS median_bizdays,
       ROUND(AVG(ship_idx - order_idx), 2) AS avg_bizdays
FROM base
WHERE TRUE ${classifiedChannelFilter(p.channels)}
  ${orderPartFilters(p, 'base')}
GROUP BY period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`bshipd:${p.grain}`)
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const median = Math.round(2 + r() * 3)
        return {
          period,
          n_shipped: Math.max(3, Math.round((180 + r() * 60) * (GRAIN_SCALE[p.grain] ?? 1))),
          median_bizdays: median,
          avg_bizdays: Math.round((median + 0.5 + r() * 2) * 100) / 100,
        }
      })
    },
  },

  /**
   * Equipment utilization inputs from the sandbox daily view — the same source
   * the owner's manual sheet tracks (healthy-fleet basis reproduces it within
   * ~1.4 pts; the sheet simple-averages daily percentages, we sum seconds).
   */
  bowler_utilization: {
    description:
      "Printer utilization inputs per period from v_utilization_daily: SUM(total_active_seconds) vs healthy-fleet capacity (fleet minus printers marked down — a hardcoded assumption inside the view) and total-fleet capacity. Rate derived client-side as active ÷ healthy capacity. Sums of seconds, so slightly different (≤1.4 pts) from the manual sheet, which averages the view's daily percentage rows. Global channel/material filters do NOT apply.",
    source: 'formlabs-data-sandbox.fcm.v_utilization_daily',
    params: zBaseFilters,
    sql: (p) => `
SELECT CAST(${grainExpr('calendar_date', p.grain)} AS STRING) AS period,
       SUM(total_active_seconds) AS active_seconds,
       SUM(n_healthy_printers_in_fleet) * 86400 AS healthy_capacity_seconds,
       SUM(n_total_printers_in_fleet) * 86400 AS fleet_capacity_seconds,
       SUM(IF(printer_type LIKE 'Fuse%', total_active_seconds, 0)) AS sls_active_seconds,
       SUM(IF(printer_type LIKE 'Fuse%', n_healthy_printers_in_fleet, 0)) * 86400 AS sls_healthy_capacity_seconds,
       SUM(IF(printer_type NOT LIKE 'Fuse%', total_active_seconds, 0)) AS sla_active_seconds,
       SUM(IF(printer_type NOT LIKE 'Fuse%', n_healthy_printers_in_fleet, 0)) * 86400 AS sla_healthy_capacity_seconds
FROM ${UTIL_DAILY}
WHERE calendar_date BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  AND calendar_date <= CURRENT_DATE()
GROUP BY period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`butil:${p.grain}`)
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const slaCap = Math.round(37 * 86400 * 7 * (GRAIN_SCALE[p.grain] ?? 1))
        const slsCap = Math.round(43 * 86400 * 7 * (GRAIN_SCALE[p.grain] ?? 1))
        const slaAct = Math.round(slaCap * (0.2 + r() * 0.15))
        const slsAct = Math.round(slsCap * (0.3 + r() * 0.15))
        return {
          period,
          active_seconds: slaAct + slsAct,
          healthy_capacity_seconds: slaCap + slsCap,
          fleet_capacity_seconds: Math.round((slaCap + slsCap) * 1.16),
          sls_active_seconds: slsAct,
          sls_healthy_capacity_seconds: slsCap,
          sla_active_seconds: slaAct,
          sla_healthy_capacity_seconds: slaCap,
        }
      })
    },
  },

  /**
   * Part yield inputs from the sandbox daily view (ship/cancel-date cohort:
   * shipped quantity vs attempted printed quantity). The owner's sheet
   * averages the view's sliced percentage rows; we sum quantities, which reads
   * a few points lower but respects the no-averaging-percentages invariant.
   */
  bowler_yield: {
    description:
      'Part yield inputs per period from v_yield_daily: SUM(total_quantity_shipped) vs SUM(total_attempted_part_quantity), cohorted by ship/cancel date. Rate derived client-side. Reads a few points below the manual sheet, which simple-averages the view\'s per-slice percentage rows (that over-weights small slices). Cohorts drift for ~2–3 weeks after closing because the view\'s attempt denominator is time-unbounded — treat recent periods as provisional. Global filters do NOT apply.',
    source: 'formlabs-data-sandbox.fcm.v_yield_daily',
    params: zBaseFilters,
    sql: (p) => `
SELECT CAST(${grainExpr('date_key', p.grain)} AS STRING) AS period,
       SUM(total_quantity_shipped) AS parts_shipped,
       SUM(total_attempted_part_quantity) AS parts_attempted
FROM ${YIELD_DAILY}
WHERE date_key BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  AND date_key <= CURRENT_DATE()
GROUP BY period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`byield:${p.grain}`)
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const attempted = Math.max(50, Math.round((4000 + r() * 3000) * (GRAIN_SCALE[p.grain] ?? 1)))
        return { period, parts_shipped: Math.round(attempted * (0.62 + r() * 0.25)), parts_attempted: attempted }
      })
    },
  },

  /**
   * RMA inputs, SHIP-DATE COHORTED (owner decision): claims attribute to the
   * period their ORIGIN ORDER shipped, not when the claim was filed, so the
   * numerator and denominator describe the same population of orders.
   */
  bowler_rma: {
    description:
      "RMA inputs per period, cohorted by the origin order's ACTUAL ship date: rma_parts_scored = SUM(failed_quantity) of claims with is_counted_in_score (Form Now's own quality-score filter — excludes contested claims incl. a 300-part outlier) attributed to the period the claimed order SHIPPED, rma_parts = unfiltered, claims = claim count; parts_shipped / orders_shipped by actual ship date. Rate derived client-side as scored ÷ shipped — a true cohort rate. Ship→claim lag is 8 days median (p90 20), so cohorts younger than ~3 weeks are still accumulating claims and read low. DATA-ENTRY WATCH: zero claims logged since 2026-06-23 despite normal ship volume — verify RMA entry hasn't lapsed before trusting recent zeros. Global filters do NOT apply.",
    source: 'fcm_api_rmapart (cohorted to origin order ship date) + fcm_api_order/orderpart',
    params: zBaseFilters,
    sql: (p) => `
WITH rma AS (
  SELECT CAST(${grainExpr('DATE(o.shipped_at)', p.grain)} AS STRING) AS period,
         COUNT(*) AS claims,
         SUM(r.failed_quantity) AS rma_parts,
         SUM(IF(r.is_counted_in_score, r.failed_quantity, 0)) AS rma_parts_scored
  FROM ${RMAPART} r
  JOIN ${T.order} o ON o.id = r.order_id
  WHERE o.shipped_at IS NOT NULL
    AND DATE(o.shipped_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  GROUP BY period
),
shipped AS (
  SELECT CAST(${grainExpr('DATE(o.shipped_at)', p.grain)} AS STRING) AS period,
         SUM(op.quantity_shipped) AS parts_shipped,
         COUNT(DISTINCT o.id) AS orders_shipped
  FROM ${T.orderPart} op
  JOIN ${T.order} o ON o.id = op.order_id
  WHERE o.shipped_at IS NOT NULL
    AND DATE(o.shipped_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
    AND DATE(o.shipped_at) <= CURRENT_DATE()
  GROUP BY period
)
SELECT COALESCE(r.period, s.period) AS period,
       IFNULL(r.claims, 0) AS claims,
       IFNULL(r.rma_parts, 0) AS rma_parts,
       IFNULL(r.rma_parts_scored, 0) AS rma_parts_scored,
       IFNULL(s.parts_shipped, 0) AS parts_shipped,
       IFNULL(s.orders_shipped, 0) AS orders_shipped
FROM rma r
FULL OUTER JOIN shipped s ON s.period = r.period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`brma:${p.grain}`)
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const shipped = Math.max(100, Math.round((4500 + r() * 3000) * (GRAIN_SCALE[p.grain] ?? 1)))
        const scored = Math.round(shipped * r() * 0.02)
        return {
          period,
          claims: Math.max(0, Math.round(scored / 5)),
          rma_parts: Math.round(scored * 1.3),
          rma_parts_scored: scored,
          parts_shipped: shipped,
          orders_shipped: Math.max(20, Math.round(shipped / 25)),
        }
      })
    },
  },

  /**
   * Labor cost vs revenue from the payroll-backed sandbox view. NOTE: the view
   * reads confidential upstream tables the Redash service account is currently
   * 403-denied on — until access is granted (or a t_labor_daily
   * materialization lands) this query errors and the bowler row explains why.
   */
  bowler_labor: {
    description:
      'Labor inputs per period from v_labor_daily (punch-clock hours × actual salaries, 1.25 burden, alongside ship-week revenue): SUM(total_labor_cost_burdened), SUM(total_labor_hours), SUM(revenue). Rate derived client-side as burdened cost ÷ revenue. CURRENTLY BLOCKED: the view reads formnow_confidential.base_salary + swipeclock punch data that the Redash data source account cannot access — ask the data team to either grant access or nightly-materialize t_labor_daily without per-person fields. Global filters do NOT apply.',
    source: 'formlabs-data-sandbox.fcm.v_labor_daily (payroll-backed; access grant pending)',
    params: zBaseFilters,
    sql: (p) => `
SELECT CAST(${grainExpr('date_key', p.grain)} AS STRING) AS period,
       SUM(total_labor_cost_burdened) AS labor_cost,
       SUM(total_labor_hours) AS labor_hours,
       SUM(CAST(revenue AS FLOAT64)) AS revenue_shipped
FROM ${LABOR_DAILY}
WHERE date_key BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  AND date_key <= CURRENT_DATE()
GROUP BY period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`blabor:${p.grain}`)
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const revenue = Math.round((55000 + r() * 25000) * (GRAIN_SCALE[p.grain] ?? 1))
        return { period, labor_cost: Math.round(revenue * (0.2 + r() * 0.12)), labor_hours: Math.round(400 * (GRAIN_SCALE[p.grain] ?? 1)), revenue_shipped: revenue }
      })
    },
  },
}
