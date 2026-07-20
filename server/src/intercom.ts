/**
 * Intercom client (read-only) for the Customer Service view.
 *
 * The server extracts one record per INBOUND CUSTOMER EMAIL (customer-initiated
 * email conversations only — no Messenger, no outbound): when it arrived, when
 * the first HUMAN reply landed (Fin/bot parts never count; human replies can
 * arrive as 'comment', 'assignment' or 'close' parts with a body — verified
 * against real threads), plus the flags the UI filters on (conversation
 * opener vs reply, assignee, Fin-resolved, xometry.com sender). All SLA math
 * (business-hours clipping, threshold, bucketing) happens client-side so the
 * SLA controls are instant.
 *
 * Volume: ~1k conversations/30d. Search pages are cheap; per-conversation part
 * fetches are cached by (id, updated_at) in a dedicated map, so refreshes only
 * re-fetch conversations that actually changed.
 */
import { config } from './config.js'
import { runRedashQuery } from './redash.js'
import { T } from './sql.js'
import type { Row } from './registry.js'
import { rng, periodsBetween } from './mock/helpers.js'

const BASE = 'https://api.intercom.io'

export class IntercomError extends Error {
  status: number
  hint?: string
  constructor(message: string, status = 502, hint?: string) {
    super(message)
    this.status = status
    this.hint = hint
  }
}

export function hasIntercomCreds(): boolean {
  return !!config.intercomToken
}

async function ic<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${config.intercomToken}`,
      'Intercom-Version': '2.11',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    throw new IntercomError('Intercom rejected the token (401)', 502, 'Check INTERCOM_ACCESS_TOKEN in .env.')
  }
  if (res.status === 429) {
    throw new IntercomError('Intercom rate limit hit (429)', 502, 'Wait a minute and refresh — results are cached once loaded.')
  }
  if (!res.ok) throw new IntercomError(`Intercom API ${path.split('?')[0]}: HTTP ${res.status}`)
  return (await res.json()) as T
}

interface SearchConversation {
  id: string
  created_at: number
  updated_at: number
  admin_assignee_id: number | null
  ai_agent_participated: boolean
  state: string
  source?: {
    type?: string
    delivered_as?: string
    author?: { type?: string; email?: string }
    subject?: string
  }
  conversation_rating?: {
    rating?: number | null
    remark?: string | null
    created_at?: number
    teammate?: { id?: string | number }
  } | null
}

interface ConversationPart {
  part_type: string
  created_at: number
  body?: string | null
  author?: { type?: string; id?: string }
}

interface ConversationDetail extends SearchConversation {
  conversation_parts?: { conversation_parts: ConversationPart[] }
}

/** One inbound customer email awaiting a human reply. */
export interface EmailRecord extends Row {
  conv_id: string
  email_at: number
  replied_at: number | null
  first: boolean
  assignee: string | null
  fin_resolved: boolean
  xometry: boolean
  /** No human reply, but a HUMAN closed the conversation after this email — an explicit "no response needed" disposition. Bot/auto-closes don't count, or misses would hide. */
  closed_no_reply: boolean
  sender: string
  subject: string
  /** Deep link into the Intercom inbox. */
  url: string
}

// Workspace id code (e.g. "vkap7doh") for inbox deep links — fetched once.
let appIdPromise: Promise<string> | null = null
function getAppId(): Promise<string> {
  if (!appIdPromise) {
    appIdPromise = ic<{ app?: { id_code?: string } }>('/me')
      .then((me) => me.app?.id_code ?? '')
      .catch(() => {
        appIdPromise = null
        return ''
      })
  }
  return appIdPromise
}

// Parts are immutable once a conversation stops changing — cache by (id, updated_at).
const convCache = new Map<string, EmailRecord[]>()
const CONV_CACHE_MAX = 8000

function cachePut(key: string, records: EmailRecord[]): void {
  if (convCache.size >= CONV_CACHE_MAX) {
    let n = 0
    for (const k of convCache.keys()) {
      convCache.delete(k)
      if (++n >= 1000) break
    }
  }
  convCache.set(key, records)
}

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

const isXometry = (email: string | undefined): boolean => !!email && /@(?:[a-z0-9-]+\.)*xometry\.com$/i.test(email)

/** A human (non-bot) reply the customer can see. Notes are internal; bots author as 'bot'. */
function isHumanReply(p: ConversationPart): boolean {
  return (
    p.author?.type === 'admin' &&
    ['comment', 'assignment', 'open', 'close'].includes(p.part_type) &&
    !!(p.body && p.body.replace(/<[^>]+>/g, '').trim())
  )
}

function extractRecords(c: ConversationDetail, appId: string): EmailRecord[] {
  const parts = c.conversation_parts?.conversation_parts ?? []
  const humanReplies = parts.filter(isHumanReply).map((p) => p.created_at)
  // A bodyless close by a real teammate; a close WITH a body is a reply-and-close
  // and already counts as a human reply above.
  const humanCloses = parts
    .filter((p) => p.author?.type === 'admin' && p.part_type === 'close' && !isHumanReply(p))
    .map((p) => p.created_at)
  const customerEmails = [c.created_at, ...parts.filter((p) => p.author?.type === 'user' && p.part_type === 'comment').map((p) => p.created_at)]
  const finResolved = c.ai_agent_participated && humanReplies.length === 0
  const xometry = isXometry(c.source?.author?.email)
  const sender = c.source?.author?.email ?? ''
  const subject = (c.source?.subject ?? '').replace(/<[^>]+>/g, '').trim() || '(no subject)'
  const url = appId ? `https://app.intercom.com/a/inbox/${appId}/inbox/conversation/${c.id}` : ''
  return customerEmails.map((at, i) => {
    const replied = humanReplies.find((r) => r >= at) ?? null
    return {
      conv_id: c.id,
      email_at: at,
      replied_at: replied,
      first: i === 0,
      assignee: c.admin_assignee_id === null || c.admin_assignee_id === undefined ? null : String(c.admin_assignee_id),
      fin_resolved: finResolved,
      xometry,
      closed_no_reply: replied === null && humanCloses.some((t) => t >= at),
      sender,
      subject,
      url,
    }
  })
}

