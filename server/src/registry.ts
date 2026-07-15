import type { ZodType } from 'zod'
import type { Exclusions } from './config.js'

export type Row = Record<string, unknown>

export interface QueryCtx {
  exclusions: Exclusions
}

export interface QueryDef<P = any> {
  /** Human-readable metric/source description, surfaced in the UI "definition & source" popover. */
  description: string
  /** Table(s)/view(s) this reads, fully qualified. */
  source: string
  /** Redash cache max_age in seconds (default 3600). UI "Refresh" overrides to 0. */
  maxAge?: number
  params: ZodType<P>
  sql: (p: P, ctx: QueryCtx) => string
  /** Deterministic demo rows for MOCK=1 mode — must match the live query's column shape. */
  mock: (p: P, ctx: QueryCtx) => Row[]
}

export type QueryRegistry = Record<string, QueryDef>
