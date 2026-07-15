import { config } from './config.js'

export interface QueryResultData {
  columns: { name: string; type: string }[]
  rows: Record<string, unknown>[]
}

export class RedashError extends Error {
  status: number
  hint?: string
  constructor(message: string, status = 502, hint?: string) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

const POLL_INTERVAL_MS = 700
const POLL_CAP_MS = 60_000
const REQUEST_TIMEOUT_MS = 30_000

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Key ${config.apiKey}`,
    'Content-Type': 'application/json',
  }
  if (config.cfClientId && config.cfClientSecret) {
    h['CF-Access-Client-Id'] = config.cfClientId
    h['CF-Access-Client-Secret'] = config.cfClientSecret
  }
  return h
}

async function redashFetch(path: string, init?: RequestInit): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${config.redashUrl}${path}`, {
      ...init,
      headers: headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e: any) {
    throw new RedashError(
      `Cannot reach Redash at ${config.redashUrl}.`,
      503,
      'Check that you are on the VPN / corporate network. The Redash host is internal-only.',
    )
  }
  if (res.status === 401 || res.status === 403) {
    throw new RedashError(
      `Redash rejected the request (HTTP ${res.status}).`,
      res.status,
      'Check REDASH_API_KEY in .env (Redash → avatar → Edit Profile → API Key). If Redash sits behind Cloudflare Access, set CF_ACCESS_CLIENT_ID/SECRET.',
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new RedashError(`Redash returned HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Run SQL through Redash (submit → poll job → fetch result).
 * maxAge > 0 lets Redash serve a cached result for identical SQL; 0 forces a fresh run.
 */
export async function runRedashQuery(sql: string, { maxAge = 3600 } = {}): Promise<QueryResultData> {
  if (!config.apiKey) {
    throw new RedashError(
      'REDASH_API_KEY is not set.',
      500,
      'Copy .env.example to .env and paste your personal Redash API key, or start with MOCK=1 for demo data.',
    )
  }

  const submitted = await redashFetch('/api/query_results', {
    method: 'POST',
    body: JSON.stringify({ query: sql, data_source_id: config.dataSourceId, max_age: maxAge }),
  })

  let resultId: number | undefined
  if (submitted.query_result) {
    return normalize(submitted.query_result)
  }
  const jobId = submitted.job?.id
  if (!jobId) throw new RedashError('Unexpected Redash response (no job or query_result).')

  const deadline = Date.now() + POLL_CAP_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const { job } = await redashFetch(`/api/jobs/${jobId}`)
    if (job.status === 3) {
      resultId = job.query_result_id
      break
    }
    if (job.status === 4 || job.status === 5) {
      throw new RedashError(`Query failed: ${job.error || 'unknown Redash job error'}`, 400)
    }
  }
  if (!resultId) {
    throw new RedashError(
      'Query timed out after 60s of polling.',
      504,
      'Large warehouse scans can take a while — try a narrower date range, or retry.',
    )
  }

  const result = await redashFetch(`/api/query_results/${resultId}.json`)
  return normalize(result.query_result)
}

function normalize(queryResult: any): QueryResultData {
  const data = queryResult?.data ?? {}
  const columns = (data.columns ?? []).map((c: any) => ({ name: c.name, type: c.type ?? 'string' }))
  const colNames = columns.map((c: { name: string }) => c.name)
  const rows = (data.rows ?? []).map((row: any) => {
    if (Array.isArray(row)) {
      const o: Record<string, unknown> = {}
      colNames.forEach((c: string, i: number) => (o[c] = row[i]))
      return o
    }
    return row
  })
  return { columns, rows }
}
