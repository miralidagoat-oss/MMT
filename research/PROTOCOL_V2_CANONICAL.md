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
- `PROXY_SWEEP_PENETRATION_POINTS = 0.25` is an NQ-like **minimum penetration
  threshold**, never called the CFD's tick.

### Coverage limitation

The CFD's last bar opens ~16:10 ET and it reopens 18:00 ET, so it does **not**
cover 16:15–18:00 ET, of which 16:15–17:00 is genuine CME time. The `post`
bucket is sparse on this basis by construction.

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
| continuous | `rank(Y_30) = α + β·rank(X)`; β's clustered p enters Holm |
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

Categorical features have **no single sign**; individual category
coefficients are descriptive. Their stability rule is the rank-correlation of
the category-effect vector across the three development subperiods,
predeclared here, required **positive in both S1↔S2 and S2↔S3 comparisons**.

Day clustering does **not** solve multi-day regime dependence and is not
claimed to; the block/stationary bootstraps remain sensitivity checks.

## 9. Promotion gate

A feature is statistically supported only if **all** hold:

1. Holm-adjusted primary test survives at α = 0.05
2. CR1 interval supports the same direction
3. no dependence-aware sensitivity gives a materially contradictory sign
4. **continuous:** full-development sign reproduced in **all three** subperiod
   point estimates (individual subperiod significance NOT required);
   **categorical:** the predeclared stability rule above
5. no domination by a handful of days · no single-year dependency · no
   single-direction dependency unless modelled · no parameter needle · no
   future leakage · no roll contamination

**"Economically nontrivial" is NOT a Phase-1 pass/fail criterion.** Effect
magnitude is reported; whether it survives entry timing, spread, slippage,
stops and targets is a separate later question. No arbitrary ATR threshold is
invented to make this look quantitative.

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
