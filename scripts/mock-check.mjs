#!/usr/bin/env node
/**
 * Hits every registered query against a running server (expects MOCK=1 on :4600)
 * with realistic params and asserts HTTP 200 + array rows.
 * Usage:  MOCK=1 NODE_ENV=production npm run start -w server &  then  node scripts/mock-check.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4600'

const range = { start: '2026-04-01', end: '2026-07-08', grain: 'week', channels: [], mfgTypes: [], materials: [] }

const CASES = [
  ['dim_materials_raw', {}],
  ['dim_material_codes', {}],
  ['meta_freshness', {}],
  ['shipments_explorer', { ...range, breakdown: 'reporting_category' }],
  ['shipments_explorer', { ...range, breakdown: 'materials' }],
  ['orders_explorer', { ...range, breakdown: 'none' }],
  ['ship_timing_distribution', range],
  ['parts_per_order', { ...range, breakdown: 'reporting_category' }],
  ['quoted_lead_time', { ...range, breakdown: 'reporting_category' }],
  ['orders_explorer', { ...range, breakdown: 'none', partsBuckets: [9, 10] }],
  ['ship_late_issues', range],
  ['wip_snapshot', { channels: [] }],
  ['wip_event_trends', { ...range, family: 'order' }],
  ['wip_event_trends', { ...range, family: 'build' }],
  ['wip_event_trends', { ...range, family: 'lot' }],
  ['wip_backlog_series', range],
  ['wip_backlog_series', { ...range, lateFilter: '2' }],
  ['order_search', { q: 'FN-1234' }],
  ['order_detail', { id: 1234 }],
  ['order_timeline', { id: 1234 }],
  ['order_parts', { id: 1234 }],
  ['order_tulip', { internalDisplayId: 'MSB-000123' }],
  ['delivery_kpis', range],
  ['ship_late_kpis', range],
  ['ship_late_kpis', { ...range, breakdown: 'reporting_category' }],
  ['shipped_by_ship_date', { ...range, breakdown: 'reporting_category' }],
  ['shipped_by_ship_date', { ...range, grain: 'day', breakdown: 'none' }],
  ['leadtime_lines', range],
  ['bowler_ship_days', range],
  ['bowler_utilization', range],
  ['bowler_yield', range],
  ['bowler_rma', range],
  ['bowler_labor', range],
  ['problem_orders', { channels: [] }],
  ['floor_stations', {}],
  ['floor_station_throughput', { ...range, includeExcluded: false, stations: [] }],
  ['floor_station_throughput', { ...range, includeExcluded: false, stations: ['Finishing 1'] }],
  ['floor_sessions', { ...range, includeExcluded: false, stationTypes: ['FINISHING'] }],
  ['floor_sessions', { ...range, includeExcluded: false, stations: [] }],
  ['pipeline_dwell', range],
  ['pipeline_dwell', { ...range, shiftDays: [1, 2, 3, 4, 5, 6], shiftStart: '06:00', shiftEnd: '18:00' }],
  ['floor_quality_exceptions', range],
  ['floor_quality_outcomes', range],
]

// Formlabs Dashboard API panels — GET endpoints outside the query registry.
const GET_CASES = [
  'cs_admins',
  'cs_emails?start=2026-06-15&end=2026-07-08',
  'cs_ratings?start=2026-06-15&end=2026-07-08',
  'nps_responses',
  'rma_tickets?start=2026-06-15&end=2026-07-08',
  'printer_queues',
  'printer_group_materials?group=Billerica%20Fuse%201%2B',
  'printer_group_materials?group=Billerica%20F4',
  'printer_group_history?group=Billerica%20Fuse%201%2B&material=Nylon%2012&start=2026-06-15&end=2026-07-08&grain=week',
]

let failures = 0
const results = []
for (const name of GET_CASES) {
  try {
    const res = await fetch(`${BASE}/api/${name}`)
    const body = await res.json()
    const ok = res.ok && Array.isArray(body.rows)
    if (!ok) failures++
    results.push({ query: `GET ${name.split("?")[0]}${name.includes("group=")?" ("+decodeURIComponent(name.split("group=")[1].split("&")[0])+")":""}`, status: res.status, rows: Array.isArray(body.rows) ? body.rows.length : `✗ ${body.error ?? '?'}` })
  } catch (e) {
    failures++
    results.push({ query: `GET ${name.split("?")[0]}${name.includes("group=")?" ("+decodeURIComponent(name.split("group=")[1].split("&")[0])+")":""}`, status: 'ERR', rows: e.message })
  }
}
for (const [name, params] of CASES) {
  try {
    const res = await fetch(`${BASE}/api/query/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    })
    const body = await res.json()
    const ok = res.ok && Array.isArray(body.rows)
    if (!ok) failures++
    results.push({ query: name, status: res.status, rows: Array.isArray(body.rows) ? body.rows.length : `✗ ${body.error ?? '?'}` })
  } catch (e) {
    failures++
    results.push({ query: name, status: 'ERR', rows: e.message })
  }
}

console.table(results)
const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null)
console.log(`health: ${JSON.stringify(health)}`)
if (failures) {
  console.error(`\n${failures} quer${failures === 1 ? 'y' : 'ies'} FAILED`)
  process.exit(1)
}
console.log('\nAll queries passed.')
