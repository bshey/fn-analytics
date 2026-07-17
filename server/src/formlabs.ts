/**
 * Formlabs Dashboard API client (read-only) — live Billerica printer queues
 * and per-material queue analytics. This is the survivorship-free source for
 * printer-queue truth: /groups/{id}/queue/ shows what is waiting right now,
 * and each print run carries print_intent.created_at = when the job entered
 * the cloud queue (verified: fcm printbuild.created_at == queue submission
 * ±2s), so history can be reconstructed from intent→start intervals.
 *
 * Auth: OAuth client credentials. FORMLABS_API_TOKEN in .env is the client
 * SECRET (using it as a bearer returns 401); tokens live 24h and are cached
 * in-process. All calls are GETs; failures surface as FormlabsError with a
 * hint so the UI can show actionable messages.
 */
import { config } from './config.js'
import { cacheGet, cacheSet } from './cache.js'
import type { Row } from './registry.js'
import { rng, periodsBetween } from './mock/helpers.js'

const BASE = 'https://api.formlabs.com/developer/v1'

/** The panels deliberately cover Billerica production only (owner request). */
export const BILLERICA_GROUPS = ['Billerica Fuse 1+', 'Billerica F4', 'Billerica F4L'] as const

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
  material_name?: string
}

interface Printer {
  serial: string
  group?: Group | null
  printer_status?: { hopper_material?: string | null } | null
  cartridge_status?: { cartridge?: { material?: string | null } | null } | null
  previous_print_run?: { material?: string | null } | null
}

interface PrintRun {
  print_started_at?: string | null
  material?: string | null
  material_name?: string | null
  estimated_duration_ms?: number | null
  print_intent?: { created_at?: string; initiated_on?: string } | null
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx]
}

const round1 = (v: number) => Math.round(v * 10) / 10
const H = 3_600_000

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

// ---------------------------------------------------------------------------
// Live queues overview — Billerica groups only.
// ---------------------------------------------------------------------------

export async function fetchPrinterQueues(): Promise<Row[]> {
  const [groupsBody, printersBody] = await Promise.all([get('/groups/'), get('/printers/')])
  const groups = items<Group>(groupsBody).filter((g) => (BILLERICA_GROUPS as readonly string[]).includes(g.name))
  const printers = items<Printer>(printersBody)
  const printerCount = new Map<string, number>()
  for (const p of printers) {
    const g = p.group?.name
    if (g) printerCount.set(g, (printerCount.get(g) ?? 0) + 1)
  }
  const rows = await pool(groups, 4, async (g) => {
    const queue = items<QueueItem>(await get(`/groups/${g.id}/queue/`))
    const estMs = queue.reduce((t, q) => t + (q.estimated_duration_ms ?? 0), 0)
    const nPrinters = printerCount.get(g.name) ?? 0
    return {
      group: g.name,
      printers: nPrinters,
      jobs: queue.length,
      est_print_hours: round1(estMs / H),
      hours_per_printer: nPrinters > 0 ? round1(estMs / H / nPrinters) : null,
    } satisfies Row
  })
  return rows.sort((a, b) => (b.jobs as number) - (a.jobs as number))
}

// ---------------------------------------------------------------------------
// Per-group material analytics — raw group data cached once, sliced two ways.
// ---------------------------------------------------------------------------

interface GroupData {
  printers: { serial: string; setupSku: string | null }[]
  prints: { sku: string | null; name: string | null; intentAt: number; startedAt: number; estMs: number; remote: boolean }[]
  queue: { name: string; createdAt: number; estMs: number }[]
  skuToName: Map<string, string>
}

const PAGE_DEPTH = 3
const SAMPLE_CUTOFF_DAYS = 60

