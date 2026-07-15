import { z } from 'zod'
import type { QueryRegistry } from '../registry.js'
import { T } from '../sql.js'
import { MOCK_MATERIALS } from '../mock/helpers.js'

/**
 * Dimension/reference queries. These are cheap and heavily cached (24h) —
 * the UI "Refresh" can still force them with refresh:true.
 */
export const dimQueries: QueryRegistry = {
  /** Raw Medusa material rows — code→friendly-name source (~30 rows). Mapping is adaptive server-side. */
  dim_materials_raw: {
    description: 'Material SKU code → friendly name mapping from the Medusa storefront.',
    source: 'form_now_medusa_prod.material',
    maxAge: 86400,
    params: z.object({}).default({}),
    sql: () => `SELECT * FROM ${T.medusaMaterial} LIMIT 200`,
    mock: () => MOCK_MATERIALS.map((m) => ({ id: m.code, name: m.name })),
  },

  /** Distinct material SKU codes actually present in the KPI view (last 365d). */
  dim_material_codes: {
    description: 'Distinct material SKU codes seen in shipments over the last year.',
    source: 'formlabs-data-sandbox.fcm.v_shipments_kpi',
    maxAge: 86400,
    params: z.object({}).default({}),
    sql: () => `
SELECT DISTINCT TRIM(m) AS code
FROM ${T.shipmentsKpi}, UNNEST(SPLIT(IFNULL(materials, ''), ',')) m
WHERE date_key >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)
  AND date_key <= CURRENT_DATE()
  AND TRIM(m) != ''
ORDER BY code`,
    mock: () => MOCK_MATERIALS.map((m) => ({ code: m.code })),
  },

  /** Warehouse freshness for the "data as of" banner. */
  meta_freshness: {
    description: 'Latest ship date in the KPI view and latest order update — the warehouse lags ~1 day.',
    source: 'v_shipments_kpi + fcm_api_order',
    maxAge: 1800,
    params: z.object({}).default({}),
    sql: () => `
SELECT
  CAST((SELECT MAX(date_key) FROM ${T.shipmentsKpi} WHERE date_key <= CURRENT_DATE()) AS STRING) AS latest_ship_date,
  CAST((SELECT MAX(updated_at) FROM ${T.order}) AS STRING) AS latest_order_update`,
    mock: () => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() - 1)
      return [
        {
          latest_ship_date: d.toISOString().slice(0, 10),
          latest_order_update: d.toISOString().replace('T', ' ').slice(0, 19),
        },
      ]
    },
  },
}

/**
 * Adaptive material mapping: the Medusa table's column names weren't verified in recon,
 * so find a name-ish column and a code-ish column (values like FLGPGR05) at runtime.
 */
export function mapMaterialRows(rows: Record<string, unknown>[]): { code: string; name: string }[] {
  if (!rows.length) return []
  const keys = Object.keys(rows[0])
  const nameKey =
    keys.find((k) => ['name', 'title', 'material_name', 'display_name'].includes(k.toLowerCase())) ?? null
  const codeLike = (v: unknown) => typeof v === 'string' && /^FL[A-Z0-9]{3,}$/i.test(v)
  let codeKey: string | null = null
  let best = 0
  for (const k of keys) {
    const hits = rows.filter((r) => codeLike(r[k])).length
    if (hits > best) {
      best = hits
      codeKey = k
    }
  }
  if (!codeKey || best === 0) return []
  return rows
    .filter((r) => codeLike(r[codeKey!]))
    .map((r) => ({
      code: String(r[codeKey!]),
      name: nameKey && r[nameKey] ? String(r[nameKey]) : String(r[codeKey!]),
    }))
}