/** All inbound-email records for conversations active in [start, end] (ISO dates). */
export async function fetchCsEmails(start: string, end: string): Promise<Row[]> {
  const startTs = Math.floor(new Date(`${start}T00:00:00-05:00`).getTime() / 1000)
  const endTs = Math.floor(new Date(`${end}T23:59:59-04:00`).getTime() / 1000)

  // Conversations updated since the window opened and created before it closed
  // — catches customer replies landing in old threads.
  const seen: SearchConversation[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < 40; page++) {
    const body: Record<string, unknown> = {
      query: {
        operator: 'AND',
        value: [
          { field: 'updated_at', operator: '>', value: startTs },
          { field: 'created_at', operator: '<', value: endTs },
          { field: 'source.delivered_as', operator: '=', value: 'customer_initiated' },
        ],
      },
      pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
    }
    const res = await ic<{ conversations: SearchConversation[]; pages?: { next?: { starting_after?: string } } }>(
      '/conversations/search',
      body,
    )
    seen.push(...(res.conversations ?? []))
    startingAfter = res.pages?.next?.starting_after
    if (!startingAfter) break
  }

  const emailConvs = seen.filter((c) => c.source?.type === 'email')
  const appId = await getAppId()
  const results = await pool(emailConvs, 8, async (c) => {
    const key = `${c.id}:${c.updated_at}`
    const hit = convCache.get(key)
    if (hit) return hit
    try {
      const detail = await ic<ConversationDetail>(`/conversations/${c.id}?display_as=plaintext`)
      const records = extractRecords(detail, appId)
      cachePut(key, records)
      return records
    } catch {
      return [] as EmailRecord[] // one bad conversation must not kill the panel
    }
  })

  return results
    .flat()
    .filter((r) => (r.email_at as number) >= startTs && (r.email_at as number) <= endTs)
    .sort((a, b) => (a.email_at as number) - (b.email_at as number))
}

/**
 * Conversation ratings (CSAT) left in [start, end]. Ratings ride on the search
 * response, so this needs no per-conversation fetches. A new rating bumps the
 * conversation's updated_at, so searching on updated_at catches ratings left
 * on old threads; the rating's own created_at does the range filtering.
 */
