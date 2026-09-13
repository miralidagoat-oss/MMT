# PROTOCOL_V2_CANONICAL — the single source of truth for V2_PROXY

**This file contains ONLY currently binding rules.** Superseded definitions
live in `PROTOCOL_V2_PRECANONICAL.md`, retained as an immutable audit trail
and binding on nothing. Where the two differ, this file governs.

Frozen before any V2 outcome exists. Verified at freeze time: forward returns
computed = 0 · MFE/MAE = 0 · feature/outcome correlations = 0 · p-values on
real data = 0 · bins against outcomes = 0 · regressions on real outcomes = 0 ·
validation inspections = 0.

## 1. Basis and evidence hierarchy

**LEVEL 1 (target):** genuine CME NQ futures. Only Level 1 evidence supports
any claim of the form "NQ does X".
**LEVEL 2 (this generation):** Dukascopy `USATECHIDXUSD`, **BID-quote CFD,**
**broker-side volume, not CME trades, not NQ order flow.** Usable for
hypothesis generation, software validation and Nasdaq behaviour exploration.

Every V2_PROXY result carries that label. A promoted hypothesis must be
replicated on genuine NQ (`V2_NQ`) before any NQ strategy is built; no CFD
coefficient or threshold is assumed to transfer.

### Price grid

- V2 reads **`data_ndx/NDX_5m.csv  (RAW, unquantized)`**.
- Raw CFD quotes are **not** on an NQ tick grid — only ~2% of raw highs land
  on 0.25. **V2 does not round them.**
- `data_ndx_q/NDX_5m.csv` was **irreversibly rounded to 0.25** for V1 and is
  retained only for V1 reproducibility. V2 does not use it.
**Four separately named research constants** (values coincide at 0.25; they are
deliberately **not** one symbol, so changing one never silently changes another):

| Constant | Purpose |
|---|---|
| `PROXY_SWEEP_PENETRATION_POINTS` | minimum penetration to call a sweep |
| `PROXY_TOUCH_TOLERANCE_POINTS` | half-width of the touch band (`touch_count`) |
| `PROXY_BODY_FLOOR_POINTS` | minimum body denominator (`wick_body_ratio`) |
| `PROXY_PIVOT_DUP_TOLERANCE_PTS` | duplicate-pivot merge band |

None is a property of the Dukascopy instrument. **None is a tick.**
`assert_v2_basis()` refuses the V1 quantized file at every load site.

### Coverage limitation and PROXY level semantics — binding

The CFD's last bar opens ~16:10 ET and it reopens 18:00 ET, so it does **not**
cover 16:15–18:00 ET, of which **16:15–17:00 is genuine CME trading time**.

Therefore `pdh`, `pdl`, `pwh`, `pwl` and every session extremum are
**PROXY-OBSERVED extrema**, *not* true CME NQ highs and lows, and may differ
from the real NQ level. The CME trade-date calendar still partitions time; only
the **prices** come from observed proxy bars. The missing interval is **never**
filled synthetically. The `post` bucket is sparse by construction.

**Every V2_PROXY report header must state this.**

## 2. Time semantics

Stored stamps are **`BAR_OPEN_TIME`** (proven: 18:00 ET stamps exist, and a
bar *closing* at 18:00 would span the maintenance halt).

```
SWEEP_BAR_OPEN_TIME      = stored stamp of the sweep bar
EVENT_CONFIRMATION_TIME  = SWEEP_BAR_OPEN_TIME + 300s      (t0)
```

`SWEEP_TIME` is a **structural bar identifier only**. It is never the
intrabar crossing instant — 5-minute OHLC cannot reveal that, and nothing
here pretends otherwise. **All event-time predictors are stamped at `t0`.**

## 3. Sweep, levels, episodes

**Sweep (raw quotes):** sell-side `low ≤ level − 0.25`; buy-side
`high ≥ level + 0.25`. **Equality is NOT a sweep.** Triggers are LOW/HIGH;
close never triggers. Gapped-through levels are still sweeps, flagged.
One bar penetrating N levels emits N events, one episode.

### Event state machine — FROZEN (Ruling 1)

Each level carries an **immutable identity** for its whole lifetime:

    AVAILABLE  →  SWEPT  →  CONSUMED_FOR_EVENT_GENERATION

