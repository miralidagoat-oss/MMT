# V3-Z1 EXECUTION SPEC — FROZEN, NOT EXECUTED

Frozen 2026-09-14. `after this spec passes, no methodology change is permitted unless an objective implementation or data-engineering defect is discovered`

```
performance_inspected         = false
outcomes_inspected            = false
development_run               = false
replication_run               = false
prospective_holdout_inspected = false
data_cost_usd                 = 0
```

## 1. The exact primary regression

For hypothesis j (one model per hypothesis):

```
Y(t) = alpha + beta_j*Z1_j(t) + gamma1*nq_z(t) + gamma2*nq_vol_state(t) + SUM_b delta_b*session_b(t) + gamma3*prev_day_nq_return(t) + eps(t)
```

- **beta_j is the ONLY coefficient used for hypothesis j's primary test**
- intercept: **YES** · estimator: **OLS**
- development inference: **CR1 cluster-robust covariance clustered by CME trade date, Student-t(G-1)**
- development test: **TWO-SIDED coefficient test**
- the expected sign is NOT used to make the development test one-sided; it is a SEPARATE promotion gate
- all continuous predictors are standardized with FROZEN development constants. beta_j is invariant to rescaling of the OTHER regressors, so this affects conditioning only, not the primary test.

**Forbidden:** interaction terms · nonlinear transformations · polynomial terms · thresholding · winsorization (none was preregistered for Z1) · automatic feature selection · stepwise anything · any model choice made after outcomes.

## 2. Session coding

`hso = hours since the 18:00 ET CME session open, 0..22`. ET wall clock via cme_session.session_epoch, so the boundaries are DST-correct by construction and never a fixed UTC offset.

| category | hso | ET | role |
|---|---|---|---|
| `asia` **(REFERENCE, omitted)** | [0, 6) | 18:00-00:00 | |
| `europe` | [6, 12) | 00:00-06:00 | |
| `premarket` | [12, 15) | 06:00-09:00 | |
| `us_open` | [15, 17) | 09:00-11:00, the 09:30 cash open sits in hso 15 | |
| `us_midday` | [17, 20) | 11:00-14:00 | |
| `us_close` | [20, 23) | 14:00-17:00 | |

- Reference: **`asia`** — chronologically first, FROZEN before outcomes.
- beta_j is mathematically invariant to which dummy is omitted - the dummies span the same space - and a test proves it.
- Coding: reference-omitted 0/1 dummies, fixed column order.
- Absent category: **FAIL CLEARLY via DesignError; never silently recode**.
- All six present in both partitions: **True**.

Design columns (k = 10):

```
intercept, Z1, nq_z, nq_vol_state, session[europe], session[premarket], session[us_open], session[us_midday], session[us_close], prev_day_nq_return
```

## 3. Complete-case rule and eligibility counts

Each hypothesis is evaluated on its **own** deterministic complete-case sample requiring:

- primary outcome PRESENT (presence predicate only)
- that hypothesis's predictor present
- all baseline variables present
- session bucket resolvable
- eligible non-roll-excluded CME trade date
- partition membership

**Forbidden:** imputation · forward fill · backward fill · switching to the H1/H2 intersection after results are known.

| | rows | trade dates |
|---|---|---|
| H1 `divergence_1h` development | **7,586** | **360** |
| H2 `divergence_session` development | **7,227** | **360** |
| H1 replication | 3,267 | 155 |
| H2 replication | 3,112 | 155 |

*ELIGIBILITY ONLY - no outcome statistic.*

## 4. Development test statistic

1. fit the frozen model
2. extract beta_j
3. extract the CR1 standard error
4. t = beta_j / se
5. two-sided p from Student-t(G-1)

**Holm FWER, m = 2, alpha = 0.05** · Holm-adjusted development p > 0.05 -> Stage 1 FAIL

## 5. Moving-block bootstrap

**chronological MOVING-BLOCK bootstrap over CME trade dates**, cluster = the CME trade date is the indivisible unit. L ∈ [5, 10, 20], 5,000 resamples, seed **20260914**.

- draw contiguous blocks of block_len consecutive development trade dates WITH REPLACEMENT from all start positions
- append blocks until at least the original number of development trade dates is collected
- truncate to exactly that many WHOLE trade-date clusters
- include ALL eligible hourly rows of every selected date, preserving within-date structure
- refit the SAME frozen regression in every replicate
- do NOT refit scalers - use the frozen development constants
- record the distribution of beta_j

Recorded: the 95% percentile interval of beta_j.

## 6. Bootstrap pass rule

- for EACH of L = 5, 10 and 20 the 95% percentile interval for beta_j must exclude zero in the PREREGISTERED direction
- For the negative hypotheses: **the UPPER endpoint of the 95% interval must be < 0**
- **All three block lengths must pass.** Any failure → **bootstrap robustness gate = FAIL**
- Forbidden: substituting another interval after results · choosing the block length that looks best

