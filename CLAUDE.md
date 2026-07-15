# fn-analytics — agent notes

Local-only analytics app for Form Now production ops. Read `README.md` for setup; the product/data spec lives with the owner (HANDOFF + spec docs).

## Invariants — do not break

- **All SQL runs through Redash data source 13** with fully-qualified `project.dataset.table` names. Never data source 12.
- **Never average pre-computed percentages.** Return summed counts / weighted sums from SQL; derive rates in the client (`SUM(on_time)/SUM(shipped)`).
- **Always date-bound scans**; `v_shipments_kpi` additionally needs `date_key <= CURRENT_DATE()`. Week grain = `WEEK(SUNDAY)`.
- Money columns in `fcm_api_order` and the KPI view are **strings** → `SAFE_CAST(... AS FLOAT64)` in SQL, `num()/num0()` in the client.
- **Bookings** = subtotal + shipping_cost + tax_cost + credit_balance_applied.
- **Due dates are channel-aware** (governed `f_orders` rule): Xometry `ship_by` is stored at 23:59 ET (03:59 UTC next day) → use `governedDueDateExpr()` from `sql.ts`, never plain `DATE(ship_by)` (that grants Xometry an extra day and inflates OTS ~8 pts). `shipped_at` dates stay UTC to match the view.
- **`v_shipments_kpi.date_key` is the DUE date, not the ship date.** A period's on-time % only counts orders that already shipped — cohorts with `orders_due > orders_shipped` are unsettled and read artificially high (today is always ~100%). The UI must mark them provisional.
- "Today" for ops comparisons (past-due) = `CURRENT_DATE('America/New_York')`, not UTC.
- New server queries go in `server/src/queries/<module>.ts` as `QueryDef`s: zod-validated params, SQL via helpers in `sql.ts` (never interpolate raw input), and a `mock()` whose row keys **exactly match** the SQL SELECT aliases (the UI must behave identically in MOCK=1).
- Server is ESM NodeNext: relative imports need `.js` extensions.
- Chart colors come from `web/src/lib/palette.ts` only (channel colors are mandated to match existing dashboards). No dual y-axes. Legend for ≥2 series. Max 8 series, fold into "Other".
- Ops-metric exclusions (test stations, non-line operators, stuck threshold) live in `config/exclusions.json` — hot-reloaded, keep it the single source.

## Verify changes

```bash
npm run typecheck && npm run build
MOCK=1 NODE_ENV=production npm run start -w server &   # then:
node scripts/mock-check.mjs                             # every query must pass
npm run smoke                                           # live data loop + Looker ground-truth anchors (needs VPN + API key)
```