A level produces **exactly ONE** baseline sweep event: the **first** bar after
`LEVEL_AVAILABILITY_TIME` that satisfies the qualifying-penetration rule above.
On emission `has_emitted_sweep := true` for that identity, irreversibly. That
level may **never** produce another baseline sweep event. This holds if:

- price remains beyond the level for several bars;
- price subsequently reclaims it;
- price revisits it;
- price moves away and later trades through it again.

Those behaviours are the **post-event path** of the original event. They may
contribute to already-frozen outcomes — reclaim, level revisit, MFE, MAE,
opposing-liquidity interaction — but they are **not** new independent baseline
sweep events from the same liquidity pool. A second event at a similar price
arises only from a genuinely distinct level created under the frozen
level-generation rules, carrying a **new** immutable identity.

**Forbidden, as a new arbitrary parameter family:** a re-arm timer; a
"price moved X ATR away, therefore re-arm" rule; regeneration of the same
identity after N minutes; any other re-arm mechanism.

**Why frozen.** The prior unspecified behaviour let an already-penetrated level
fire on every subsequent qualifying bar — pathological pseudo-replication at
roughly **16.8 events/bar** in diagnosis, individual levels firing hundreds of
times. The first-event rule took the 16-day diagnostic sample from **70,694 to
404 events**, about **25.2 per trade day** across the 11 frozen liquidity
classes. Decided **before** Y_30, Y_5/15/60, MFE, MAE, any correlation,
regression, p-value, validation or stress-set result was observed, so it is a
legitimate pre-outcome event-definition correction (ledger:
`performance_inspected = false`).

**Counts are not targets.** 404 and 5,875 are observations, not optimisation
targets. The event definition is not tuned because 25.2 events/day seems high
or low, nor toward any eventual trading frequency. This is an event study; it
is expected to contain far more candidate events than a strategy. Trade
frequency becomes relevant only after predictive information is established.

**Conformance.** The engine was rewritten to match this specification after an audit found it reproducible but not spec-correct. `research/CONFORMANCE_MATRIX_V2.json` maps all **29** declared event-time fields to an implementation, required formula, availability, missingness rule and unit test, and HALTS if any mapping is absent; **22/22** confirmatory features are emitted. A deliberately naive reference engine (`backtest/v2_reference.py`) re-derives the frozen level economics with no optimizations and agrees with the production engine on every synthetic fixture. The superseded artifacts (`WINSORIZATION_FREEZE.json`, `EVENT_STREAM_CHECKSUM.json`) are retained for audit history, marked `SUPERSEDED_PRE_OUTCOME_NONCONFORMANT_ENGINE`, and are never used for Phase 1. Corrected burn-in: **9,723 events / 252 trade dates** (superseded: 5,875); corrected constants in `research/WINSORIZATION_FREEZE_V2.json`.

**Levels:** 11 generators in `v2_events.LEVEL_UNIVERSE`, each declaring
formation, availability, expiration, touch-update, invalidation, duplicates,
price, timeframe, session survival. **`PIVOT_LEN = 5`.** Pivot availability is
its confirmation close, never backdated.

**Pivot lifetime is economic, not computational.** A pivot lives from
availability until structural invalidation (swept AND reclaimed) and **never**
expires because newer pivots formed. `MAX_ACTIVE_POOLS = 20000` is a **safety
ceiling only**; if it would bind, the run **HALTS** (`PoolCeilingExceeded`)
rather than pruning a valid level.

**Duplicate pivots** within 0.25: price, `level_id`, formation time and
availability time all survive from the **older** level (earlier availability);
touch counts sum.

**Episode:** joins the open episode only if same direction **and**
`t − EPISODE_START ≤ 60 min` **and** `|level − reference| ≤ 0.5 × ATR_AT_START`.
Window runs from **start**, so 0/50/100-min events cannot chain. ATR frozen at
start. Opposite direction always opens a new episode. Every constituent
`level_id` is retained. Reports state events, episodes and trade days.

## 4. Partitions

