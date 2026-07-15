import { z } from 'zod'
import type { QueryRegistry, Row } from '../registry.js'
import {
  T,
  zChannels,
  classifiedOrdersCTEs,
  classifiedChannelFilter,
  governedBookingsExpr,
  governedDueDateExpr,
  CURRENT_DATE_ET,
} from '../sql.js'
import { rng, randInt, pick, daysAgoIso, MOCK_CHANNELS } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Ship-date predictor — feature extraction for open production orders.
// The prediction RULES live client-side in web/src/modules/predictor/rules.ts
// (empirical quantiles from docs/late-shipment-analysis.md); this query only
// assembles the observable features those rules condition on, plus the live
// family backlog for the capacity trigger.
// ---------------------------------------------------------------------------

const FAILURE_EVENTS = `('TOTAL_BUILD_FAILURE','PART_NEEDS_REPRINT','PART_QUARANTINED','PART_MISSING','MANUFACTURING_ISSUE')`

export const predictorQueries: QueryRegistry = {
  predictor_features: {
    description:
      'Prediction features for every open production order (status ACCEPTED/PRINTING/ON_HOLD): channel, mfg family, quantity, age since acceptance, days since first ORDER_PRINTING event, pre-ship failure-event count, governed due date and days past due, order value — plus the CURRENT family backlog (open SLA/SLS/total order counts, identical to the backlog definition in docs/late-shipment-analysis.md). The anticipated-ship-date rules themselves are applied in the UI from the analysis rule set; ages use America/New_York "today".',
    source:
      'fcm_api_order (+ medusa for channel) + fcm_api_orderpart (family/qty) + fcm_api_orderevent (printing, failures); rules: docs/late-shipment-analysis.md',
    maxAge: 300,
    params: z.object({ channels: zChannels }).default({}),
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(
      `o.status IN ('ACCEPTED', 'PRINTING', 'ON_HOLD') AND o.accepted_at IS NOT NULL`,
      ctx.exclusions.revenueSentinelBillingId,
    )},
parts AS (
  SELECT order_id,
    SUM(quantity) AS qty,
    CASE WHEN COUNT(DISTINCT SPLIT(manufacturing_type, ' - ')[OFFSET(0)]) > 1 THEN 'Mixed'
         ELSE IFNULL(ANY_VALUE(SPLIT(manufacturing_type, ' - ')[OFFSET(0)]), 'Unknown') END AS family
  FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
ev AS (
  SELECT order_id,
    COUNTIF(event_type IN ${FAILURE_EVENTS}) AS fail_events,
    MIN(IF(event_type = 'ORDER_PRINTING', timestamp, NULL)) AS first_printing
  FROM ${T.orderEvent}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
floorstate AS (
  -- Live station-app position: which lots have reached the bin (ready-to-ship
  -- signal — historically 100% of orders ship within hours-to-a-day of the last
  -- bin) and which are parked in quarantine.
  SELECT order_id,
    COUNT(DISTINCT IF(event_type = 'Binned', lot_guid, NULL)) AS lots_binned,
    COUNT(DISTINCT IF(event_type = 'Pending Binning', lot_guid, NULL)) AS lots_pending_bin,
    COUNT(DISTINCT IF(event_type = 'Quarantine - Routing', lot_guid, NULL)) AS lots_quarantined,
    COUNT(DISTINCT lot_guid) AS lots_seen
  FROM ${T.mfgEvent}
  WHERE source = 'STATION_APP' AND lot_guid IS NOT NULL
    AND order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
backlog AS (
  SELECT
    COUNT(*) AS total_open,
    COUNTIF(pp.family = 'SLA') AS sla_open,
    COUNTIF(pp.family = 'SLS') AS sls_open
  FROM classified c
  LEFT JOIN parts pp ON pp.order_id = c.id
)
SELECT
  c.id,
  c.source_display_id,
  c.internal_display_id,
  c.status,
  c.reporting_category,
  IF(c.xometry_order_id IS NOT NULL AND c.xometry_order_id != '', 'Xometry', 'FormNow') AS channel,
  IFNULL(pp.family, 'Unknown') AS family,
  IFNULL(pp.qty, 0) AS qty,
  ${governedBookingsExpr('c', ctx.exclusions.revenueSentinelBillingId)} AS bookings,
  CAST(DATE(c.accepted_at) AS STRING) AS accepted_date,
  CAST(${governedDueDateExpr('c')} AS STRING) AS due_date,
  DATE_DIFF(${CURRENT_DATE_ET}, DATE(c.accepted_at), DAY) AS age_days,
  IF(e.first_printing IS NULL, NULL, DATE_DIFF(${CURRENT_DATE_ET}, DATE(e.first_printing), DAY)) AS days_since_print,
  IFNULL(e.fail_events, 0) AS fail_events,
  c.status = 'ON_HOLD' AS on_hold,
  IF(${governedDueDateExpr('c')} IS NULL, NULL,
     DATE_DIFF(${CURRENT_DATE_ET}, ${governedDueDateExpr('c')}, DAY)) AS days_past_due,
  IFNULL(fs.lots_binned, 0) AS lots_binned,
  IFNULL(fs.lots_pending_bin, 0) AS lots_pending_bin,
  IFNULL(fs.lots_quarantined, 0) AS lots_quarantined,
  IFNULL(fs.lots_seen, 0) AS lots_seen,
  b.total_open, b.sla_open, b.sls_open
FROM classified c
LEFT JOIN parts pp ON pp.order_id = c.id
LEFT JOIN ev e ON e.order_id = c.id
LEFT JOIN floorstate fs ON fs.order_id = c.id
CROSS JOIN backlog b
WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
ORDER BY ${governedDueDateExpr('c')} ASC NULLS LAST
LIMIT 1000`,
    mock: (p) => {
      const r = rng('predictor_v1')
      const rows: Row[] = []
      const total = 58
      for (let i = 0; i < total; i++) {
        const channel = r() < 0.5 ? 'FormNow' : 'Xometry'
        const reporting_category = channel === 'Xometry' ? 'Xometry' : pick(r, MOCK_CHANNELS.filter((c) => c !== 'Xometry'))
        if (p.channels.length && !(p.channels as string[]).includes(reporting_category)) continue
        const family = r() < 0.55 ? 'SLA' : r() < 0.85 ? 'SLS' : 'Mixed'
        const age = Math.floor(Math.pow(r(), 1.6) * 14)
        const dueIn = randInt(r, -4, 8)
        const printed = r() < 0.6
        rows.push({
          id: 30000 + i,
          source_display_id: `FN-${3000 + i}`,
          internal_display_id: `MSB-${String(3000 + i).padStart(6, '0')}`,
          status: r() < 0.12 ? 'ON_HOLD' : r() < 0.5 ? 'PRINTING' : 'ACCEPTED',
          reporting_category,
          channel,
          family,
          qty: Math.max(1, Math.round(Math.pow(r(), 2.2) * 160)),
          bookings: Math.round((60 + r() * 900) * 100) / 100,
          accepted_date: daysAgoIso(age),
          due_date: daysAgoIso(-dueIn),
          age_days: age,
          days_since_print: printed ? Math.min(age, randInt(r, 0, 6)) : null,
          fail_events: Math.max(0, randInt(r, -3, 5)),
          on_hold: r() < 0.1,
          days_past_due: -dueIn,
          lots_binned: printed && r() < 0.3 ? randInt(r, 1, 4) : 0,
          lots_pending_bin: printed ? randInt(r, 1, 4) : 0,
          lots_quarantined: r() < 0.15 ? randInt(r, 1, 2) : 0,
          lots_seen: printed ? randInt(r, 2, 6) : 0,
          total_open: 293,
          sla_open: 149,
          sls_open: 155,
        })
      }
      return rows
    },
  },
}
