import express from 'express'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config, loadExclusions, repoRoot } from './config.js'
import { runRedashQuery, RedashError } from './redash.js'
import { cacheKey, cacheGet, cacheSet } from './cache.js'
import { registry } from './queries/index.js'
import { mapMaterialRows } from './queries/dims.js'
import type { Row } from './registry.js'
import { CHANNELS, MFG_TYPES } from './sql.js'
import {
  IntercomError,
  fetchCsAdmins,
  fetchCsEmails,
  fetchCsRatings,
  hasIntercomCreds,
  mockCsAdmins,
  mockCsEmails,
  mockCsRatings,
} from './intercom.js'
import {
  BILLERICA_GROUPS,
  FormlabsError,
  fetchGroupHistory,
  fetchGroupMaterials,
  fetchPrinterQueues,
  hasFormlabsCreds,
  mockGroupHistory,
  mockGroupMaterials,
  mockPrinterQueues,
} from './formlabs.js'

export const app = express()
app.use(express.json({ limit: '1mb' }))

interface QueryResponse {
  rows: Row[]
  meta: {
    name: string
    source: string
    description: string
    mock: boolean
    cached: boolean
    retrievedAt: string
  }
}

/** Run a registered query (mock-aware, cached). refresh=true bypasses every cache layer. */
async function runNamed(name: string, rawParams: unknown, refresh = false): Promise<QueryResponse> {
  const def = registry[name]
  if (!def) throw new RedashError(`Unknown query: ${name}`, 404)
  const params = def.params.parse(rawParams ?? {})
  const ctx = { exclusions: loadExclusions() }

  if (config.mock) {
    return {
      rows: def.mock(params, ctx),
      meta: { name, source: def.source, description: def.description, mock: true, cached: false, retrievedAt: new Date().toISOString() },
    }
  }

  const sql = def.sql(params, ctx)
  const key = cacheKey(sql)
  if (!refresh) {
    const hit = cacheGet<{ rows: Row[]; retrievedAt: string }>(key)
    if (hit) {
      return {
        rows: hit.rows,
        meta: { name, source: def.source, description: def.description, mock: false, cached: true, retrievedAt: hit.retrievedAt },
      }
    }
  }

  const maxAge = refresh ? 0 : (def.maxAge ?? 3600)
  const result = await runRedashQuery(sql, { maxAge })
  const retrievedAt = new Date().toISOString()
  cacheSet(key, { rows: result.rows, retrievedAt }, 120)
  return {
    rows: result.rows,
    meta: { name, source: def.source, description: def.description, mock: false, cached: false, retrievedAt },
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mock: config.mock,
    hasApiKey: !!config.apiKey,
    redashUrl: config.redashUrl,
    dataSourceId: config.dataSourceId,
  })
})

app.get('/api/config', (_req, res) => {
  res.json(loadExclusions())
})

/** Merged dimension lists for the global filter bar. */
app.get('/api/dims', async (req, res) => {
  const refresh = req.query.refresh === '1'
  try {
    const [rawMats, codes] = await Promise.all([
      runNamed('dim_materials_raw', {}, refresh),
      runNamed('dim_material_codes', {}, refresh),
    ])
    const nameMap = new Map(mapMaterialRows(rawMats.rows).map((m) => [m.code.toUpperCase(), m.name]))
    const materials = codes.rows
      .map((r) => String(r.code ?? ''))
      .filter(Boolean)
      .map((code) => ({ code, name: nameMap.get(code.toUpperCase()) ?? code }))
    res.json({
      channels: CHANNELS,
      mfgTypes: MFG_TYPES,
      materials,
      mock: rawMats.meta.mock,
    })
  } catch (e) {
    handleError(res, e)
  }
})

app.post('/api/query/:name', async (req, res) => {
  try {
    const { params, refresh } = req.body ?? {}
    const out = await runNamed(req.params.name, params, !!refresh)
    res.json(out)
  } catch (e) {
    handleError(res, e)
  }
})

/**
 * Formlabs Dashboard API panels (not Redash-backed): live printer queues and
 * per-print queue waits. Cached in-process; ?refresh=1 bypasses.
 */
function formlabsRoute(name: string, ttlSeconds: number, live: () => Promise<Row[]>, mock: () => Row[]): express.RequestHandler {
  return async (req, res) => {
    try {
      const meta = {
        name,
        source: 'Formlabs Dashboard API (api.formlabs.com)',
        description: '',
        cached: false,
        retrievedAt: new Date().toISOString(),
      }
      if (config.mock) {
        res.json({ rows: mock(), meta: { ...meta, mock: true } })
        return
      }
      if (!hasFormlabsCreds()) {
        res.status(503).json({
          error: 'Formlabs Dashboard API credentials not configured',
          hint: 'Set FORMLABS_API_CLIENT_ID and FORMLABS_API_TOKEN (OAuth client secret) in .env.',
        })
        return
      }
      const key = `formlabs:${name}`
      if (req.query.refresh !== '1') {
        const hit = cacheGet<{ rows: Row[]; retrievedAt: string }>(key)
        if (hit) {
          res.json({ rows: hit.rows, meta: { ...meta, mock: false, cached: true, retrievedAt: hit.retrievedAt } })
          return
        }
      }
      const rows = await live()
      cacheSet(key, { rows, retrievedAt: meta.retrievedAt }, ttlSeconds)
      res.json({ rows, meta: { ...meta, mock: false } })
    } catch (e) {
      if (e instanceof FormlabsError) {
        res.status(e.status).json({ error: e.message, hint: e.hint })
        return
      }
      handleError(res, e)
    }
  }
}

