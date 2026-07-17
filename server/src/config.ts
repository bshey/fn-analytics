import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, '..', '..')

dotenv.config({ path: resolve(repoRoot, '.env') })

export const config = {
  redashUrl: (process.env.REDASH_URL ?? 'https://redash.devops.priv.prod.gcp.formlabs.cloud').replace(/\/+$/, ''),
  apiKey: process.env.REDASH_API_KEY ?? '',
  dataSourceId: Number(process.env.REDASH_DATA_SOURCE_ID ?? 13),
  cfClientId: process.env.CF_ACCESS_CLIENT_ID,
  cfClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
  // Formlabs Dashboard API (OAuth client credentials; FORMLABS_API_TOKEN is the client SECRET).
  formlabsClientId: process.env.FORMLABS_API_CLIENT_ID ?? '',
  formlabsClientSecret: process.env.FORMLABS_API_TOKEN ?? '',
  port: Number(process.env.PORT ?? 4600),
  mock: process.env.MOCK === '1',
  isProd: process.env.NODE_ENV === 'production',
}

export interface Exclusions {
  testStations: string[]
  nonLineOperators: string[]
  revenueSentinelBillingId: string
  stuckThresholdDays: number
  stationAppDataSince: string
  /** Part-file volumes above this are unit-scale upload artifacts (nothing over ~25L fits any printer) and are excluded from volume sums. */
  maxPartVolumeMl: number
}

// Serverless bundlers relocate this module, so repoRoot can point outside the
// deployed bundle — fall back to the process cwd (Vercel runs at /var/task).
const EXCLUSIONS_CANDIDATES = [
  resolve(repoRoot, 'config', 'exclusions.json'),
  resolve(process.cwd(), 'config', 'exclusions.json'),
]

/** Re-read on every call so edits to config/exclusions.json apply without a restart. */
export function loadExclusions(): Exclusions {
  let raw: any = {}
  for (const path of EXCLUSIONS_CANDIDATES) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
      break
    } catch {
      // try next candidate; all defaults below apply if none is readable
    }
  }
  return {
    testStations: raw.testStations ?? [],
    nonLineOperators: raw.nonLineOperators ?? [],
    revenueSentinelBillingId: raw.revenueSentinelBillingId ?? 'external-fcm-sales-789!',
    stuckThresholdDays: raw.stuckThresholdDays ?? 3,
    stationAppDataSince: raw.stationAppDataSince ?? '2026-07-02',
    maxPartVolumeMl: raw.maxPartVolumeMl ?? 25000,
  }
}
