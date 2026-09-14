# V3-Z1 — CROSS-MARKET MARKET-STATE PREREGISTRATION

**Frozen 2026-09-14T02:44:06+00:00. PREREGISTERED, NOT EXECUTED.**

> Selection of Z1 is NOT a claim that Z1 has an edge. It is the next candidate for preregistration and engineering only.

No Z1 outcome, coefficient, correlation, p-value, hit rate, strategy return, Profit Factor, win rate, MFE, MAE or validation result was inspected in producing this document. Data cost **$0**.

## 1. The 730d / 618-day question, resolved by measurement

| quantity | measured |
|---|---|
| requested range | `730d` |
| **calendar days actually returned** | **875** |
| unique UTC dates | 735 |
| unique New York dates | 724 |
| **unique CME trade dates** | **618** |
| distinct weekday values | 6 |
| modal bars per trade date | 23 |

Yahoo's 730d label is a cap, not a literal lookback: the 1h response spans 875 calendar days. Those contain 724 New York dates across SIX weekday values, because the CME week opens Sunday 18:00 ET. Sunday evening bars belong to Monday's CME trade date, collapsing 724 NY dates into 618 CME trade dates. 626 weekdays exist in the span; 618 are present; the 8 absent are exactly US market holidays.

The eight absent weekdays are exactly: `2024-12-25`, `2025-01-01`, `2025-04-18`, `2025-09-01`, `2025-12-25`, `2026-01-01`, `2026-05-25`, `2026-09-07`.

**Precise statement.** Yahoo's usable 1-hour coverage for these tickers is ~875 calendar days ending at the request instant, containing **618 CME trade dates**, with a complete 23-bar session on 566 of them. The label `730d` is a cap name, not a lookback length. The phrase "730 days = 618 trade dates" was never correct and is retired.

## 2. Frozen raw snapshots

`data_z1/` — eight files, each a single request with one retrieval stamp; none assembled from multiple refreshes. Full hashes, timestamps, row counts, timezone and bar semantics in `research/V3_Z1_DATA_MANIFEST.json`.

These are immutable. Any later Yahoo refresh becomes a **new version**; development data is never silently overwritten with revised vendor history.

## 3. Terminology

Yahoo Finance generic/continuous futures series REFERENCING CME equity-index futures - NOT a contract-level CME feed

**Known:** the current quote maps to an exchange-listed contract; prices obey the expected tick structure; the instrument is futures-linked.

**Unknown / insufficiently documented:** historical child-contract identity; generic switch date; roll algorithm; back-adjustment methodology; vendor revisions.

## 4. Roll exclusion — calendar-derived, frozen

- Expiry: CME equity-index expiry = third Friday of Mar/Jun/Sep/Dec
- Published convention: lead-month roll is the Thursday 8 days before expiry
- **Frozen rule: exclude every CME trade date in [expiry - 10d, expiry + 2d]**
- the Yahoo generic switch date is UNKNOWN, so the window is deliberately wider than the published convention on both sides
- **Cancellation is NOT assumed.** NOT assumed. Roll effects are NOT presumed to cancel merely because all four are US equity-index futures.
- Excluded: **86 CME trade dates = 13.9% of sample**
- Derived from outcomes: **False** · cannot change during development except for a demonstrated data-engineering error

Nine trade dates excluded per quarterly roll (five for the partial 2026Q3 window at the snapshot edge).

## 5. Strict synchronization

a Z1 observation exists only where ALL FOUR markets have a closed hourly bar at that timestamp. No forward fill, no backward fill, no interpolation, no fabricated zero return, no partial-market row.

| market | hour-aligned closed bars | rows lost | missingness |
|---|---|---|---|
| NQ | 13,712 | 9 | 0.07% |
| ES | 13,714 | 11 | 0.08% |
| YM | 13,709 | 6 | 0.04% |
| RTY | 13,739 | 36 | 0.26% |

**Synchronized panel: 13,703 rows.** Hours since session open present: 0..22 (23 distinct). 52 trade dates carry fewer than 23 rows.

