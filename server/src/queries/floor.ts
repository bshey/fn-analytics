import { z } from 'zod'
import type { QueryCtx, QueryRegistry, Row } from '../registry.js'
import {
  T,
  zBaseFilters,
  sqlDate,
  sqlString,
  sqlStringList,
  grainExpr,
  classifiedOrdersCTEs,
  classifiedChannelFilter,
  orderPartFilters,
} from '../sql.js'
import {
  rng,
  randInt,
  pick,
  periodsBetween,
  truncPeriod,
  daysAgoIso,
  MOCK_OPERATORS,
  MOCK_STATIONS,
} from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module D — Stations, Quality & Operators.
// Station-app queries (manufacturing_events) only have data since
// ctx.exclusions.stationAppDataSince (2026-07-02): starts are clamped
// server-side with GREATEST(). Test stations and non-line operators are
// excluded by name (config/exclusions.json) unless includeExcluded=true.
// Tulip / orderevent queries are historical and NOT clamped.
// ---------------------------------------------------------------------------

const zStations = z
  .array(z.string().min(1).max(60).regex(/^[A-Za-z0-9 .,'()_-]+$/, 'station name'))
  .default([])

const zStationTypes = z
  .array(z.enum(['POST_PROCESSING', 'FINISHING', 'QUARANTINE', 'SHIPPING']))
  .default([])

const zFloorStation = zBaseFilters.extend({
  /** Debug switch: skip the test-station / non-line-operator exclusions. */
  includeExcluded: z.boolean().default(false),
  /** Empty = all stations. Names from floor_stations. */
  stations: zStations,
  /** Empty = all station types. The primary floor filter dimension. */
  stationTypes: zStationTypes,
})

const SIGN_EVENTS = `('SIGN_IN', 'SIGN_OUT')`

/**
 * GREATEST(requested start, station-app go-live) — station-app tables have no data before go-live.
 * Operands must be DATE-typed: GREATEST over two string literals yields a STRING,
 * which BigQuery refuses to compare with a DATE in BETWEEN.
 */
function clampedStartExpr(start: string, ctx: QueryCtx): string {
  return `GREATEST(DATE ${sqlDate(start)}, DATE ${sqlDate(ctx.exclusions.stationAppDataSince)})`
}

/** AND-fragment excluding test stations by joined station name. */
function stationExclusion(alias: string, p: { includeExcluded: boolean }, ctx: QueryCtx): string {
  const list = ctx.exclusions.testStations
  if (p.includeExcluded || !list.length) return ''
  return `AND ${alias}.name NOT IN (${sqlStringList(list)})`
}

/** AND-fragment applying the user's station / station-type filters (empty = all). */
function stationFilter(alias: string, p: { stations: string[]; stationTypes: string[] }): string {
  const parts: string[] = []
  if (p.stations.length) parts.push(`AND ${alias}.name IN (${sqlStringList(p.stations)})`)
  if (p.stationTypes.length) parts.push(`AND ${alias}.default_app IN (${sqlStringList(p.stationTypes)})`)
  return parts.join('\n  ')
}

/** AND-fragment excluding non-line operators by joined operator name. */
function operatorExclusion(alias: string, p: { includeExcluded: boolean }, ctx: QueryCtx): string {
  const list = ctx.exclusions.nonLineOperators
  if (p.includeExcluded || !list.length) return ''
  return `AND ${alias}.name NOT IN (${sqlStringList(list)})`
}

// ---------- mock helpers ----------

const GRAIN_SCALE: Record<string, number> = { day: 1 / 7, week: 1, month: 4.3, quarter: 13, year: 52 }

/** Station-type relative volume so mock stations look plausible. */
const TYPE_WEIGHT: Record<string, number> = {
  FINISHING: 1.2,
  POST_PROCESSING: 1.0,
  SHIPPING: 0.8,
  QUARANTINE: 0.15,
}

const MOCK_EXCLUDED_STATION = { name: 'Test', type: 'POST_PROCESSING' }
const MOCK_EXCLUDED_OPERATOR = 'Jacob Haip'

/** Clamp [start, end] to [stationAppDataSince, today]. Returns null when the window is empty. */
function mockStationWindow(p: { start: string; end: string }, ctx: QueryCtx): { start: string; end: string } | null {
  const since = ctx.exclusions.stationAppDataSince
  const today = daysAgoIso(0)
  const start = p.start > since ? p.start : since
  const end = p.end < today ? p.end : today
  return start > end ? null : { start, end }
}

function isWeekend(dayIso: string): boolean {
  const dow = new Date(`${dayIso}T00:00:00Z`).getUTCDay()
  return dow === 0 || dow === 6
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export const floorQueries: QueryRegistry = {
  /** Station registry — options for the Floor page's station filter. */
  floor_stations: {
    description:
      'Station-app station registry: name, type and active flag. Test stations are excluded (config/exclusions.json) unless includeExcluded.',
    source: 'mes_station_station',
    maxAge: 3600,
    params: z.object({ includeExcluded: z.boolean().default(false) }).default({}),
    sql: (p, ctx) => `
SELECT s.name AS station, s.default_app AS station_type, s.is_active
FROM ${T.station} s
WHERE TRUE ${stationExclusion('s', p, ctx)}
ORDER BY s.name`,
    mock: (p) => [
      ...MOCK_STATIONS.map((s) => ({ station: s.name, station_type: s.type, is_active: true })),
      ...(p.includeExcluded ? [{ station: MOCK_EXCLUDED_STATION.name, station_type: MOCK_EXCLUDED_STATION.type, is_active: true }] : []),
    ],
  },

  /**
   * D1 — parts/actions/lots per period × station from the station app.
   */
  floor_station_throughput: {
    description:
      'Station-app activity per period × station: parts = SUM(part_quantity) over all non-sign-in/out events, actions = event count, lots = distinct lot GUIDs touched. Station-app data exists only since go-live (2026-07-02); the requested start is clamped to that date. Test stations are excluded by name (config/exclusions.json) unless includeExcluded. Channel/material/mfg-type filters do not apply (floor events are not order-classified).',
    source: 'manufacturing_events_manufacturingevent + mes_station_station',
    maxAge: 600,
    params: zFloorStation,
    sql: (p, ctx) => `
SELECT
  CAST(${grainExpr('DATE(e.timestamp)', p.grain)} AS STRING) AS period,
  s.name AS station,
  s.default_app AS station_type,
  SUM(IFNULL(SAFE_CAST(e.part_quantity AS INT64), 0)) AS parts,
  COUNT(*) AS actions,
  COUNT(DISTINCT e.lot_guid) AS lots
FROM ${T.mfgEvent} e
JOIN ${T.station} s ON s.id = e.station_id
WHERE e.source = 'STATION_APP'
  AND e.event_type NOT IN ${SIGN_EVENTS}
  AND DATE(e.timestamp) BETWEEN ${clampedStartExpr(p.start, ctx)} AND ${sqlDate(p.end)}
  AND DATE(e.timestamp) <= CURRENT_DATE()
  ${stationExclusion('s', p, ctx)}
  ${stationFilter('s', p)}
GROUP BY period, station, station_type
ORDER BY period, station`,
    mock: (p, ctx) => {
      const win = mockStationWindow(p, ctx)
      if (!win) return []
      const stations = [...MOCK_STATIONS, ...(p.includeExcluded ? [MOCK_EXCLUDED_STATION] : [])]
        .filter((s) => !p.stations.length || p.stations.includes(s.name))
        .filter((s) => !p.stationTypes.length || p.stationTypes.includes(s.type as never))
      const agg = new Map<string, { period: string; station: string; station_type: string; parts: number; actions: number; lots: number }>()
      for (const day of periodsBetween(win.start, win.end, 'day')) {
        const weekendFactor = isWeekend(day) ? 0.12 : 1
        for (const st of stations) {
          const r = rng(`thru:${day}:${st.name}`)
          const w = (TYPE_WEIGHT[st.type] ?? 0.5) * weekendFactor * (st.name === MOCK_EXCLUDED_STATION.name ? 0.1 : 1)
          const parts = Math.round((40 + r() * 90) * w)
          if (parts <= 0) continue
          const lots = Math.max(1, Math.round(parts / (3 + r() * 5)))
          const actions = lots + Math.round(parts * (0.3 + r() * 0.4))
          const period = truncPeriod(day, p.grain)
          const key = `${period}|${st.name}`
          const cur = agg.get(key) ?? { period, station: st.name, station_type: st.type, parts: 0, actions: 0, lots: 0 }
          cur.parts += parts
          cur.actions += actions
          cur.lots += lots
          agg.set(key, cur)
        }
      }
      return [...agg.values()].sort((a, b) => a.period.localeCompare(b.period) || a.station.localeCompare(b.station))
    },
  },

  /**
   * D3 — one row per station-app operator session (spec §8.6).
   */
  floor_sessions: {
    description:
      'One row per station-app session (SIGN_IN…SIGN_OUT bound): operator, station, started_at = MIN(event timestamp), ended_at = MAX(event timestamp), session_hours = TIMESTAMP_DIFF minutes / 60, parts_processed = SUM(part_quantity) of non-sign events, actions = non-sign event count, lots = distinct lots touched. Data exists only since station-app go-live (2026-07-02); start clamped to it. Test stations and non-line operators excluded by name unless includeExcluded. Rates (parts/hour) must be derived client-side as SUM(parts)/SUM(hours), never averaged.',
    source: 'manufacturing_events_manufacturingevent + mes_station_operator + mes_station_station',
    maxAge: 600,
    params: zFloorStation,
    sql: (p, ctx) => `
WITH ev AS (
  SELECT e.session_id, e.operator_id, e.station_id, e.timestamp, e.event_type, e.part_quantity, e.lot_guid
  FROM ${T.mfgEvent} e
  WHERE e.source = 'STATION_APP'
    AND e.session_id IS NOT NULL
    AND e.operator_id IS NOT NULL
    AND DATE(e.timestamp) BETWEEN ${clampedStartExpr(p.start, ctx)} AND ${sqlDate(p.end)}
    AND DATE(e.timestamp) <= CURRENT_DATE()
),
sess AS (
  SELECT
    session_id,
    ANY_VALUE(operator_id) AS operator_id,
    ANY_VALUE(station_id) AS station_id,
    MIN(timestamp) AS started_at,
    MAX(timestamp) AS ended_at,
    SUM(IF(event_type NOT IN ${SIGN_EVENTS}, IFNULL(SAFE_CAST(part_quantity AS INT64), 0), 0)) AS parts_processed,
    COUNTIF(event_type NOT IN ${SIGN_EVENTS}) AS actions,
    COUNT(DISTINCT IF(event_type NOT IN ${SIGN_EVENTS}, lot_guid, NULL)) AS lots
  FROM ev
  GROUP BY session_id
)
SELECT
  sess.session_id,
  op.name AS operator,
  st.name AS station,
  st.default_app AS station_type,
  CAST(sess.started_at AS STRING) AS started_at,
  CAST(sess.ended_at AS STRING) AS ended_at,
  TIMESTAMP_DIFF(sess.ended_at, sess.started_at, MINUTE) / 60.0 AS session_hours,
  sess.parts_processed,
  sess.actions,
  sess.lots
FROM sess
JOIN ${T.operator} op ON op.id = sess.operator_id
JOIN ${T.station} st ON st.id = sess.station_id
WHERE TRUE
  ${operatorExclusion('op', p, ctx)}
  ${stationExclusion('st', p, ctx)}
  ${stationFilter('st', p)}
ORDER BY sess.started_at DESC`,
    mock: (p, ctx) => {
      const win = mockStationWindow(p, ctx)
      if (!win) return []
      const rows: Row[] = []
      const operators = [...MOCK_OPERATORS, ...(p.includeExcluded ? [MOCK_EXCLUDED_OPERATOR] : [])]
      for (const day of periodsBetween(win.start, win.end, 'day')) {
        for (let oi = 0; oi < operators.length; oi++) {
          const operator = operators[oi]
          const excluded = operator === MOCK_EXCLUDED_OPERATOR
          const r = rng(`sess:${day}:${operator}`)
          if (isWeekend(day) && r() > 0.15) continue
          const nSessions = excluded ? 1 : randInt(r, 1, 2)
          for (let k = 0; k < nSessions; k++) {
            const station = excluded ? MOCK_EXCLUDED_STATION : pick(r, MOCK_STATIONS)
            const startHour = 7 + k * 5 + randInt(r, 0, 3)
            const startMin = randInt(r, 0, 59)
            const hours = Math.round((0.75 + r() * 3.5) * 100) / 100
            const rate = (TYPE_WEIGHT[station.type] ?? 0.5) * (10 + r() * 25)
            const parts = Math.max(0, Math.round(hours * rate))
            const lots = Math.max(1, Math.round(parts / (3 + r() * 5)))
            const startedMs = Date.parse(`${day}T${pad2(startHour)}:${pad2(startMin)}:00Z`)
            const endedMs = startedMs + Math.round(hours * 60) * 60_000
            rows.push({
              session_id: `sess-${day}-${oi}-${k}`,
              operator,
              station: station.name,
              station_type: station.type,
              started_at: new Date(startedMs).toISOString(),
              ended_at: new Date(endedMs).toISOString(),
              session_hours: hours,
              parts_processed: parts,
              actions: lots + Math.round(parts * (0.3 + r() * 0.4)),
              lots,
            })
          }
        }
      }
      return rows
        .filter((r) => !p.stations.length || p.stations.includes(String(r.station)))
        .filter((r) => !p.stationTypes.length || p.stationTypes.includes(String(r.station_type) as never))
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
    },
  },

  /**
   * Pipeline dwell — the owner's 9-stage order→ship funnel, each boundary
   * verified against real warehouse data (recon 2026-07-10):
   *   order: accepted → DFM approved → cleared (print queue) … ready → shipped
   *   build: queued → print start → print end → wash/sift scan → lot split
   *   lot:   split → {finishing | bin/ship | quarantine} scan
   * "Quarantine → processed" was removed at owner request: pass/fail updates
   * the MES-internal lot table without reliably emitting warehouse events, so
   * quarantine dwell is unmeasurable until that table is synced to BigQuery.
   * Legacy traps deliberately avoided: started_processing_at (dead since Jun'26),
   * printbuild.status (sticky), zdobb wash start (dead), QC1/2 columns,
   * gpygu quarantine end (dead). Tulip↔build linkage uses the station-app bridge
   * (lot_guid+print_build_id on the same event row), which exists since 2026-07-02 —
   * build/lot stages are effectively station-era.
   *
   * Durations count SHIFT HOURS only (owner request): elapsed time is clipped
   * to the configured shift window (default Mon–Fri 07:30–16:00 ET) so overnight
   * and weekend waiting doesn't inflate dwell. Exception: '04 Printing' stays
   * wall-clock — printers run unattended.
   */
  pipeline_dwell: {
    description:
      "Order→ship pipeline dwell: median SHIFT-HOURS per stage boundary — elapsed time clipped to the configured production shift (shiftDays ISO 1=Mon..7=Sun, shiftStart/shiftEnd ET; default Mon–Fri 07:30–16:00), so off-shift waiting is not counted. '04 Printing' is machine time and stays wall-clock. Order stages (accepted→DFM approved [all parts PASSED/AT_RISK_APPROVED], DFM→cleared-for-production = print-queue entry, ready-to-ship [last lot Binned]→shipped) cover ~98% of orders. Build stages (build queued [printbuild.created_at]→print start→print end [Tulip, via the station-app lot↔build bridge]→wash/sift scan→lot split) and lot tracks (split→finishing scan / bin-ship scan / quarantine scan) exist since station-app go-live 2026-07-02; Form 4 print timestamps ~76% covered, Fuse X1 currently unlogged. There is deliberately NO quarantine→processed stage: pass/fail updates the MES-internal lot table without reliably emitting warehouse events (~2/3 of routed lots have no recorded disposition, most on since-shipped orders), so quarantine dwell is unmeasurable until that table is synced to BigQuery. Channel filters apply at order level; material/mfg-type filters apply exactly at part level for lot stages and as any-part for order/build stages. Durations <0 or >720 shift-hours discarded. Cohort anchor = when the stage COMPLETED.",
    source:
      'fcm_api_order/orderpart/orderevent/printbuild(+parts) + manufacturing_events (station app) + formcloud_manufacturing.master_table (Tulip)',
    params: zBaseFilters.extend({
      shiftDays: z.array(z.number().int().min(1).max(7)).nonempty().default([1, 2, 3, 4, 5]),
      shiftStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('07:30'),
      shiftEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('16:00'),
    }).refine((v) => v.shiftEnd > v.shiftStart, { message: 'shiftEnd must be after shiftStart' }),
    sql: (p, ctx) => {
      const partConds: string[] = []
      if (p.materials.length) partConds.push(`op.material IN (${sqlStringList(p.materials)})`)
      if (p.mfgTypes.length) partConds.push(`op.manufacturing_type IN (${sqlStringList(p.mfgTypes)})`)
      const partFilter = partConds.length ? `AND ${partConds.join(' AND ')}` : ''
      // ISO weekday (Mon=1..Sun=7) → BigQuery DAYOFWEEK (Sun=1..Sat=7).
      const bqDays = [...new Set<number>(p.shiftDays)].map((d) => (d % 7) + 1).join(', ')
      // Shift-hours between two timestamps: overlap with [shiftStart, shiftEnd]
      // ET on each selected weekday. NULL when either endpoint is NULL or the
      // interval is negative (empty date array) — filtered like the old <0 rule.
      const sh = (from: string, to: string) => `(
    SELECT SUM(GREATEST(TIMESTAMP_DIFF(
      LEAST(${to}, TIMESTAMP(DATETIME(day, TIME '${p.shiftEnd}:00'), 'America/New_York')),
      GREATEST(${from}, TIMESTAMP(DATETIME(day, TIME '${p.shiftStart}:00'), 'America/New_York')),
      SECOND), 0)) / 3600.0
    FROM UNNEST(GENERATE_DATE_ARRAY(DATE(${from}, 'America/New_York'), DATE(${to}, 'America/New_York'))) AS day
    WHERE EXTRACT(DAYOFWEEK FROM day) IN (${bqDays}))`
      return `
WITH ${classifiedOrdersCTEs(
        `o.status NOT IN ('QUOTING', 'CANCELLED')
    AND DATE(o.submitted_at) BETWEEN DATE_SUB(${sqlDate(p.start)}, INTERVAL 90 DAY) AND ${sqlDate(p.end)}`,
        ctx.exclusions.revenueSentinelBillingId,
      )},
flt AS (
  SELECT c.id, c.accepted_at, c.shipped_at
  FROM classified c
  WHERE TRUE ${classifiedChannelFilter(p.channels, 'c')}
    ${orderPartFilters(p, 'c')}
),
dfm AS (
  SELECT op.order_id, MAX(op.dfm_reviewed_at) AS dfm_done
  FROM ${T.orderPart} op
  WHERE op.order_id IN (SELECT id FROM flt)
  GROUP BY op.order_id
  HAVING COUNTIF(op.dfm_review_status IN ('PASSED', 'AT_RISK_APPROVED')) = COUNT(*)
),
cleared AS (
  SELECT order_id, MIN(timestamp) AS cleared_at
  FROM ${T.orderEvent}
  WHERE event_type = 'ORDER_CLEARED_FOR_PRODUCTION'
    AND order_id IN (SELECT id FROM flt)
    AND timestamp >= TIMESTAMP(DATE_SUB(${sqlDate(p.start)}, INTERVAL 90 DAY))
  GROUP BY order_id
),
ready AS (
  SELECT order_id, MAX(timestamp) AS ready_at
  FROM ${T.mfgEvent}
  WHERE source = 'STATION_APP' AND event_type = 'Binned'
    AND order_id IN (SELECT id FROM flt)
  GROUP BY order_id
),
builds AS (
  SELECT pb.guid, pb.created_at
  FROM ${T.printBuild} pb
  WHERE pb.created_at >= TIMESTAMP(DATE_SUB(${sqlDate(p.start)}, INTERVAL 60 DAY))
    AND EXISTS (
      SELECT 1 FROM ${T.printBuildPart} pbp
      JOIN ${T.orderPart} op ON op.guid = pbp.order_part_id
      WHERE pbp.print_build_id = pb.guid AND op.order_id IN (SELECT id FROM flt) ${partFilter}
    )
),
bridge AS (
  SELECT DISTINCT lot_guid, print_build_id
  FROM ${T.mfgEvent}
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
  SELECT b.guid, b.created_at,
         MIN(t.print_start) AS print_start,
         MAX(t.print_end) AS print_end,
         MIN(t.wash_at) AS wash_at
  FROM builds b
  JOIN bridge br ON br.print_build_id = b.guid
  JOIN tulip t ON t.lot_guid = br.lot_guid
  GROUP BY b.guid, b.created_at
),
bsplit AS (
  SELECT e.print_build_id, MIN(e.timestamp) AS split_at
  FROM ${T.mfgEvent} e
  WHERE e.source = 'STATION_APP' AND e.event_type = 'LOT_SPLIT'
  GROUP BY e.print_build_id
),
lots AS (
  SELECT e.lot_guid, MIN(e.timestamp) AS split_ts
  FROM ${T.mfgEvent} e
  JOIN ${T.orderPart} op ON op.guid = e.order_part_id
  WHERE e.source = 'STATION_APP' AND e.event_type = 'LOT_SPLIT'
    AND e.order_id IN (SELECT id FROM flt) ${partFilter}
  GROUP BY e.lot_guid
),
scans AS (
  SELECT lot_guid, event_type, MIN(timestamp) AS ts
  FROM ${T.mfgEvent}
  WHERE source = 'STATION_APP'
    AND event_type IN ('Pending Finishing', 'Pending Binning', 'Quarantine - Routing')
  GROUP BY lot_guid, event_type
),
intervals AS (
  SELECT '01 Accepted → DFM approved' AS stage, DATE(d.dfm_done) AS anchor,
         ${sh('f.accepted_at', 'd.dfm_done')} AS hours
  FROM flt f JOIN dfm d ON d.order_id = f.id
  UNION ALL
  SELECT '02 DFM approved → print queue', DATE(c.cleared_at),
         ${sh('d.dfm_done', 'c.cleared_at')}
  FROM dfm d JOIN cleared c ON c.order_id = d.order_id
  UNION ALL
  SELECT '03 Build queued → print start', DATE(b.print_start),
         ${sh('b.created_at', 'b.print_start')}
  FROM bstage b
  UNION ALL
  -- Printing is machine time: printers run overnight, so wall-clock, not shift.
  SELECT '04 Printing', DATE(b.print_end),
         TIMESTAMP_DIFF(b.print_end, b.print_start, MINUTE) / 60.0
  FROM bstage b
  UNION ALL
  SELECT '05 Print end → wash/sift scan', DATE(b.wash_at),
         ${sh('b.print_end', 'b.wash_at')}
  FROM bstage b
  UNION ALL
  SELECT '06 Wash scan → lot split', DATE(sp.split_at),
         ${sh('b.wash_at', 'sp.split_at')}
  FROM bstage b JOIN bsplit sp ON sp.print_build_id = b.guid
  UNION ALL
  SELECT '07 Lot split → finishing scan', DATE(s.ts),
         ${sh('l.split_ts', 's.ts')}
  FROM lots l JOIN scans s ON s.lot_guid = l.lot_guid AND s.event_type = 'Pending Finishing'
  UNION ALL
  SELECT '08 Lot split → bin/ship scan', DATE(s.ts),
         ${sh('l.split_ts', 's.ts')}
  FROM lots l JOIN scans s ON s.lot_guid = l.lot_guid AND s.event_type = 'Pending Binning'
  UNION ALL
  SELECT '09 Lot split → quarantine scan', DATE(s.ts),
         ${sh('l.split_ts', 's.ts')}
  FROM lots l JOIN scans s ON s.lot_guid = l.lot_guid AND s.event_type = 'Quarantine - Routing'
  UNION ALL
  SELECT '11 Ready to ship → shipped', DATE(f.shipped_at),
         ${sh('r.ready_at', 'f.shipped_at')}
  FROM flt f JOIN ready r ON r.order_id = f.id
  WHERE f.shipped_at IS NOT NULL
),
d AS (
  SELECT stage, anchor, hours FROM intervals
  WHERE hours IS NOT NULL AND hours >= 0 AND hours <= 720
    AND anchor BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
)
SELECT stage, COUNT(*) AS n, ROUND(APPROX_QUANTILES(hours, 100)[OFFSET(50)], 2) AS median_hours
FROM d GROUP BY stage ORDER BY stage`
    },
    mock: (p) => {
      const STAGES: [string, number][] = [
        ['01 Accepted → DFM approved', 5],
        ['02 DFM approved → print queue', 0.5],
        ['03 Build queued → print start', 18],
        ['04 Printing', 6],
        ['05 Print end → wash/sift scan', 8],
        ['06 Wash scan → lot split', 12],
        ['07 Lot split → finishing scan', 3],
        ['08 Lot split → bin/ship scan', 2],
        ['09 Lot split → quarantine scan', 4],
        ['11 Ready to ship → shipped', 1],
      ]
      const r = rng(`pipe:${p.grain}:${p.shiftStart}${p.shiftEnd}${p.shiftDays.join('')}`)
      // Narrower shift windows clip more elapsed time out of every dwell.
      const shiftFactor = Math.min(1, (p.shiftDays.length / 5) * 0.9 + 0.1)
      return STAGES.map(([stage, base]) => ({
        stage,
        n: Math.max(5, Math.round((250 + r() * 200) * (stage.startsWith('09') || stage.startsWith('10') ? 0.25 : 1))),
        median_hours: Math.round(base * shiftFactor * (0.8 + r() * 0.5) * 100) / 100,
      }))
    },
  },

  /**
   * D2(a) — production exception events vs parts shipped, per period.
   */
  floor_quality_exceptions: {
    description:
      'Production exception counts per period from fcm_api_orderevent (event timestamp): quarantined = PART_QUARANTINED events, reprints = PART_NEEDS_REPRINT, build_failures = TOTAL_BUILD_FAILURE; plus parts_shipped = SUM(qty_parts_shipped) from the governed KPI view for the same period. Rate = events / parts shipped × 100, derived client-side — approximate (events and shipments are different populations in the same window). Global channel/material filters are NOT applied.',
    source: 'fcm_api_orderevent + formlabs-data-sandbox.fcm.v_shipments_kpi',
    params: zBaseFilters,
    sql: (p) => `
WITH ev AS (
  SELECT
    CAST(${grainExpr('DATE(timestamp)', p.grain)} AS STRING) AS period,
    COUNTIF(event_type = 'PART_QUARANTINED') AS quarantined,
    COUNTIF(event_type = 'PART_NEEDS_REPRINT') AS reprints,
    COUNTIF(event_type = 'TOTAL_BUILD_FAILURE') AS build_failures
  FROM ${T.orderEvent}
  WHERE event_type IN ('PART_QUARANTINED', 'PART_NEEDS_REPRINT', 'TOTAL_BUILD_FAILURE')
    AND DATE(timestamp) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  GROUP BY period
),
sh AS (
  SELECT
    CAST(${grainExpr('date_key', p.grain)} AS STRING) AS period,
    SUM(qty_parts_shipped) AS parts_shipped
  FROM ${T.shipmentsKpi}
  WHERE date_key BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
    AND date_key <= CURRENT_DATE()
  GROUP BY period
)
SELECT
  period,
  IFNULL(ev.quarantined, 0) AS quarantined,
  IFNULL(ev.reprints, 0) AS reprints,
  IFNULL(ev.build_failures, 0) AS build_failures,
  IFNULL(sh.parts_shipped, 0) AS parts_shipped
FROM ev
FULL JOIN sh USING (period)
ORDER BY period`,
    mock: (p) => {
      const r = rng(`qex:${p.grain}`)
      const scale = GRAIN_SCALE[p.grain] ?? 1
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const parts = Math.max(5, Math.round((260 + r() * 160) * scale))
        return {
          period,
          quarantined: Math.round(parts * (0.015 + r() * 0.02)),
          reprints: Math.round(parts * (0.01 + r() * 0.015)),
          build_failures: Math.round(parts * (0.002 + r() * 0.006)),
          parts_shipped: parts,
        }
      })
    },
  },

  /**
   * D2(b) — Tulip lot outcome mix per period.
   */
  floor_quality_outcomes: {
    description:
      "Tulip lot outcome mix per period (keyed by the lot's last update date): good = lots whose status is 'Shipped' or 'Binned'; failed = 'Quarantine', 'QC Failed' or 'Complete Build Failure' (broken out). In-progress statuses are excluded. First-pass-yield-ish: a lot counts by its LATEST status, so reworked lots that later shipped count as good and lots still parked in Quarantine may yet recover — treat as approximate. Shares derived client-side as count / period total.",
    source: 'formcloud_manufacturing.master_table (Tulip)',
    params: zBaseFilters,
    sql: (p) => `
SELECT
  CAST(${grainExpr('DATE(SAFE_CAST(_updatedAt AS TIMESTAMP))', p.grain)} AS STRING) AS period,
  COUNTIF(judyq_status IN ('Shipped', 'Binned')) AS good,
  COUNTIF(judyq_status = 'Quarantine') AS quarantine,
  COUNTIF(judyq_status = 'QC Failed') AS qc_failed,
  COUNTIF(judyq_status = 'Complete Build Failure') AS build_failure
FROM ${T.tulipMaster}
WHERE SAFE_CAST(_updatedAt AS TIMESTAMP) IS NOT NULL
  AND DATE(SAFE_CAST(_updatedAt AS TIMESTAMP)) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
  AND judyq_status IN ('Shipped', 'Binned', 'Quarantine', 'QC Failed', 'Complete Build Failure')
GROUP BY period
ORDER BY period`,
    mock: (p) => {
      const r = rng(`qout:${p.grain}`)
      const scale = GRAIN_SCALE[p.grain] ?? 1
      return periodsBetween(p.start, p.end, p.grain).map((period) => {
        const total = Math.max(10, Math.round((320 + r() * 160) * scale))
        const failShare = 0.04 + r() * 0.07
        const failed = Math.max(1, Math.round(total * failShare))
        const quarantine = Math.round(failed * (0.4 + r() * 0.2))
        const qcFailed = Math.round((failed - quarantine) * (0.5 + r() * 0.3))
        return {
          period,
          good: total - failed,
          quarantine,
          qc_failed: qcFailed,
          build_failure: Math.max(0, failed - quarantine - qcFailed),
        }
      })
    },
  },
}