| Partition | Range | Days |
|---|---|---|
| Development (burn-in) | 2022-09-09 → 2023-08-31 | 252 |
| **Development (evaluable)** | **2023-09-01 → 2025-05-05** | **431** |
| Validation | 2025-05-07 → 2026-08-31 | 341 |
| **PRISTINE stress set** | **2018-05-31 → 2022-08-09** | **1084** |
| CONTAMINATED tail | 2022-08-10 → 2022-09-08 | 22 |

**Development subperiods, frozen mechanically:**
- S1: 2023-09-01 → 2024-03-21 (143 days)
- S2: 2024-03-22 → 2024-10-10 (144 days)
- S3: 2024-10-11 → 2025-05-05 (144 days)

**Validation state initialisation:** from the 252 eligible trade dates
immediately preceding validation — development history through 2025-05-05 plus
the state-only embargo day 2025-05-06. Using *past* data to initialise rolling
predictors does not inspect validation outcomes. **No validation burn-in is
consumed**; first evaluable date remains 2025-05-07, giving all 341 days. All
feature parameters and winsorization constants stay frozen from development.

**Stress set:** only the **pristine** block can support an untouched
historical-stress claim. The contaminated tail was read by V1 as warm-up and
initialised V1 state; it is permanently excluded from that claim. Neither is
opened without `MMT_SPEND_STRESS_SET=yes`. Even if opened, the result is
**historical stress/generalisation evidence, never prospective performance** —
the block precedes the development data.

## 4a. Primary-outcome population — settled BEFORE any feature test

One **master primary population** is built first, for all features at once:

> **A** in the V2-evaluable development period · **B** confirmation valid ·
> **C** `ATR0` valid · **D** the exact `C_30` endpoint bar exists · **E** no gap
> interrupts the path · **F** the horizon does not cross a partition boundary ·
> **G** no contract roll crossed · **H** all other frozen censoring rules met.

Any failure → **PRIMARY-OUTCOME-INELIGIBLE**, with the reason recorded.

**Eligibility is determined first; feature availability second.** A feature test
may narrow the population only through *that feature's own* missingness.

Reported globally: total detected events · primary-Y30 eligible · censored ·
censoring-reason counts. Per feature: Y30-eligible · feature-nonmissing ·
episodes · trade days · missing %.

### Censoring audit — availability only

Before any confirmatory test, eligibility **rate** is reported by
`session_location`, hour, `direction`, `liquidity_class` and year. This audit may
read whether an outcome is present; it may **never** read its value or sign, and
`censoring_audit()` raises if handed an event carrying one.

**A categorical level joins the confirmatory design only with ≥ 30 distinct CME
trade-date clusters carrying primary-eligible events.** Below that it is excluded
from inference and reported as insufficient coverage. This is sample
availability, never an outcome-performance decision, and is frozen now.

## 5. Outcomes

```
C0   = close of the confirmed sweep bar
ATR0 = 5m Wilder ATR(14) known at t0
C_H  = close of the bar whose CLOSE stamp is EXACTLY t0 + H
Y_H  = direction * (C_H - C0) / ATR0        direction: +1 sell-side, -1 buy-side
```

**PRIMARY: `Y_30`.** Horizons 5/15/30/60 min; 5/15/60 are descriptive and
**cannot independently promote a feature**.

**MFE/MAE use only bars strictly AFTER `t0`.** The sweep bar is excluded — its
high/low may contain pre-confirmation movement.

```
dir +1:  MFE_H = max(future_high) - C0     MAE_H = C0 - min(future_low)
dir -1:  MFE_H = C0 - min(future_low)      MAE_H = max(future_high) - C0
MFE_ATR = MFE_H / ATR0      MAE_ATR = MAE_H / ATR0
```

`time_to_MFE` / `time_to_MAE` measured from `t0`.

**Secondary, frozen:** `vwap_reached` — a post-confirmation bar contains the
VWAP value **frozen at t0** (never the drifting VWAP). `level_revisited` — a
post-confirmation bar contains the original swept level. 
`opposing_liquidity_reached` — the nearest available opposite-side level is
identified and **its price frozen at t0**; a level formed later can never
retroactively become the target; none available → N/A.

**Censoring:** data gap, maintenance hour, partition boundary or contract roll
→ **CENSORED**. Never nearest-bar, previous-bar, next-available or
interpolated substitution. (The CFD basis has no contract roll; the rule is
implemented and simply never fires here.)

