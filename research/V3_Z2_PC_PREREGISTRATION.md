# V3-Z2-PC — POSITIVE CONTROL PREREGISTRATION

Frozen 2026-09-14T16:17:55+00:00. **PREREGISTERED - NOT EXECUTED**

```
performance_inspected = false
outcomes_inspected    = false
development_run       = false
data_cost_usd         = 0
```

## Why this exists

An INSTRUMENT CHECK on the V3-Z1 inference pipeline. It asks whether that pipeline can detect a known-true effect (volatility persistence) and whether it rejects at its nominal rate when no effect exists. It is NOT an edge hunt.

24 predeclared primary hypotheses across V2_PROXY and V3-Z1 have returned zero promotions. A pipeline that always returns null is, on that evidence alone, indistinguishable from a broken one. This resolves that ambiguity.

**A pass means:** the instrument has demonstrated sensitivity and correct size. The prior nulls become credible evidence about the market rather than about the code. It does NOT promote any trading signal, does NOT imply a directional edge, and does NOT authorize strategy work.

**A fail means:** a defect exists in the shared machinery. V1, V2_PROXY and V3-Z1 conclusions must be re-read before any of them is relied on. The response is a defect hunt, NOT a new model class.

## Design principle

> identical data, identical code path, identical inference - only the QUESTION changes. A control that runs through different machinery calibrates nothing, so every shared component is imported from z1_panel / z1_design / v2_inference rather than reimplemented.

**Imported unchanged from Z1:**

- build_panel (strict 4-market intersection)
- log_returns and the 2h maximum gap rule
- rolling-window omission of gap returns
- roll_excluded_dates [expiry-10d, expiry+2d]
- session_bucket coding and the asia reference
- development window 2024-04-29 .. 2025-12-30
- frozen-scaler discipline (development only, outcome-free)
- cr1_ols day-clustered inference, Student-t(G-1)
- check_design rank and condition thresholds
- the prospective firewall at 2026-09-14T02:44:06Z

**What changes:**

- the OUTCOME is future realized variance, not direction
- the PREDICTORS are lagged realized variance at three scales (HAR)
- there is no promotion, no replication stage and no strategy path

## Outcome

```
Y_vol(t) = log( r_NQ(t+1)^2 )      horizon = 1 hour
```

**Why this horizon:** EXACTLY the horizon V3-Z1 used, so the control runs on essentially the same rows with the same censoring pattern. Comparability with the experiment being calibrated matters more than a smoother outcome.

**Drafted then rejected:** a 6-hour forward window was drafted first. It censored hso 17-22 entirely - the window cannot cross the 17:00 ET maintenance break - which emptied the us_midday and us_close buckets and produced a RANK-DEFICIENT design. The frozen absent-category rule caught it before any outcome existed.

**Known cost, stated up front:** log(r^2) over a single bar is a NOISY proxy for log variance (log chi-square, 1 df, variance pi^2/2 ~ 4.93). This ATTENUATES the standardized coefficient; it does not bias the sign or invalidate the test. The thresholds below are set against the ATTENUATED expectation, not against unattenuated literature values.

Censoring: CENSORED, never bridged, wherever t+1 is not the genuine next hour.

## Predictors

hourly HAR, all in logs of per-bar mean variance.

| component | window (bars) | meaning |
|---|---|---|
| `rv_short` | 6 | quarter session |
| `rv_day` | 23 | one full CME session |
| `rv_week` | 115 | five sessions |

each uses only bars CLOSED AT OR BEFORE t; gap returns are omitted from the window, never fabricated; a partial window yields MISSING rather than a downward-biased estimate. all three standardized with FROZEN development constants, fitted on predictor values only, reading no outcome.

Measured collinearity: short↔day **+0.646**, short↔week **+0.509**, day↔week **+0.723**.

## Model

```
Y_vol(t) = alpha + b_s*rv_short(t) + b_d*rv_day(t) + b_w*rv_week(t) + SUM_b delta_b*session_b(t) + eps(t)
```

OLS, CR1 clustered by CME trade date, Student-t(G-1).

**Session fixed effects:** INCLUDED deliberately. NQ intraday volatility seasonality is large; without these the test would partly 'detect' time-of-day rather than persistence, which would make passing trivial and the control meaningless.

## Sample (eligibility only — no outcome value computed)

| | |
|---|---|
| eligible rows | **7,834** |
| eligible trade dates (clusters) | **368** |
| window | 2024-04-29 → 2025-12-30 |
| design k / rank | 9 / 9 |
| condition number | **8.53** (PASSES (warn 30 / fail 100)) |

