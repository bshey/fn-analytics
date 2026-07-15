# Form Now — Production Ops Analytics

Local, single-user analytics cockpit for Form Now rapid-manufacturing operations. Reads Formlabs **Redash** (BigQuery data source 13) via its REST API — no writes, no auth, binds to `127.0.0.1` only.

Four modules:

| Route | Module | What it answers |
|---|---|---|
| `/shipments` | **Shipment Analytics** | How much are we shipping, worth how much, how on-time? Metrics explorer (metric × breakdown × grain, ship vs order-placed cohort), on-time KPIs, ship-timing distribution. |
| `/wip` | **Throughput & WIP** | What's in the pipe, aging, past due, or stuck? Live funnel, aging histogram, past-due & stuck boards, exceptions trend. |
| `/orders` | **Order Deep-Dive** | Paste any identifier (FN-####, MSB…, Medusa `order_…`, email, part/build guid) and see everything: merged timeline, parts & builds, Tulip shop-floor detail, problem-orders finder. |
| `/floor` | **Stations, Quality & Operators** | Station throughput, stage dwell, quality/exception rates, operator sessions & productivity (station-app data since 2026-07-02). |

## Setup

Requirements: Node ≥ 20, and (for live data) the corporate VPN — the Redash host is internal.

```bash
npm install
cp .env.example .env     # then paste your Redash API key into .env
npm run smoke            # proves the whole data loop + ground-truth anchors
npm run dev              # server on :4600, UI on the Vite port it prints (proxies /api)
```

**Getting the API key:** Redash → avatar (top-right) → **Edit Profile** → copy **API Key**. It lives only in `.env` (git-ignored). Treat it like a password.

Production-style (single port, serves the built SPA):

```bash
npm run build
npm start                # http://127.0.0.1:4600
```

### Demo / offline mode

No key or VPN? Run entirely on deterministic generated data (a "Mock data mode" badge shows in the sidebar):

```bash
npm run dev:mock         # or: npm run build && npm run start:mock
```

## Verifying correctness

- `npm run smoke` runs the HANDOFF §3 connectivity loop (`SELECT 1` → poll → fetch), the cross-project count check, and the §7 **ground-truth anchor**: week of 2026-06-07 on-time% ≈ Web 0.394 / Xometry 0.355 / PreForm-RevGen 0.286. If those tie out, the pipeline matches the existing Looker report.
- Every chart has an **ⓘ popover** naming its source table/view and formula.
- Rates are always re-derived from summed counts (`SUM(on_time)/SUM(shipped)`), never averaged from pre-computed percentages. Weeks start Sunday, matching Looker.

## Configuration

`config/exclusions.json` (hot-reloaded per request — no restart needed):

- `testStations` / `nonLineOperators` — excluded from floor/productivity metrics.
- `stuckThresholdDays` — default "stuck order" threshold (also adjustable in the WIP UI).
- `stationAppDataSince` — station-app instrumentation start date (queries clamp to it).

`.env` — see `.env.example`. If Redash ever moves behind Cloudflare Access, set the `CF_ACCESS_CLIENT_ID/SECRET` service-token pair.

## Architecture

```
server/   Express (127.0.0.1:4600). Holds the API key. One registry of named,
          zod-validated queries → SQL built with whitelisted/escaped literals →
          Redash job loop (submit → poll ≤60s → fetch) → in-memory cache.
          Every query ships a deterministic mock() twin for MOCK=1.
web/      React 18 + Vite + TS + Tailwind v4 + ECharts + TanStack Query/Table.
          Global filter bar (date/grain/channel/type/material + cohort) persists
          to URL + localStorage. POST /api/query/:name per named query.
scripts/  smoke.mjs (connectivity + ground truth), mock-check.mjs (hits every
          registered query in mock mode).
```

Data conventions baked in: everything runs through **data source 13** with fully-qualified table names; `v_shipments_kpi` is the governed source for shipment metrics; `max_age` caching (UI **Refresh** forces `max_age=0`); money fields are strings → `SAFE_CAST`; the warehouse lags ~1 day, so the newest period is labeled provisional.

## Troubleshooting

- **Requests hang / 403** → VPN or Cloudflare Access, not code. Get on the corporate network; check the key.
- **"Query timed out after 60s"** → big warehouse scan; narrow the date range and retry.
- **Numbers differ from Looker** → check the ⓘ popover for the exact source/formula; the shipment module should tie out exactly (same governed view, same re-derived rates). The ship-timing *distribution* is calendar-day and order-level by design, so it can differ by a hair from the view's business-day on-time flag.
