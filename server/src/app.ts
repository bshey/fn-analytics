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
  FormlabsError,
  fetchPrinterQueues,
  fetchQueueWaits,
  hasFormlabsCreds,
  mockPrinterQueues,
  mockQueueWaits,
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

app.get('/api/printer_queues', formlabsRoute('printer_queues', 180, fetchPrinterQueues, mockPrinterQueues))
app.get('/api/printer_queue_waits', formlabsRoute('printer_queue_waits', 1800, fetchQueueWaits, mockQueueWaits))

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
