# Late Shipments: Causes, Delay Drivers, and Predicted Ship Dates

**Analysis date:** 2026-07-10 · **Population:** 6,028 shipped orders (Oct 1 2025 – Jul 9 2026) plus the current open backlog · **All numbers computed from live warehouse data** (BigQuery via Redash, ds 13). Five parallel investigations (baseline, composition, failures, backlog, survival) + a held-out backtest on June 2026.

---

## 1. Executive summary

1. **Lateness is 23.0% overall but not stationary.** Nov'25–May'26 was a healthy regime (monthly late rates 8–31%, best 11–17% in May). June 2026 was a capacity shock hitting both channels simultaneously (peak week Jun 8: **60.2% late**), with a second, Xometry-led wave in the weeks of Jun 29 / Jul 6 (52%/48%). Failures did NOT cause the June spike (failure rate was flat at ~37%); intake outran throughput — parts shipped/month *fell* ~40% while intake surged.
2. **The biggest per-order discriminators, ranked:** (a) **failure events** — orders with ≥1 pre-ship failure event are late 43.0% vs 11.6% without (3.7×), and carry 67.8% of all late orders; (b) **build count** — 1-build orders 9.0% late vs 4–10 builds 49.2% and 11+ builds 74.8%; (c) **order size** — qty 100+ runs 47–55% late, and big-SLS is the severity killer (P80 **+14 days**, P95 +31); (d) **backlog at acceptance** — top-quartile backlog ≈ 2–3× the late rate of bottom-quartile; (e) **channel/promise calibration** — FormNow promises carry no buffer while Xometry long promises are padded.
3. **Slack at failure time, not failure severity, decides lateness.** Recovery from any failure type takes ~2–4 days flat. 49% of first failures land with ≤1 day of slack → 48% late; the same failures with ≥4 days of slack are absorbed (30% late, P80 +1d). A failure logged after the due date = 100% late, ships ~3 more days out.
4. **Anticipated ship dates are predictable with quantified confidence.** The rule set below achieved, on the *worst month in the window* as a holdout: P50 coverage 47–56% (target 50%), P80 coverage 73–83% raw, **83–88% with the backlog adjustment**.
5. ⚠️ **Current state (Jul 10) is the worst on record for SLS**: 155 open SLS orders (99.8th percentile) and **26,476 open SLS parts — above the all-time max, ≈11 weeks of trailing throughput**. Orders accepted today enter a regime whose only historical analogue (June) ran 39–70% late. Expect SLS lateness ≥42–50% until quoted dates are stretched or capacity is added.

---

## 2. Theory

Lateness = *promise aggressiveness* × *work content* × *production friction* × *capacity state*:

- **H1 (promise):** `ship_by` is set by a quoting rule; if it doesn't scale with real work content, specific segments (long-lead complex orders, SLS) will be systematically missed.
- **H2 (composition):** parts/quantity/volume drive build count; more builds → more scheduling slots, more failure surface.
- **H3 (friction):** failures (build failure, reprint, quarantine, missing part) inject a roughly constant recovery time; whether that converts to lateness depends on remaining slack.
- **H4 (capacity):** backlog at acceptance is queueing time in disguise; intake > throughput weeks poison whole cohorts.
- **H5 (status memory):** for an open order, current age + milestones reached (cleared, printing, binned) predict remaining time-to-ship — enabling anticipated ship dates with percentile confidence.

All five hypotheses were confirmed; effect sizes below.

### Definitions used everywhere

