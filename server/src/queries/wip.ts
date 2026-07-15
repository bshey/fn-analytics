import { z } from 'zod'
import type { QueryRegistry, Row } from '../registry.js'
import {
  T,
  zBaseFilters,
  zChannels,
  sqlDate,
  sqlStringList,
  grainExpr,
  classifiedOrdersCTEs,
  classifiedChannelFilter,
  bookingsExpr,
  governedDueDateExpr,
  orderPartFilters,
  CURRENT_DATE_ET,
  CLOSED_ORDER_STATUSES,
} from '../sql.js'
import { rng, randInt, pick, periodsBetween, daysAgoIso, MOCK_CHANNELS, CHANNEL_WEIGHT } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module B — Throughput & WIP (daily triage board). Spec §5 Module B, §8.5.
// wip_snapshot is a point-in-time scan of all open orders (no date range —
// the open set is small); wip_event_trends and wip_backlog_series are bounded
// by the global range.
// ---------------------------------------------------------------------------

const zSnapshot = z.object({ channels: zChannels })

/** Weighted pick of a reporting category matching real channel mix. */
function pickChannel(r: () => number): string {
  const roll = r()
  let acc = 0
  for (const ch of MOCK_CHANNELS) {
    acc += CHANNEL_WEIGHT[ch] ?? 0.1
    if (roll < acc) return ch
  }
  return MOCK_CHANNELS[0]
}

function pickStatus(r: () => number): string {
  const roll = r()
  if (roll < 0.18) return 'QUOTING'
  if (roll < 0.5) return 'ACCEPTED'
  if (roll < 0.88) return 'PRINTING'
  return 'ON_HOLD'
}

