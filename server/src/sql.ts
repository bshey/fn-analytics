import { z } from 'zod'

/** Fully-qualified table names — always query through data source 13 with these. */
export const T = {
  order: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_order`',
  orderPart: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_orderpart`',
  partFile: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_partfile`',
  printBuild: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_printbuild`',
  printBuildPart: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_printbuildpart`',
  orderEvent: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.fcm_api_orderevent`',
  mfgEvent: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.manufacturing_events_manufacturingevent`',
  station: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.mes_station_station`',
  operator: '`formlabs-data-warehouse.formcloud_manufacturing_admin_public.mes_station_operator`',
  tulipMaster: '`formlabs-data-warehouse.formcloud_manufacturing.master_table`',
  tulipDefect: '`formlabs-data-warehouse.formcloud_manufacturing.defect_table`',
  medusaOrder: '`formlabs-data-warehouse.form_now_medusa_prod.order`',
  medusaMaterial: '`formlabs-data-warehouse.form_now_medusa_prod.material`',
  shipmentsKpi: '`formlabs-data-sandbox.fcm.v_shipments_kpi`',
} as const

export const CHANNELS = [
  'Xometry',
  'Web - Revenue Generating',
  'Web - Non-Revenue Generating',
  'PreForm - Revenue Generating',
  'PreForm - Non-Revenue Generating',
] as const

export const MFG_TYPES = [
  'SLA - Form 4',
  'SLA - Form 4L',
  'SLA - Form 3',
  'SLA - Form 3L',
  'SLS - Fuse 1+',
  'SLS - Fuse X1',
] as const

export const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const
export type Grain = (typeof GRAINS)[number]

// ---------- zod param fragments (shared by all query defs) ----------

export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const zGrain = z.enum(GRAINS).default('week')
export const zChannels = z.array(z.enum(CHANNELS)).default([])
export const zMfgTypes = z.array(z.enum(MFG_TYPES)).default([])
export const zMaterials = z.array(z.string().regex(/^[A-Za-z0-9._ -]{1,40}$/)).default([])

/** Empty arrays mean "no filter" (all). */
export const zBaseFilters = z.object({
  start: zDate,
  end: zDate,
  grain: zGrain,
  channels: zChannels,
  mfgTypes: zMfgTypes,
  materials: zMaterials,
})
export type BaseFilters = z.infer<typeof zBaseFilters>

// ---------- safe literal builders ----------

/** Escape a validated string for a BigQuery single-quoted literal. */
export function sqlString(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export function sqlStringList(values: readonly string[]): string {
  return values.map(sqlString).join(', ')
}

export function sqlDate(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`invalid date literal: ${v}`)
  return `'${v}'`
}

/** Period-truncation expression for a DATE column. Week starts Sunday (matches Looker). */
export function grainExpr(dateCol: string, grain: Grain): string {
  switch (grain) {
    case 'day':
      return dateCol
    case 'week':
      return `DATE_TRUNC(${dateCol}, WEEK(SUNDAY))`
    case 'month':
      return `DATE_TRUNC(${dateCol}, MONTH)`
    case 'quarter':
      return `DATE_TRUNC(${dateCol}, QUARTER)`
    case 'year':
      return `DATE_TRUNC(${dateCol}, YEAR)`
  }
}

/**
 * The governed due date (matches formlabs-data-sandbox.fcm.f_orders):
 * Xometry ship_by timestamps are stored at 23:59 America/New_York (03:59 UTC next day),
 * so a plain UTC DATE() shifts every Xometry due date one day later and inflates
 * on-time % by ~8 points. Web/PreForm ship_by is stored at 00:00 UTC — unaffected.
 * Always use this instead of DATE(ship_by).
 */
export function governedDueDateExpr(alias = 'o'): string {
  return `CASE
      WHEN ${alias}.ship_by IS NULL THEN NULL
      WHEN (${alias}.xometry_order_id IS NOT NULL AND ${alias}.xometry_order_id != '') OR ${alias}.source = 'Xometry'
        THEN DATE(${alias}.ship_by, 'America/New_York')
      ELSE DATE(${alias}.ship_by, 'UTC')
    END`
}

/** "Today" for the Somerville ops team — UTC CURRENT_DATE() flips at 8 PM ET and mislabels evening triage. */
export const CURRENT_DATE_ET = `CURRENT_DATE('America/New_York')`