/** Intercom-backed Customer Service endpoints — same envelope, same caching pattern. */
function intercomRoute(name: string, ttlSeconds: number, live: () => Promise<Row[]>, mock: () => Row[]): express.RequestHandler {
  return async (req, res) => {
    try {
      const meta = { name, source: 'Intercom API (api.intercom.io)', description: '', cached: false, retrievedAt: new Date().toISOString() }
      if (config.mock) {
        res.json({ rows: mock(), meta: { ...meta, mock: true } })
        return
      }
      if (!hasIntercomCreds()) {
        res.status(503).json({ error: 'Intercom access token not configured', hint: 'Set INTERCOM_ACCESS_TOKEN in .env.' })
        return
      }
      const key = `intercom:${name}`
      if (req.query.refresh !== '1') {
        const hit = cacheGet<{ rows: Row[]; retrievedAt: string }>(key)
        if (hit) {
          res.json({ rows: hit.rows, meta: { ...meta, mock: false, cached: true, retrievedAt: hit.retrievedAt } })
          return
        }
      }
      const rows = await live()
      cacheSet(key, { rows, retrievedAt: meta.retrievedAt }, ttlSeconds)
      res.json({ rows, meta: { ...meta, mock: false } })
    } catch (e) {
      if (e instanceof IntercomError) {
        res.status(e.status).json({ error: e.message, hint: e.hint })
        return
      }
      handleError(res, e)
    }
  }
}

app.get('/api/cs_admins', intercomRoute('cs_admins', 3600, fetchCsAdmins, mockCsAdmins))

app.get('/api/cs_emails', (req, res, next) => {
  const start = String(req.query.start ?? '')
  const end = String(req.query.end ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    res.status(400).json({ error: 'Expected start/end (YYYY-MM-DD)' })
    return
  }
  intercomRoute(
    `cs_emails:${start}:${end}`,
    900,
    () => fetchCsEmails(start, end),
    () => mockCsEmails(start, end),
  )(req, res, next)
})

app.get('/api/cs_ratings', (req, res, next) => {
  const start = String(req.query.start ?? '')
  const end = String(req.query.end ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    res.status(400).json({ error: 'Expected start/end (YYYY-MM-DD)' })
    return
  }
  intercomRoute(
    `cs_ratings:${start}:${end}`,
    900,
    () => fetchCsRatings(start, end),
    () => mockCsRatings(start, end),
  )(req, res, next)
})

app.get('/api/printer_queues', formlabsRoute('printer_queues', 180, fetchPrinterQueues, mockPrinterQueues))

function parseGroup(req: express.Request): string | null {
  const g = String(req.query.group ?? '')
  return (BILLERICA_GROUPS as readonly string[]).includes(g) ? g : null
}

app.get('/api/printer_group_materials', (req, res, next) => {
  const group = parseGroup(req)
  if (!group) {
    res.status(400).json({ error: `group must be one of: ${BILLERICA_GROUPS.join(', ')}` })
    return
  }
  formlabsRoute(
    `printer_group_materials:${group}`,
    900,
    () => fetchGroupMaterials(group),
    () => mockGroupMaterials(group),
  )(req, res, next)
})

const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

app.get('/api/printer_group_history', (req, res, next) => {
  const group = parseGroup(req)
  const material = String(req.query.material ?? '').slice(0, 80)
  const start = String(req.query.start ?? '')
  const end = String(req.query.end ?? '')
  const grain = String(req.query.grain ?? 'day') as (typeof GRAINS)[number]
  if (!group || !material || !ISO_DATE.test(start) || !ISO_DATE.test(end) || !GRAINS.includes(grain) || start > end) {
    res.status(400).json({ error: 'Expected group (Billerica), material, start/end (YYYY-MM-DD), grain' })
    return
  }
  formlabsRoute(
    `printer_group_history:${group}:${material}:${start}:${end}:${grain}`,
    900,
    () => fetchGroupHistory(group, material, start, end, grain),
    () => mockGroupHistory(group, material, start, end, grain),
  )(req, res, next)
})

function handleError(res: express.Response, e: unknown): void {
  if (e instanceof RedashError) {
    res.status(e.status).json({ error: e.message, hint: e.hint })
    return
  }
  if (e && typeof e === 'object' && 'issues' in (e as any)) {
    res.status(400).json({ error: 'Invalid query parameters', detail: (e as any).issues })
    return
  }
  console.error(e)
  res.status(500).json({ error: e instanceof Error ? e.message : 'Internal error' })
}

// Production: serve the built SPA. Assets carry content hashes and may cache;
// index.html must not, or browsers keep serving stale bundles after a rebuild.
const dist = resolve(repoRoot, 'web', 'dist')
if (config.isProd && existsSync(dist)) {
  app.use(express.static(dist, { index: false }))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile(resolve(dist, 'index.html'))
  })
}