export const wipQueries: QueryRegistry = {
  /**
   * B1 — one open-order scan powering the funnel, aging histogram, past-due
   * board and stuck board (all derived client-side from these rows).
   */
  wip_snapshot: {
    description:
      'Point-in-time snapshot of every open order (status not SHIPPED / CANCELLED / REJECTED). QUOTING rows are included only when the quote saw activity in the last 30 days — the warehouse holds thousands of stale, abandoned quotes that are not real WIP. age_days = days since accepted_at (falling back to submitted_at, then created_at). past_due / days_overdue compare the promised ship_by date to today. last_event_at / last_event_type come from the most recent order event; has_not_progressing flags any ORDER_PARTS_NOT_PROGRESSING event in the last 30 days. Bookings = subtotal + shipping + tax + credit. The global date range does not apply — this is live WIP.',
    source: 'fcm_api_order + fcm_api_orderevent + fcm_api_orderpart (+ medusa order for channel)',
    maxAge: 300,
    params: zSnapshot,
    sql: (p, ctx) => `
WITH ${classifiedOrdersCTEs(
      `o.status NOT IN (${sqlStringList(CLOSED_ORDER_STATUSES)}) AND IFNULL(o.include_in_reporting, TRUE)
    AND (o.status != 'QUOTING'
         OR DATE(COALESCE(o.updated_at, o.created_at)) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY))`,
      ctx.exclusions.revenueSentinelBillingId,
    )},
ev AS (
  SELECT
    e.order_id,
    MAX(e.timestamp) AS last_event_at,
    ARRAY_AGG(e.event_type ORDER BY e.timestamp DESC LIMIT 1)[OFFSET(0)] AS last_event_type,
    COUNTIF(e.event_type = 'ORDER_PARTS_NOT_PROGRESSING'
            AND e.timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)) AS n_not_progressing
  FROM ${T.orderEvent} e
  WHERE e.order_id IN (SELECT id FROM orders)
  GROUP BY e.order_id
),
op AS (
  SELECT order_id, SUM(quantity) AS n_parts, COUNT(DISTINCT part_file_id) AS n_unique_parts
  FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM orders)
  GROUP BY order_id
)
SELECT
  c.internal_display_id,
  c.source_display_id,
  c.status,
  c.reporting_category,
  IFNULL(c.manufacturing_location, 'Unknown') AS manufacturing_location,
  ${bookingsExpr('c')} AS bookings,
  CAST(DATE(c.submitted_at) AS STRING) AS submitted_at,
  CAST(DATE(c.accepted_at) AS STRING) AS accepted_at,
  CAST(${governedDueDateExpr('c')} AS STRING) AS ship_by,
  DATE_DIFF(${CURRENT_DATE_ET}, DATE(COALESCE(c.accepted_at, c.submitted_at, c.created_at)), DAY) AS age_days,
  (c.ship_by IS NOT NULL AND ${governedDueDateExpr('c')} < ${CURRENT_DATE_ET}) AS past_due,
  CASE WHEN c.ship_by IS NOT NULL AND ${governedDueDateExpr('c')} < ${CURRENT_DATE_ET}
       THEN DATE_DIFF(${CURRENT_DATE_ET}, ${governedDueDateExpr('c')}, DAY) ELSE 0 END AS days_overdue,
  FORMAT_TIMESTAMP('%FT%TZ', ev.last_event_at) AS last_event_at,
  DATE_DIFF(${CURRENT_DATE_ET}, DATE(ev.last_event_at), DAY) AS days_since_event,
  ev.last_event_type,
  (IFNULL(ev.n_not_progressing, 0) > 0) AS has_not_progressing,
  IFNULL(op.n_parts, 0) AS n_parts,
  IFNULL(op.n_unique_parts, 0) AS n_unique_parts
FROM classified c
LEFT JOIN ev ON ev.order_id = c.id
LEFT JOIN op ON op.order_id = c.id
WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
ORDER BY past_due DESC, days_overdue DESC, age_days DESC
LIMIT 2000`,
    mock: (p) => {
      const r = rng('wip_snapshot_v1')
      const rows: Row[] = []
      for (let i = 0; i < 62; i++) {
        const reporting_category = pickChannel(r)
        const status = pickStatus(r)
        // Age skews young; a tail of older orders.
        const age_days = Math.floor(Math.pow(r(), 1.7) * 16)
        const submittedDaysAgo = age_days + (status === 'QUOTING' ? 0 : randInt(r, 0, 2))
        const submitted_at = daysAgoIso(submittedDaysAgo)
        const accepted_at = status === 'QUOTING' ? null : daysAgoIso(age_days)
        // Promised date = submitted + 3..9 day lead; older orders drift past due.
        const shipByDaysAgo = submittedDaysAgo - randInt(r, 3, 9)
        const ship_by = status === 'QUOTING' && r() < 0.5 ? null : daysAgoIso(shipByDaysAgo)
        const past_due = ship_by !== null && shipByDaysAgo > 0
        const days_overdue = past_due ? shipByDaysAgo : 0
        // ~20% of orders have gone quiet (stuck); the rest saw activity in the last 2 days.
        const days_since_event = Math.min(age_days + 1, r() < 0.2 ? randInt(r, 3, 9) : randInt(r, 0, 2))
        const has_not_progressing = r() < 0.12
        const last_event_type = has_not_progressing && r() < 0.6
          ? 'ORDER_PARTS_NOT_PROGRESSING'
          : status === 'QUOTING'
            ? 'ORDER_SUBMITTED_BY_CUSTOMER'
            : status === 'ON_HOLD'
              ? 'ORDER_PLACED_ON_HOLD'
              : status === 'ACCEPTED'
                ? pick(r, ['ORDER_ACCEPTED', 'ORDER_CLEARED_FOR_PRODUCTION'])
                : pick(r, ['ORDER_PRINTING', 'SHIPPING_UPDATE', 'PART_NEEDS_REPRINT', 'MANUFACTURING_ISSUE'])
        const revenue = !reporting_category.includes('Non-Revenue')
        const n_unique_parts = randInt(r, 1, 6)
        rows.push({
          internal_display_id: `MSB${(81000 + i * 7).toString()}`,
          source_display_id: `FN-${4200 + i}`,
          status,
          reporting_category,
          manufacturing_location: pick(r, ['Somerville', 'Milwaukee']),
          bookings: revenue ? Math.round(120 + r() * 950) : 0,
          submitted_at,
          accepted_at,
          ship_by,
          age_days,
          past_due,
          days_overdue,
          last_event_at: `${daysAgoIso(days_since_event)}T${String(randInt(r, 8, 18)).padStart(2, '0')}:${String(randInt(r, 0, 59)).padStart(2, '0')}:00Z`,
          days_since_event,
          last_event_type,
          has_not_progressing,
          n_parts: n_unique_parts * randInt(r, 1, 4),
          n_unique_parts,
        })
      }
      const filtered = p.channels.length
        ? rows.filter((x) => (p.channels as string[]).includes(x.reporting_category as string))
        : rows
      return filtered.sort((a, b) => {
        if (a.past_due !== b.past_due) return a.past_due ? -1 : 1
        if (a.days_overdue !== b.days_overdue) return (b.days_overdue as number) - (a.days_overdue as number)
        return (b.age_days as number) - (a.age_days as number)
      })
    },
  },

  /**
   * B2 — pipeline event trends: counts of stage events per period for one
   * entity family (order / build / lot), each with an entity count and a part
   * count so the UI can toggle units. Event→timestamp mappings reuse the
   * verified pipeline recon (see pipeline_dwell): Tulip print/wash times reach
   * builds via the station-app lot↔build bridge; lot part counts come from the
   * Tulip lot quantity. Build/lot families exist since station-app go-live
   * (2026-07-02); order family covers all history.
   */
  wip_event_trends: {
    description:
      "Pipeline event counts per period × event for one family. family=order: 'Order accepted' (accepted_at), 'In production' (first ORDER_PRINTING event), 'Order shipped' (shipped_at); parts = order part quantity. family=build: 'Build submitted' (printbuild.created_at), 'Print started'/'Print complete' (Tulip via station-app bridge), 'Wash/sift scan' (Tulip wash end / sift start); parts = build part quantity. family=lot: 'Lot created' (LOT_SPLIT), 'Cure started', 'Finishing started', 'Binned / ready to ship' (first occurrence per lot); parts = Tulip lot quantity (fallback 1). Channel filters at order level; material/mfg filters part-level for build/lot, any-part for order.",
    source:
      'fcm_api_order/orderevent/orderpart/printbuild(+parts) + manufacturing_events (station app) + formcloud_manufacturing.master_table (Tulip)',
    maxAge: 600,
    params: zBaseFilters.extend({ family: z.enum(['order', 'build', 'lot']).default('order') }),
    sql: (p, ctx) => {
      const partConds: string[] = []
      if (p.materials.length) partConds.push(`op2.material IN (${sqlStringList(p.materials)})`)
      if (p.mfgTypes.length) partConds.push(`op2.manufacturing_type IN (${sqlStringList(p.mfgTypes)})`)
      const partFilter = partConds.length ? `AND ${partConds.join(' AND ')}` : ''
      const head = `
WITH ${classifiedOrdersCTEs(
        `IFNULL(o.include_in_reporting, TRUE) AND o.status != 'QUOTING'
    AND DATE(o.submitted_at) BETWEEN DATE_SUB(${sqlDate(p.start)}, INTERVAL 90 DAY) AND ${sqlDate(p.end)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )},
flt AS (
  SELECT c.id, c.accepted_at, c.shipped_at
  FROM classified c
  WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
    ${orderPartFilters(p, 'c')}
)`
      const tail = `
SELECT
  CAST(${grainExpr('d', p.grain)} AS STRING) AS period,
  event,
  COUNT(*) AS entities,
  CAST(ROUND(SUM(parts)) AS INT64) AS parts
FROM ev
WHERE d BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)} AND d <= CURRENT_DATE()
GROUP BY period, event
ORDER BY period, event`
      if (p.family === 'order')
        return `${head},