## 7. Concentration rule

DEVELOPMENT trade dates split chronologically into 10 contiguous, approximately equal-count groups D1..D10. Sizes: **[36, 36, 36, 36, 36, 36, 36, 36, 36, 36]** — frozen before outcomes.

Procedure: 10 leave-one-decile-out refits of the identical frozen model; NO scaler refitting.

**PASS requires ALL of:**

- at least 9 of 10 leave-one-decile-out beta estimates retain the preregistered sign
- no sign reversal has absolute magnitude greater than the full-development |beta|
- the median leave-one-decile-out |beta| is at least 50% of the full-development |beta|

This is a robustness gate, NOT a new significance test. no p-value is computed from these ten models for promotion purposes.

## 8. Effect-size gate

**|standardized beta_j| ≥ 0.03** on |standardized beta_j| from the FULL development regression. It is only a minimum standardized predictive-information magnitude. It must **not** be converted into P&L, converted into ticks, called expected strategy return.

## 9. Stage-1 promotion — all nine required

1 Holm-adjusted development p <= 0.05
2 beta sign matches preregistration (NEGATIVE for both)
3 |standardized beta| >= 0.03
4 concentration robustness PASS
5 moving-block bootstrap PASS for L=5
6 moving-block bootstrap PASS for L=10
7 moving-block bootstrap PASS for L=20
8 the coefficient is estimated in the full frozen baseline model
9 the design matrix passes rank and conditioning checks

**the feature does NOT enter replication.**

## 10. Design-matrix quality

Computed **before** fitting: matrix rank, column count, condition number (SVD). Rank deficient → FAIL CLOSED (DesignError). Condition number: warn > **30.0**, fail > **100.0** (frozen before any output).

| hypothesis | n | k | rank | condition number |
|---|---|---|---|---|
| `divergence_1h` | 7,586 | 10 | 10 | **6.59** |
| `divergence_session` | 7,227 | 10 | 10 | **6.19** |

## 11. Stage-2 replication

- Entrants: **ONLY Stage-1 survivors**
- Identical: model equation, baseline, session coding, development scaling constants, feature definition, outcome, missing-data rule
- Test: **ONE-SIDED in the preregistered NEGATIVE direction**, alpha = **0.1**
- One survivor: p_one_sided <= 0.10 · Two survivors: Holm correction across the two replication p-values at family alpha = 0.10
- Also requires: **beta_replication < 0**
- reported DESCRIPTIVELY; never converted into a gate after outcomes

## 12. Firewalls

**Replication:** replication coefficients, p-values, correlations, plots and directional summaries are NOT computed for a hypothesis that failed Stage 1. Failed hypotheses remain outcome-uninspected in replication. Both fail → **V3-Z1 closes NEGATIVE immediately**.

**Prospective:** sealed; opens only after 126 ELIGIBLE CME trade dates under the frozen eligibility rule. Forbidden: early peeking, interim performance chart, running coefficient, running p-value.

**Outcome:** --dry-run replaces the outcome VALUE function with a poisoned stub that raises; only the bool presence predicate is reachable. --execute additionally requires --i-authorize-outcome-inspection and is disabled in this build.

## 13. Frozen development scaling constants

| variable | mean | sd | n |
|---|---|---|---|
| `divergence_1h` | -0.003351 | 0.670001 | 8,102 |
| `divergence_session` | +0.010353 | 0.474127 | 7,734 |
| `nq_z` | -0.001628 | 1.066438 | 8,102 |
| `nq_vol_state` | -6.113859 | 0.399884 | 8,205 |
| `prev_day_nq_return` | +0.000306 | 0.013716 | 8,050 |

## 14. Protected hashes — verified before any outcome is read

| artifact | sha256 |
|---|---|
| `research/V3_Z1_PREREGISTRATION.json` | `a979a8ca4ddccc0f995b6b5cfe3ff5c02841a8daf6350879abc159a565fad98a` |
| `research/V3_Z1_PREREGISTRATION_AMENDMENT_01.md` | `48a92a0c3ef695468cf3f08c49dc0972a22b263711ed38c7dfb6cd7c52d9b843` |
| `research/V3_Z1_DATA_MANIFEST.json` | `a8f82dc864607241ba00eea97d00644a1632bb8e2be971327adf55fd926aa1a3` |
| `backtest/z1_panel.py` | `24259e15e3de9f704fe7859ab3e66b258c655c7a048238567827555ad03733a8` |
| `backtest/z1_design.py` | `0a884b8d834bf05e947df982eaecd6a4dd93e52377d7e8cccaa7359c8e8fd428` |

the runner verifies these before reading any real outcome; any mismatch HALTS.