async function getGroupData(groupName: string): Promise<GroupData> {
  const key = `flgrp:${groupName}`
  const hit = cacheGet<GroupData>(key)
  if (hit) return hit

  const [groupsBody, printersBody] = await Promise.all([get('/groups/'), get('/printers/')])
  const group = items<Group>(groupsBody).find((g) => g.name === groupName)
  if (!group) throw new FormlabsError(`Unknown printer group: ${groupName}`, 404)
  const printers = items<Printer>(printersBody).filter((p) => p.serial && p.group?.name === groupName)

  const queueItems = items<QueueItem>(await get(`/groups/${group.id}/queue/`))
  const cutoff = Date.now() - SAMPLE_CUTOFF_DAYS * 24 * H

  const perPrinter = await pool(printers, 10, async (p) => {
    const runs: PrintRun[] = []
    for (let page = 1; page <= PAGE_DEPTH; page++) {
      let batch: PrintRun[] = []
      try {
        batch = items<PrintRun>(await get(`/printers/${p.serial}/prints/?per_page=50&page=${page}`))
      } catch {
        break // a flaky printer must not kill the panel
      }
      runs.push(...batch)
      if (batch.length < 50) break
      const oldest = batch[batch.length - 1]?.print_started_at
      if (oldest && new Date(oldest).getTime() < cutoff) break
    }
    return runs
  })

  const skuToName = new Map<string, string>()
  const prints: GroupData['prints'] = []
  for (const runs of perPrinter) {
    for (const r of runs) {
      if (r.material && r.material_name) skuToName.set(r.material, r.material_name)
      const intent = r.print_intent?.created_at
      const started = r.print_started_at
      if (!intent || !started) continue
      prints.push({
        sku: r.material ?? null,
        name: r.material_name ?? null,
        intentAt: new Date(intent).getTime(),
        startedAt: new Date(started).getTime(),
        estMs: r.estimated_duration_ms ?? 0,
        remote: r.print_intent?.initiated_on === 'REMOTE',
      })
    }
  }

  const data: GroupData = {
    printers: printers.map((p) => ({
      serial: p.serial,
      setupSku:
        (p.printer_status?.hopper_material || null) ??
        p.cartridge_status?.cartridge?.material ??
        p.previous_print_run?.material ??
        null,
    })),
    prints,
    queue: queueItems.map((q) => ({
      name: q.material_name ?? 'Unknown',
      createdAt: q.created_at ? new Date(q.created_at).getTime() : Date.now(),
      estMs: q.estimated_duration_ms ?? 0,
    })),
    skuToName,
  }
  cacheSet(key, data, 1800)
  return data
}

function waitsOf(prints: GroupData['prints']): number[] {
  return prints
    .filter((p) => !p.remote)
    .map((p) => (p.startedAt - p.intentAt) / H)
    .filter((w) => Number.isFinite(w) && w >= 0 && w <= 45 * 24)
    .sort((a, b) => a - b)
}

/** Per-material table for one group: setup, backlog, est time, median wait. */
export async function fetchGroupMaterials(groupName: string): Promise<Row[]> {
  const d = await getGroupData(groupName)
  // Queue items say "Nylon 12 GF" while hopper SKUs map to "Nylon 12 GF V1" —
  // merge a versioned name into its stripped form when that form is a queue
  // material, so set-up printers count against the backlog they can serve.
  const queueNames = new Set(d.queue.map((q) => q.name))
  const canon = (name: string): string => {
    if (queueNames.has(name)) return name
    const stripped = name.replace(/\s+V[\d.]+$/, '')
    return queueNames.has(stripped) ? stripped : name
  }
  const mats = new Map<string, { jobs: number; estMs: number; printsOf: GroupData['prints']; setup: number }>()
  const entry = (name: string) => {
    let m = mats.get(name)
    if (!m) mats.set(name, (m = { jobs: 0, estMs: 0, printsOf: [], setup: 0 }))
    return m
  }
  for (const q of d.queue) {
    const m = entry(q.name)
    m.jobs++
    m.estMs += q.estMs
  }
  for (const p of d.prints) {
    if (p.name) entry(canon(p.name)).printsOf.push(p)
  }
  for (const p of d.printers) {
    if (!p.setupSku) continue
    entry(canon(d.skuToName.get(p.setupSku) ?? p.setupSku)).setup++
  }
  return [...mats.entries()]
    .map(([material, m]) => {
      const waits = waitsOf(m.printsOf)
      return {
        material,
        printers_setup: m.setup,
        jobs: m.jobs,
        est_print_hours: round1(m.estMs / H),
        hours_per_printer: m.setup > 0 ? round1(m.estMs / H / m.setup) : null,
        median_wait_h: waits.length ? round1(quantile(waits, 0.5)) : null,
        recent_prints: waits.length,
      } satisfies Row
    })
    .filter((r) => (r.jobs as number) > 0 || (r.printers_setup as number) > 0 || (r.recent_prints as number) > 0)
    .sort((a, b) => (b.jobs as number) - (a.jobs as number) || (b.est_print_hours as number) - (a.est_print_hours as number))
}

/**
 * Queue history for one group+material, reconstructed from intent→start
 * intervals plus the current queue: at any past instant a job was outstanding
 * iff its intent existed but its print hadn't started. Periods older than the
 * sampled prints reach are returned as nulls, not zeros.
 */