op AS (
  SELECT order_id, SUM(quantity) AS qty FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM flt) GROUP BY order_id
),
printing AS (
  SELECT order_id, MIN(timestamp) AS ts FROM ${T.orderEvent}
  WHERE event_type = 'ORDER_PRINTING' AND order_id IN (SELECT id FROM flt)
  GROUP BY order_id
),
ev AS (
  SELECT 'Order accepted' AS event, DATE(f.accepted_at) AS d, IFNULL(op.qty, 0) AS parts
  FROM flt f LEFT JOIN op ON op.order_id = f.id WHERE f.accepted_at IS NOT NULL
  UNION ALL
  SELECT 'In production', DATE(pr.ts), IFNULL(op.qty, 0)
  FROM printing pr LEFT JOIN op ON op.order_id = pr.order_id
  UNION ALL
  SELECT 'Order shipped', DATE(f.shipped_at), IFNULL(op.qty, 0)
  FROM flt f LEFT JOIN op ON op.order_id = f.id WHERE f.shipped_at IS NOT NULL
)${tail}`
      if (p.family === 'build')
        return `${head},
builds AS (
  SELECT pb.guid, pb.created_at, SUM(pbp.quantity) AS parts
  FROM ${T.printBuild} pb
  JOIN ${T.printBuildPart} pbp ON pbp.print_build_id = pb.guid
  JOIN ${T.orderPart} op2 ON op2.guid = pbp.order_part_id
  WHERE op2.order_id IN (SELECT id FROM flt) ${partFilter}
    AND pb.created_at >= TIMESTAMP(DATE_SUB(${sqlDate(p.start)}, INTERVAL 60 DAY))
  GROUP BY pb.guid, pb.created_at
),
bridge AS (
  SELECT DISTINCT lot_guid, print_build_id FROM ${T.mfgEvent}
  WHERE source = 'STATION_APP' AND lot_guid IS NOT NULL AND print_build_id IS NOT NULL
),
tulip AS (
  SELECT m.nphse_guid AS lot_guid,
         MIN(m.dhghz_print_starttime) AS print_start,
         MAX(m.pnhtt_print_finishedtime) AS print_end,
         MIN(COALESCE(m.obssa_wash_end_timestamp, SAFE.PARSE_TIMESTAMP('%FT%T%Ez', m.lzdll_sift_started_at))) AS wash_at
  FROM ${T.tulipMaster} m
  WHERE m._createdAt >= TIMESTAMP(DATE_SUB(${sqlDate(p.start)}, INTERVAL 60 DAY))
  GROUP BY m.nphse_guid
),
bstage AS (
  SELECT b.guid, MIN(t.print_start) AS ps, MAX(t.print_end) AS pe, MIN(t.wash_at) AS w
  FROM builds b
  JOIN bridge br ON br.print_build_id = b.guid
  JOIN tulip t ON t.lot_guid = br.lot_guid
  GROUP BY b.guid
),
ev AS (
  SELECT 'Build submitted' AS event, DATE(b.created_at) AS d, b.parts FROM builds b
  UNION ALL
  SELECT 'Print started', DATE(s.ps), b.parts FROM builds b JOIN bstage s ON s.guid = b.guid WHERE s.ps IS NOT NULL
  UNION ALL
  SELECT 'Print complete', DATE(s.pe), b.parts FROM builds b JOIN bstage s ON s.guid = b.guid WHERE s.pe IS NOT NULL
  UNION ALL
  SELECT 'Wash/sift scan', DATE(s.w), b.parts FROM builds b JOIN bstage s ON s.guid = b.guid WHERE s.w IS NOT NULL
)${tail}`
      return `${head},