## 6. Bar-time causality

- Timestamp semantics: **bar OPEN; the bar closes at timestamp + 3600s**
- Admission: only hour-aligned timestamps (ts %% 3600 == 0) are loaded. This drops the trailing still-forming bar and the irregular early-close stubs - 25 such rows per market in the snapshot.
- Rule: every feature at hour t is computable only from bars closed at or before t; the primary outcome begins strictly after t closes
- Proof: `backtest/test_z1_causality.py`

**Gap semantics.** the CME day carries a 1-hour maintenance break (17:00-18:00 ET) belonging to neither session, so consecutive panel rows sit 2h apart once per trade date. That break is a normal feature of the instrument; a weekend or holiday gap is 47h+ and is excluded. Sigma window: the most recent 120 VALID returns at or before t. Gap returns are omitted from the window, never stitched. Requiring a contiguous block is unsatisfiable - a 120-hour window spans about a calendar week and therefore always contains a weekend - and the first implementation produced 0.00%% availability for exactly that reason. Outcome is stricter: Y requires exactly consecutive hours and is CENSORED across the maintenance break, so it measures one homogeneous quantity rather than mixing in a higher-variance session-open gap once per day.

## 7. Primary outcome — ONE, frozen

```
Y(t) = ln(C_NQ(t+1)/C_NQ(t)) / sigma_NQ(t)
```

- Horizon: **1 hour** · sigma: std of the 120 most recent valid NQ hourly returns at or before t
- **Why this horizon:** the hypothesised mechanism is transient price impact from an unconfirmed move. Such imbalances are resolved by index arbitrage and market making on a minutes-to-hours scale, so the next fully closed hour is where the effect should be STRONGEST. A longer horizon would dilute a transient effect.
- chosen from the mechanism before any outcome; NOT selected by comparing 1h/2h/3h/4h results
- Secondary horizons [2, 3]: DESCRIPTIVE ONLY, predeclared, no second Holm family, may never replace the primary

## 8. Cross-market state equation and the confirmatory family

```
z_m(t) = r_m(t) / sigma_m(t-1)
z_B(t) = mean over {ES, YM, RTY} of z_m(t)
```

z_m(t) = r_m(t)/sigma_m(t-1). The sigma window ends at t-1, STRICTLY before the return it scales, so a normalizer can never be contaminated by its own bar. Rolling only - no full-sample estimate.

the basket is EQUALLY weighted by declaration. No ES/YM/RTY weight, lookback, lag or threshold is optimized against NQ outcomes.

**m = 3** (maximum allowed 6; fewer is preferred).

| feature | equation | expected sign | availability | overlaps V1/V2 |
|---|---|---|---|---|
| `divergence_1h` | z_NQ(t) - z_B(t) | **NEGATIVE** | 97.79% | False |
| `divergence_session` | sum of (z_NQ - z_B) since the 18:00 ET session open through t, divided by sqrt(n hours) | **NEGATIVE** | 93.36% | False |
| `basket_z` | z_B(t) | **POSITIVE** | 97.79% | False |

- **`divergence_1h`** — an NQ move the broad complex does not confirm is more likely transient idiosyncratic flow than broad repricing, so it should partly revert.
- **`divergence_session`** — session-scale positioning imbalance rather than a single-hour innovation. *Related:* divergence_1h - same sign expectation at a different time scale. Declared as ONE family; Holm accounts for the correlation.
- **`basket_z`** — a confirmed broad-complex macro move is the common factor and should persist.

three genuinely distinct constructs - an hourly innovation, a session-scale accumulation, and the common factor itself - not six variants of one variable.

## 9. Baseline the effect must beat

Z1 must add information BEYOND NQ's own state. Variables: `nq_z = z_NQ(t)`, `nq_vol_state = log sigma_NQ(t) [the Z2 control]`, `session_bucket = hours since the 18:00 ET open, categorical`, `prev_day_nq_return = NQ return over the prior COMPLETED CME trade date`.

