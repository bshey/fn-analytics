import { z } from 'zod'
import type { QueryRegistry, Row } from '../registry.js'
import {
  T,
  sqlString,
  zChannels,
  classifiedOrdersCTEs,
  classifiedChannelFilter,
  bookingsExpr,
  governedDueDateExpr,
  CURRENT_DATE_ET,
} from '../sql.js'
import { rng, randInt, pick, daysAgoIso, MOCK_CHANNELS } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module C — Order Deep-Dive. Identifier-driven case investigation: resolve
// any id/email/guid to orders, then show the full lifecycle (order events +
// station-app floor events + Tulip lots) for one order. Everything here is
// keyed by an exact validated order id or display id — no broad scans beyond
// the small (~20k row) fcm_api_order table.
// ---------------------------------------------------------------------------

const zSearch = z.object({
  q: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9@._ -]+$/, 'letters, digits, @ . _ space and - only'),
})

const zOrderId = z.object({ id: z.number().int().min(0).max(2_147_483_647) })

const zInternalId = z.object({
  internalDisplayId: z.string().min(1).max(40).regex(/^[A-Za-z0-9-]+$/),
})

const zProblem = z.object({ channels: zChannels }).default({})

/** Build a safe case-insensitive LIKE pattern literal from a validated search term. */
function likePattern(q: string): string {
  // Escape LIKE metacharacters; sqlString then escapes backslashes for the literal.
  const term = q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)
  return sqlString(`%${term}%`)
}

const ISSUE_EVENT_TYPES = [
  'TOTAL_BUILD_FAILURE',
  'PART_NEEDS_REPRINT',
  'PART_QUARANTINED',
  'MANUFACTURING_ISSUE',
] as const

// ---------------------------------------------------------------------------
// Mock fixture: one coherent order FN-1234 / MSB-000123 (submitted 2026-06-24,
// promised 2026-06-29, shipped 2026-06-30 → 1 day late; one part quarantined
// and reprinted along the way).
// ---------------------------------------------------------------------------

const MOCK_SUMMARY: Row = {
  id: 1234,
  source_display_id: 'FN-1234',
  internal_display_id: 'MSB-000123',
  status: 'SHIPPED',
  reporting_category: 'Web - Revenue Generating',
  submitted_at: '2026-06-24T09:15:00Z',
  shipped_at: '2026-06-30T15:45:00Z',
  bookings: 463.85,
  email: 'jane.engineer@acme-devices.com',
}

const { bookings: _summaryBookings, ...MOCK_SUMMARY_SANS_BOOKINGS } = MOCK_SUMMARY

const MOCK_DETAIL: Row = {
  ...MOCK_SUMMARY_SANS_BOOKINGS,
  manufacturing_location: 'Somerville',
  lead_time_days: 4,
  reorder_of_order_id: null,
  created_at: '2026-06-24T09:12:00Z',
  accepted_at: '2026-06-24T13:40:00Z',
  started_processing_at: '2026-06-25T08:05:00Z',
  printed_at: '2026-06-27T16:20:00Z',
  cancelled_at: null,
  ship_by: '2026-06-29',
  subtotal: 412.5,
  shipping_cost: 24.0,
  tax_cost: 27.35,
  credit_balance_applied: 0,
  amount_charged: 463.85,
  days_late: 1,
}

const ev = (
  ts: string,
  event_type: string,
  details: string | null,
  extra: Partial<Row> = {},
): Row => ({
  ts,
  event_type,
  details,
  needs_attention: null,
  assigned_to_dept: null,
  resolved_at: null,
  src: 'order',
  station: null,
  operator: null,
  part_quantity: null,
  lot_guid: null,
  ...extra,
})

