# V2 research protocol — event study before strategy

**FROZEN before any V2 outcome is computed.**

`PROTOCOL.md` v1.3c remains in force for data provenance, costs and failure
criteria. This document supersedes it on partitions, uncertainty, and the
naming of the 2018–2022 block, and governs everything V2 does.

---

## GATE 5 — walk-forward was never reached, and is not run retroactively

V1's correct research history, recorded as fact:

1. pooled development evaluation
2. → no candidate survived
3. → research generation terminated
4. → **walk-forward never reached**
5. → validation never used for candidate confirmation
6. → sealed historical stress set never opened

§4 of `PROTOCOL.md` specifies 12-month train → 3-month test stepped 3 months,
which over development + validation yields **11 windows** (W1 train
2022-09-09→2023-09-09 test →2023-12-09 … W11 train 2025-03-09→2026-03-09 test
→2026-06-09).

**No walk-forward has ever been run in this project.** V1 will not have one run
after the fact. A rejected generation does not get retroactive procedural
completeness, and a walk-forward executed after rejection would be a new search
over already-rejected specifications, not a validation of them.

---

## GATE 6 — the 2018–2022 block is a SEALED HISTORICAL STRESS SET

**2018-05-31 → 2022-09-08, 1,106 trade days. SEALED. Never loaded.**

It is no longer called a holdout. A holdout implies *prospective* evaluation —
data arriving after the model was frozen. This block **precedes** the V1/V2
development data, so the implication is false and the name was misleading.

**What it can establish:** untouched cross-regime historical generalisation —
whether a frozen architecture survives regimes it was never fitted on, including
COVID and the 2022 bear market.

**What it cannot establish:** forward prospective performance, future-market
generalisation, or any conventional train-past/test-future claim.

If V2 ever earns evaluation on it, the result is reported as **untouched
historical stress/generalisation testing**, never as prospective holdout
performance. A genuine prospective holdout would require data collected *after*
a model is frozen, which this project does not yet possess and cannot
manufacture.

It is not opened during V2 feature discovery, model construction, parameter
selection, internal walk-forward, or validation. Guards stay in force:
`partitions.guard()` refuses it unless `MMT_SPEND_HOLDOUT=yes` is set
deliberately, refusing before reading anything.

---

## GATE 7 — V2 data usage, post-correction

All boundaries below are the corrected, timezone-aware CME sessions from
`cme_session.py` (GATE 1), verified by `test_cme_session.py`.

| Partition | Trade dates | Eligible days | Opens (ET) | Closes (ET) |
|---|---|---|---|---|
| **Development** | 2022-09-09 → 2025-05-05 | **683** | 2022-09-08 18:00 | 2025-05-05 17:00 |
| **Validation** | 2025-05-07 → 2026-08-31 | **341** | 2025-05-06 18:00 | 2026-08-31 17:00 |
| **Sealed historical stress set** | 2018-05-31 → 2022-09-08 | 1,106 | — | **SEALED** |

Development warm-up from 2022-08-10, no embargo (no preceding boundary).
Validation warm-up from 2025-04-06, embargo 2025-05-06, so evaluation opens
2025-05-07 — which is why 341 eligible days, not the 342 nominal.

**Within development:** feature discovery, event studies, model construction,
parameter development, internal walk-forward.

**Validation is not a second development set.** Only a small frozen candidate
architecture is promoted to it. **Every inspection of validation is logged** in
`RESEARCH_LEDGER.jsonl` with a timestamp and what was looked at. Modifying V2
after seeing validation performance contaminates validation, and any such
modification must be disclosed in the ledger and in any result that follows it.

---

## GATE 8 — exact research ledger

`RESEARCH_LEDGER.jsonl` replaces the estimate "~114". Every entry carries
research_id, generation, timestamp, code commit, config hash, dataset partition,
hypothesis, parameters, purpose, result location, whether performance was
inspected, and whether it influenced later decisions.

