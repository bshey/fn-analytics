import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

export type Row = Record<string, unknown>

export interface QueryMeta {
  name: string
  source: string
  description: string
  mock: boolean
  cached: boolean
  retrievedAt: string
}

export interface QueryPayload {
  rows: Row[]
  meta: QueryMeta
}

export interface ApiError {
  error: string
  hint?: string
}

// When the user hits Refresh we invalidate everything and, for a short window,
// every refetch asks the server to bypass Redash's cache (max_age=0).
let forceRefreshUntil = 0

export async function postQuery(name: string, params: Record<string, unknown>): Promise<QueryPayload> {
  const res = await fetch(`/api/query/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ params, refresh: Date.now() < forceRefreshUntil }),
  })
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { hint: body.hint }) as Error & { hint?: string }
  return body as QueryPayload
}

/** Run a registered server query. Query key includes params, so filter changes refetch automatically. */
export function useNamedQuery(
  name: string,
  params: Record<string, unknown>,
  opts: { enabled?: boolean } = {},
): UseQueryResult<QueryPayload, Error & { hint?: string }> {
  return useQuery({
    queryKey: ['q', name, params],
    queryFn: () => postQuery(name, params),
    enabled: opts.enabled,
  }) as UseQueryResult<QueryPayload, Error & { hint?: string }>
}

export interface Dims {
  channels: string[]
  mfgTypes: string[]
  materials: { code: string; name: string }[]
  mock: boolean
}

export function useDims(): UseQueryResult<Dims, Error> {
  return useQuery({
    queryKey: ['dims'],
    queryFn: async () => {
      const res = await fetch('/api/dims')
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
      return (await res.json()) as Dims
    },
    staleTime: 24 * 3600 * 1000,
  })
}

export interface Health {
  ok: boolean
  mock: boolean
  hasApiKey: boolean
  redashUrl: string
}

export function useHealth(): UseQueryResult<Health, Error> {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await fetch('/api/health')
      return (await res.json()) as Health
    },
    staleTime: 60_000,
  })
}

export interface AppConfig {
  testStations: string[]
  nonLineOperators: string[]
  stuckThresholdDays: number
  stationAppDataSince: string
}

export function useAppConfig(): UseQueryResult<AppConfig, Error> {
  return useQuery({
    queryKey: ['config'],
    queryFn: async () => {
      const res = await fetch('/api/config')
      return (await res.json()) as AppConfig
    },
    staleTime: 5 * 60_000,
  })
}

/** Global Refresh: bypass Redash cache for refetches triggered in the next 15s. */
export function useRefreshAll(): () => void {
  const qc = useQueryClient()
  return () => {
    forceRefreshUntil = Date.now() + 15_000
    void qc.invalidateQueries()
  }
}