export async function fetchGroupHistory(
  groupName: string,
  material: string,
  start: string,
  end: string,
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year',
): Promise<Row[]> {
  const d = await getGroupData(groupName)
  const queueNames = new Set(d.queue.map((q) => q.name))
  const canon = (name: string): string => {
    if (queueNames.has(name)) return name
    const stripped = name.replace(/\s+V[\d.]+$/, '')
    return queueNames.has(stripped) ? stripped : name
  }
  const prints = d.prints.filter((p) => p.name && canon(p.name) === material)
  const queue = d.queue.filter((q) => q.name === material)
  const horizon = prints.length ? Math.min(...prints.map((p) => p.intentAt)) : Date.now()
  const periods = periodsBetween(start, end, grain)
  const now = Date.now()
  const rows: Row[] = []
  for (let i = 0; i < periods.length; i++) {
    const pStart = new Date(`${periods[i]}T00:00:00Z`).getTime()
    const pEnd = i + 1 < periods.length ? new Date(`${periods[i + 1]}T00:00:00Z`).getTime() : new Date(`${end}T00:00:00Z`).getTime() + 24 * H
    if (pEnd <= horizon) {
      rows.push({ period: periods[i], avg_outstanding_hours: null, avg_jobs: null, median_wait_h: null, prints_started: 0 })
      continue
    }
    const startedIn = prints.filter((p) => p.startedAt >= pStart && p.startedAt < pEnd)
    const waits = waitsOf(startedIn)
    // Sample outstanding state daily at 16:00 UTC (noon ET).
    let samples = 0
    let jobsSum = 0
    let hoursSum = 0
    for (let t = pStart + 16 * H; t < Math.min(pEnd, now); t += 24 * H) {
      samples++
      let jobs = 0
      let ms = 0
      for (const p of prints) {
        if (p.intentAt <= t && t < p.startedAt) {
          jobs++
          ms += p.estMs
        }
      }
      for (const q of queue) {
        if (q.createdAt <= t) {
          jobs++
          ms += q.estMs
        }
      }
      jobsSum += jobs
      hoursSum += ms / H
    }
    rows.push({
      period: periods[i],
      avg_outstanding_hours: samples ? round1(hoursSum / samples) : null,
      avg_jobs: samples ? round1(jobsSum / samples) : null,
      median_wait_h: waits.length ? round1(quantile(waits, 0.5)) : null,
      prints_started: startedIn.length,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// MOCK=1 — deterministic demo rows, same shapes as the live aggregations.
// ---------------------------------------------------------------------------

const MOCK_MATS = ['Nylon 12', 'Nylon 12 GF', 'Grey V5', 'White V5', 'Tough 2000', 'Clear V5']

export function mockPrinterQueues(): Row[] {
  const r = rng('flq:queues')
  return BILLERICA_GROUPS.map((group, i) => {
    const printers = i === 0 ? 24 : 18 + Math.round(r() * 14)
    const jobs = i === 0 ? 240 + Math.round(r() * 60) : Math.round(r() * 50)
    const estH = jobs * (4 + r() * 6)
    return {
      group,
      printers,
      jobs,
      est_print_hours: round1(estH),
      hours_per_printer: printers > 0 ? round1(estH / printers) : null,
    }
  })
}

export function mockGroupMaterials(group: string): Row[] {
  const r = rng(`flq:mats:${group}`)
  const isFuse = group.includes('Fuse')
  const mats = isFuse ? MOCK_MATS.slice(0, 2) : MOCK_MATS.slice(2)
  return mats.map((material, i) => {
    const setup = i === 0 ? 10 + Math.round(r() * 10) : Math.round(r() * 6)
    const jobs = Math.round(r() * (isFuse ? 180 : 30))
    const estH = jobs * (3 + r() * 8)
    return {
      material,
      printers_setup: setup,
      jobs,
      est_print_hours: round1(estH),
      hours_per_printer: setup > 0 ? round1(estH / setup) : null,
      median_wait_h: round1(2 + r() * 30),
      recent_prints: 20 + Math.round(r() * 200),
    }
  })
}

export function mockGroupHistory(group: string, material: string, start: string, end: string, grain: 'day' | 'week' | 'month' | 'quarter' | 'year'): Row[] {
  const r = rng(`flq:hist:${group}:${material}:${grain}`)
  return periodsBetween(start, end, grain).map((period) => {
    const jobs = 20 + r() * 120
    return {
      period,
      avg_outstanding_hours: round1(jobs * (4 + r() * 4)),
      avg_jobs: round1(jobs),
      median_wait_h: round1(2 + r() * 40),
      prints_started: Math.round(5 + r() * 60),
    }
  })
}
