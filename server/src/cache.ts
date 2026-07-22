import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Entry {
  at: number
  ttlMs: number
  data: unknown
}

const store = new Map<string, Entry>()
const MAX_ENTRIES = 500

export function cacheKey(sql: string): string {
  return createHash('sha1').update(sql).digest('hex')
}

export function cacheGet<T>(key: string): T | undefined {
  const e = store.get(key)
  if (!e) return undefined
  if (Date.now() - e.at > e.ttlMs) {
    store.delete(key)
    return undefined
  }
  return e.data as T
}

export function cacheSet(key: string, data: unknown, ttlSeconds: number): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) store.delete(oldest[0])
  }
  store.set(key, { at: Date.now(), ttlMs: ttlSeconds * 1000, data })
}

export function cacheDelete(key: string): void {
  store.delete(key)
}

// ---------------------------------------------------------------------------
// Last-known-good store for stale-while-revalidate on slow external fetches
// (Intercom panels take minutes to crunch cold). Entries never expire — the
// caller serves them instantly while refreshing in the background — and they
// persist to disk so a server restart doesn't cold-start every panel.
// ---------------------------------------------------------------------------

const STALE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url))
const STALE_FILE = join(STALE_DIR, 'stale.json')
const STALE_MAX = 40

interface StaleEntry {
  savedAt: number
  data: unknown
}

let staleMem: Map<string, StaleEntry> | null = null
let staleWriteTimer: NodeJS.Timeout | null = null

function staleLoad(): Map<string, StaleEntry> {
  if (staleMem) return staleMem
  staleMem = new Map()
  try {
    const raw = JSON.parse(readFileSync(STALE_FILE, 'utf8')) as Record<string, StaleEntry>
    for (const [k, v] of Object.entries(raw)) staleMem.set(k, v)
  } catch {
    // first boot or unreadable file — start empty
  }
  return staleMem
}

export function staleGet<T>(key: string): { data: T; savedAt: number } | undefined {
  const e = staleLoad().get(key)
  return e ? { data: e.data as T, savedAt: e.savedAt } : undefined
}

export function staleSet(key: string, data: unknown): void {
  const m = staleLoad()
  m.delete(key) // re-insert so Map order tracks recency
  m.set(key, { savedAt: Date.now(), data })
  while (m.size > STALE_MAX) m.delete(m.keys().next().value as string)
  if (staleWriteTimer) clearTimeout(staleWriteTimer)
  staleWriteTimer = setTimeout(() => {
    staleWriteTimer = null
    try {
      mkdirSync(STALE_DIR, { recursive: true })
      writeFileSync(STALE_FILE, JSON.stringify(Object.fromEntries(m)))
    } catch {
      // disk persistence is best-effort; in-memory copy still serves
    }
  }, 2000)
  staleWriteTimer.unref?.()
}
