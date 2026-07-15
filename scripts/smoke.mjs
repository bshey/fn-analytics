#!/usr/bin/env node
/**
 * Connectivity + ground-truth smoke test (HANDOFF §3 and §7).
 * Run after filling .env:  npm run smoke
 *
 * 1. SELECT 1 through the full submit→poll→fetch loop
 * 2. Cross-project counts (warehouse + sandbox via data source 13)
 * 3. Ground truth: week of 2026-06-07 on-time% ≈ Web 0.394 / Xometry 0.355 / PreForm-RevGen 0.286
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const URL_BASE = (process.env.REDASH_URL ?? 'https://redash.devops.priv.prod.gcp.formlabs.cloud').replace(/\/+$/, '')
const KEY = process.env.REDASH_API_KEY
const DS = Number(process.env.REDASH_DATA_SOURCE_ID ?? 13)

if (!KEY) {
  console.error('✗ REDASH_API_KEY is not set. Copy .env.example to .env and paste your key (Redash → avatar → Edit Profile → API Key).')
  process.exit(1)
}

const headers = { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' }
if (process.env.CF_ACCESS_CLIENT_ID) {
  headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID
  headers['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET
}

async function run(sql) {
  const submit = await fetch(`${URL_BASE}/api/query_results`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: sql, data_source_id: DS, max_age: 0 }),
  })
  if (submit.status === 401 || submit.status === 403) {
    throw new Error(`HTTP ${submit.status} — bad API key, or Cloudflare Access is required (see .env.example).`)
  }
  if (!submit.ok) throw new Error(`submit HTTP ${submit.status}: ${(await submit.text()).slice(0, 200)}`)
  let body = await submit.json()
  if (!body.query_result) {
    const jobId = body.job?.id
    if (!jobId) throw new Error('no job id in response')
    const deadline = Date.now() + 90_000
    let resultId
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800))
      const jr = await (await fetch(`${URL_BASE}/api/jobs/${jobId}`, { headers })).json()
      if (jr.job.status === 3) {
        resultId = jr.job.query_result_id
        break
      }
      if (jr.job.status === 4) throw new Error(`query failed: ${jr.job.error}`)
    }
    if (!resultId) throw new Error('timed out polling job')
    body = await (await fetch(`${URL_BASE}/api/query_results/${resultId}.json`, { headers })).json()
  }
  return body.query_result.data.rows
}

function approx(a, b, tol = 0.02) {
  return Math.abs(a - b) <= tol
}

try {
  console.log(`Redash: ${URL_BASE} (data source ${DS})\n`)

  process.stdout.write('1. SELECT 1 submit→poll→fetch loop… ')
  const r1 = await run('SELECT 1 AS ok')
  if (Number(r1[0]?.ok) !== 1) throw new Error(`unexpected result: ${JSON.stringify(r1)}`)
  console.log('✓')

  process.stdout.write('2. Cross-project visibility (warehouse + sandbox)… ')
  const r2 = await run(`SELECT
 (SELECT COUNT(*) FROM \`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_order\`) AS wh,
 (SELECT COUNT(*) FROM \`formlabs-data-sandbox.fcm.v_shipments_kpi\`) AS sb`)
  const { wh, sb } = r2[0]
  if (!(Number(wh) > 0 && Number(sb) > 0)) throw new Error(`expected two non-zero counts, got wh=${wh} sb=${sb}`)
  console.log(`✓ (orders=${wh}, kpi rows=${sb})`)

  process.stdout.write('3. Ground truth — week of 2026-06-07 on-time%… ')
  const r3 = await run(`SELECT reporting_category,
  SUM(n_orders_shipped_on_time)/NULLIF(SUM(n_orders_shipped),0) AS on_time
FROM \`formlabs-data-sandbox.fcm.v_shipments_kpi\`
WHERE DATE_TRUNC(date_key, WEEK(SUNDAY)) = '2026-06-07'
GROUP BY reporting_category`)
  const byCat = Object.fromEntries(r3.map((r) => [r.reporting_category, Number(r.on_time)]))
  const expected = {
    'Web - Revenue Generating': 0.394,
    Xometry: 0.355,
    'PreForm - Revenue Generating': 0.286,
  }
  const failures = Object.entries(expected).filter(([cat, want]) => !approx(byCat[cat] ?? -1, want))
  if (failures.length) {
    console.log('✗')
    for (const [cat, want] of failures) {
      console.log(`   ${cat}: expected ≈${want}, got ${byCat[cat]?.toFixed(3) ?? 'missing'}`)
    }
    console.log('   (If the view was restated this may be fine — but investigate before trusting the app.)')
    process.exit(1)
  }
  console.log('✓ matches Looker anchors')

  console.log('\nAll smoke tests passed — the data layer is proven. Run: npm run dev')
} catch (e) {
  console.log('✗')
  console.error(`\n${e.message}`)
  console.error('\nIf requests hang or 403: check VPN / corporate network (the Redash host is internal), then the API key.')
  process.exit(1)
}
