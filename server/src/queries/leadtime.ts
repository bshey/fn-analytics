import type { QueryRegistry, Row } from '../registry.js'
import { T, zBaseFilters, sqlDate } from '../sql.js'
import { rng, periodsBetween } from '../mock/helpers.js'

// ---------------------------------------------------------------------------
// Module G — Lead Time Tuner. One row per LINE ITEM of Form Now orders
// submitted in the window, carrying every input the quoting engine uses
// (family, part count, line volume, material, bounding-box max dimension)
// plus the order's outcome. All tier math/simulation happens client-side so
// threshold edits recompute instantly.
// ---------------------------------------------------------------------------

export const leadtimeQueries: QueryRegistry = {
  leadtime_lines: {
    description:
      "Quoting-engine inputs per line item for Form Now orders SUBMITTED in the window (the benchmark cohort — pick a short recent range when caught up, a wider one in stable times): family (SLA/SLS), part quantity, line material volume (part volume × qty), material code, bounding-box max dimension, plus the order's submitted date, governed quoted lead (business days to ship_by), shipped flag and actual production business days (Mon–Fri, null while unshipped — unshipped orders ride along so the UI can warn about unsettled cohorts). Unit-scale upload artifacts (volume > 25 L or max dimension > 353 mm — impossible on any printer) are excluded at the line level. Cancelled/rejected/quoting orders excluded. Channel/material filters do NOT apply (quoting is Form Now only).",
    source: 'fcm_api_order + fcm_api_orderpart + fcm_api_partfile (Form Now only)',
    params: zBaseFilters,
    sql: (p) => `
WITH bcal AS (
  SELECT d, ROW_NUMBER() OVER (ORDER BY d) AS idx
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(${sqlDate(p.start)}, INTERVAL 14 DAY), DATE_ADD(${sqlDate(p.end)}, INTERVAL 150 DAY))) AS d
  WHERE EXTRACT(DAYOFWEEK FROM d) NOT IN (1, 7)
),
orders AS (
  SELECT o.id, o.submitted_at, o.shipped_at, o.ship_by, o.status,
         bsub.idx AS sub_idx,
         (SELECT MIN(idx) FROM bcal WHERE d >= DATE(o.shipped_at)) AS ship_idx,
         (SELECT MIN(idx) FROM bcal WHERE d >= DATE(o.ship_by)) AS due_idx
  FROM ${T.order} o
  JOIN bcal bsub ON bsub.d = (SELECT MIN(d) FROM bcal WHERE d >= DATE(o.submitted_at))
  WHERE o.source = 'Form Now'
    AND o.status NOT IN ('QUOTING', 'CANCELLED', 'REJECTED')
    AND o.submitted_at IS NOT NULL AND o.ship_by IS NOT NULL
    AND DATE(o.submitted_at) BETWEEN ${sqlDate(p.start)} AND ${sqlDate(p.end)}
)
SELECT
  o.id AS order_id,
  CAST(DATE(o.submitted_at) AS STRING) AS submitted,
  o.shipped_at IS NOT NULL AS shipped,
  IF(o.shipped_at IS NOT NULL, o.ship_idx - o.sub_idx, NULL) AS actual_bizdays,
  o.due_idx - o.sub_idx AS quoted_bizdays,
  IF(STARTS_WITH(op.manufacturing_type, 'SLS'), 'SLS', 'SLA') AS family,
  op.quantity AS qty,
  ROUND(SAFE_CAST(pf.volume_ml AS FLOAT64) * op.quantity, 2) AS line_volume_ml,
  op.material,
  ROUND(GREATEST(
    IFNULL(SAFE_CAST(pf.size_width_mm AS FLOAT64), 0),
    IFNULL(SAFE_CAST(pf.size_depth_mm AS FLOAT64), 0),
    IFNULL(SAFE_CAST(pf.size_height_mm AS FLOAT64), 0)
  ), 1) AS max_dim_mm
FROM orders o
JOIN ${T.orderPart} op ON op.order_id = o.id
JOIN ${T.partFile} pf ON pf.guid = op.part_file_id
WHERE IFNULL(SAFE_CAST(pf.volume_ml AS FLOAT64), 0) <= 25000
  AND GREATEST(
    IFNULL(SAFE_CAST(pf.size_width_mm AS FLOAT64), 0),
    IFNULL(SAFE_CAST(pf.size_depth_mm AS FLOAT64), 0),
    IFNULL(SAFE_CAST(pf.size_height_mm AS FLOAT64), 0)
  ) <= 353
ORDER BY o.id`,
    mock: (p) => {
      const r = rng(`ltl:${p.start}:${p.end}`)
      const rows: Row[] = []
      let id = 30000
      const mats = ['FLGPGR05', 'FLGPBK05', 'FLP12G01', 'FLTO2002', 'FLTO1502', 'FLELCL02']
      for (const day of periodsBetween(p.start, p.end, 'day')) {
        const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
        if (dow === 0 || dow === 6) continue
        const nOrders = 20 + Math.round(r() * 20)
        for (let i = 0; i < nOrders; i++) {
          const oid = id++
          const nLines = 1 + Math.floor(r() * 3)
          const sls = r() < 0.35
          const shipped = r() < 0.85
          const actual = Math.max(1, Math.round((sls ? 4 : 2.5) + r() * 5))
          const quoted = Math.max(1, Math.round((sls ? 5 : 3) + r() * 3))
          for (let l = 0; l < nLines; l++) {
            const qty = 1 + Math.floor(r() * (sls ? 30 : 8))
            rows.push({
              order_id: oid,
              submitted: day,
              shipped,
              actual_bizdays: shipped ? actual : null,
              quoted_bizdays: quoted,
              family: sls ? 'SLS' : 'SLA',
              qty,
              line_volume_ml: Math.round(qty * (5 + r() * 60) * 100) / 100,
              material: mats[Math.floor(r() * mats.length)],
              max_dim_mm: Math.round((20 + r() * 220) * 10) / 10,
            })
          }
        }
      }
      return rows
    },
  },
}