export async function fetchCsRatings(start: string, end: string): Promise<Row[]> {
  const startTs = Math.floor(new Date(`${start}T00:00:00-05:00`).getTime() / 1000)
  const endTs = Math.floor(new Date(`${end}T23:59:59-04:00`).getTime() / 1000)
  const appId = await getAppId()

  const rows: Row[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < 40; page++) {
    const body: Record<string, unknown> = {
      query: { field: 'updated_at', operator: '>', value: startTs },
      pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
    }
    const res = await ic<{ conversations: SearchConversation[]; pages?: { next?: { starting_after?: string } } }>(
      '/conversations/search',
      body,
    )
    for (const c of res.conversations ?? []) {
      const r = c.conversation_rating
      if (!r || r.rating === null || r.rating === undefined) continue
      const ratedAt = r.created_at ?? c.updated_at
      if (ratedAt < startTs || ratedAt > endTs) continue
      rows.push({
        conv_id: c.id,
        rated_at: ratedAt,
        rating: r.rating,
        remark: r.remark ?? '',
        teammate: r.teammate?.id === undefined ? null : String(r.teammate.id),
        sender: c.source?.author?.email ?? '',
        subject: (c.source?.subject ?? '').replace(/<[^>]+>/g, '').trim() || '(no subject)',
        channel: c.source?.type ?? '',
        url: appId ? `https://app.intercom.com/a/inbox/${appId}/inbox/conversation/${c.id}` : '',
      })
    }
    startingAfter = res.pages?.next?.starting_after
    if (!startingAfter) break
  }
  return rows.sort((a, b) => (a.rated_at as number) - (b.rated_at as number))
}

/**
 * Customer-facing RMA tickets ("Form Now RMA" + "Xometry RMA" ticket types).
 * These are the RMA source that KEPT flowing after the back-office "RMA
 * Submission" form (which fed fcm_api_rmapart with part quantities) lapsed on
 * 2026-06-23. Tickets carry origin/RMA order ids but NO part quantities, so
 * the honest continuing unit is orders-with-an-RMA. Coverage note: these
 * types ramped up in early 2026 — Jan–Mar undercount vs the back-office form.
 */
const RMA_TICKET_TYPES = [
  { id: 2991363, label: 'Form Now' },
  { id: 2949414, label: 'Xometry' },
]

interface RmaTicket {
  id: string
  created_at: number
  open: boolean
  ticket_attributes?: Record<string, unknown>
}

export async function fetchRmaTickets(start: string, end: string): Promise<Row[]> {
  const startTs = Math.floor(new Date(`${start}T00:00:00-05:00`).getTime() / 1000)
  // RMAs are SHIP-DATE cohorted downstream: a ticket for an order shipped in
  // the window can be filed weeks later, so the ticket search extends 45 days
  // past the window (median ship→RMA lag is 8 days, p90 20).
  const endTs = Math.min(
    Math.floor(Date.now() / 1000),
    Math.floor(new Date(`${end}T23:59:59-04:00`).getTime() / 1000) + 45 * 86400,
  )
  const appId = await getAppId()
  const rows: Row[] = []
  for (const type of RMA_TICKET_TYPES) {
    let startingAfter: string | undefined
    for (let page = 0; page < 20; page++) {
      const body: Record<string, unknown> = {
        query: {
          operator: 'AND',
          value: [
            { field: 'ticket_type_id', operator: '=', value: type.id },
            { field: 'created_at', operator: '>', value: startTs - 1 },
            { field: 'created_at', operator: '<', value: endTs + 1 },
          ],
        },
        pagination: { per_page: 150, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      }
      const res = await ic<{ tickets: RmaTicket[]; pages?: { next?: { starting_after?: string } } }>('/tickets/search', body)
      for (const t of res.tickets ?? []) {
        const a = t.ticket_attributes ?? {}
        const originId = Number(a['Origin Job Internal ID'])
        const rmaId = Number(a['RMA Job Internal ID'])
        rows.push({
          ticket_id: String(t.id),
          rma_type: type.label,
          created_at: t.created_at,
          state: t.open ? 'open' : 'closed',
          title: String(a['_default_title_'] ?? '').trim(),
          origin_order_id: Number.isFinite(originId) && originId > 0 ? originId : null,
          rma_order_id: Number.isFinite(rmaId) && rmaId > 0 ? rmaId : null,
          url: appId ? `https://app.intercom.com/a/inbox/${appId}/inbox/conversation/${t.id}` : '',
        })
      }
      startingAfter = res.pages?.next?.starting_after
      if (!startingAfter) break
    }
  }
  // Resolve origin orders' ship dates for cohorting (degrades without VPN).
  const ids = [...new Set(rows.map((r) => r.origin_order_id).filter((v): v is number => typeof v === 'number'))]
  if (ids.length) {
    try {
      const res = await runRedashQuery(
        `SELECT id, CAST(DATE(shipped_at) AS STRING) AS ship_date FROM ${T.order} WHERE id IN (${ids.join(', ')}) AND shipped_at IS NOT NULL`,
        { maxAge: 3600 },
      )
      const shipDates = new Map(res.rows.map((r) => [Number(r.id), String(r.ship_date)]))
      for (const r of rows) r.origin_shipped_at = shipDates.get(r.origin_order_id as number) ?? null
    } catch {
      for (const r of rows) r.origin_shipped_at = null
    }
  }
  return rows.sort((a, b) => (b.created_at as number) - (a.created_at as number))
}

export function mockRmaTickets(start: string, end: string): Row[] {
  const r = rng(`rmat:${start}:${end}`)
  const rows: Row[] = []
  let id = 5000
  for (const day of periodsBetween(start, end, 'day')) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
    if (dow === 0 || dow === 6 || r() < 0.55) continue
    const n = 1 + Math.round(r())
    for (let i = 0; i < n; i++) {
      const createdAt = Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000) + 14 * 3600 + Math.round(r() * 6 * 3600)
      rows.push({
        ticket_id: String(id),
        rma_type: r() < 0.5 ? 'Form Now' : 'Xometry',
        created_at: createdAt,
        state: r() < 0.6 ? 'closed' : 'open',
        title: `Part quality issue — order ${17000 + id - 5000}`,
        origin_order_id: 17000 + id - 5000,
        origin_shipped_at: new Date((createdAt - Math.round((2 + r() * 14) * 86400)) * 1000).toISOString().slice(0, 10),
        rma_order_id: r() < 0.7 ? 21000 + id - 5000 : null,
        url: '',
      })
      id++
    }
  }
  return rows
}

