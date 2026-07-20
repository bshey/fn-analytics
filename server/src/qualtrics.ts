/**
 * Qualtrics client (read-only) for the NPS view — "Form Now Customer Order
 * Survey". Response retrieval is Qualtrics' async export: start a JSON export
 * (compress=false so no zip handling), poll until complete, download the file.
 *
 * Records carry the NPS score (QID2), the improvement comment (QID4_TEXT),
 * the respondent's email and order reference (embedded data; order_id arrives
 * as either "FN-110" or a bare number), and any uploaded photo/video (QID6).
 * Order references are resolved to fcm order ids via one Redash lookup so the
 * UI can deep-link into MES; when Redash is unreachable (no VPN) the links
 * just degrade to absent. Uploaded files are streamed through /api/nps_file —
 * the browser can't attach the X-API-TOKEN header itself.
 */
import { config } from './config.js'
import { runRedashQuery } from './redash.js'
import { T, sqlStringList } from './sql.js'
import type { Row } from './registry.js'
import { rng, periodsBetween } from './mock/helpers.js'

export class QualtricsError extends Error {
  status: number
  hint?: string
  constructor(message: string, status = 502, hint?: string) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

export function hasQualtricsCreds(): boolean {
  return !!(config.qualtricsToken && config.qualtricsNpsSurvey)
}

const base = () => `https://${config.qualtricsDatacenter}.qualtrics.com/API/v3`

async function qx<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-API-TOKEN': config.qualtricsToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 || res.status === 403) {
    throw new QualtricsError(`Qualtrics rejected the token (HTTP ${res.status})`, 502, 'Check QUALTRICS_API_TOKEN in .env.')
  }
  if (!res.ok) throw new QualtricsError(`Qualtrics API ${path.split('?')[0]}: HTTP ${res.status}`)
  return (await res.json()) as T
}

interface QResponse {
  responseId: string
  values: Record<string, unknown>
}

async function exportAll(): Promise<QResponse[]> {
  const sv = config.qualtricsNpsSurvey
  const start = await qx<{ result: { progressId: string } }>(`/surveys/${sv}/export-responses`, {
    format: 'json',
    compress: false,
  })
  const prg = start.result.progressId
  let fileId: string | undefined
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const p = await qx<{ result: { status: string; fileId?: string } }>(`/surveys/${sv}/export-responses/${prg}`)
    if (p.result.status === 'complete') {
      fileId = p.result.fileId
      break
    }
    if (p.result.status === 'failed') throw new QualtricsError('Qualtrics export failed')
  }
  if (!fileId) throw new QualtricsError('Qualtrics export timed out', 504, 'Try refreshing in a minute.')
  const body = await qx<{ responses: QResponse[] }>(`/surveys/${sv}/export-responses/${fileId}/file`)
  return body.responses ?? []
}

/** Map order_id embedded values ("FN-110" or bare "124") to fcm order ids via one warehouse query. */
async function resolveOrders(refs: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const clean = [...new Set(refs.map((r) => r.trim()).filter((r) => /^(FN-)?\d{1,7}$/i.test(r)))]
  if (!clean.length) return out
  const displays = clean.map((r) => (r.toUpperCase().startsWith('FN-') ? r.toUpperCase() : `FN-${r}`))
  const bare = clean.filter((r) => !r.toUpperCase().startsWith('FN-')).map((r) => Number(r))
  try {
    const sql = `
SELECT id, source_display_id FROM ${T.order}
WHERE source_display_id IN (${sqlStringList(displays)})
   ${bare.length ? `OR id IN (${bare.join(', ')})` : ''}`
    const res = await runRedashQuery(sql, { maxAge: 3600 })
    const byDisplay = new Map<string, number>()
    const byId = new Set<number>()
    for (const row of res.rows) {
      byDisplay.set(String(row.source_display_id).toUpperCase(), Number(row.id))
      byId.add(Number(row.id))
    }
    for (const ref of clean) {
      const up = ref.toUpperCase()
      const display = up.startsWith('FN-') ? up : `FN-${up}`
      if (byDisplay.has(display)) out.set(ref, byDisplay.get(display)!)
      else if (!up.startsWith('FN-') && byId.has(Number(ref))) out.set(ref, Number(ref))
    }
  } catch {
    // No VPN / Redash down — MES links simply degrade to absent.
  }
  return out
}

export async function fetchNpsResponses(): Promise<Row[]> {
  const responses = await exportAll()
  const usable = responses.filter((r) => {
    const v = r.values
    return v.QID2 !== undefined && v.finished === 1 && v.distributionChannel !== 'preview'
  })
  const orderMap = await resolveOrders(usable.map((r) => String(r.values.order_id ?? '')).filter(Boolean))
  return usable
    .map((r) => {
      const v = r.values
      const ref = String(v.order_id ?? '').trim()
      return {
        response_id: r.responseId ?? String(v._recordId ?? ''),
        recorded_at: Math.floor(new Date(String(v.recordedDate ?? v.endDate)).getTime() / 1000),
        nps: Number(v.QID2),
        comment: String(v.QID4_TEXT ?? '').trim(),
        email: String(v.email ?? '').trim(),
        order_ref: ref,
        order_fcm_id: orderMap.get(ref) ?? null,
        file_id: (v.QID6_FILE_ID as string | undefined) ?? null,
        file_name: (v.QID6_FILE_NAME as string | undefined) ?? null,
        file_type: (v.QID6_FILE_TYPE as string | undefined) ?? null,
      } satisfies Row
    })
    .filter((r) => Number.isFinite(r.recorded_at) && Number.isFinite(r.nps))
    .sort((a, b) => (b.recorded_at as number) - (a.recorded_at as number))
}

/** Stream an uploaded survey file (photo/video) — the browser can't send X-API-TOKEN itself. */
export async function fetchNpsFile(responseId: string, fileId: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(`${base()}/surveys/${config.qualtricsNpsSurvey}/responses/${responseId}/uploaded-files/${fileId}`, {
    headers: { 'X-API-TOKEN': config.qualtricsToken },
  })
  if (!res.ok) throw new QualtricsError(`Qualtrics file fetch: HTTP ${res.status}`, res.status === 404 ? 404 : 502)
  return { bytes: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
}

// ---------------------------------------------------------------------------
// MOCK=1 — deterministic demo rows, same shape as the live extraction.
// ---------------------------------------------------------------------------

export function mockNpsResponses(): Row[] {
  const r = rng('nps:v1')
  const rows: Row[] = []
  let id = 3000
  const days = periodsBetween('2025-12-07', new Date().toISOString().slice(0, 10), 'day')
  for (const day of days) {
    if (r() < 0.65) continue
    const n = 1 + Math.round(r() * 1.5)
    for (let i = 0; i < n; i++) {
      const roll = r()
      const nps = roll < 0.5 ? 10 : roll < 0.65 ? 9 : roll < 0.8 ? 8 : roll < 0.87 ? 7 : Math.floor(r() * 7)
      rows.push({
        response_id: `R_mock${id}`,
        recorded_at: Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000) + 15 * 3600 + Math.round(r() * 6 * 3600),
        nps,
        comment: nps <= 6 ? 'Parts arrived later than promised.' : r() < 0.3 ? 'Great quality, smooth process!' : '',
        email: `customer${Math.floor(r() * 60)}@example.com`,
        order_ref: `FN-${1000 + id - 3000}`,
        order_fcm_id: 18000 + (id - 3000),
        file_id: null,
        file_name: null,
        file_type: null,
      })
      id++
    }
  }
  return rows.sort((a, b) => (b.recorded_at as number) - (a.recorded_at as number))
}
