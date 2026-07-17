/**
 * Formlabs Dashboard API client (read-only) — live printer queues and
 * per-physical-print queue waits. This is the survivorship-free source for
 * "build queued → print start": the warehouse only sees prints that already
 * happened, while /groups/{id}/queue/ shows what is waiting right now, and
 * each print run carries print_intent.created_at = when the job entered the
 * cloud queue (verified: fcm printbuild.created_at == queue submission ±2s).
 *
 * Auth: OAuth client credentials. FORMLABS_API_TOKEN in .env is the client
 * SECRET (using it as a bearer returns 401); tokens live 24h and are cached
 * in-process. All calls are GETs; failures surface as FormlabsError with a
 * hint so the UI can show actionable messages.
 */
import { config } from './config.js'
import type { Row } from './registry.js'
import { rng } from './mock/helpers.js'

const BASE = 'https://api.formlabs.com/developer/v1'

export class FormlabsError extends Error {
  status: number
  hint?: string
  constructor(message: string, status = 502, hint?: string) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

export function hasFormlabsCreds(): boolean {
  return !!(config.formlabsClientId && config.formlabsClientSecret)
}

let token: { value: string; expiresAt: number } | null = null

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value
  const res = await fetch(`${BASE}/o/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.formlabsClientId,
      client_secret: config.formlabsClientSecret,
    }),
  })
  if (!res.ok) {
    throw new FormlabsError(
      `Formlabs token request failed: HTTP ${res.status}`,
      502,
      'Check FORMLABS_API_CLIENT_ID / FORMLABS_API_TOKEN in .env (the token var holds the OAuth client secret).',
    )
  }
  const body = (await res.json()) as { access_token: string; expires_in: number }
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  return token.value
}

async function get<T>(path: string): Promise<T> {
  const bearer = await getToken()
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${bearer}` } })
  if (res.status === 401) {
    token = null // token revoked/expired early — one refresh retry
    const retryBearer = await getToken()
    const retry = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${retryBearer}` } })
    if (!retry.ok) throw new FormlabsError(`Formlabs API ${path}: HTTP ${retry.status}`)
    return (await retry.json()) as T
  }
  if (!res.ok) throw new FormlabsError(`Formlabs API ${path}: HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Endpoints paginate inconsistently — accept a bare array or {results: []}. */
function items<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[]
  if (body && typeof body === 'object' && Array.isArray((body as { results?: unknown }).results)) {
    return (body as { results: T[] }).results
  }
  return []
}

interface Group {
  id: string | number
  name: string
}

interface QueueItem {
  created_at?: string
  estimated_duration_ms?: number
  username?: string
}

interface Printer {
  serial: string
  group?: Group | null
}

interface PrintRun {
  print_started_at?: string | null
  user?: { username?: string } | null
  print_intent?: { created_at?: string; initiated_on?: string } | null
}

function hoursSince(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / 3_600_000
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx]
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** Small concurrency pool for per-printer fetches. */
async function pool<T, R>(inputs: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, async () => {
      while (i < inputs.length) {
        const idx = i++
        out[idx] = await fn(inputs[idx])
      }
    }),
  )
  return out
}

/** Live cloud print queue per printer group: count + age quantiles. */
export async function fetchPrinterQueues(): Promise<Row[]> {
  const groups = items<Group>(await get('/groups/'))
  const now = Date.now()
  const rows = await pool(groups, 4, async (g) => {
    const queue = items<QueueItem>(await get(`/groups/${g.id}/queue/`))
    const ages = queue
      .filter((q) => q.created_at)
      .map((q) => hoursSince(q.created_at!, now))
      .sort((a, b) => a - b)
    const estMs = queue.reduce((t, q) => t + (q.estimated_duration_ms ?? 0), 0)
    return {
      group: g.name,
      jobs: queue.length,
      median_age_h: round1(quantile(ages, 0.5)),
      p90_age_h: round1(quantile(ages, 0.9)),
      oldest_age_h: round1(ages[ages.length - 1] ?? 0),
      est_print_hours: round1(estMs / 3_600_000),
    } satisfies Row
  })
  return rows.filter((r) => (r.jobs as number) > 0).sort((a, b) => (b.jobs as number) - (a.jobs as number))
}