export async function fetchCsAdmins(): Promise<Row[]> {
  const res = await ic<{ admins: { id: string; name: string }[] }>('/admins')
  return (res.admins ?? []).map((a) => ({ id: String(a.id), name: a.name }))
}

// ---------------------------------------------------------------------------
// MOCK=1 — deterministic demo rows, same shapes as the live extraction.
// ---------------------------------------------------------------------------

const MOCK_ADMINS = [
  { id: '1', name: 'Cameron W.' },
  { id: '2', name: 'Izzy P.' },
  { id: '3', name: 'Nassim A.' },
  { id: '4', name: 'Alanna R.' },
]

export function mockCsAdmins(): Row[] {
  return MOCK_ADMINS.map((a) => ({ ...a }))
}

export function mockCsRatings(start: string, end: string): Row[] {
  const r = rng(`csr:${start}:${end}`)
  const rows: Row[] = []
  let id = 7000
  for (const day of periodsBetween(start, end, 'day')) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
    if (dow === 0 || dow === 6) continue
    const n = Math.round(r() * 3)
    for (let i = 0; i < n; i++) {
      const rating = r() < 0.7 ? 5 : r() < 0.5 ? 4 : r() < 0.5 ? 3 : r() < 0.5 ? 2 : 1
      rows.push({
        conv_id: String(id++),
        rated_at: Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000) + 14 * 3600 + Math.round(r() * 6 * 3600),
        rating,
        remark: rating <= 2 ? 'Took too long to hear back.' : r() < 0.2 ? 'Great service, thank you!' : '',
        teammate: MOCK_ADMINS[Math.floor(r() * MOCK_ADMINS.length)].id,
        sender: `customer${Math.floor(r() * 40)}@example.com`,
        subject: `Order question #${1000 + Math.floor(r() * 900)}`,
        channel: 'email',
        url: '',
      })
    }
  }
  return rows
}

export function mockCsEmails(start: string, end: string): Row[] {
  const r = rng(`cs:${start}:${end}`)
  const rows: Row[] = []
  let id = 9000
  for (const day of periodsBetween(start, end, 'day')) {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
    const n = dow === 0 || dow === 6 ? Math.round(r() * 4) : 8 + Math.round(r() * 14)
    for (let i = 0; i < n; i++) {
      const emailAt = Math.floor(new Date(`${day}T00:00:00Z`).getTime() / 1000) + 11 * 3600 + Math.round(r() * 10 * 3600)
      const replied = r() < 0.85
      const finResolved = !replied && r() < 0.5
      rows.push({
        conv_id: String(id++),
        email_at: emailAt,
        replied_at: replied ? emailAt + Math.round((0.2 + r() * 30) * 3600) : null,
        first: r() < 0.7,
        assignee: r() < 0.3 ? null : MOCK_ADMINS[Math.floor(r() * MOCK_ADMINS.length)].id,
        fin_resolved: finResolved,
        xometry: r() < 0.25,
        closed_no_reply: !replied && !finResolved && r() < 0.5,
        sender: `customer${Math.floor(r() * 40)}@example.com`,
        subject: `Order question #${1000 + Math.floor(r() * 900)}`,
        url: '',
      })
    }
  }
  return rows
}