## 6. Landmarks

`TL = t0 + L`, **L ∈ {5, 10, 15, 30} minutes, measured from confirmation.**
At `TL` only information stamped ≤ `TL` is usable.

**Every landmark uses the SAME remaining horizon: 30 minutes from `TL`,**
normalised by **`ATR0`**. This answers *how much predictive information
remains after waiting L* — not *which waiting/horizon pair looks best*.

## 7. Confirmatory family and multiple testing

**m = 22, Holm step-down FWER, α = 0.05.**

1. `liquidity_class`
2. `level_age_min`
3. `touch_count`
4. `level_prominence_atr`
5. `competing_liquidity_atr`
6. `penetration_atr`
7. `close_vs_level_atr`
8. `wick_body_ratio`
9. `vwap_dist_sigma`
10. `vwap_slope_sigma_per_bar`
11. `session_location`
12. `minutes_since_session_open`
13. `atr_percentile`
14. `realized_vol_state`
15. `range_compression`
16. `dist_session_open_atr`
17. `dist_overnight_high_atr`
18. `dist_overnight_low_atr`
19. `htf_15m_compression`
20. `htf_1h_range_pctile`
21. `htf_1h_vol_state`
22. `htf_1h_dist_ref_atr`

**Excluded from the family** (still reportable descriptively, never
promoting a hypothesis):

- `level_formation_lag_min` — diagnostic only
- `level_kind_dynamic` — deterministic function of liquidity_class
- `penetration_pts` — raw-scale duplicate of penetration_atr
- `same_bar_reclaim` — deterministic thresholding of close_vs_level_atr
- `vwap_dist_pts` — raw-scale duplicate of vwap_dist_sigma
- `dist_weekly_open_atr` — exploratory - weekly-open information is contaminated by prior research exposure
- `direction` — stratification/orientation variable, not an ordinary predictor

One predeclared test per feature against **`Y_30` only**. Trying multiple
functional forms and reporting the best is prohibited; coarse bins are
descriptive unless logged as a new exploratory test.

## 8. Inference — `v2_inference.py`

All tests are OLS with CR1 clustered on **CME trade date**:

```
V_CR1 = (X'X)^-1 [ Σ_g X_g' u_g u_g' X_g ] (X'X)^-1 · c
c     = (G/(G-1)) · ((N-1)/(N-K))
```

| | |
|---|---|
| continuous | `rank(Y_30) = α + β·rank(X)`; β's clustered p enters Holm. Also report `rho` = Pearson on the same ranks — **descriptive effect size only, supplying no p-value** |
| boolean | `Y_30 = α + β·B`; β's clustered p |
| categorical | `rank(Y_30)` on K−1 dummies; **one** clustered omnibus Wald (H0: all K−1 zero) → F(q, G−1); that single p enters Holm |
| critical dist. | **Student-t(G−1)**; Wald referred to F(q, G−1) |
| ties | average ranks |
| singular design | **FAIL CLOSED** (`SingularDesign`) — never pseudo-inverted |
| min clusters | **30**, else `TooFewClusters` |
| NaN | rows dropped and **counted**, never imputed |

`report_result.cr1_se()` is a **sample-mean** estimator and is NOT reused for
any of these. Naive Spearman/Kruskal–Wallis p-values are never combined with
a clustered interval.

Categorical features have **no single sign**; individual category coefficients
are descriptive.

**Categorical stability, reference-invariant.** For each subperiod compute the
fitted mean rank outcome for every eligible category, then centre by the
**unweighted** mean across eligible categories. Centring makes the vector
independent of which dummy was the regression reference. The **same category
set** must be present in S1, S2 and S3 and must meet the minimum-cluster rule in
each; the common set is used. **Fewer than 3 common categories → INCONCLUSIVE
and non-promotable.** Otherwise Spearman rho of the centred vectors for S1↔S2
and S2↔S3 must **both be > 0**. A category is dropped only for sample
availability, never for performing poorly.