the outcome is regressed on [baseline + one Z1 feature]; the p-value of the Z1 coefficient is the incremental test. A raw correlation already explained by NQ's own lagged state is NOT an effect.

Z2 role: frozen baseline/control, never a competing hypothesis.

**VIX excluded.** a daily VIX close is not available earlier the same trading day, so an intraday feature would need the prior completed daily value. That complication buys nothing for the primary question, so VIX is excluded rather than carried with a leakage risk.

## 10. Partitions — three distinct concepts

| | span | trade dates | rows | nature |
|---|---|---|---|---|
| **A Development** | 2024-04-29 → 2025-12-30 | 369 | 8,211 | HISTORICAL |
| **B Internal replication** | 2025-12-31 → 2026-09-04 | 158 | 3,504 | HISTORICAL |
| **C True prospective holdout** | after `2026-09-14T02:44:06+00:00` | — | — | DOES NOT YET EXIST at freeze time |

data already existing at freeze time is HISTORICAL even where we choose not to inspect it. Only bars timestamped after the freeze instant are a true prospective holdout. B is frozen before outcomes; never used to repair or retune the model. C requires at least 126 CME trade dates before any inspection.

## 11. Effective sample — stated honestly

| stage | value |
|---|---|
| raw synchronized hourly rows | 13,703 |
| unique cme trade dates | 618 |
| rows after roll exclusion | 11,830 |
| trade dates after roll exclusion | 532 |
| rows after warmup and roll | 11,715 |
| trade dates after warmup and roll | 527 |
| development trade dates | 369 |
| replication trade dates | 158 |

**the effective sample is the TRADE-DATE CLUSTER COUNT, not 13,703 hourly bars. Hourly observations within a day are dependent and are never advertised as independent.**

Primary inference: OLS with CR1 covariance clustered on CME trade date, Student-t(G-1). Dependence sensitivity: predeclared moving-block bootstrap over CME trade dates at block lengths 5, 10 and 20 days, 5000 resamples, seed 20260914.

## 12. Multiplicity

**m = 3, alpha = 0.05, Holm step-down FWER**, fixed before outcomes.

- m is never reduced after seeing failures
- a secondary relationship is never moved into the primary family after results
- an untestable feature is reported NOT TESTABLE and is never replaced

## 13. Promotion gate — all seven, mechanically

1 Holm-adjusted p <= 0.05
2 effect sign matches the preregistered expected_sign
3 |standardized beta| >= 0.03
4 not concentrated in one period: dropping the highest-contribution decile of CME trade dates neither flips the sign nor reduces |beta| by more than 50%
5 internal chronological replication agrees DIRECTIONALLY
6 survives the predeclared block-bootstrap dependence sensitivity
7 remains incremental to the NQ-only + Z2 baseline

**Economic threshold, frozen now:** 0.03 standardized units is frozen NOW, before any result. NQ's hourly sigma is roughly 0.35%%, so 0.03 sigma is about 1 basis point, near 3 index points at current levels - comparable to a round-trip cost of one tick plus commission. Below that an effect cannot plausibly survive execution costs even before slippage, so it would not be worth carrying into a strategy phase.

**On failure:** V3-Z1 closes NEGATIVE. No repair search, no threshold tweaking, no horizon switching, no mining the replication segment.

## 14. Prohibited in this phase

`entries`, `stops`, `targets`, `position sizing`, `profit factor`, `win rate`, `equity curve`, `TradingView strategy`, `any Z1 coefficient, correlation, p-value or hit rate`.

## 15. Contaminated prior observations — never fresh evidence

- V2 Y_60 nominal p=0.04945
- the 19 exploratory landmark relationships
- weekly-open distance
- V2 range-compression directional results
- V1 H1-H6
- prior pivot observations

The 10-year daily panel is **NOT an independent dataset** (same vendor, related underlying markets). Permitted uses: different-horizon corroboration, long-history regime robustness, economic-direction sanity check. A contamination audit is required before it is used at all.

