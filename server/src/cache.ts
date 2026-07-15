import { createHash } from 'node:crypto'

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