/** Sum of money fields defining "bookings" (matches the governed view). `o` = fcm_api_order alias. */
export function bookingsExpr(alias = 'o'): string {
  const f = (c: string) => `IFNULL(SAFE_CAST(${alias}.${c} AS FLOAT64), 0)`
  return `(${f('subtotal')} + ${f('shipping_cost')} + ${f('tax_cost')} + ${f('credit_balance_applied')})`
}

// ---------- filter fragments for v_shipments_kpi ----------

/** AND-fragments (each starts with "AND ") applying channel/type/material filters to the KPI view. */
export function kpiViewFilters(p: BaseFilters): string {
  const parts: string[] = []
  if (p.channels.length) parts.push(`AND reporting_category IN (${sqlStringList(p.channels)})`)
  if (p.mfgTypes.length) {
    parts.push(
      `AND EXISTS (SELECT 1 FROM UNNEST(SPLIT(IFNULL(manufacturing_types,''), ',')) t WHERE TRIM(t) IN (${sqlStringList(p.mfgTypes)}))`,
    )
  }
  if (p.materials.length) {
    parts.push(
      `AND EXISTS (SELECT 1 FROM UNNEST(SPLIT(IFNULL(materials,''), ',')) m WHERE TRIM(m) IN (${sqlStringList(p.materials)}))`,
    )
  }
  return parts.join('\n  ')
}

/**
 * AND-fragments applying material / manufacturing-type filters to ORDER-LEVEL
 * queries via fcm_api_orderpart (each part carries `material` SKU + `manufacturing_type`,
 * same value sets as the KPI view). "Contains" semantics: an order matches when
 * ANY of its parts matches — combinable with channel filters.
 */
export function orderPartFilters(p: Pick<BaseFilters, 'mfgTypes' | 'materials'>, alias = 'o'): string {
  const parts: string[] = []
  if (p.mfgTypes.length) {
    parts.push(
      `AND EXISTS (SELECT 1 FROM ${T.orderPart} fp WHERE fp.order_id = ${alias}.id AND fp.manufacturing_type IN (${sqlStringList(p.mfgTypes)}))`,
    )
  }
  if (p.materials.length) {
    parts.push(
      `AND EXISTS (SELECT 1 FROM ${T.orderPart} fp WHERE fp.order_id = ${alias}.id AND fp.material IN (${sqlStringList(p.materials)}))`,
    )
  }
  return parts.join('\n  ')
}

// ---------- reporting-category classification for order-level tables (spec §8.1) ----------

/**
 * CTE text replicating the GOVERNED f_orders classification VERBATIM (so channel
 * filters tie to Looker): medusa_coupons + medusa_li_utm + `orders` (fcm_api_order
 * enriched with utm_source [order-level with line-item fallback], medusa_email,
 * coupon_codes) + `classified` (adds reporting_category). Key rules beyond the
 * old HANDOFF §8.1 draft: INTERNAL-FORM-NOW-PO coupon orders are Revenue
 * Generating; non-Form-Now/non-Xometry sources are PreForm; negative applied
 * credit counts as revenue-generating.
 * Embed inside `WITH ${classifiedOrdersCTEs()} SELECT ... FROM classified`.
 * `extraWhere` is ANDed into the base order scan to limit bytes scanned — always date-bound it.
 * `sentinel` is the revenue-generating billing id (config/exclusions.json revenueSentinelBillingId).
 */