tq AS (
  SELECT nphse_guid, MAX(SAFE_CAST(gscor_quantity AS FLOAT64)) AS qty
  FROM ${T.tulipMaster} GROUP BY nphse_guid
),
lev AS (
  SELECT e.lot_guid, e.event_type, MIN(e.timestamp) AS ts, ANY_VALUE(e.order_part_id) AS opid
  FROM ${T.mfgEvent} e
  WHERE e.source = 'STATION_APP' AND e.lot_guid IS NOT NULL
    AND e.event_type IN ('LOT_SPLIT', 'Cure Started', 'Finishing Started', 'Binned')
  GROUP BY e.lot_guid, e.event_type
),
ev AS (
  SELECT
    CASE l.event_type
      WHEN 'LOT_SPLIT' THEN 'Lot created'
      WHEN 'Cure Started' THEN 'Cure started'
      WHEN 'Finishing Started' THEN 'Finishing started'
      ELSE 'Binned / ready to ship' END AS event,
    DATE(l.ts) AS d,
    IFNULL(tq.qty, 1) AS parts
  FROM lev l
  JOIN ${T.orderPart} op2 ON op2.guid = l.opid
  LEFT JOIN tq ON tq.nphse_guid = l.lot_guid
  WHERE op2.order_id IN (SELECT id FROM flt) ${partFilter}
)${tail}`
    },
    mock: (p) => {
      const r = rng(`wip_ev:${p.family}:${p.grain}`)
      const events =
        p.family === 'order'
          ? [['Order accepted', 9], ['In production', 8.5], ['Order shipped', 8]]
          : p.family === 'build'
            ? [['Build submitted', 14], ['Print started', 13], ['Print complete', 12.5], ['Wash/sift scan', 12]]
            : [['Lot created', 30], ['Cure started', 12], ['Finishing started', 7], ['Binned / ready to ship', 26]]
      const scale = p.grain === 'day' ? 1 : p.grain === 'week' ? 7 : p.grain === 'month' ? 30 : p.grain === 'quarter' ? 91 : 365
      const chFrac = p.channels.length
        ? (p.channels as string[]).reduce((acc: number, ch: string) => acc + (CHANNEL_WEIGHT[ch] ?? 0.1), 0)
        : 1
      const rows: Row[] = []
      for (const period of periodsBetween(p.start, p.end, p.grain)) {
        for (const [event, base] of events as [string, number][]) {
          const entities = Math.round(base * (0.55 + r() * 0.9) * scale * chFrac)
          if (entities > 0) rows.push({ period, event, entities, parts: Math.round(entities * (2 + r() * 4)) })
        }
      }
      return rows
    },
  },

  /**
   * B3 — end-of-day open backlog series. For each day in range, counts
   * entities open at 23:59:59 ET: orders [accepted_at, shipped_at), builds
   * [created_at, print complete — falling back to wash scan) and lots
   * [LOT_SPLIT, Binned), each with its part quantity. Build/lot series exist
   * since station-app go-live; a build/lot with no recorded end stays open.
   * The client aggregates day rows to the selected grain as an AVERAGE.
   */
  wip_backlog_series: {
    description:
      'End-of-day (23:59 America/New_York) open backlog per day: open_orders / order_parts (accepted, not yet shipped; excludes cancelled/rejected), open_builds / build_parts (printbuild created, print not yet complete — wash scan used as fallback end; builds with no recorded end stay open), open_lots / lot_parts (lot split, not yet binned; part counts from Tulip lot quantity, fallback 1). Build/lot tracking exists since station-app go-live (2026-07-02) — earlier days read 0. Aggregate to coarser grains as an average of the daily values, never a sum. lateFilter restricts the ORDER series to orders late as of each day: late = governed due date before that day; 1..10 = more than N business days (Mon-Fri excl. company holidays) past due as of that day. Build/lot series ignore the lateness cut (due dates are order-level).',
    source:
      'fcm_api_order/orderpart/printbuild(+parts) + manufacturing_events (station app) + formcloud_manufacturing.master_table (Tulip)',
    maxAge: 600,
    params: zBaseFilters.extend({
      /** Order-level lateness cut, evaluated per day: 'late' = governed due date before that day; '1'..'10' = more than N business days past due as of that day. */
      lateFilter: z.enum(['all', 'late', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']).default('all'),
    }),
    sql: (p, ctx) => {
      const partConds: string[] = []
      if (p.materials.length) partConds.push(`op2.material IN (${sqlStringList(p.materials)})`)
      if (p.mfgTypes.length) partConds.push(`op2.manufacturing_type IN (${sqlStringList(p.mfgTypes)})`)
      const partFilter = partConds.length ? `AND ${partConds.join(' AND ')}` : ''
      // Company holidays, mirroring dim_date.is_business_day for 2026 (same
      // list the client's shipping-day calendar uses).
      const holidays = [
        '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
        '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
      ].map((h) => `DATE '${h}'`).join(', ')
      const nLate = /^\d+$/.test(p.lateFilter) ? Number(p.lateFilter) : null
      const lateJoin =
        nLate === null
          ? ''
          : `
  JOIN bizidx bd ON bd.d = dy.d
  JOIN bizidx bdue ON bdue.d = GREATEST(LEAST(f.due_date, ${sqlDate(p.end)}), DATE_SUB(${sqlDate(p.start)}, INTERVAL 400 DAY))`
      const lateCond =
        p.lateFilter === 'all'
          ? ''
          : p.lateFilter === 'late'
            ? 'AND f.due_date IS NOT NULL AND f.due_date < dy.d'
            : `AND f.due_date IS NOT NULL AND (bd.idx - bdue.idx) > ${nLate}`
      return `