**VERIFIED MINIMUM COUNT** — enumerable from artifacts in this repository:

| | count |
|---|---|
| performance-inspected configurations | **50** |
| distinct hypotheses (H1–H6) | **6** |
| baseline | 1 |
| reproducibility corrections | 1 (adds **0** configurations) |

**UNKNOWN ADDITIONAL HISTORICAL TESTS** — recorded in `PROTOCOL.md` §0 but
carrying no commit, hash or artifact, and therefore **not independently
auditable**: **70 claimed configurations** (38 pre-V1 5m, 4 session variants,
~12 exit variants, 7 timeframes, 9 rejected improvement ideas).

These two figures are reported separately and never summed into a single
confident number. The honest statement is: **at least 50 configurations were
performance-inspected under artifact-backed conditions, plus approximately 70
more whose exact count cannot be verified.**

**By partition touched:** development 50 · validation **0** · sealed historical
stress set **0** · pre-basis 70 (unverifiable).

From this point the count is exact. Every V2 analysis appends an entry before
its result is examined. Failed experiments are never deleted.

---

## GATE 9 — uncertainty rule, frozen before V2 results exist

All seven estimators are computed and **reported** for every serious result:
naive trade-level · day-cluster CR1 · day bootstrap · 5-day moving block ·
10-day moving block · 20-day moving block · stationary bootstrap.

**The governing estimator is predeclared, not chosen after seeing results:**

> **The primary interval for every V2 decision is the day-cluster CR1
> interval.** All six others are reported as sensitivity. A V2 finding is
> declared only if the CR1 interval excludes zero **and** no other
> dependence-aware estimator contradicts it in sign.

CR1 is chosen in advance because trade-day clustering is the dependence
structure this data demonstrably has, and because fixing one estimator removes
the freedom to select whichever interval suits the result — which the V1
"widest dependence-aware" rule left open, since which estimator is widest varies
per result.

**Language correction, binding.** V1 described its headline as "the most
conservative interval". That was wrong: in **11 of 15** V1 results the naive
trade-level interval was wider than the chosen headline. The correct description
is "the widest **dependence-aware** interval", and that phrasing is used
retroactively in the V1 artifacts. It changed no V1 conclusion — 0 of 15 results
excluded zero under *any* estimator, naive included — but the claim was
overstated and is corrected.

---

## V2.1 — event definition, frozen

A **liquidity event** is a penetration of an available liquidity level.
**Reclaim is recorded as an outcome, never required as a filter** — requiring it
would presuppose V1's answer.

Four timestamps are maintained separately for every event:

| Timestamp | Meaning |
|---|---|
| `LEVEL_FORMATION_TIME` | when the level economically came into existence |
| `LEVEL_AVAILABILITY_TIME` | when the algorithm could first know it |
| `SWEEP_TIME` | first bar whose extreme exceeds the level |
| `EVENT_CONFIRMATION_TIME` | close of the bar at which the event is fully known |

**A level may not be used before `LEVEL_AVAILABILITY_TIME`.** A fractal pivot
requiring *k* confirming bars exists economically at its formation bar but is
unavailable until those bars have closed. No future-confirmed level is ever
backdated. The event engine uses availability time; formation time is recorded
for study only and must never be used as if known at that moment.

All features are evaluated at `EVENT_CONFIRMATION_TIME` using only information
available then.

## V2.2 — episode de-duplication, frozen before results

One market move must not become dozens of pseudo-independent observations. Both
`event_id` and `episode_id` are assigned.

- Two sweeps belong to the **same episode** when they occur within **60 minutes**
  and touch levels within **0.5 ATR** of each other in the same direction.
- A repeated touch of the same level is a **separate event** but the **same
  episode** unless separated by more than 60 minutes *and* an intervening
  opposite-direction event.