/** 12 merged events: 9 order-system + 3 floor, incl. one NEEDS_ATTENTION and one PART_QUARANTINED. */
const MOCK_TIMELINE: Row[] = [
  ev('2026-06-24T09:15:00Z', 'ORDER_SUBMITTED_BY_CUSTOMER', '{"channel":"web","parts":3,"quoted_total":463.85}'),
  ev('2026-06-24T13:40:00Z', 'ORDER_ACCEPTED', '{"accepted_by":"ops-review","lead_time_days":4}'),
  ev('2026-06-25T08:05:00Z', 'ORDER_CLEARED_FOR_PRODUCTION', '{"queue":"SLS","location":"Somerville"}'),
  ev('2026-06-25T08:30:00Z', 'ORDER_PRINTING', '{"builds":["9001","9002","9003"]}'),
  ev('2026-06-26T10:12:00Z', 'NEEDS_ATTENTION', '{"reason":"Surface defect flagged during post-processing on housing_cover"}', {
    needs_attention: true,
    assigned_to_dept: 'PRINT_PRODUCTION',
    resolved_at: '2026-06-26T15:30:00Z',
  }),
  ev('2026-06-26T11:02:00Z', 'PART_QUARANTINED', '{"part_guid":"part-aaaa-0002","reason":"Dimensional check failed at Inspection 1","station":"Quarantine 1"}'),
  ev('2026-06-26T15:35:00Z', 'PART_NEEDS_REPRINT', '{"part_guid":"part-aaaa-0002","new_build_id":"9004"}'),
  ev('2026-06-27T16:25:00Z', 'PART_STATUS_CHANGED', '{"from_status":"Wash","to_status":"Cure","location":"Post Processing 1","location_type":"POST_PROCESSING"}', {
    src: 'floor',
    station: 'Post Processing 1',
    operator: 'Alex Rivera',
    part_quantity: 3,
    lot_guid: 'lot-7f21a9',
  }),
  ev('2026-06-28T09:00:00Z', 'ORDER_DELAYED_EMAIL_SENT', '{"recipient":"jane.engineer@acme-devices.com","new_ship_estimate":"2026-06-30"}'),
  ev('2026-06-29T10:05:00Z', 'PART_STATUS_CHANGED', '{"from_status":"Finishing","to_status":"Inspection 1","location":"Finishing 2","location_type":"FINISHING"}', {
    src: 'floor',
    station: 'Finishing 2',
    operator: 'Sam Chen',
    part_quantity: 2,
    lot_guid: 'lot-9c04d2',
  }),
  ev('2026-06-30T14:50:00Z', 'PART_STATUS_CHANGED', '{"from_status":"Binned","to_status":"Shipped","location":"Shipping 1","location_type":"SHIPPING"}', {
    src: 'floor',
    station: 'Shipping 1',
    operator: 'Jordan Lee',
    part_quantity: 5,
    lot_guid: 'lot-7f21a9',
  }),
  ev('2026-06-30T15:45:00Z', 'ORDER_SHIPPED', '{"carrier":"UPS","tracking_number":"1Z999AA10123456784"}'),
]

const MOCK_PARTS: Row[] = [
  { order_part_id: 50001, part_guid: 'part-aaaa-0001', part_file_id: 'pf-1111-bracket', quantity: 2, volume_ml: 42.5, n_builds: 2, build_ids: '9001, 9002' },
  { order_part_id: 50002, part_guid: 'part-aaaa-0002', part_file_id: 'pf-2222-housing', quantity: 1, volume_ml: 118.0, n_builds: 2, build_ids: '9002, 9004' },
  { order_part_id: 50003, part_guid: 'part-aaaa-0003', part_file_id: 'pf-3333-clip', quantity: 2, volume_ml: 7.9, n_builds: 1, build_ids: '9003' },
]

const MOCK_TULIP: Row[] = [
  {
    part_no: 'bracket_rev3.stl',
    status: 'Shipped',
    quantity: 3,
    material: 'Nylon 12 GF',
    manufacturing_type: 'SLS - Fuse 1+',
    printer_sn: 'FUSE1-0341',
    print_start: '2026-06-25T09:02:00Z',
    print_finished: '2026-06-26T02:41:00Z',
    shipping_label_created: '2026-06-30T14:58:00Z',
    due_date: '2026-06-29',
    updated_at: '2026-06-30T15:40:00Z',
  },
  {
    part_no: 'housing_cover.stl',
    status: 'Quarantine',
    quantity: 1,
    material: 'Nylon 12 GF',
    manufacturing_type: 'SLS - Fuse 1+',
    printer_sn: 'FUSE1-0287',
    print_start: '2026-06-25T09:02:00Z',
    print_finished: '2026-06-26T02:41:00Z',
    shipping_label_created: null,
    due_date: '2026-06-29',
    updated_at: '2026-06-26T11:05:00Z',
  },
]

// ---------------------------------------------------------------------------