/**
 * Queue submission → print start, per PHYSICAL print run, from each printer's
 * most recent prints page. Wall-clock hours (printers run around the clock).
 * REMOTE-initiated prints are excluded (their intents postdate the start).
 */
export async function fetchQueueWaits(): Promise<Row[]> {
  const printers = items<Printer>(await get('/printers/'))
  const withGroup = printers.filter((p) => p.serial && p.group?.name)
  const perPrinter = await pool(withGroup, 10, async (p) => {
    try {
      const prints = items<PrintRun>(await get(`/printers/${p.serial}/prints/?per_page=50&page=1`))
      return { group: p.group!.name, prints }
    } catch {
      return { group: p.group!.name, prints: [] as PrintRun[] } // one flaky printer must not kill the panel
    }
  })
  const byGroup = new Map<string, { dwells: number[]; starts: number[] }>()
  for (const { group, prints } of perPrinter) {
    for (const pr of prints) {
      const intent = pr.print_intent?.created_at
      const started = pr.print_started_at
      if (!intent || !started) continue
      if (pr.print_intent?.initiated_on === 'REMOTE') continue
      const dwell = (new Date(started).getTime() - new Date(intent).getTime()) / 3_600_000
      if (!Number.isFinite(dwell) || dwell < 0 || dwell > 45 * 24) continue
      let g = byGroup.get(group)
      if (!g) byGroup.set(group, (g = { dwells: [], starts: [] }))
      g.dwells.push(dwell)
      g.starts.push(new Date(started).getTime())
    }
  }
  return [...byGroup.entries()]
    .map(([group, g]) => {
      const sorted = [...g.dwells].sort((a, b) => a - b)
      return {
        group,
        prints: sorted.length,
        p25_h: round1(quantile(sorted, 0.25)),
        median_h: round1(quantile(sorted, 0.5)),
        p75_h: round1(quantile(sorted, 0.75)),
        p90_h: round1(quantile(sorted, 0.9)),
        oldest_start: new Date(Math.min(...g.starts)).toISOString().slice(0, 10),
      } satisfies Row
    })
    .filter((r) => (r.prints as number) > 0)
    .sort((a, b) => (b.prints as number) - (a.prints as number))
}

// ---------------------------------------------------------------------------
// MOCK=1 — deterministic demo rows, same shapes as the live aggregations.
// ---------------------------------------------------------------------------

const MOCK_GROUPS = ['Billerica Fuse 1+', 'Billerica F4', 'Billerica F4L', 'MSB Ohio F4', 'MSB Ohio F4L']

export function mockPrinterQueues(): Row[] {
  const r = rng('flq:queues')
  return MOCK_GROUPS.map((group, i) => {
    const jobs = i === 0 ? 240 + Math.round(r() * 60) : Math.round(r() * 50)
    const median = 8 + r() * 30
    return {
      group,
      jobs,
      median_age_h: round1(median),
      p90_age_h: round1(median * (1.5 + r())),
      oldest_age_h: round1(median * (2 + r() * 2)),
      est_print_hours: round1(jobs * (4 + r() * 6)),
    }
  }).filter((row) => row.jobs > 0)
}

export function mockQueueWaits(): Row[] {
  const r = rng('flq:waits')
  return MOCK_GROUPS.map((group) => {
    const median = 3 + r() * 15
    return {
      group,
      prints: 40 + Math.round(r() * 300),
      p25_h: round1(median * 0.2),
      median_h: round1(median),
      p75_h: round1(median * (2.5 + r() * 2)),
      p90_h: round1(median * (5 + r() * 4)),
      oldest_start: '2026-06-20',
    }
  })
}