- **Nested levels** (a level inside another's 0.5 ATR band) collapse to one
  episode, keyed on the older level.

Every report states **number of events**, **number of unique episodes**, and
**number of unique trade days**. Inference accounts for multiple events per day,
multiple events per episode, long/short clustering and volatility-regime
clustering — CR1 clusters on trade day, with episode-level clustering reported
as sensitivity.

## V2.3 — predeclared feature dictionary

Every feature needs definition, units, availability timestamp, missing-value
rule and normalisation. Features are added only as a new ledger entry.

| Feature | Units | Available at | Missing rule | Normalisation |
|---|---|---|---|---|
| `liquidity_class` | categorical | availability | — | one-hot |
| `level_kind_dynamic` | bool | availability | — | — |
| `level_age_min` | minutes | availability | drop | log1p |
| `touch_count` | count | availability | 0 | raw |
| `level_prominence_atr` | ATR | availability | drop | raw |
| `competing_liquidity_atr` | ATR | availability | max-cap | raw |
| `penetration_pts` | points | sweep | drop | — |
| `penetration_atr` | ATR | sweep | drop | raw |
| `reclaim_magnitude_atr` | ATR | confirmation | NaN if none | raw |
| `reclaim_latency_min` | minutes | confirmation | NaN if none | raw |
| `wick_body_ratio` | ratio | confirmation | drop | clip 0–10 |
| `vwap_dist_pts` | points | confirmation | drop | — |
| `vwap_dist_sigma` | σ | confirmation | drop | raw |
| `vwap_slope` | σ/bar | confirmation | 0 | closed bars only |
| `session_location` | categorical | confirmation | — | one-hot |
| `minutes_since_session_open` | minutes | confirmation | — | raw |
| `atr_percentile` | 0–1 | confirmation | drop | rolling 252d |
| `realized_vol_state` | 0–1 | confirmation | drop | rolling 252d |
| `range_compression` | ratio | confirmation | drop | raw |
| `dist_session_open_atr` | ATR | confirmation | drop | raw |
| `dist_weekly_open_atr` | ATR | confirmation | drop | raw |
| `dist_overnight_high_atr` | ATR | confirmation | drop | raw |
| `dist_overnight_low_atr` | ATR | confirmation | drop | raw |
| `htf_15m_compression` | 0–1 | last **closed** 15m | drop | raw |
| `htf_1h_range_pctile` | 0–1 | last **closed** 1H | drop | raw |
| `htf_1h_vol_state` | 0–1 | last **closed** 1H | drop | raw |
| `htf_1h_dist_ref_atr` | ATR | last **closed** 1H | drop | raw |
| `direction` | ±1 | sweep | — | — |

**Prohibited:** any feature of the form `5m long AND 15m bullish AND 1H bullish`,
or any mathematical equivalent. H6 rejected directional agreement; it is not
reintroduced under a new name. HTF enters as **continuous context only**.

## V2.4 — continuous before boolean

`penetration_atr = 0.41`, not `deep_sweep = true`. `vwap_dist_sigma = -1.37`,
not `below_vwap = true`. `reclaim_latency_min = 13`, not
`reclaim_within_3_bars = true`. `htf_1h_range_pctile = 0.82`, not
`htf_bullish = true`. Thresholds only after stable evidence, shown.

## V2.5 — forward outcomes, predeclared

**Horizons: 5, 15, 30, 60 minutes.** No others are computed, and none may be
added after results are seen.

**PRIMARY: 30-minute horizon, ATR-normalised signed forward return,
direction-normalised.** 5m/15m/60m are secondary temporal-shape diagnostics.

At each horizon: signed forward return · ATR-normalised signed return · MFE ·
MAE · MFE/ATR · MAE/ATR. Also recorded: time to MFE · time to MAE · VWAP
reached · swept level revisited · opposing liquidity reached.

**Secondary outcomes are descriptive.** Each is not an independent opportunity
to declare success; a finding on a secondary outcome alone is not a finding.

## V2.6 — direction normalisation

Raw direction is always retained. For analysis, orientation is signed so that
the hypothesised-favourable direction is positive: for a sell-side sweep
(hypothesised bullish reversal) upward movement is positive; for a buy-side
sweep, downward movement is positive.

Every result reports **combined direction-normalised**, **long-side only**, and
**short-side only**. Asymmetry is never hidden, and never claimed without
adequate events, episodes and days on both sides.

## V2.7 — event time vs execution time

The event study measures price relative to the confirmed event timestamp / the
confirmed 5m close. **That is not executable P&L and is never called it.**

Any later strategy must enter at the first genuinely tradable price available
*after* the signal, under the frozen execution assumptions. No result may assume
execution at a price that existed before confirmation.

## V2.8 / V2.9 — censoring at boundaries, gaps and rolls

A forward outcome must never cross a partition boundary. An event 30 minutes
before the development close **cannot** use validation prices for its 60-minute
outcome: that horizon is **marked censored** and excluded from that horizon's
statistics, never borrowed.

The same rule applies to data gaps (the 11 known absences, the 17:00–18:00 ET
maintenance hour, weekends) and to contract rolls.

**Roll status of the current basis:** `USATECHIDXUSD` is a CFD with **no
contract roll**, so roll censoring is implemented and enforced but never fires
on this data. If NQ contract data is ever used, a horizon crossing the
active-contract boundary is censored; MFE/MAE is never computed across two
contracts; and no liquidity level survives a contract switch.

## V2.10 — the displacement-latency question

Three competing explanations for V1's negative displacement gradient, tested
separately, none assumed:

- **A** — displacement carries adverse information
- **B** — the event carries information but waiting for displacement enters
  after the useful move
- **C** — neither is stable and the V1 gradient is noise

Forward path is analysed conditional on: time since sweep · time since reclaim ·
completed 5m bars since event · distance already travelled favourably ·
displacement magnitude. The question is whether information **decays with
confirmation latency**. No trading rule is built from this until the
relationship survives internal validation.

## V2.11–V2.13 — carried-forward constraints

**HTF is context, never agreement** (V2.3 prohibition is binding).

**Dynamic liquidity is studied by characteristics** — age, prominence, touch
count, separation, clustering, ATR-normalised distance, formation duration — not
by hardcoding one fractal width. H5 does **not** establish that the existing
pivot algorithm is good, only that the tested static named-level set did not
carry V1's signal.

**Weekly open is exploratory only.** It is contaminated by prior research
exposure and V2 is not constructed around it. If multi-day reference location is
tested, the hypothesis is framed generically and a **small predetermined
family** is declared before outcomes are inspected. No large anchor search.

## V2.14–V2.16 — analysis order and multiple testing

Descriptive first: sample counts · missingness · feature distributions · events
by year, session, direction and volatility regime · event/episode concentration ·
forward-outcome distributions. **No optimizer, no machine learning, no strategy
backtest at this stage.**

Then predeclared univariate conditional analyses. Then, only if stable structure
exists: coarse monotonic bins → regularised model → nonlinear model only if it
beats simpler baselines on **internal walk-forward within development**.

Every feature/horizon analysis is appended to the ledger. A favourable p-value in
one bin or one horizon is not a finding. Required instead: effect direction
consistency · economic magnitude · stability across development subperiods ·
stability across reasonable feature definitions · dependence-aware uncertainty.
Any formal multiple-testing correction is declared before results.

## V2.17 — promotion gate

V2 Phase 1 succeeds only with evidence that predeclared market-state information
produces a **stable and economically meaningful** difference in the post-event
path. Before any move from event study to strategy design, all of:

- stable sign across development subperiods
- adequate event, episode and trade-day sample sizes
- dependence-aware uncertainty (CR1 primary, per GATE 9)
- no domination by a handful of days
- no single-year dependency
- no single-direction dependency unless explicitly modelled
- no obvious parameter needle
- no future leakage
- no contract-roll contamination

**If those do not hold: STOP.** No entry/exit strategy is manufactured. The
first V2 question is not profit factor — it is whether stable conditional
information exists at all.