By session bucket: `asia` 2,117, `europe` 2,162, `premarket` 1,078, `us_open` 710, `us_midday` 1,061, `us_close` 706.

## Pre-outcome power check — the rule V3-Z1 was missing

> **no pass threshold may be declared BELOW the design's MDE at 80% power, computed before outcomes. V3-Z1 violated this: it declared a 0.03 economic floor while its MDE was 0.071, so it could not certify the effect it said it cared about.**

| | |
|---|---|
| clusters G | 368 |
| scaled CR1 se estimate | 0.02491 |
| **MDE at 80% power** | **0.0698** |
| expected attenuated effect | 0.132 – 0.246 |
| ratio expected / MDE | **1.9× – 3.5×** |
| implied \|t\| | 5 – 10 |

**SATISFIED - the expected effect is 1.9x to 3.5x the MDE.**

*Correction:* an earlier informal estimate quoted |t| ~ 12-24 for this control. That assumed an UNATTENUATED effect. With the single-bar log(r^2) proxy the realistic range is |t| ~ 5-10. The control remains decisive but is less overwhelming than first stated.

## Stage A1 — sensitivity (the positive control)

*can the pipeline detect a known-true effect?*

**PASS requires ALL:**

1. b_s > 0 (positive volatility persistence)
2. t(b_s) >= 4.0 under CR1 day-clustered inference
3. joint Wald test of {b_s, b_d, b_w} has p < 1e-4
4. |standardized b_s| >= 0.0698 (the design's own MDE, per the rule above)

4.0 sits BELOW the conservative expected |t| of ~5 so a genuine effect passes comfortably, yet far above noise (p ~ 6e-5 at df=367). Set before outcomes and never tuned.

## Stage A2 — specificity / size (the negative control)

*does the pipeline reject at its nominal rate when NO effect exists?*

block-permute the three HAR predictors ACROSS trade dates - whole-date blocks, so within-date dependence and the predictors' mutual correlation are preserved while the link to the outcome is destroyed. Refit the identical frozen model. 1,000 permutations, seed 20260914.

**Recorded:** empirical rejection rate for b_s at alpha = 0.05 two-sided. **PASS band: [0.025, 0.08]**.

Monte-Carlo SE at p=0.05 with 1,000 reps is 0.0069, so +/-3 SE is about [0.029, 0.071]. The band is slightly wider to avoid a false alarm from MC noise, yet far tighter than the 0.20-0.40 rejection rate a naive iid test would show against this much within-day dependence.

**Why this is the most valuable half:** this directly tests the SIZE of the CR1 p-values used throughout V2_PROXY and V3-Z1. Over-rejection would mean those nulls survived an anti-conservative test and are even more convincing. Under-rejection would mean the tests were too conservative and could have masked real effects. Both readings matter and the two-sided band catches both.

## Stage B is deliberately absent

**NO research hypothesis is preregistered in this document.**

calibrate the instrument, THEN design the experiment. Preregistering a research hypothesis now would mean committing to it before knowing whether the instrument works, which is backwards. If A1 and A2 pass, a separate preregistration may follow.

**Warning recorded now for any future Stage B:** any added feature must NOT be a linear combination of the HAR components already in the model. A short-versus-long log variance ratio, for example, is exactly the algebraic redundancy that Amendment 01 removed from Z1 - conditional on rv_short and rv_week it spans nothing new.

## Not authorized

`promoting any trading signal`, `replication stage`, `prospective holdout access`, `strategy construction`, `entry/stop/target rules`, `profit factor`, `win rate`, `Sharpe`, `position sizing`, `TradingView work`.

Prospective holdout remains sealed at `2026-09-14T02:44:06Z`; this document does not change it.

## Protected hashes

| file | sha256 |
|---|---|
| `backtest/z1_panel.py` | `24259e15e3de9f704fe7859ab3e66b258c655c7a048238567827555ad03733a8` |
| `backtest/z1_design.py` | `0a884b8d834bf05e947df982eaecd6a4dd93e52377d7e8cccaa7359c8e8fd428` |
| `backtest/z2_control.py` | `c653a12d26f4a661cbc018deb1404e436bb14552102ee00cd081dc3a9c94b037` |
| `research/V3_Z1_DATA_MANIFEST.json` | `a8f82dc864607241ba00eea97d00644a1632bb8e2be971327adf55fd926aa1a3` |