**Holm family size is permanently 22.** A predeclared feature that cannot
produce a valid test for a pre-outcome reason is reported **NOT TESTABLE / NOT
PROMOTABLE**. It is never replaced, and `m` is never reduced — power must not be
gained because a predeclared test failed to become usable.

Day clustering does **not** solve multi-day regime dependence and is not
claimed to; the block/stationary bootstraps remain sensitivity checks.

## 9. Promotion — mechanical gates only

**These seven are the ONLY hard Phase-1 gates**, evaluated by `promote()`:

1. feature is in the frozen 22-feature family
2. feature missingness ≤ 20% — applied **literally**, as frozen before any result: not tightened, not rounded up, given no safety margin. **Measured on the development evaluable population**, per section 10 (“every univariate result … percent missing”). An earlier revision of this line said “measured on the burn-in”; that was wrong and contradicted section 10 — burn-in is precisely the 252 days that build the 252-day comparators, so `atr_percentile`, `realized_vol_state`, `htf_1h_range_pctile` and `htf_1h_vol_state` are 100% missing there **by construction**, exactly as section 10 anticipates. On development: `dist_overnight_high_atr` and `dist_overnight_low_atr` at **60.19%** are **NON-PROMOTABLE** (predeclared, in the original family, descriptively reportable; no favourable p-value may override a gate failed before outcomes were seen, and neither may be repaired, replaced or re-defined). The other 20 pass, `htf_1h_dist_ref_atr` now at **0.00%** — its earlier 19.80% was an artifact of the sqrt(12) approximation, not a property of the feature. The two non-promotable features create **no vacancies**: Holm **m = 22** stands, nothing is substituted, no multiplicity power is gained
3. minimum-cluster requirement satisfied
4. a valid primary CR1 test exists
5. Holm-adjusted p ≤ 0.05
6. **continuous:** the full-development CR1 effect direction is reproduced by
   the point estimate in S1, S2 **and** S3 (individual subperiod significance
   NOT required); **categorical:** the frozen stability rule above
7. no timestamp / leakage / integrity test failed

**Removed as gates**, because they were not mechanical and created post-result
discretion: *"no domination by a handful of days"*, *"no single-year
dependency"*, *"no parameter needle"*, *"no materially contradictory sensitivity
sign"*, *"economically nontrivial"*.

`promote()` **raises** if a diagnostic is passed in as a gate, and raises if any
hard gate is absent. That is how those phrases stop being discretionary vetoes
applied after the numbers are visible.

## 9a. Robustness diagnostics — reported, never gates

Frozen now so they cannot be chosen opportunistically. For every feature
surviving Holm:

- **year** — effect by calendar year where sample permits
- **direction** — sell-side and buy-side separately
- **day concentration** — descriptive effect after excluding the top 1% of trade
  dates by absolute contribution to the association statistic
- **block dependence** — moving block at **5, 10, 20** trade days plus a
  stationary bootstrap at mean block **5**, **5000 resamples, seed 20260913**.
  Block lengths are predeclared and never searched.
- **gapped events** — gapped events are **INCLUDED** in the primary analysis; a
  gap-excluded rerun is descriptive only

None adds a Holm hypothesis. None can change `promoted`. A later strategy stage
may formalise any of them only with thresholds frozen before that stage's
results.

## 10. Missingness, winsorization, gaps

Every univariate result reports eligible events before missingness, events /
episodes / trade days retained, and percent missing. **>20% missing → the
feature stays descriptive and cannot be promoted.**

**Winsorization is per-feature, no global fallback:** 19 of 29 features are winsorized at [0.005, 0.995], with
constants computed on the **burn-in only** and frozen there. Bounded 0–1
percentiles, booleans, categoricals and counts are **never** winsorized — so
no 252-day percentile ever needs a constant from a period in which it is not
yet eligible.

**Gapped events are INCLUDED in the primary analysis** if they satisfy the
sweep definition. `gapped` is recorded. A gap-excluded rerun is a
**descriptive sensitivity only** — it cannot promote or reject a feature and
does not enter Holm unless logged as a new exploratory test.

## 11. Validation budget

**ONE promoted architecture, ONE primary validation evaluation.** Modifying
the architecture after seeing that result contaminates validation for this
generation; every subsequent use is labelled **ADAPTIVE** in the ledger and in
any result quoting it.