export function classifiedOrdersCTEs(extraWhere = '', sentinel = 'external-fcm-sales-789!'): string {
  const medusaLineItem = '`formlabs-data-warehouse.form_now_medusa_prod.order_line_item`'
  const medusaLineItemAdj = '`formlabs-data-warehouse.form_now_medusa_prod.order_line_item_adjustment`'
  const medusaOrderItem = '`formlabs-data-warehouse.form_now_medusa_prod.order_item`'
  return `medusa_coupons AS (
  SELECT oi.order_id, STRING_AGG(DISTINCT olia.code ORDER BY olia.code) AS discount_codes
  FROM ${medusaLineItem} oli
  JOIN ${medusaLineItemAdj} olia ON oli.id = olia.item_id
  JOIN (
    SELECT * FROM ${medusaOrderItem}
    QUALIFY ROW_NUMBER() OVER(PARTITION BY item_id ORDER BY version DESC) = 1
  ) oi ON oi.item_id = oli.id
  WHERE NOT STARTS_WITH(olia.code, 'LOYALTY-')
  GROUP BY oi.order_id
),
medusa_li_utm AS (
  SELECT oi.order_id, STRING_AGG(DISTINCT JSON_VALUE(oli.metadata, '$.utm.utm_source'), ', ') AS utm_source
  FROM ${medusaLineItem} oli
  JOIN (
    SELECT * FROM ${medusaOrderItem}
    QUALIFY ROW_NUMBER() OVER(PARTITION BY item_id ORDER BY version DESC) = 1
  ) oi ON oi.item_id = oli.id
  WHERE JSON_EXTRACT(oli.metadata, '$.utm') IS NOT NULL
  GROUP BY oi.order_id
),
orders AS (
  SELECT o.*,
    COALESCE(NULLIF(JSON_VALUE(m.metadata, '$.attribution.utm_source'), ''), li.utm_source) AS utm_source,
    m.email AS medusa_email,
    cc.discount_codes AS coupon_codes
  FROM ${T.order} o
  LEFT JOIN ${T.medusaOrder} m ON m.id = o.source_reference_id
  LEFT JOIN medusa_coupons cc ON cc.order_id = o.source_reference_id
  LEFT JOIN medusa_li_utm li ON li.order_id = o.source_reference_id
  ${extraWhere ? `WHERE ${extraWhere}` : ''}
),
classified AS (
  SELECT *,
    CASE
      WHEN xometry_order_id IS NOT NULL AND xometry_order_id != '' THEN 'Xometry'
      WHEN SAFE_CAST(amount_charged AS FLOAT64) > 0 AND source = 'Form Now'
        THEN IF(utm_source = 'preform', 'PreForm - Revenue Generating', 'Web - Revenue Generating')
      WHEN source = 'Form Now' AND coupon_codes = 'INTERNAL-FORM-NOW-PO'
        THEN IF(utm_source = 'preform', 'PreForm - Revenue Generating', 'Web - Revenue Generating')
      WHEN source = 'Form Now'
        THEN IF(utm_source = 'preform', 'PreForm - Non-Revenue Generating', 'Web - Non-Revenue Generating')
      WHEN SAFE_CAST(amount_charged AS FLOAT64) > 0
        OR formlabs_billing_id = ${sqlString(sentinel)}
        OR discount_code = ${sqlString(sentinel)}
        OR SAFE_CAST(credit_balance_applied AS FLOAT64) < 0 THEN 'PreForm - Revenue Generating'
      WHEN formlabs_billing_id IS NOT NULL AND formlabs_billing_id != '' THEN 'PreForm - Non-Revenue Generating'
      WHEN source IS NOT NULL AND source != '' THEN source
      ELSE 'PreForm - Non-Revenue Generating'
    END AS reporting_category
  FROM orders
)`
}

/** AND-fragment applying a channel filter to a `classified` CTE selection. */
export function classifiedChannelFilter(channels: readonly string[], alias = ''): string {
  if (!channels.length) return ''
  const col = alias ? `${alias}.reporting_category` : 'reporting_category'
  return `AND ${col} IN (${sqlStringList(channels as string[])})`
}

export const OPEN_ORDER_STATUSES = ['QUOTING', 'ACCEPTED', 'PRINTING', 'ON_HOLD'] as const
export const CLOSED_ORDER_STATUSES = ['SHIPPED', 'CANCELLED', 'REJECTED'] as const

/**
 * The governed BOOKINGS formula (verbatim semantics from f_orders): money
 * recognized AT ORDER TIME regardless of shipment — Xometry = subtotal; else
 * amount_charged when > 0; internal (formlabs.com / sentinel billing id / PO
 * coupon) = full quoted value; external 100%-discounted orders = $0.
 * Revenue in f_orders is this same formula gated on shipped_at.
 * `alias` must be a classifiedOrdersCTEs row (carries medusa_email + coupon_codes).
 */
export function governedBookingsExpr(alias: string, sentinel: string): string {
  const f = (c: string) => `IFNULL(SAFE_CAST(${alias}.${c} AS FLOAT64), 0)`
  const full = `${f('subtotal')} + ${f('shipping_cost')} + ${f('tax_cost')}`
  return `CASE
      WHEN (${alias}.xometry_order_id IS NOT NULL AND ${alias}.xometry_order_id != '') OR ${alias}.source = 'Xometry' THEN ${f('subtotal')}
      WHEN ${f('amount_charged')} > 0 THEN ${f('amount_charged')}
      WHEN CONTAINS_SUBSTR(IFNULL(${alias}.medusa_email, ''), '@formlabs.com') THEN ${full}
      WHEN ${alias}.formlabs_billing_id = ${sqlString(sentinel)}
        OR ${alias}.discount_code = ${sqlString(sentinel)}
        OR ${alias}.coupon_codes = 'INTERNAL-FORM-NOW-PO' THEN ${full}
      ELSE 0
    END`
}