WITH ${classifiedOrdersCTEs(
        `IFNULL(o.include_in_reporting, TRUE)
    AND o.status NOT IN ('QUOTING', 'CANCELLED', 'REJECTED')
    AND o.accepted_at IS NOT NULL
    AND DATE(o.submitted_at) >= DATE_SUB(${sqlDate(p.start)}, INTERVAL 180 DAY)
    AND DATE(o.submitted_at) <= ${sqlDate(p.end)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )},
flt AS (
  SELECT c.id, c.accepted_at, c.shipped_at, ${governedDueDateExpr('c')} AS due_date
  FROM classified c
  WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
    ${orderPartFilters(p, 'c')}
),
days AS (
  SELECT d, TIMESTAMP(DATE_ADD(d, INTERVAL 1 DAY), 'America/New_York') AS cutoff
  FROM UNNEST(GENERATE_DATE_ARRAY(${sqlDate(p.start)}, LEAST(${sqlDate(p.end)}, ${CURRENT_DATE_ET}))) AS d
),
bizidx AS (
  -- Running count of business days so "biz days late as of day d" is a cheap
  -- index difference: idx(d) - idx(due_date).
  SELECT x AS d,
         SUM(IF(EXTRACT(DAYOFWEEK FROM x) NOT IN (1, 7) AND x NOT IN (${holidays}), 1, 0)) OVER (ORDER BY x) AS idx
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(${sqlDate(p.start)}, INTERVAL 400 DAY), ${sqlDate(p.end)})) AS x
),
op AS (
  SELECT order_id, SUM(quantity) AS qty FROM ${T.orderPart}
  WHERE order_id IN (SELECT id FROM flt) GROUP BY order_id
),
o_open AS (
  SELECT dy.d, COUNT(*) AS n, SUM(IFNULL(op.qty, 0)) AS parts
  FROM days dy
  JOIN flt f ON f.accepted_at < dy.cutoff AND (f.shipped_at IS NULL OR f.shipped_at >= dy.cutoff)${lateJoin}
  LEFT JOIN op ON op.order_id = f.id
  WHERE TRUE ${lateCond}
  GROUP BY dy.d
),
builds AS (
  SELECT pb.guid, pb.created_at, SUM(pbp.quantity) AS parts
  FROM ${T.printBuild} pb
  JOIN ${T.printBuildPart} pbp ON pbp.print_build_id = pb.guid
  JOIN ${T.orderPart} op2 ON op2.guid = pbp.order_part_id
  WHERE op2.order_id IN (SELECT id FROM flt) ${partFilter}
    AND pb.created_at >= TIMESTAMP(${sqlDate(ctx.exclusions.stationAppDataSince)})
  GROUP BY pb.guid, pb.created_at
),
bridge AS (
  SELECT DISTINCT lot_guid, print_build_id FROM ${T.mfgEvent}
  WHERE source = 'STATION_APP' AND lot_guid IS NOT NULL AND print_build_id IS NOT NULL
),
tulip AS (
  SELECT m.nphse_guid AS lot_guid,
         MAX(m.pnhtt_print_finishedtime) AS print_end,
         MIN(COALESCE(m.obssa_wash_end_timestamp, SAFE.PARSE_TIMESTAMP('%FT%T%Ez', m.lzdll_sift_started_at))) AS wash_at
  FROM ${T.tulipMaster} m
  GROUP BY m.nphse_guid
),
bend AS (
  SELECT b.guid, MAX(COALESCE(t.print_end, t.wash_at)) AS done_at
  FROM builds b
  JOIN bridge br ON br.print_build_id = b.guid
  JOIN tulip t ON t.lot_guid = br.lot_guid
  GROUP BY b.guid
),
b_open AS (
  SELECT dy.d, COUNT(*) AS n, SUM(IFNULL(b.parts, 0)) AS parts
  FROM days dy
  JOIN builds b ON b.created_at < dy.cutoff
  LEFT JOIN bend e ON e.guid = b.guid
  WHERE e.done_at IS NULL OR e.done_at >= dy.cutoff
  GROUP BY dy.d
),
tq AS (
  SELECT nphse_guid, MAX(SAFE_CAST(gscor_quantity AS FLOAT64)) AS qty
  FROM ${T.tulipMaster} GROUP BY nphse_guid
),
lots AS (
  SELECT e.lot_guid, MIN(IF(e.event_type = 'LOT_SPLIT', e.timestamp, NULL)) AS born,
         MIN(IF(e.event_type = 'Binned', e.timestamp, NULL)) AS binned,
         ANY_VALUE(e.order_part_id) AS opid
  FROM ${T.mfgEvent} e
  WHERE e.source = 'STATION_APP' AND e.lot_guid IS NOT NULL
    AND e.event_type IN ('LOT_SPLIT', 'Binned')
  GROUP BY e.lot_guid
),
lflt AS (
  SELECT l.lot_guid, l.born, l.binned, IFNULL(tq.qty, 1) AS parts
  FROM lots l
  JOIN ${T.orderPart} op2 ON op2.guid = l.opid
  LEFT JOIN tq ON tq.nphse_guid = l.lot_guid
  WHERE l.born IS NOT NULL AND op2.order_id IN (SELECT id FROM flt) ${partFilter}
),
l_open AS (
  SELECT dy.d, COUNT(*) AS n, CAST(ROUND(SUM(l.parts)) AS INT64) AS parts
  FROM days dy
  JOIN lflt l ON l.born < dy.cutoff AND (l.binned IS NULL OR l.binned >= dy.cutoff)
  GROUP BY dy.d
)
SELECT
  CAST(dy.d AS STRING) AS date,
  IFNULL(o.n, 0) AS open_orders,
  IFNULL(o.parts, 0) AS order_parts,
  IFNULL(b.n, 0) AS open_builds,
  IFNULL(b.parts, 0) AS build_parts,
  IFNULL(l.n, 0) AS open_lots,
  IFNULL(l.parts, 0) AS lot_parts
FROM days dy
LEFT JOIN o_open o ON o.d = dy.d
LEFT JOIN b_open b ON b.d = dy.d
LEFT JOIN l_open l ON l.d = dy.d
ORDER BY dy.d`
    },
    mock: (p) => {
      const r = rng(`wip_backlog_v1:${p.lateFilter}`)
      const lateFrac = p.lateFilter === 'all' ? 1 : p.lateFilter === 'late' ? 0.45 : 0.4 * Math.pow(0.85, Number(p.lateFilter))
      const chFrac = p.channels.length
        ? (p.channels as string[]).reduce((acc: number, ch: string) => acc + (CHANNEL_WEIGHT[ch] ?? 0.1), 0)
        : 1
      const rows: Row[] = []
      let orders = 70 * chFrac
      const start = new Date(`${p.start}T00:00:00Z`)
      const end = new Date(`${p.end}T00:00:00Z`)
      for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
        orders = Math.max(15 * chFrac, orders + (r() - 0.48) * 8 * chFrac)
        const open_orders = Math.round(orders * lateFrac)
        const open_builds = Math.round(orders * (0.5 + r() * 0.3))
        const open_lots = Math.round(orders * (1.1 + r() * 0.6))
        rows.push({
          date: new Date(t).toISOString().slice(0, 10),
          open_orders,
          order_parts: Math.round(open_orders * (3 + r() * 3)),
          open_builds,
          build_parts: Math.round(open_builds * (4 + r() * 3)),
          open_lots,
          lot_parts: Math.round(open_lots * (2 + r() * 2)),
        })
      }
      return rows
    },
  },
}