export const orderQueries: QueryRegistry = {
  /** C1 — resolve any identifier (FN/MSB/id/medusa/xometry/email/part guid) to matching orders. */
  order_search: {
    description:
      'Resolves any identifier to matching orders: FN source_display_id, MSB internal_display_id, numeric order id, medusa source_reference_id (order_…), Xometry order id, customer email (from the medusa storefront order), or a part/file GUID on the order. Case-insensitive contains match; bookings = subtotal + shipping + tax + credit. Newest 25 by submitted_at.',
    source: 'fcm_api_order + form_now_medusa_prod.order + fcm_api_orderpart',
    maxAge: 60,
    params: zSearch,
    sql: (p, ctx) => {
      const pat = likePattern(p.q)
      const exact = sqlString(p.q.toLowerCase())
      return `
WITH ${classifiedOrdersCTEs('', ctx.exclusions.revenueSentinelBillingId)}
SELECT
  c.id,
  c.source_display_id,
  c.internal_display_id,
  c.status,
  c.reporting_category,
  CAST(c.submitted_at AS STRING) AS submitted_at,
  CAST(c.shipped_at AS STRING) AS shipped_at,
  ${bookingsExpr('c')} AS bookings,
  m.email AS email
FROM classified c
LEFT JOIN ${T.medusaOrder} m ON m.id = c.source_reference_id
WHERE LOWER(IFNULL(c.source_display_id, '')) LIKE ${pat}
   OR LOWER(IFNULL(c.internal_display_id, '')) LIKE ${pat}
   OR LOWER(CAST(c.id AS STRING)) LIKE ${pat}
   OR LOWER(IFNULL(c.source_reference_id, '')) LIKE ${pat}
   OR LOWER(IFNULL(c.xometry_order_id, '')) LIKE ${pat}
   OR LOWER(IFNULL(m.email, '')) LIKE ${pat}
   OR EXISTS (
        SELECT 1 FROM ${T.orderPart} op
        WHERE op.order_id = c.id
          AND (LOWER(IFNULL(CAST(op.guid AS STRING), '')) LIKE ${pat}
               OR LOWER(IFNULL(CAST(op.part_file_id AS STRING), '')) LIKE ${pat})
      )
ORDER BY
  CASE WHEN LOWER(IFNULL(c.source_display_id, '')) = ${exact}
         OR LOWER(IFNULL(c.internal_display_id, '')) = ${exact}
         OR LOWER(CAST(c.id AS STRING)) = ${exact}
       THEN 0 ELSE 1 END,
  c.submitted_at DESC
LIMIT 25`
    },
    mock: () => [{ ...MOCK_SUMMARY }],
  },

  /** C2 — one order's full header: lifecycle timestamps, money, channel, promise vs actual. */
  order_detail: {
    description:
      'Single-order header from fcm_api_order: every lifecycle timestamp (created → submitted → accepted → started processing → printed → shipped / cancelled), promised ship_by, reporting category, location, lead time, and each money field (subtotal, shipping, tax, credit applied, amount charged). days_late = DATE_DIFF(shipped_at, ship_by, DAY) — positive means shipped late.',
    source: 'fcm_api_order + form_now_medusa_prod.order (email, channel)',
    maxAge: 300,
    params: zOrderId,
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(`o.id = ${p.id}`, ctx.exclusions.revenueSentinelBillingId)}
SELECT
  c.id,
  c.source_display_id,
  c.internal_display_id,
  c.status,
  c.reporting_category,
  c.manufacturing_location,
  c.lead_time_days,
  c.reorder_of_order_id,
  CAST(c.created_at AS STRING) AS created_at,
  CAST(c.submitted_at AS STRING) AS submitted_at,
  CAST(c.accepted_at AS STRING) AS accepted_at,
  CAST(c.started_processing_at AS STRING) AS started_processing_at,
  CAST(c.printed_at AS STRING) AS printed_at,
  CAST(c.shipped_at AS STRING) AS shipped_at,
  CAST(c.cancelled_at AS STRING) AS cancelled_at,
  CAST(${governedDueDateExpr('c')} AS STRING) AS ship_by,
  SAFE_CAST(c.subtotal AS FLOAT64) AS subtotal,
  SAFE_CAST(c.shipping_cost AS FLOAT64) AS shipping_cost,
  SAFE_CAST(c.tax_cost AS FLOAT64) AS tax_cost,
  SAFE_CAST(c.credit_balance_applied AS FLOAT64) AS credit_balance_applied,
  SAFE_CAST(c.amount_charged AS FLOAT64) AS amount_charged,
  m.email AS email,
  DATE_DIFF(DATE(c.shipped_at), ${governedDueDateExpr('c')}, DAY) AS days_late
FROM classified c
LEFT JOIN ${T.medusaOrder} m ON m.id = c.source_reference_id
LIMIT 1`,
    mock: () => [{ ...MOCK_DETAIL }],
  },

  /** C3 — merged chronological timeline: order-system events + station-app floor events. */
  order_timeline: {
    description:
      'Every event for one order, merged chronologically from two sources: fcm_api_orderevent (order-system lifecycle, issues, holds — src=order) and manufacturing_events_manufacturingevent (station-app floor scans with station/operator/lot — src=floor; floor data exists since 2026-07-02 only). details is the raw JSON event payload.',
    source: 'fcm_api_orderevent + manufacturing_events_manufacturingevent + mes_station_station + mes_station_operator',
    maxAge: 300,
    params: zOrderId,
    sql: (p) => `
SELECT * FROM (
  SELECT
    CAST(e.timestamp AS STRING) AS ts,
    e.event_type,
    CAST(e.event_data AS STRING) AS details,
    e.needs_attention,
    CAST(e.assigned_to_dept AS STRING) AS assigned_to_dept,
    CAST(e.resolved_at AS STRING) AS resolved_at,
    'order' AS src,
    CAST(NULL AS STRING) AS station,
    CAST(NULL AS STRING) AS operator,
    CAST(NULL AS INT64) AS part_quantity,
    CAST(NULL AS STRING) AS lot_guid
  FROM ${T.orderEvent} e
  WHERE e.order_id = ${p.id}
  UNION ALL
  SELECT
    CAST(me.timestamp AS STRING) AS ts,
    me.event_type,
    CAST(me.payload AS STRING) AS details,
    CAST(NULL AS BOOL) AS needs_attention,
    CAST(NULL AS STRING) AS assigned_to_dept,
    CAST(NULL AS STRING) AS resolved_at,
    'floor' AS src,
    s.name AS station,
    op.name AS operator,
    SAFE_CAST(me.part_quantity AS INT64) AS part_quantity,
    CAST(me.lot_guid AS STRING) AS lot_guid
  FROM ${T.mfgEvent} me
  LEFT JOIN ${T.station} s ON s.id = me.station_id
  LEFT JOIN ${T.operator} op ON op.id = me.operator_id
  WHERE me.order_id = ${p.id}
)
ORDER BY ts
LIMIT 500`,
    mock: () => MOCK_TIMELINE.map((r) => ({ ...r })),
  },

  /** C4 — parts on the order with file volume and the print builds each part landed on. */
  order_parts: {
    description:
      'Parts on one order (fcm_api_orderpart × fcm_api_partfile): part GUID, part file, quantity, part volume (mL), and the print build ids the part was placed on (via fcm_api_printbuildpart, aggregated per part).',
    source: 'fcm_api_orderpart + fcm_api_partfile + fcm_api_printbuildpart',
    maxAge: 300,
    params: zOrderId,
    sql: (p) => `
SELECT
  CAST(op.guid AS STRING) AS order_part_id,
  CAST(op.guid AS STRING) AS part_guid,
  CAST(op.part_file_id AS STRING) AS part_file_id,
  op.quantity,
  SAFE_CAST(pf.volume_ml AS FLOAT64) AS volume_ml,
  COUNT(DISTINCT pbp.print_build_id) AS n_builds,
  STRING_AGG(DISTINCT CAST(pbp.print_build_id AS STRING), ', ') AS build_ids
FROM ${T.orderPart} op
LEFT JOIN ${T.partFile} pf ON pf.guid = op.part_file_id
LEFT JOIN ${T.printBuildPart} pbp ON pbp.order_part_id = op.guid
WHERE op.order_id = ${p.id}
GROUP BY order_part_id, part_guid, part_file_id, op.quantity, volume_ml
ORDER BY order_part_id`,
    mock: () => MOCK_PARTS.map((r) => ({ ...r })),
  },

  /** C5 — Tulip shop-floor lots for the order's MSB id. */
  order_tulip: {
    description:
      'Tulip master_table lots where the order number equals this order\'s MSB internal_display_id: per-lot pipeline status (Lot Created → Wash → Cure → … → Shipped, plus Quarantine/QC Failed), printer serial, print start/finish, shipping-label timestamp and due date. Empty for orders newer than the Tulip sync — that is normal.',
    source: 'formcloud_manufacturing.master_table (Tulip)',
    maxAge: 300,
    params: zInternalId,
    sql: (p) => `
SELECT
  qzfob_part_no AS part_no,
  judyq_status AS status,
  gscor_quantity AS quantity,
  wmdzw_material AS material,
  qiuke_manufacturing_type AS manufacturing_type,
  ccnku_printer_sn AS printer_sn,
  CAST(dhghz_print_starttime AS STRING) AS print_start,
  CAST(pnhtt_print_finishedtime AS STRING) AS print_finished,
  CAST(axclf_shippinglabelcreated_timestamp AS STRING) AS shipping_label_created,
  CAST(boads_due_date AS STRING) AS due_date,
  CAST(_updatedAt AS STRING) AS updated_at
FROM ${T.tulipMaster}
WHERE eyjfy_order_no = ${sqlString(p.internalDisplayId)}
ORDER BY updated_at DESC
LIMIT 200`,
    mock: () => MOCK_TULIP.map((r) => ({ ...r })),
  },

  /** C6 — severity-ranked triage board of open orders. */
  problem_orders: {
    description:
      "Every open production order (ACCEPTED / PRINTING / ON_HOLD), oldest governed due date first. Per order: customer email + lifetime stats (order count and LTV = sum of bookings across the customer's non-cancelled orders, matched on email), materials, lagging production stage (earliest pipeline stage with outstanding work: no build yet → printing → wash/lot split → post-processing → quarantine → ready to ship; build/lot signals exist since station-app go-live 2026-07-02 and Fuse X1 prints are unlogged in Tulip, so those orders can read as 'Printing'), parts_ready (MES-style ready-to-ship: per line item, parts in station lots whose latest event is Binned — scanned onto the fulfillment's consolidation shelf — capped at the ordered quantity, plus parts on lines MES's ORDER_PARTS_NOT_PROGRESSING watchdog once flagged but no longer does, which proves they progressed inside MES-only lots the station apps never logged; still a floor — smooth flow through unlogged lots stays invisible until the MES lot table is synced to BigQuery) vs parts_total (ordered part quantity), parts_manual_queue (part quantity in print builds still PENDING that never fired an ORDER_PRINTING event — builds needing manual re-queueing), and yield components (parts_printed = build part quantity on builds with a Tulip print-complete; parts_alive = parts_printed minus observed lot scrap (Tulip original-minus-current quantity) minus parts in lots currently parked in quarantine — printed parts not yet scanned into a lot are presumed alive, so pre-wash losses are not yet visible). days_overdue vs the governed due date; issue events = build failure / reprint / quarantine / mfg issue in 30d. The global date range does not apply — this is live WIP.",
    source:
      'fcm_api_order/orderevent/orderpart/printbuild(+parts) + medusa order (email) + manufacturing_events + formcloud_manufacturing.master_table (Tulip)',
    maxAge: 300,
    params: zProblem,
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(
      `o.status IN ('ACCEPTED', 'PRINTING', 'ON_HOLD') AND IFNULL(o.include_in_reporting, TRUE)`,
      ctx.exclusions.revenueSentinelBillingId,
    )},
last_ev AS (
  SELECT order_id, MAX(timestamp) AS last_ts
  FROM ${T.orderEvent}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
issues AS (
  SELECT order_id, COUNT(*) AS issue_events_30d
  FROM ${T.orderEvent}
  WHERE order_id IN (SELECT id FROM classified)
    AND event_type IN (${ISSUE_EVENT_TYPES.map((t) => sqlString(t)).join(', ')})
    AND timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  GROUP BY order_id
),
mats AS (
  SELECT order_id,
         STRING_AGG(DISTINCT NULLIF(material, ''), ', ' ORDER BY NULLIF(material, '')) AS materials,
         STRING_AGG(DISTINCT NULLIF(manufacturing_type, ''), ', ' ORDER BY NULLIF(manufacturing_type, '')) AS mfg_types,
         SUM(quantity) AS parts_total
  FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM classified)
  GROUP BY order_id
),
matdet AS (
  -- Per-material line-item and part counts, for the Mixed hover breakdown.
  SELECT order_id,
         TO_JSON_STRING(ARRAY_AGG(STRUCT(code, n_lines, n_parts) ORDER BY code)) AS materials_detail
  FROM (
    SELECT order_id, IFNULL(NULLIF(material, ''), 'Unknown') AS code, COUNT(*) AS n_lines, SUM(quantity) AS n_parts
    FROM ${T.orderPart}
    WHERE order_id IN (SELECT id FROM classified)
    GROUP BY order_id, code
  )
  GROUP BY order_id
),
cust AS (
  SELECT LOWER(m2.email) AS email, COUNT(*) AS cust_orders, SUM(${bookingsExpr('o2')}) AS cust_ltv
  FROM ${T.order} o2
  JOIN ${T.medusaOrder} m2 ON m2.id = o2.source_reference_id
  WHERE o2.status NOT IN ('QUOTING', 'CANCELLED', 'REJECTED')
    AND LOWER(m2.email) IN (SELECT DISTINCT LOWER(medusa_email) FROM classified WHERE medusa_email IS NOT NULL)
  GROUP BY 1
),
builds AS (
  SELECT op.order_id, pb.guid, ANY_VALUE(pb.status) AS bstatus, SUM(pbp.quantity) AS qty
  FROM ${T.printBuild} pb
  JOIN ${T.printBuildPart} pbp ON pbp.print_build_id = pb.guid
  JOIN ${T.orderPart} op ON op.guid = pbp.order_part_id
  WHERE op.order_id IN (SELECT id FROM classified)
  GROUP BY op.order_id, pb.guid
),
pevt AS (
  -- Builds that actually printed fire ORDER_PRINTING with their build id;
  -- printbuild.status alone is sticky, so require both signals.
  SELECT DISTINCT JSON_VALUE(event_data, '$.print_build_id') AS guid
  FROM ${T.orderEvent}
  WHERE event_type = 'ORDER_PRINTING' AND order_id IN (SELECT id FROM classified)
),
bt AS (
  SELECT br.print_build_id AS guid, MAX(t.pe) AS pe
  FROM (
    SELECT DISTINCT lot_guid, print_build_id FROM ${T.mfgEvent}
    WHERE source = 'STATION_APP' AND lot_guid IS NOT NULL AND print_build_id IS NOT NULL
  ) br
  JOIN (
    SELECT nphse_guid, MAX(pnhtt_print_finishedtime) AS pe
    FROM ${T.tulipMaster} GROUP BY nphse_guid
  ) t ON t.nphse_guid = br.lot_guid
  GROUP BY br.print_build_id
),
bagg AS (
  SELECT b.order_id,
         COUNT(*) AS n_builds,
         COUNTIF(bt.pe IS NOT NULL) AS n_printed,
         SUM(IF(bt.pe IS NOT NULL, b.qty, 0)) AS parts_printed,
         -- Manual print queue: PENDING build that never fired a print event.
         SUM(IF(b.bstatus = 'PENDING' AND pv.guid IS NULL, b.qty, 0)) AS parts_manual_queue
  FROM builds b
  LEFT JOIN bt ON bt.guid = b.guid
  LEFT JOIN pevt pv ON pv.guid = b.guid
  GROUP BY b.order_id
),
tq AS (
  SELECT nphse_guid,
         MAX(SAFE_CAST(gscor_quantity AS FLOAT64)) AS q0,
         MAX(SAFE_CAST(sroeo_current_quantity AS FLOAT64)) AS q1
  FROM ${T.tulipMaster} GROUP BY nphse_guid
),
lots AS (
  SELECT e.order_id, e.lot_guid,
         MAX(IF(e.event_type = 'Binned', 1, 0)) AS binned,
         MAX(IF(e.event_type = 'Quarantine - Routing', 1, 0)) AS quar,
         -- Latest state scan: a lot whose most recent state is still
         -- Quarantine - Routing is parked, not in active production.
         ARRAY_AGG(e.event_type ORDER BY e.timestamp DESC LIMIT 1)[OFFSET(0)] = 'Quarantine - Routing' AS in_quarantine
  FROM ${T.mfgEvent} e
  WHERE e.source = 'STATION_APP' AND e.lot_guid IS NOT NULL
    AND e.order_id IN (SELECT id FROM classified)
    AND e.event_type IN ('LOT_SPLIT', 'Lot Created', 'Cure Started', 'Pending Finishing', 'Finishing Started',
                         'Pending Binning', 'Binned', 'Quarantine - Routing', 'Waiting to Repeat MediaBlast')
  GROUP BY e.order_id, e.lot_guid
),
lagg AS (
  SELECT l.order_id,
         COUNT(*) AS lots_seen,
         SUM(l.binned) AS lots_binned,
         SUM(l.quar) AS lots_quar,
         -- Observed processing scrap: lot entered with q0 parts, currently q1.
         CAST(ROUND(SUM(GREATEST(IFNULL(tq.q0, 0) - IFNULL(tq.q1, IFNULL(tq.q0, 0)), 0))) AS INT64) AS parts_scrapped,
         CAST(ROUND(SUM(IF(l.in_quarantine, IFNULL(tq.q1, IFNULL(tq.q0, 1)), 0))) AS INT64) AS parts_quarantined
  FROM lots l
  LEFT JOIN tq ON tq.nphse_guid = l.lot_guid
  GROUP BY l.order_id
),
lot_state AS (
  -- Current stage of every station-tracked lot = its latest event of ANY type
  -- (event columns order_part_id / part_quantity are first-class, no JSON).
  SELECT order_id, lot_guid,
         ARRAY_AGG(STRUCT(event_type, order_part_id, part_quantity)
                   ORDER BY timestamp DESC, id DESC LIMIT 1)[OFFSET(0)] AS last
  FROM ${T.mfgEvent}
  WHERE lot_guid IS NOT NULL AND order_id IN (SELECT id FROM classified)
  GROUP BY order_id, lot_guid
),
line_lot AS (
  SELECT order_id, last.order_part_id AS op_guid,
         SUM(IF(last.event_type = 'Binned', last.part_quantity, 0)) AS binned_qty,
         SUM(last.part_quantity) AS tracked_qty
  FROM lot_state
  GROUP BY 1, 2
),
np_lines AS (
  -- MES's stuck-parts watchdog names line items in older flags but not the
  -- latest one => those parts progressed inside MES-only lots that the
  -- station apps never logged (zero event rows).
  SELECT order_id, JSON_VALUE(item, '$.line_item_id') AS op_guid,
         LOGICAL_OR(rn = 1) AS stuck_in_latest
  FROM (
    SELECT order_id, event_data,
           ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY timestamp DESC, id DESC) AS rn
    FROM ${T.orderEvent}
    WHERE event_type = 'ORDER_PARTS_NOT_PROGRESSING' AND order_id IN (SELECT id FROM classified)
  ), UNNEST(JSON_EXTRACT_ARRAY(event_data, '$.stuck_line_items')) AS item
  GROUP BY 1, 2
),
ready AS (
  -- MES "Ready to Ship": binned lot quantity capped per line at ordered qty
  -- (reprints overproduce), plus full credit for untracked parts on lines the
  -- watchdog cleared. The MES lot table itself is not synced to BigQuery, so
  -- this is a floor: smooth flow through unlogged lots stays invisible.
  SELECT op.order_id,
         SUM(LEAST(op.quantity, IFNULL(ll.binned_qty, 0))
             + IF(npl.op_guid IS NOT NULL AND NOT npl.stuck_in_latest,
                  GREATEST(op.quantity - IFNULL(ll.tracked_qty, 0), 0), 0)) AS parts_ready
  FROM ${T.orderPart} op
  LEFT JOIN line_lot ll ON ll.order_id = op.order_id AND ll.op_guid = op.guid
  LEFT JOIN np_lines npl ON npl.order_id = op.order_id AND npl.op_guid = op.guid
  WHERE op.order_id IN (SELECT id FROM classified)
  GROUP BY op.order_id
)
SELECT
  c.id,
  c.source_display_id,
  c.internal_display_id,
  c.status,
  c.reporting_category,
  c.medusa_email AS email,
  CAST(c.submitted_at AS STRING) AS submitted_at,
  CAST(${governedDueDateExpr('c')} AS STRING) AS ship_by,
  GREATEST(IFNULL(DATE_DIFF(${CURRENT_DATE_ET}, ${governedDueDateExpr('c')}, DAY), 0), 0) AS days_overdue,
  IFNULL(GREATEST(DATE_DIFF(${CURRENT_DATE_ET}, DATE(COALESCE(le.last_ts, c.submitted_at, c.created_at)), DAY), 0), 0) AS days_since_last_event,
  IFNULL(i.issue_events_30d, 0) AS issue_events_30d,
  ${bookingsExpr('c')} AS bookings,
  m.materials,
  m.mfg_types,
  md.materials_detail,
  IFNULL(cu.cust_orders, 1) AS cust_orders,
  IFNULL(cu.cust_ltv, ${bookingsExpr('c')}) AS cust_ltv,
  CASE
    WHEN IFNULL(bg.n_builds, 0) = 0 THEN 'No build yet'
    WHEN bg.n_printed < bg.n_builds THEN 'Printing'
    WHEN IFNULL(lg.lots_seen, 0) = 0 THEN 'Wash / lot split'
    WHEN lg.lots_binned + lg.lots_quar < lg.lots_seen THEN 'Post-processing'
    WHEN lg.lots_quar > 0 THEN 'Quarantine'
    ELSE 'Ready to ship'
  END AS lagging_stage,
  GREATEST(IFNULL(bg.parts_printed, 0) - IFNULL(lg.parts_scrapped, 0) - IFNULL(lg.parts_quarantined, 0), 0) AS parts_alive,
  IFNULL(bg.parts_printed, 0) AS parts_printed,
  IFNULL(rd.parts_ready, 0) AS parts_ready,
  IFNULL(m.parts_total, 0) AS parts_total,
  IFNULL(bg.parts_manual_queue, 0) AS parts_manual_queue
FROM classified c
LEFT JOIN last_ev le ON le.order_id = c.id
LEFT JOIN issues i ON i.order_id = c.id
LEFT JOIN mats m ON m.order_id = c.id
LEFT JOIN matdet md ON md.order_id = c.id
LEFT JOIN cust cu ON cu.email = LOWER(c.medusa_email)
LEFT JOIN bagg bg ON bg.order_id = c.id
LEFT JOIN lagg lg ON lg.order_id = c.id
LEFT JOIN ready rd ON rd.order_id = c.id
WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
ORDER BY ${governedDueDateExpr('c')} ASC NULLS LAST, days_overdue DESC
LIMIT 400`,
    mock: (p) => {
      const r = rng('problem_orders_v2')
      const statuses = ['PRINTING', 'ACCEPTED', 'ON_HOLD'] as const
      const stages = ['No build yet', 'Printing', 'Wash / lot split', 'Post-processing', 'Quarantine', 'Ready to ship']
      const mats = ['FLGPGR05', 'FLGPBK05', 'FLP12G01', 'FLTO2002', 'FLGPGR05, FLP12G01']
      const typeOf = (code: string) => (code.startsWith('FLP1') || code.startsWith('FLTP') ? 'SLS - Fuse 1+' : 'SLA - Form 4L')
      const rows: Row[] = []
      for (let i = 0; i < 24; i++) {
        const status = statuses[i % statuses.length]
        const daysOverdue = Math.max(0, randInt(r, -3, 12))
        const shipBy = daysOverdue > 0 ? daysAgoIso(daysOverdue) : daysAgoIso(-randInt(r, 1, 6))
        const printed = randInt(r, 4, 60)
        const bookings = Math.round((150 + r() * 900) * 100) / 100
        const custOrders = Math.max(1, randInt(r, -4, 12))
        rows.push({
          id: 2001 + i,
          source_display_id: `FN-${2001 + i}`,
          internal_display_id: `MSB-${String(2001 + i).padStart(6, '0')}`,
          status,
          reporting_category: pick(r, MOCK_CHANNELS),
          email: r() < 0.85 ? `customer${randInt(r, 1, 14)}@example.com` : null,
          submitted_at: `${daysAgoIso(daysOverdue + randInt(r, 3, 12))}T10:00:00Z`,
          ship_by: shipBy,
          days_overdue: daysOverdue,
          days_since_last_event: randInt(r, 0, 8),
          issue_events_30d: Math.max(0, randInt(r, -2, 3)),
          bookings,
          materials: pick(r, mats),
          mfg_types: '',
          materials_detail: '',
          cust_orders: custOrders,
          cust_ltv: Math.round(bookings * custOrders * (0.6 + r())),
          lagging_stage: pick(r, stages),
          parts_alive: Math.max(0, printed - randInt(r, 0, 6)),
          parts_printed: printed,
          parts_ready: Math.max(0, printed - randInt(r, 0, printed)),
          parts_total: printed + randInt(r, 0, 20),
          parts_manual_queue: r() < 0.2 ? randInt(r, 1, 12) : 0,
        })
      }
      for (const row of rows) {
        const codes = String(row.materials).split(', ')
        row.mfg_types = [...new Set(codes.map(typeOf))].sort().join(', ')
        row.materials_detail = JSON.stringify(
          codes.map((code) => ({ code, n_lines: randInt(r, 1, 3), n_parts: randInt(r, 1, 40) })),
        )
      }
      const filtered = p.channels.length
        ? rows.filter((row) => (p.channels as string[]).includes(String(row.reporting_category)))
        : rows
      return filtered.sort((a, b) => String(a.ship_by).localeCompare(String(b.ship_by)))
    },
  },
}