- **Due date (governed rule):** Xometry `ship_by` read in America/New_York (stored 23:59 ET); others in UTC. Naive UTC would inflate Xometry OTS ~8 pts.
- **days_late** = ship date − due date (calendar days); **late** = days_late > 0.
- **Failure events:** TOTAL_BUILD_FAILURE, PART_NEEDS_REPRINT, PART_QUARANTINED, PART_MISSING, MANUFACTURING_ISSUE (order events, pre-ship).
- `started_processing_at` is dead (0% since Jun'26) and was never reliable — queue entry = `ORDER_CLEARED_FOR_PRODUCTION` event.

---

## 3. Findings by driver

### 3.1 Regime & baseline

- Median order ships exactly on its due date (P50 days_late = 0; P90 = +3, P95 = +6).
- FormNow is structurally worse than Xometry: 28.3% vs 19.1% late, and a much heavier tail (42% of late FormNow orders are ≥4 days late vs 26% for Xometry).
- **Internal FormNow orders (amount_charged = 0; 20% of FormNow) run 37.2% late** with 24% of lates ≥8 days — they are visibly deprioritized and pollute the aggregate ~2 pts.
- Weekday-only operation (zero Sunday ships): Thu/Fri-due orders fail less often but fail *big* (median 4 days late — the weekend swallows recovery); Mon/Tue-due orders fail often but small (1–3 days). A Thu-due order that misses its next-day Friday truck is Monday-plus.

### 3.2 Promise calibration (H1 confirmed, in opposite directions)

- **FormNow lateness rises with promised lead** (≤3d: 24.6% → 9+d: 32.2%): long promises mark complex orders and don't scale enough. FormNow ≤3d promises have essentially zero early-ship buffer (2.3% ship >1d early).
- **Xometry lateness falls with promised lead** (19.9% → 16.0%), and 9+d Xometry promises are heavily padded (54% ship >1 day early).
- **SLS is under-promised at every lead bucket** (e.g. ≤3d: 31.7% late vs SLA 19.8%; 9+d: 27.9% vs 19.9%, median-when-late up to 7d). Xometry gives SLS a median 5-day promise vs FormNow's 7 and pays for it.

#### How FormNow promises are actually made (quoting engine V2, v5 active)

FormNow `ship_by` comes from the MES quoting config (Xometry dates come from the Xometry platform and are out of this engine's control). Per **line item**: production days = MAX(part-count tier, volume tier) for the family, plus adjusters (per-material +1/+2 days; FLFRGR01 +42d shortage; sanding +1; parts >200 mm +1). Order promise = the **longest line item**. Current tier outputs: SLA 2–6 days by count (≤9→2 … ≤57.6→6) / 1–5 by volume (≤310 mL→1 … ≤2318→5); SLS 4–8 by count / 2–6 by volume.

Two structural findings once the engine is layered onto the data:

1. **The engine's own version history tracks the June disaster.** v2 (Jun 3, "expand access to shorter lead time") shipped five days before the worst week in the dataset (Jun 8: 60.2% late); v4 (Jun 11, "extend lead times due to capacity constraints") was the reactive correction. Promise changes are a live lever — and a live risk — at exactly the moments capacity is tight.
2. **The tier structure encodes composition but not friction or capacity.** Count/volume tiers capture H2 (composition) reasonably; nothing in the engine responds to the failure budget (H3: half of failures land with ≤1 day of slack) or the backlog state (H4). That's why identical tier cells performed 15–25 pts worse in June than in May. The per-line MAX-over-lines rule also means multi-line interaction cost (mixed SLA+SLS: 37.3% late) is unpriced — the known gap.

### 3.3 Composition (H2 confirmed)

| Signal | Effect |
|---|---|
| Print builds (strongest) | 1 build: **9.0%** late → 2–3: 26.4% → 4–10: 49.2% → 11+: **74.8%** (conditional P50 +5d, P80 +11d) |
| Total quantity | FormNow qty 1: 19.9% → qty 100+: **53.3%** (late P50 7d / P80 16d); gradient is regime-robust |
| Volume | Threshold at ~343 mL: flat 17.6% below, 33–61% above; 3 L+ ⇒ 58% late |
| Family | SLA 21.0% < SLS 27.0% < **mixed SLA+SLS 37.3%**; big-SLS (qty>100) = worst tails: P80 **+14d**, P95 **+31d** |
| Line items | 1 line 18.4% → 11+ lines 49.4% |
| Materials | Weak axis overall; hot spots: FLELCL02 40% late; FLTO2002 has **3× the build-failure rate** (26.8%); SLS powders FLP11B01/FLP12T01 ~50% any-failure |
| Safe segment | Single build + qty ≤5: **8% late, P95 = +1 day** (n=2,121) — safe to promise tight |

### 3.4 Failures & friction (H3 confirmed — the per-order story)

- Dose-response: 0 events → 11.6% late (P80 = 0); 1 → 32%; 2–3 → 39%; 4–7 → 49%; 8+ → **67.5%** (P80 +8, P95 +19).
- Worst types: PART_NEEDS_REPRINT (52.4% late, +2.6d mean) and TOTAL_BUILD_FAILURE (50.5%, +2.4d, slowest recovery: P50 4d / P80 7d from first TBF to ship).
- **The slack mechanism:** failure with ≥4 days slack → 30% late (absorbed); with 0–1 days slack → 48%; after due date → **100% late**, ~3 more days to ship. Half of all first failures land with ≤1 day of slack — the quoting rule leaves no failure budget.
- Holds: hold+failure is the worst combo in the study (65.4% late). Holds resolve fast when they resolve (P50 0.7d to re-clearance) but carry real cancellation risk.
- The failure *rate* has been stable ~35–41% since December — failures explain **which** orders are late within a regime, not the June regime shift.

### 3.5 Backlog & capacity (H4 confirmed — the cohort story)

- Backlog at acceptance (order count) is monotone: total backlog <87 → 17.0% late; ≥168 → 32.2%. Family-specific is stronger: SLA backlog <60 → **11.9%** late; 120–149 → **34.2%** (2.9×). SLS <70 → 23.1%; 70–129 → 37.9%.
- Orders accepted in weeks where family part intake >1.5× shipments: SLS 33.3% late, SLA 24.4%, vs 16% in balanced weeks.
- **Order-count backlog beats part-weighted backlog** as a signal (corr 0.117 vs 0.058) — part counts are distorted by giants (top-5 open orders hold ~63% of open parts).
- Regime history: demand stepped up ~4× (SLS) in March 2026; capacity followed and Apr–May recovered; June intake surged again while throughput *fell* ~40% → the June cohort disaster.

### 3.6 Status-conditional time-to-ship (H5 confirmed — powers anticipated dates)

- **The hazard is U-shaped:** orders aged 4–6 days are closest to shipping; past ~8 days the tail re-expands (a 14-day-old open order is drawn from a different, slow population). Any predictor must condition on age, and widen bands after age 8.
- **Print start is the strongest absorbing signal:** once the first ORDER_PRINTING fires, remaining time is short and flat — FormNow P50 2d / P80 5d; Xometry P50 1–2d / P80 3–4d.
- **Being past due adds nothing beyond age** (past-due orders at a given age ship no slower — consistent with expediting). Don't stack a past-due penalty on the age rules.
- For already-late orders: expected ship = due + 3/7/13 days (FormNow with failure P50/P80/P90), +2/6/11 (FormNow clean), +2/5/8 (Xometry failure), +1/3/5 (Xometry clean).
- Regimes diverged in Apr–Jun'26: FormNow's slow tail compressed sharply, Xometry's widened. P50s are stable pooled; P80/P90 rules should use the recent regime.

---

## 4. The rule set — anticipated ship dates with confidence levels

Three layers. **Quote the P80 date; show P50 as "likely."** All offsets are calendar days.

### Layer A — At acceptance (risk class + first estimate)

Base estimate: `accepted_date + BASE(channel)` where BASE = FormNow **P50 5 / P80 8 / P90 12**, Xometry **P50 4 / P80 6 / P90 7** (train window Oct–May).

Adjust the P80/P90 (and risk class) by composition and capacity:

| Condition (at acceptance) | Adjustment / expectation |
|---|---|
| Single build expected AND qty ≤ 5 | Safe class: P(late) ≈ 8%, P95 days_late = +1 — tight promise OK |
| Qty 21–100 | P(late) ≈ 39%; +1d P80 |
| Qty > 100 (SLA) | P(late) ≈ 47%; +2d P80 |
| **Qty > 100 (SLS)** | P(late) ≈ 55%; **+6d P80** (historical P80 days_late +14 — quote long) |
| Mixed SLA+SLS parts | P(late) ≈ 37%; +2d P80 |
| Contains FLTO2002 | expect 3× build-failure risk; +1d P80 |
| FormNow internal order | P(late) ≈ 37%; +2d P80 (or prioritize explicitly) |
| **Family backlog high** (SLA ≥120 open SLA orders / SLS ≥70 open SLS orders / total ≥168) | **+2d P80** — this is the June-regime adjustment, restores backtest coverage |

### Layer B — Live update for open orders (dominates Layer A once known)

| Current status | Anticipated remaining days (P50 / P80) |
|---|---|
| Age 0–1d since acceptance | FormNow 5/8 · Xometry 4/7 |
| Age 2–3d | FormNow 3/6 · Xometry 3/5 |
| Age 4–7d | FormNow 2/5–6 · Xometry 1–2/4–5 |
| Age ≥8d (re-expanded tail) | FormNow 2–3/6 (recent regime) · Xometry 2/6 |
| **First ORDER_PRINTING fired 1–3d ago** | FormNow 2/5 · Xometry 1–2/3–4 (overrides age rules when tighter) |
| ORDER_PRINTING ≥7d ago, still unshipped | FormNow 2/7 (P90 13) · Xometry 1/5 |
| Additive: any failure event on record | +1 P50 / +2 P80 (dose: 4–7 events → P80 +4; 8+ → P80 +8) |
| Additive: SLS or mixed family (FormNow) | +1 P50 / +2 P80 |
| Additive: on hold + failure | treat as worst class: P(late) 65%, +3d P80 |
| A failure logged with ≤1 day of slack | expect the miss: P(late) ≈ 50–100%, ship ≈ failure date + 2–4d |

### Layer C — Already past due

Anticipated ship = **due date + 3/7/13** (FormNow, failure on record — P50/P80/P90), **+2/6/11** (FormNow clean), **+2/5/8** (Xometry failure), **+1/3/5** (Xometry clean). Do not add extra past-due penalties on top of the age rules — expediting already offsets it.

---

## 5. Backtest (held-out June 2026 — the hardest month in the window)

Rules trained on Oct 1 2025 – May 31 2026 only; evaluated on the 939 orders shipped in June 2026. Coverage = share of orders shipping on/before the predicted date (targets: 50% / 80%).

| Prediction point | Channel | P50 coverage | P80 coverage | P80 + backlog adj (+2d) |
|---|---|---|---|---|
| At acceptance | FormNow | 56.3% | **83.4%** | 88.4% |
| At acceptance | Xometry | 47.1% | 72.6% | **84.9%** |
| At age 4 (live, failure-aware) | FormNow | 42.6% | 74.8% | **83.9%** |
| At age 4 (live, failure-aware) | Xometry | 48.1% | 65.8% | **82.9%** |

Interpretation: **P50 rules are robust even under a capacity shock.** Raw P80 rules hold for FormNow and degrade for Xometry in the shock month — exactly the regime the backlog trigger detects (June acceptance backlogs were all in the top band). With the +2d backlog adjustment active, P80 coverage lands at 83–88% everywhere. In a normal month (Apr–May), the unadjusted rules are calibrated as-is.

---

## 6. Lead-time recalibration: hitting 90% OTS with the current engine structure

**Question:** keeping the engine exactly as structured (SLA/SLS × count/volume tiers, MAX per line, longest line wins, adjusters unchanged), what should the production-day values be to hit 90% OTS? **Calibration window:** FormNow orders shipped Apr 10 – Jul 9 2026 (last 3 months — includes the June shock deliberately, since scaling continues; excludes FLFRGR01 orders, which the +42d shortage adjuster already governs).

**Units: every value in this section is PRODUCTION DAYS** — counted on the warehouse business-day calendar (`dim_date.is_business_day`: weekends AND US holidays excluded; Memorial Day, Juneteenth, and Jul 3 fall inside this window and are correctly skipped). One assumption to confirm on the engine side: if the quoting engine's due-date roller skips only weekends (not holidays), promises quoted across a holiday were effectively one production day shorter than labeled — worth fixing in the engine.

### What the last 3 months actually required

Orders grouped by the promise the engine gave them (business days accepted→due). P90 of actual business days = the promise needed for 90% OTS in that group:

| Family | Promised (now) | n | OTS now | P50 actual | P90 actual | → Needed |
|---|---|---|---|---|---|---|
| SLA | 1 | 88 | 79.5% | 1 | 2 | +1 |
| SLA | 2 | 233 | 73.4% | 2 | 4 | +2 |
| SLA | 3 | 254 | 74.4% | 3 | 5 | +2 |
| SLA | 4 | 147 | 73.5% | 4 | 7 | +3 |
| SLA | 5 | 65 | 70.8% | 5 | 6 | +1–2 |
| SLA | 6 | 41 | 58.5% | 6 | 11 | +5 |
| SLS | 2 | 45 | 66.7% | 2 | 5 | +3 |
| SLS | 3 | 105 | 60.0% | 3 | 7 | +4 |
| SLS | 4 | 113 | 66.4% | 4 | 7 | +3 |
| SLS | 5 | 81 | 69.1% | 4 | 9 | +4 |
| SLS | 6 | 37 | 64.9% | 5 | 11 | +5 |
| SLS | 7 | 15 | 80.0% | 6 | 9 | +2 (small n) |

Note the P50s: the median order finishes roughly on the current promise — the current table is a **P50 table**. 90% OTS requires quoting near the P90.

### Recommended tier values (simulated on the 3-month window)

| Proposal | Overall OTS | SLA OTS | SLS OTS | Avg promise (SLA / SLS) |
|---|---|---|---|---|
| Current table | 71.4% | 74.0% | 66.0% | 3.1 / 4.1 biz days |
| **A. P90 table (recommended for 90%)** | **92.3%** | 92.6% | 91.6% | 5.4 / 7.8 |
| B. Apr–May-calibrated (lean) | 87.2% | 88.1% | 85.4% | 4.5 / 6.3 |

**Proposal A — the table that hits 90% under blended (incl. shock) conditions.** Because the engine takes MAX(count, volume) and the mapping is monotone, applying it to each tier cell preserves the structure (adjusters unchanged):

| SLA part count | now → **new** | | SLA volume mL | now → **new** |
|---|---|---|---|---|
| ≤9 | 2 → **4** | | ≤310 | 1 → **2** |
| ≤18 | 3 → **5** | | ≤679 | 2 → **4** |
| ≤23 | 4 → **7** | | ≤998 | 3 → **5** |
| ≤30 | 5 → **7** | | ≤1335 | 4 → **7** |
| ≤57.6 | 6 → **11** | | ≤2318 | 5 → **7** |

| SLS part count | now → **new** | | SLS volume mL | now → **new** |
|---|---|---|---|---|
| ≤15.8 | 4 → **7** | | ≤800 | 2 → **5** |
| ≤50.3 | 5 → **9** | | ≤1670 | 3 → **7** |
| ≤120 | 6 → **11** | | ≤2966 | 4 → **7** |
| ≤271.2 | 7 → **11** | | ≤4149 | 5 → **9** |
| ≤504 | 8 → **12** | | ≤7146 | 6 → **11** |

**Proposal B — lean table** (calibrated on healthy Apr–May only; roughly "A minus 1–2 days" per cell): hits ~87% on the blended window and would hit ~90% **if** capacity returns to May levels. Choose B only alongside a capacity commitment.

### Proposal C — preserving 1–2 day SLA / 3-day SLS fast lanes (owner-requested, recommended)

The owner wants short lead times to remain offerable. Behavioral calibration (orders that actually *received* fast promises, so production-priority effects are included; Apr 10 – Jul 9):

| Fast lane candidate | Met promise | Shipped ≤ promise+1 | n |
|---|---|---|---|
| SLA 1-day, qty ≤1 & vol ≤50 mL | 81% | 91% | 47 |
| SLA 2-day, qty ≤2 & vol ≤100 mL | 79–83% | 83–94% | 155 |
| SLA 2-day, anything bigger | 62–67% | 82–89% | 78 |
| SLS 2-day, any threshold | 58–67% | ≤83% | 45 |
| **SLS 3-day, qty ≤1 & vol ≤50 mL** | **84%** | **100%** | 19 |
| SLS 3-day, bigger | 48–69% | 73–83% | 86 |

Conclusions: a **90% 1–2 day SLA lane does not exist at any threshold** (best ≈81–83% even with priority), and **2-day SLS is unsupportable** (≤67%). But tightly-thresholded fast lanes at ~80–85% are a small share of volume, so the blended table still reaches ~90% when everything else quotes at P90+.

**Proposal C tier tables** (fast lanes kept with tightened thresholds; upper tiers from Proposal A; adjusters unchanged):

| SLA part count | days | | SLA volume mL | days |
|---|---|---|---|---|
| **≤1** | **1** | | **≤50** | **1** |
| **≤2** | **2** | | **≤100** | **2** |
| ≤9 | 4 | | ≤310 | 4 |
| ≤18 | 5 | | ≤679 | 5 |
| ≤30 | 7 | | ≤1335 | 7 |
| ≤57.6 | 11 | | ≤2318 | 7 |

| SLS part count | days | | SLS volume mL | days |
|---|---|---|---|---|
| **≤1** | **3** | | **≤50** | **3** |
| ≤15.8 | 7 | | ≤800 | 5 |
| ≤50.3 | 9 | | ≤1670 | 7 |
| ≤120 | 11 | | ≤2966 | 7 |
| ≤271.2 | 11 | | ≤4149 | 9 |
| ≤504 | 12 | | ≤7146 | 11 |

(The engine's MAX(count, volume) rule makes the fast lane exactly the intersection: SLA 1-day = 1 part AND ≤50 mL; SLA 2-day = ≤2 parts AND ≤100 mL; SLS 3-day = 1 part AND ≤50 mL.)

**Expected blended OTS ≈ 90%:** fast lanes ~80–85% on ~20–25% of SLA volume (~5% of SLS), everything else at the P90 tiers ≈ 92%+ → SLA ≈ 90%, SLS ≈ 91%. Three conditions attach:
1. **Gate the fast lanes on the backlog trigger** — suspend 1–2 day offers when family backlog is in the top band (this is what v4 did manually on Jun 11; the trigger automates it). In June conditions the fast lanes ran 10–25 pts worse.
2. **Keep finishing options out of the fast lanes.** Calibration note: adjusters are implicitly priced in this analysis (orders were grouped by their final adjusted promise), and in practice ZERO fast-promised orders carried Standard/Media-Blast finishing — the sanding/large-part +1 adjusters already push them out. Make that exclusion explicit in the engine (finishing option ⇒ ineligible for the 1–2 day rows) rather than incidental.
3. Accept that the fast lanes themselves are a known ~15–20% miss segment; if a customer-facing 90% per-lane guarantee is ever needed, the honest fast-lane values are SLA 1-day→2 / 2-day→3 and SLS 3-day→4 (each lane's met+1 column is ≥91%).

### Adjusters: risk materials, sanding, large parts (validated)

Method: current promises already include the adjusters, so a segment's **residual P90 excess** (actual − promised production days) *above the baseline's* means its adjuster is too small. FormNow, Apr 10 – Jul 9; baseline = orders containing no adjusted material (n=1,041, P90 excess +3, OTS 70%).

| Adjuster | Now | Residual vs baseline | Verdict |
|---|---|---|---|
| FLFL8011 (+2) | +2 | P90 excess +1, OTS 86% | ✅ keep (working well) |
| FLHTAM02, FLP12W01 (+1) | +1 | +1, OTS 81–85% | ✅ keep |
| FLGPCO05, FLELCL02 (+2); FLRG1011, FLTO1502 (+1) | — | +2 to +3 (≈ baseline) | ✅ keep |
| **FLP11B01** | +1 | **+4 (1 above baseline), OTS 79%** | ⬆ raise to **+2** (also 50% any-failure rate) |
| **FLTO2002** | **none** | **+4, OTS 63% (n=106)** | ➕ **add +1** — this material has 3× the build-failure rate (26.8%) and is the biggest gap in the current list |
| **FLP12T01** | **none** | **+4, OTS 59% (n=39)** | ➕ **add +1** |
| FLPA1101, FLTO1511 (+1) | +1 | <12 orders in window | keep (untestable) |
| FLFRGR01 (+42) | +42 | excluded from calibration | keep until shortage ends |
| **Large part >200 mm** | **+1** | **P90 excess +5, OTS 59% (n=169)** | ⬆ **raise to +3** (data supports up to +4; the +1 is clearly insufficient) |
| Sanding | +1 | untestable | keep — zero shipped FormNow orders in the window carried Standard/Media-Blast finishing, so there's no data either way; this also confirms the fast lanes are de-facto finishing-free (make the exclusion explicit) |

### Recommendation

- **Adopt Proposal C** — it honors the 1–2 day SLA / 3-day SLS offers with thresholds the data supports, and reaches ~90% blended. Drop the 2-day SLS offer (no threshold supports it; 3-day at 1 part/≤50 mL is the defensible floor).
- **Adjuster changes:** FLP11B01 +1→+2; add FLTO2002 +1 and FLP12T01 +1; **Large Part Adjustment Days 1→3**; everything else unchanged.
- If fast lanes are not required: adopt **A for SLS immediately** — SLS is under-promised at every tier, its backlog is at an all-time record (§7), and even Apr–May required +2–5 days. Adopt **B for SLA** if the June throughput dip is being fixed; otherwise A for both.
- Add ~**+2 days for mixed SLA+SLS orders** (37% late historically; the per-line MAX doesn't price the interaction).
- Pair the static table with the **dynamic backlog trigger** from §4 (family backlog high → +2 days at quote time). That's what covers the next June without permanently quoting for the worst case; it would also have flagged the v2 (Jun 3) shortening as unsafe — backlog was already climbing.
- Trade-off to own: proposal A lengthens the average FormNow quote by ~2.3 (SLA) / ~3.7 (SLS) business days, which may cost conversion. The P50 column shows the median customer would still receive the part around the old promise date — "ships early" becomes the norm (Xometry's long-promise pattern, 54% early, shows this works operationally).
- Caveats: quotas are calibrated on shipped orders (July's open stragglers would push SLS P90s slightly higher); behavioral drift is possible if ops paces to the new due dates (monitor P50 creep); Xometry dates are out of scope for this engine.

## 7. Current state & immediate implications (as of Jul 10 2026)

- **SLS: 155 open orders (99.8th pctile), 26,476 open parts — above the historical maximum, ≈11 weeks of parts at trailing throughput.** The backlog trigger is ON: quote SLS with the +2d P80 adjustment *at minimum*; for qty>100 SLS, quote P80 +6d or split shipments. Historical analogue (June) ran 39–70% late.
- SLA: 149 open orders (98th pctile), ~1.7 weeks of parts — elevated; +2d P80 trigger also ON.
- Watch the intake/throughput ratio weekly (see app WIP module); the June pattern was visible in the intake data ~a week before the late-rate peak.
- Fastest structural wins suggested by the data: (1) add a failure budget to promises on segments with ≤1 day slack (half of failures land there); (2) stretch SLS promises (under-promised at every bucket); (3) stop internal orders from silently degrading the paid-order stats (separate lane or explicit deprioritized promise); (4) Thursday/Friday dues need earlier internal targets, since a missed Friday truck costs the weekend.

## 8. Limitations

- **Right-censoring:** shipped-only population; high-backlog cohorts (June/July accepts) are floors, not finals — SLS ≥130-backlog cohorts are 76% still open. Age ≥14 remaining-time estimates are optimistic lower bounds.
- **Regime sensitivity:** capacity roughly doubled/tripled in March 2026; absolute backlog thresholds shift meaning. Weeks-of-throughput is the more durable form of the backlog trigger. Re-fit quantiles quarterly (or after any capacity change).
- Station-app data (<2 weeks) not yet usable for prediction; Fuse X1 is invisible in Tulip stage timing.
- Rules are empirical quantiles, not a causal model; build count is partly endogenous (reprints add builds) — use "builds so far" only as a live signal, not an acceptance-time one.

## 9. Operationalizing in the app (proposed next step)

Add a `predicted_ship` server query implementing Layers A–C (all inputs are already queryable: age, milestones, failure events, family backlog), and surface on the WIP boards: predicted P50/P80 ship dates + risk class per open order, with the backlog trigger evaluated live. Backtest coverage becomes a monthly health check (are we still ~80% at P80?).

---

## Appendix — Evidence tables (verbatim from the five investigation tracks)


### Track: baseline

### T1. Overall days_late distribution (shipped 2025-10-01→2026-07-09)
| Segment | n | late rate | P10 | P25 | P50 | P75 | P80 | P90 | P95 |
|---|---|---|---|---|---|---|---|---|---|
| ALL | 6,028 | 23.0% | -3 | -1 | 0 | 0 | — | +3 | +6 |
| FormNow | 2,581 | 28.3% | -4 | -1 | 0 | +1 | +1 | +5 | +7 |
| Xometry | 3,447 | 19.1% | -3 | -1 | 0 | 0 | 0 | +2 | +4 |

### T2. Monthly late rate by channel (P50L = median days_late among late orders)
| Month | FN n | FN late | FN P50L | Xom n | Xom late | Xom P50L |
|---|---|---|---|---|---|---|
| 2025-10 | 189 | 40.2% | 10 | 341 | 12.6% | 1 |
| 2025-11 | 152 | 19.7% | 3 | 224 | 12.1% | 2 |
| 2025-12 | 134 | 20.1% | 5 | 275 | 7.6% | 1 |
| 2026-01 | 144 | 27.8% | 3 | 269 | 12.6% | 2 |
| 2026-02 | 199 | 30.7% | 2 | 285 | 27.4% | 1 |
| 2026-03 | 325 | 22.2% | 2 | 526 | 21.5% | 2 |
| 2026-04 | 344 | 29.7% | 3 | 515 | 10.9% | 2 |
| 2026-05 | 473 | 16.7% | 2 | 447 | 11.4% | 2 |
| 2026-06 | 483 | 40.6% | 3 | 456 | 39.0% | 3 |
| 2026-07 (1–9) | 138 | 34.1% | 2 | 109 | 51.4% | 2 |

### T3. Weekly late rate, May–Jul 2026 (June shock + July re-spike)
| Week of | n | late (all) | FormNow | Xometry |
|---|---|---|---|---|
| 2026-05-04 | 240 | 14.6% | 21.5% | 6.4% |
| 2026-05-11 | 222 | 14.9% | 17.4% | 12.4% |
| 2026-05-18 | 236 | 14.4% | 15.4% | 13.4% |
| 2026-05-25 | 172 | 9.3% | 8.0% | 10.7% |
| 2026-06-01 | 193 | 22.3% | 29.3% | 14.9% |
| 2026-06-08 | 206 | 60.2% | 61.9% | 58.4% |
| 2026-06-15 | 235 | 44.7% | 45.1% | 44.4% |
| 2026-06-22 | 209 | 29.7% | 29.9% | 29.3% |
| 2026-06-29 | 183 | 41.0% | 30.5% | 52.3% |
| 2026-07-06 (partial) | 160 | 42.5% | 38.7% | 47.8% |

### T4. Promise calibration by channel × mfg family (leads in days)
| Channel | Family | n | Promised P25/P50/P75 | Actual lead P50/P75 | late rate | P50L |
|---|---|---|---|---|---|---|
| FormNow | SLA | 1,463 | 3 / 5 / 6 | 4 / 7 | 27.1% | 2* |
| FormNow | SLS | 989 | 5 / 7 / 8 | 6 / 8 | 28.6% | 3* |
| FormNow | Mixed | 129 | 5 / 6 / 7 | 6 / 10 | 38.8% | — |
| Xometry | SLA | 2,752 | 3 / 5 / 6 | 4 / 6 | 17.7% | 2* |
| Xometry | SLS | 673 | 4 / 5 / 6 | 5 / 7 | 24.5% | 2* |

### T5. Late rate by promised-lead bucket × channel (P50L = median days_late when late; early = shipped >1d early)
| Channel | Promise | n | late rate | P50L | P90 days_late | early >1d |
|---|---|---|---|---|---|---|
| FormNow | ≤3d | 570 | 24.6% | 3 | +4 | 2.3% |
| FormNow | 4–5d | 684 | 29.1% | 2 | +3 | 16.7% |
| FormNow | 6–8d | 1,088 | 28.9% | 3 | +6 | 32.5% |
| FormNow | 9+d | 239 | 32.2% | 4 | +8 | 38.1% |
| Xometry | ≤3d | 1,092 | 19.9% | 3 | +3 | 10.9% |
| Xometry | 4–5d | 1,323 | 20.0% | 1 | +1 | 14.1% |
| Xometry | 6–8d | 820 | 17.3% | 2 | +2 | 34.6% |
| Xometry | 9+d | 212 | 16.0% | 3 | +2 | 54.2% |

### T6. Late rate by promised-lead bucket × family (both channels pooled)
| Family | Promise | n | late rate | P50L |
|---|---|---|---|---|
| SLA | ≤3d | 1,414 | 19.8% | 3 |
| SLA | 4–5d | 1,573 | 21.4% | 2 |
| SLA | 6–8d | 992 | 22.2% | 2 |
| SLA | 9+d | 236 | 19.9% | 3 |
| SLS | ≤3d | 230 | 31.7% | 4 |
| SLS | 4–5d | 392 | 28.8% | 2 |
| SLS | 6–8d | 843 | 24.6% | 4 |
| SLS | 9+d | 197 | 27.9% | 7 |

### T7. Due-date day-of-week pattern
| Due DOW | n | late rate | slip 1–3d | slip 4+d | P50L |
|---|---|---|---|---|---|
| Mon | 1,207 | 27.1% | 21.1% | 6.0% | 2 |
| Tue | 1,219 | 24.6% | 19.8% | 4.8% | 1 |
| Wed | 1,157 | 23.4% | 15.9% | 7.5% | 2 |
| Thu | 1,259 | 19.5% | 9.2% | 10.3% | 4 |
| Fri | 1,169 | 20.7% | 9.5% | 11.2% | 4 |
| Sat | 17 | 5.9% | 0% | 5.9% | 4 |

### T8. Ship day-of-week (weekday-only operation)
| Ship DOW | n | share |
|---|---|---|
| Mon | 1,077 | 17.9% |
| Tue | 1,205 | 20.0% |
| Wed | 1,339 | 22.2% |
| Thu | 1,279 | 21.2% |
| Fri | 1,074 | 17.8% |
| Sat | 54 | 0.9% |
| Sun | 0 | 0% |

### T9. Magnitude mix among LATE orders + internal split
| Segment | n late | 1d | 2–3d | 4–7d | 8+d |
|---|---|---|---|---|---|
| FormNow (all period) | 730 | 33.7% | 24.2% | 24.8% | 17.3% |
| FormNow (ex Oct'25) | 654 | 35.9% | 26.8% | 25.1% | 12.2% |
| Xometry | 657 | 42.6% | 31.1% | 18.0% | 8.4% |

| FormNow sub-segment | n | late rate | P50L | 8+d share of lates |
|---|---|---|---|---|
| Paid (amount_charged>0) | 2,059 | 26.0% | 2 | 14.9% |
| Internal (0/NULL) | 522 | 37.2% | 4 | 23.7% |


### Track: composition

### Late rate by total quantity bucket x channel (shipped 2025-10-01..2026-07-09)
| Channel | Qty bucket | n | late rate | P50 days late (late only) | P80 (late only) |
|---|---|---|---|---|---|
| FormNow | 1 | 534 | 19.9% | 2 | 4 |
| FormNow | 2-5 | 835 | 23.2% | 2 | 6 |
| FormNow | 6-20 | 650 | 28.2% | 2 | 6 |
| FormNow | 21-100 | 378 | 39.4% | 4 | 8 |
| FormNow | 100+ | 184 | 53.3% | 7 | 16 |
| Xometry | 1 | 870 | 12.8% | 2 | 4 |
| Xometry | 2-5 | 1,468 | 16.0% | 2 | 4 |
| Xometry | 6-20 | 782 | 23.7% | 2 | 4 |
| Xometry | 21-100 | 270 | 38.9% | 2 | 5 |
| Xometry | 100+ | 40 | 40.0% | 3 | 11 |
| Xometry | (no parts rows) | 17 | 29.4% | 3 | 3 |

### Late rate by total part volume (qty x volume_ml summed per order)
| Volume bucket | n | late rate | P50 late | P80 late |
|---|---|---|---|---|
| < 343 ml (Q1-Q3) | 4,510 | 17.6% | 2 | 5 |
| 343 ml - 1 L | 784 | 33.2% | 2 | 6 |
| 1 - 3 L | 421 | 37.5% | 3 | 9 |
| 3 - 10 L | 206 | 61.2% | 4 | 8 |
| 10 L+ | 90 | 51.1% | 7 | 17 |

Volume quartile 4 (>~343 ml) by channel: FormNow 42.0% late (n=843), Xometry 35.8% (n=659); quartiles 1-3 range 13.7-23.1%.

### Late rate by line-item count
| Lines | n | late rate | P50 late | P80 late | FormNow rate (n) | Xometry rate (n) |
|---|---|---|---|---|---|---|
| 1 | 3,285 | 18.4% | 2 | 5 | 23.1% (1,228) | 15.6% (2,057) |
| 2-3 | 1,754 | 24.5% | 2 | 5 | 27.7% (766) | 22.0% (988) |
| 4-10 | 792 | 32.7% | 3 | 7 | 37.5% (448) | 26.5% (344) |
| 11+ | 180 | 49.4% | 3 | 9 | 47.5% (139) | 56.1% (41) |

### Manufacturing family / model composition
| Composition | n | late rate | P50 late | P80 late |
|---|---|---|---|---|
| SLA only | 4,215 | 21.0% | 2 | 4 |
| SLS only | 1,662 | 27.0% | 3 | 8 |
| Mixed SLA+SLS | 134 | 37.3% | 4 | 9 |
| Form 4 only | 2,187 | 16.7% | 2 | 4 |
| Form 4L only | 1,822 | 25.6% | 2 | 5 |
| Fuse 1+ only | 1,662 | 27.0% | 3 | 8 |
| Mixed models | 340 | 30.0% | 3 | 7 |

Form 4-only by channel: FormNow 30.8% late (n=182) vs Xometry 15.4% (n=2,005) — model effect is confounded with channel.

### Family x quantity interaction
| Family | Qty | n | late rate | P50 late | P80 late |
|---|---|---|---|---|---|
| SLA | 1-5 | 2,865 | 16.5% | 2 | 4 |
| SLA | 6-20 | 929 | 26.0% | 2 | 4 |
| SLA | 21-100 | 331 | 39.9% | 2 | 5 |
| SLA | 100+ | 90 | 42.2% | 3 | 8 |
| SLS | 1-5 | 793 | 20.1% | 2 | 6 |
| SLS | 6-20 | 454 | 24.7% | 3 | 7 |
| SLS | 21-100 | 296 | 37.8% | 4 | 8 |
| SLS | 100+ | 119 | 54.6% | 8 | 22 |
| Mixed | 1-5 | 49 | 30.6% | 2 | 6 |
| Mixed | 6-20 | 49 | 28.6% | 2 | 7 |
| Mixed | 21-100 | 21 | 47.6% | 7 | 11 |
| Mixed | 100+ | 15 | 73.3% | 7 | 16 |

### Top 12 materials by shipped-order count (order contains material)
| Material | n orders | late rate | P50 late | P80 late | >1.5x overall (34.5%)? |
|---|---|---|---|---|---|
| FLGPGR05 | 1,249 | 22.0% | 2 | 5 | no |
| FLP12G01 | 1,053 | 27.2% | 3 | 9 | no |
| FLGPCL05 | 736 | 17.9% | 2 | 4 | no |
| FLGPWH05 | 532 | 23.9% | 1 | 4 | no |
| FLTO1502 | 386 | 22.8% | 3 | 6 | no |
| FLTO2011 | 312 | 21.2% | 1 | 3 | no |
| FLRG1011 | 268 | 22.4% | 2 | 5 | no |
| FLHTAM02 | 267 | 19.9% | 2 | 4 | no |
| FLP12B01 | 257 | 31.5% | 3 | 8 | no |
| FLP11B01 | 232 | 30.2% | 3 | 8 | no |
| FLTO2002 | 213 | 28.2% | 3 | 6 | no |
| FLTP9G01 | 169 | 23.1% | 3 | 7 | no |

Flagged materials outside top 12 (>=30 orders, late rate > 34.5%): FLELCL02 40.2% (n=97, P50 late 3d); FLDUCL21 36.4% (n=33, P50 late 1d).

### Internal vs external
| Channel | Internal (charged 0/null) | n | late rate | P50 late | P80 late |
|---|---|---|---|---|---|
| FormNow | no (paid) | 2,059 | 26.0% | 2 | 7 |
| FormNow | yes | 522 | 37.2% | 4 | 9 |
| Xometry | yes (all, by definition) | 3,447 | 19.1% | 2 | 4 |

### Reorders and build count
| Segment | n | late rate | P50 late | P80 late |
|---|---|---|---|---|
| Reorder (reorder_of_order_id set) | 85 | 44.7% | 7 | 17 |
| Not a reorder | 5,943 | 22.7% | 2 | 6 |
| 1 build | 2,656 | 9.0% | 1 | 3 |
| 2-3 builds | 1,746 | 26.4% | 2 | 4 |
| 4-10 builds | 911 | 49.2% | 3 | 6 |
| 11+ builds | 127 | 74.8% | 5 | 11 |
| No build rows | 588 | 24.3% | 6 | 18 |

### Mutually exclusive segment ladder (first matching rule top-down; days_late quantiles UNCONDITIONAL, i.e. include early/on-time as <=0)
| Segment | n | late rate | P50 days_late | P80 | P95 |
|---|---|---|---|---|---|
| SLS and qty > 100 | 119 | 54.6% | +2 | +14 | +31 |
| qty > 100 (non-SLS) | 105 | 46.7% | 0 | +5 | +12 |
| 11+ builds | 86 | 74.4% | +3 | +9 | +17 |
| 4-10 builds | 854 | 48.9% | 0 | +4 | +8 |
| reorder (residual) | 38 | 31.6% | 0 | +2 | +9 |
| 1 build and qty <= 5 | 2,121 | 8.0% | -1 | 0 | +1 |
| everything else | 2,688 | 22.5% | 0 | +1 | +4 |


### Track: failures

**T1. Lateness with vs without each pre-ship failure event type** (shipped orders 2025-10-01..2026-07-09, N=6,028)

| Event type | Flag | n | Late rate | P50 days_late | P80 days_late | Mean days_late | Incremental mean delay |
|---|---|---:|---:|---:|---:|---:|---:|
| TOTAL_BUILD_FAILURE | without | 5,472 | 20.2% | 0 | +1 | -0.25 | — |
| TOTAL_BUILD_FAILURE | with | 556 | 50.5% | +1 | +4 | +2.12 | **+2.4d** |
| PART_NEEDS_REPRINT | without | 5,284 | 18.9% | 0 | 0 | -0.35 | — |
| PART_NEEDS_REPRINT | with | 744 | 52.4% | +1 | +4 | +2.26 | **+2.6d** |
| PART_MISSING | without | 5,564 | 20.8% | 0 | +1 | -0.19 | — |
| PART_MISSING | with | 464 | 49.6% | 0 | +4 | +1.97 | **+2.2d** |
| PART_QUARANTINED | without | 5,642 | 21.7% | 0 | +1 | -0.12 | — |
| PART_QUARANTINED | with | 386 | 42.2% | 0 | +3 | +1.33 | **+1.5d** |
| MANUFACTURING_ISSUE | without | 5,111 | 20.3% | 0 | +1 | -0.30 | — |
| MANUFACTURING_ISSUE | with | 917 | 38.4% | 0 | +2 | +1.51 | **+1.8d** |

**T2. Dose response: pre-ship failure event count -> lateness**

| Failure events | n | Late rate | P50 days_late | P80 | P95 |
|---|---:|---:|---:|---:|---:|
| 0 | 3,840 | 11.6% | -1 | 0 | +2 |
| 1 | 715 | 32.3% | 0 | +1 | +5 |
| 2-3 | 723 | 39.0% | 0 | +2 | +7 |
| 4-7 | 430 | 49.1% | 0 | +4 | +10 |
| 8+ | 320 | 67.5% | +2 | +8 | +19 |

**T3. Recovery time and due-proximity per failure type** (orders with the event)

| Event type | n | First evt->ship P50/P80 (d) | Last evt->ship P50/P80 (d) | P50 days-to-due at first evt | % first evt at/past due | % within 1d of due or past |
|---|---:|---|---|---:|---:|---:|
| TOTAL_BUILD_FAILURE | 556 | 4 / 7 | 3 / 5 | 2 | 22.5% | 39.7% |
| PART_NEEDS_REPRINT | 744 | 2 / 6 | 1 / 4 | 1 | 37.0% | 56.9% |
| PART_QUARANTINED | 386 | 2 / 5 | 1 / 3 | 2 | 30.1% | 49.0% |
| PART_MISSING | 464 | 2 / 5 | 1 / 4 | 1 | 33.4% | 51.9% |
| MANUFACTURING_ISSUE | 917 | 2 / 5 | 1 / 3 | 1 | 28.2% | 55.4% |

**T4. Lateness by slack remaining at FIRST failure event (any type)** (n=2,188 orders with >=1 failure)

| Days to due at first failure | n | Late rate | P50 days_late | P80 | P50 fail->ship (d) |
|---|---:|---:|---:|---:|---:|
| Already past due | 160 | 100% | +6 | +10 | 3 |
| 0-1 days | 920 | 48.2% | 0 | +3 | 1 |
| 2-3 days | 533 | 30.6% | 0 | +2 | 2 |
| 4+ days | 575 | 30.3% | 0 | +1 | 5 |

**T5. Holds x failures (2x2)** (hold = ORDER_PLACED_ON_HOLD pre-ship; 299/6,028 = 5.0% of shipped orders held)

| Hold | Failure | n | Late rate | P50 days_late | P80 | Mean |
|---|---|---:|---:|---:|---:|---:|
| No | No | 3,697 | 10.9% | -1 | 0 | -0.96 |
| No | Yes | 2,032 | 41.2% | 0 | +3 | +1.39 |
| Yes | No | 143 | 31.5% | 0 | +1 | +0.42 |
| Yes | Yes | 156 | 65.4% | +1 | +6 | +3.20 |

Hold resume proxy (next ORDER_CLEARED_FOR_PRODUCTION after first hold; available 221/299): P50 0.7d, P80 2.9d on hold. Next event after hold (all orders): DFM_REVIEW_CHANGED n=208, PROPS_CHANGED_BY_ADMIN n=176, INTERNAL_NOTE n=52, ORDER_CANCELLED n=42.

**T6. Failure rates by manufacturing family** (order-level, event has no part linkage)

| Family | n | Any-fail rate | TBF | Reprint | Quarantine | Missing | Mfg issue | Late rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SLA | 4,215 | 35.0% | 8.4% | 12.6% | 7.0% | 5.6% | 15.7% | 21.0% |
| SLS | 1,662 | 38.1% | 10.6% | 11.1% | 4.8% | 11.9% | 13.8% | 27.0% |
| Mixed | 134 | 59.0% | 17.9% | 20.1% | 9.0% | 23.9% | 20.9% | 37.3% |

**T7. Materials ranked by order any-fail rate** (orders containing material, n>=100; top/bottom)

| Material | n orders | Any-fail | TBF | Reprint | Late rate | P80 days_late |
|---|---:|---:|---:|---:|---:|---:|
| FLP11B01 (SLS) | 232 | 49.6% | 19.4% | 15.5% | 30.2% | +2 |
| FLP12T01 (SLS) | 108 | 47.2% | 7.4% | 7.4% | 34.3% | +3 |
| FLTO1502 (SLA Tough) | 386 | 45.6% | 11.4% | 11.4% | 22.8% | +1 |
| FLP12B01 (SLS) | 257 | 44.4% | 13.2% | 23.3% | 31.5% | +2 |
| FLTO2002 (SLA Tough) | 213 | 43.7% | 26.8% | 28.2% | 28.2% | +2 |
| FLGPGR05 (SLA) | 1,249 | 39.9% | 9.0% | 14.0% | 22.0% | +1 |
| FLP12G01 (SLS) | 1,053 | 38.0% | 10.4% | 9.8% | 27.2% | +1 |
| FLGPCL05 (SLA) | 736 | 31.9% | 4.8% | 11.7% | 17.9% | 0 |

**T8. Monthly trend: failure rate vs late rate** (by ship month)

| Month | n | Any-fail rate | Fail events/order | Late rate |
|---|---:|---:|---:|---:|
| 2025-10 | 530 | 24.2% | 1.13 | 22.5% |
| 2025-11 | 376 | 30.9% | 1.52 | 15.2% |
| 2025-12 | 409 | 43.8% | 1.42 | 11.7% |
| 2026-01 | 413 | 41.9% | 1.57 | 17.9% |
| 2026-02 | 484 | 39.0% | 1.35 | 28.7% |
| 2026-03 | 851 | 34.7% | 1.38 | 21.7% |
| 2026-04 | 859 | 40.6% | 2.31 | 18.4% |
| 2026-05 | 920 | 37.1% | 1.75 | 14.1% |
| 2026-06 | 939 | 37.4% | 1.85 | 39.8% |
| 2026-07 (to 07-09) | 247 | 27.1% | 0.79 | 41.7% |


### Track: backlog

**T1. Overall backlog-at-accept (order count) quartiles — shipped orders, 2025-10-01..2026-07-09**

| Quartile | Backlog range | n | Late rate | P50 days_late | P80 days_late | P50 days late (late only) |
|---|---|---|---|---|---|---|
| Q1 | 32–87 | 1,507 | 17.0% | 0 | 0 | 2 |
| Q2 | 87–134 | 1,507 | 20.8% | 0 | 1 | 2 |
| Q3 | 134–168 | 1,507 | 22.0% | 0 | 1 | 2 |
| Q4 | 168–333 | 1,507 | 32.2% | 0 | 2 | 3 |

**T2. Family-specific backlog quartiles (pure-family orders; family backlog counts only open orders containing that family)**

| Family | Quartile | Backlog range | n | Late rate | P80 days_late | P50 late (late only) |
|---|---|---|---|---|---|---|
| SLA | Q1 | 19–61 | 1,054 | 12.5% | 0 | 2 |
| SLA | Q2 | 61–84 | 1,054 | 21.0% | 1 | 2 |
| SLA | Q3 | 84–105 | 1,054 | 19.6% | 0 | 2 |
| SLA | Q4 | 105–184 | 1,053 | 30.8% | 1 | 2 |
| SLS | Q1 | 3–34 | 416 | 22.1% | 1 | 4 |
| SLS | Q2 | 34–52 | 416 | 25.2% | 1 | 5 |
| SLS | Q3 | 52–72 | 415 | 23.1% | 1 | 3 |
| SLS | Q4 | 72–162 | 415 | 37.3% | 3 | 3 |

**T3. Order-count vs part-weighted backlog as predictors (corr with late flag)**

| Segment | n | corr(order-count backlog, late) | corr(part-weighted backlog, late) | Verdict |
|---|---|---|---|---|
| All orders | 6,028 | 0.117 | 0.058 | order-count wins |
| SLA-only | 4,215 | 0.142 | 0.068 | order-count wins |
| SLS-only | 1,662 | 0.104 | 0.105 | tie |

Part-weighted quartiles (all orders): Q1 (312–3,481 parts) 18.1% late; Q2 24.4%; Q3 22.1%; Q4 (7,714–29,187) 27.4% (n=1,507 each) — non-monotone.

**T4. Weekly intake/throughput ratio (parts accepted ÷ parts shipped, same week & family) vs late rate of that week's accepted-and-shipped orders**

| Family | Intake/ship ratio | Weeks | n orders | Late rate | Avg parts in/wk | Avg parts out/wk |
|---|---|---|---|---|---|---|
| SLA | >1.5x | 10 | 1,178 | 24.4% | 2,684 | 1,135 |
| SLA | 1.2–1.5x | 5 | 648 | 23.8% | 2,721 | 2,044 |
| SLA | 0.8–1.2x (balanced) | 10 | 1,003 | 15.6% | 1,514 | 1,558 |
| SLA | <0.8x | 15 | 1,471 | 21.4% | 1,020 | 2,076 |
| SLS | >1.5x | 14 | 667 | 33.3% | 3,841 | 928 |
| SLS | 1.2–1.5x | 2 | 152 | 41.4% | 1,697 | 1,279 |
| SLS | 0.8–1.2x (balanced) | 7 | 374 | 16.0% | 2,777 | 2,924 |
| SLS | <0.8x | 17 | 567 | 21.2% | 757 | 2,530 |

**T5. Worst surge weeks (intake >1.5x throughput), late rate of that accept-week cohort**

| Family | Week | Parts in | Parts out | Ratio | n shipped | Late rate |
|---|---|---|---|---|---|---|
| SLS | 2026-06-08 | 4,362 | 1,607 | 2.7 | 76 | 70% |
| SLA | 2026-06-08 | 1,885 | 1,148 | 1.6 | 151 | 54% |
| SLA | 2026-06-01 | 2,388 | 1,037 | 2.3 | 141 | 48% |
| SLS | 2026-06-22 | 6,309 | 2,230 | 2.8 | 60 | 38% |
| SLS | 2026-03-30 | 2,724 | 627 | 4.3 | 83 | 33% |
| SLS | 2026-06-29 | 13,233 | 1,516 | 8.7 | 47 | 32% (right-censored) |
| SLS | 2026-06-15 | 2,782 | 1,380 | 2.0 | 81 | 32% |
| SLA | 2026-06-15 | 3,738 | 1,115 | 3.4 | 152 | 20% (right-censored) |

**T6. Monthly regime: median family backlog at accept, cohort late rate (accept-month cohorts)**

| Month | SLA n acc | SLA P50 backlog | SLA late (shipped) | SLS n acc | SLS P50 backlog | SLS late (shipped) | % open (SLA/SLS) |
|---|---|---|---|---|---|---|---|
| 2025-10 | 411 | 56 | 11% | 69 | 18 | 28% | 0/0 |
| 2025-11 | 306 | 57 | 13% | 80 | 26 | 23% | 0/0 |
| 2025-12 | 328 | 51 | 13% | 87 | 19 | 30% | 0/0 |
| 2026-01 | 341 | 59 | 16% | 86 | 17 | 16% | 0/0 |
| 2026-02 | 421 | 77 | 30% | 118 | 25 | 22% | 0/0 |
| 2026-03 | 582 | 95 | 26% | 333 | 48 | 17% | 0/0 |
| 2026-04 | 545 | 97 | 19% | 342 | 67 | 21% | 0/0 |
| 2026-05 | 649 | 93 | 14% | 290 | 56 | 22% | 0/0 |
| 2026-06 | 658 | 120 | 39% | 394 | 95 | 50% | 3%/16% |
| 2026-07 (partial) | 207 | 145 | 24%* | 108 | 151 | 16%* | 56%/77% (*meaningless, censored) |

**T7. Current open backlog, 2026-07-10 (status PRINTING/ACCEPTED/ON_HOLD, accepted, unshipped)**

| Family | Open orders | Open parts | On hold | P50 age (days) | Max age | Pctile vs hist backlog-at-accept (orders) | Pctile (parts) | Weeks of work (orders / parts, trailing 8-wk rate) |
|---|---|---|---|---|---|---|---|---|
| SLA | 149 | 4,196 | 20 | 4 | 54 | 98.0% (hist max 184) | 77.5% (hist max 7,211) | 1.0 / 1.7 |
| SLS | 155 | 26,476 | 7 | 8 | 31 | 99.8% (hist max 162) | 100% — ABOVE hist max 22,359 | 2.3 / 11.0 |
| TOTAL | 293 | 30,672 | 25 | 4 | 54 | deep in overall Q4 (Q4 = 168–333) | — | — |

Trailing 8-wk throughput (2026-05-11..07-05): SLA 144.5 orders / 2,417 parts per wk; SLS 68.3 orders / 2,409 parts per wk.


### Track: survival

**T1. Milestone→ship quantiles (days), shipped orders Oct'25-Jul'26**

| Channel | Family | n | acc→ship P50/P80/P90 | cleared→ship P50/P80/P90 (n) | 1st-printing→ship P50/P80/P90 (n) |
|---|---|---|---|---|---|
| FormNow | SLA | 1463 | 4 / 7 / 9 | 4 / 6 / 8 (1248) | 3 / 6 / 7 (1427) |
| FormNow | SLS | 989 | 6 / 9 / 13 | 4 / 7 / 10 (727) | 4 / 7 / 11 (963) |
| FormNow | Mixed | 129 | 6 / 12 / 16 | 6 / 10 / 14 (107) | 5 / 10 / 14 (123) |
| Xometry | SLA | 2752 | 4 / 6 / 7 | 4 / 6 / 7 (1882) | 3 / 5 / 6 (2729) |
| Xometry | SLS | 673 | 5 / 7 / 9 | 4 / 7 / 9 (673) | 3 / 5 / 7 (667) |
| Xometry | Mixed | 5 | 6 / 7 / 7 | 6 / 6 / 7 (5) | 5 / 6 / 6 (5) |

(printed_at→ship omitted: identical to 1st-printing→ship; same-day for 5905/5906 orders.)

**T2. KEY TABLE — remaining days to ship, conditioned on still unshipped N days after acceptance**

| Channel | N (days open) | n | P50 | P80 | P90 |
|---|---|---|---|---|---|
| FormNow | 0 | 2581 | 5 | 8 | 11 |
| FormNow | 2 | 2375 | 3 | 6 | 10 |
| FormNow | 4 | 1733 | 2 | 6 | 10 |
| FormNow | 6 | 1118 | 2 | 6 | 10 |
| FormNow | 8 | 582 | 3 | 8 | 12 |
| FormNow | 10 | 380 | 3 | 8 | 14 |
| FormNow | 14 | 179 | 3 | 11 | 20 |
| Xometry | 0 | 3447 | 4 | 6 | 7 |
| Xometry | 2 | 3152 | 3 | 4 | 6 |
| Xometry | 4 | 2101 | 1 | 3 | 5 |
| Xometry | 6 | 943 | 1 | 3 | 6 |
| Xometry | 8 | 343 | 2 | 6 | 9 |
| Xometry | 10 | 181 | 3 | 6 | 9 |
| Xometry | 14 | 74 | 2 | 7 | 12 |

**T2b. Same, split by past-due status at age N (selected N; P50/P80/P90)**

| Channel | N | Not past due (n) | P50/P80/P90 | Past due (n) | P50/P80/P90 |
|---|---|---|---|---|---|
| FormNow | 6 | 880 | 2 / 6 / 10 | 238 | 1 / 5 / 10 |
| FormNow | 8 | 283 | 3 / 8 / 14 | 299 | 2 / 7 / 12 |
| FormNow | 10 | 116 | 2 / 8 / 15 | 264 | 3 / 10 / 14 |
| FormNow | 14 | 29 | 3 / 12 / 34 | 150 | 3 / 10 / 16 |
| Xometry | 6 | 605 | 1 / 4 / 7 | 338 | 1 / 2 / 5 |
| Xometry | 8 | 145 | 2 / 6 / 10 | 198 | 1 / 5 / 8 |
| Xometry | 10 | 80 | 2 / 7 / 9 | 101 | 3 / 6 / 8 |
| Xometry | 14 | 20 | 3 / 7 / 11 | 54 | 2 / 6 / 19 |

**T3. Remaining days to ship, conditioned on K days since first ORDER_PRINTING**

| Channel | K | n | P50 | P80 | P90 |
|---|---|---|---|---|---|
| FormNow | 0 | 2512 | 3 | 6 | 9 |
| FormNow | 1 | 2405 | 2 | 5 | 8 |
| FormNow | 2 | 1890 | 2 | 5 | 9 |
| FormNow | 3 | 1446 | 2 | 5 | 9 |
| FormNow | 5 | 915 | 2 | 6 | 9 |
| FormNow | 7 | 479 | 2 | 7 | 13 |
| Xometry | 0 | 3401 | 3 | 5 | 6 |
| Xometry | 1 | 3282 | 2 | 4 | 6 |
| Xometry | 2 | 2650 | 2 | 4 | 5 |
| Xometry | 3 | 1996 | 1 | 3 | 5 |
| Xometry | 5 | 983 | 1 | 3 | 6 |
| Xometry | 7 | 334 | 1 | 5 | 8 |

**T4. Late orders — days shipped past due date (survival from due date)**

| Channel | Segment | n | P50 | P80 | P90 |
|---|---|---|---|---|---|
| FormNow | SLA | 397 | 2 | 5 | 8 |
| FormNow | SLS | 283 | 4 | 9 | 16 |
| FormNow | Mixed | 50 | 4 | 9 | 16 |
| FormNow | failure event: yes | 505 | 3 | 7 | 13 |
| FormNow | failure event: no | 225 | 2 | 6 | 11 |
| Xometry | SLA | 487 | 2 | 4 | 5 |
| Xometry | SLS | 165 | 3 | 7 | 10 |
| Xometry | failure event: yes | 441 | 2 | 5 | 8 |
| Xometry | failure event: no | 216 | 1 | 3 | 5 |

**T5. Stability check — age-conditioned remaining days, Oct'25-Mar'26 vs Apr-Jun'26 (P50/P80/P90, n)**

| Channel | N | Oct-Mar | Apr-Jun |
|---|---|---|---|
| FormNow | 0 | 5 / 8 / 13 (1143) | 5 / 8 / 10 (1438) |
| FormNow | 4 | 3 / 7 / 11 (806) | 2 / 5 / 8 (927) |
| FormNow | 8 | 4 / 10 / 17 (282) | 2 / 6 / 9 (300) |
| FormNow | 14 | 6 / 14 / 25 (107) | 2 / 6 / 8 (72) |
| Xometry | 0 | 4 / 6 / 7 (1920) | 4 / 7 / 9 (1527) |
| Xometry | 4 | 1 / 3 / 4 (1128) | 2 / 4 / 7 (973) |
| Xometry | 8 | 1 / 5 / 7 (121) | 2 / 6 / 9 (222) |
| Xometry | 14 | 1 / 5 / 8 (24)* | 3 / 8 / 12 (50) |

*n<30, unreliable.

**T5b. Late rate & severity by period**

| Channel | Period | n | n late | Late rate | Late P50/P80/P90 |
|---|---|---|---|---|---|
| FormNow | Oct-Mar | 1143 | 306 | 26.8% | 3 / 10 / 18 |
| FormNow | Apr-Jun | 1438 | 424 | 29.5% | 3 / 6 / 8 |
| Xometry | Oct-Mar | 1920 | 316 | 16.5% | 1 / 3 / 5 |
| Xometry | Apr-Jun | 1527 | 341 | 22.3% | 2 / 6 / 9 |

