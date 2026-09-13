# V2_PROXY research protocol — event study before strategy

**FROZEN before any V2 outcome is computed. Amended after the pre-outcome
specification audit; zero V2 outcomes existed at amendment time, so no
correction here is result-driven.**

> **GENERATION NAME: `V2_PROXY`.** The basis is a Dukascopy CFD, not CME NQ.
> This generation may not reach final NQ strategy validation. A later `V2_NQ`
> must independently replicate any promoted hypothesis on genuine NQ data.

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
6. → sealed historical stress set never used for evaluation or
   selection (see GATE 6 for the exact, corrected reading-from-disk claim)

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

**2018-05-31 → 2022-09-08, 1,106 trade days.**

### Factual correction — "never loaded" was FALSE

The audit is correct and my earlier statement was wrong. V1's development
warm-up began **2022-08-10**, which lies **inside** the stress set (it ends
2022-09-08). Those bars — roughly 21 trade days at the very end of the block —
**were read from disk** and **did** initialize V1's causal state (ATR, VWAP
accumulators, liquidity pools), which fed V1's development evaluation.

The exact, defensible statements are therefore:

| Claim | True? |
|---|---|
| literally never read from disk | **NO** — 2022-08-10..2022-09-08 was read by V1 |
| ever used to evaluate an outcome | **No** |
| ever used to select a parameter or candidate | **No** |
| 2018-05-31..2022-08-09 (1,085 of 1,106 days) ever read | **No** |

**V2 fix:** `partitions.load_v2()` reads **no bar earlier than the partition's
own first trade date**. Development state initializes causally from 2022-09-09.
Verified: the earliest bar loaded has trade date 2022-09-09. From V2 onward the
stress set is untouched in the literal sense as well.

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
`partitions.guard()` refuses it unless **`MMT_SPEND_STRESS_SET=yes`** is set
deliberately, refusing before reading anything. The legacy
`MMT_SPEND_HOLDOUT` still works, with a warning, so older scripts cannot
silently bypass the guard (amendment O).

---

## GATE 7 — V2 data usage, post-correction

All boundaries below are the corrected, timezone-aware CME sessions from
`cme_session.py` (GATE 1), verified by `test_cme_session.py`.

| Partition | Trade dates | Eligible days | Opens (ET) | Closes (ET) |
|---|---|---|---|---|
| **Development** | 2022-09-09 → 2025-05-05 | **683** | 2022-09-08 18:00 | 2025-05-05 17:00 |
| **Validation** | 2025-05-07 → 2026-08-31 | **341** | 2025-05-06 18:00 | 2026-08-31 17:00 |
| **Sealed historical stress set** | 2018-05-31 → 2022-09-08 | 1,106 | — | **SEALED** |

**Superseded for V2 by amendment C.** The warm-up shown above is V1's. V2 reads
no bar before each partition's own first trade date and uses a 252-day
development-only burn-in instead: evaluable development is **2023-09-01 →
2025-05-05, 431 trade days**. Validation's embargo (2025-05-06) still applies,
giving 341 eligible days rather than the 342 nominal.

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


---

# POST-AUDIT AMENDMENTS — these supersede anything above that conflicts

## A / A1 / N — evidence hierarchy and the proxy bridge

**LEVEL 1 — TARGET-MARKET EVIDENCE: genuine CME NQ futures.** Only Level 1
evidence may support "NQ has this edge", "NQ liquidity sweeps behave this way",
"NQ VWAP adds predictive information", or "this is an NQ strategy".

**LEVEL 2 — PROXY EVIDENCE: Dukascopy `USATECHIDXUSD` CFD.** Usable only for
hypothesis generation, software validation and broad Nasdaq price-behaviour
exploration. **A proxy finding is never silently promoted to an NQ conclusion.**

### Volume semantics — determined, not assumed

The `.bi5` record is `(int32 second-offset, int32 o, c, l, h, float32 volume)`.
Measured on the ingested file: **n = 577,413 · min 0.000022 · median 0.333 ·
max 9.13 · non-integer · 3,305 distinct values in the first 5,000**.

That is **not** a contract count and **not** CME exchange volume. It is
Dukascopy's own broker-side volume unit for this CFD. Consequently:

> **Every VWAP-derived feature on this basis is PROXY-SPECIFIC and is labelled
> so in every result.** No CFD VWAP result is evidence that NQ session VWAP
> behaves equivalently.

### Is genuine multi-year NQ available? No.

The project holds NQ 5m for ~72 days and NQ 1h for ~2.4 years (Yahoo), neither
sufficient for a 5-minute event study. Multi-year NQ requires a paid vendor,
which is declined. **Hence the generation is `V2_PROXY`.**

**Mandatory bridge before any NQ strategy:**

```
V2_PROXY event study
  → freeze a SMALL number of surviving hypotheses
  → replicate them on genuine NQ data (V2_NQ)
  → only then may NQ strategy construction begin
```

No CFD coefficient, threshold or parameter is assumed to transfer. The
replication question is **does the effect direction and economically meaningful
structure generalise**, never whether the identical numerical optimum transfers.

## C — development-only burn-in (252-day features)

252-day rolling features cannot be built from 30 days of warm-up, and the
shortfall must **not** be covered by the stress set.

| | |
|---|---|
| burn-in start | **2022-09-09** |
| burn-in end | **2023-08-31** (252 eligible trade days) |
| **first V2-evaluable trade date** | **2023-09-01** |
| remaining eligible development days | **431** |
| evaluable span | 2023-09-01 → 2025-05-05 |

Burn-in days build causal state only: **no outcome evaluated, no feature
relationship inspected, no candidate selected** on them. All primary features
are evaluated on this same eligible event period.

**The 252-day design is frozen now.** If 431 days proves too small, that is
reported as a limitation — it is not fixed by shortening 252 after seeing
results.

## D / E — reclaim reclassified, landmark analysis added

`reclaim_latency_min` and `reclaim_magnitude_atr` are **removed from the
event-time feature set**. A reclaim after `EVENT_CONFIRMATION_TIME` is not
knowable at confirmation.

Event-time replacements, both knowable at the sweep bar's close:
`close_vs_level_atr` (signed distance of the sweep bar's close relative to the
level) and `same_bar_reclaim` (bool).

`v2_events.assert_event_time_row()` **raises** if any prohibited key appears —
including a NaN placeholder, which is the exact mistake the audit named, since a
NaN that cannot be present now cannot be backfilled later.

**LANDMARK analysis**, predeclared at **5, 10, 15, 30 minutes**. At landmark L
only information timestamped ≤ `SWEEP_TIME + L` is usable: reclaim-by-L,
latency-if-already-occurred, magnitude-if-already-occurred, distance travelled,
displacement observed. Forbidden at L: ultimate MFE, ultimate MAE, any reclaim
after L, future displacement. Landmarks are fixed now; none is chosen later for
looking best. This is how A (adverse information) / B (late entry) / C (noise)
are separated without leakage.

## F / G / H — episode machine, sweep, level universe

All three are executable in `backtest/v2_events.py` and tested.

**Sweep:** sell-side `low ≤ level − 0.25`; buy-side `high ≥ level + 0.25`. One
full NQ tick required. **A touch exactly equal to the level is NOT a sweep** —
predeclared, not decided after observing outcomes. Trigger fields are LOW and
HIGH; close never triggers. Gapped-through levels are still sweeps and carry a
`gapped` flag for sensitivity. One bar penetrating N levels emits N events, one
per level, collapsed into one episode with every `level_id` retained.

**Episode:** one deterministic rule. An event joins the open episode only if the
direction matches **and** `event_time − EPISODE_START ≤ 60 min` **and**
`|level − episode_reference| ≤ 0.5 × ATR_AT_EPISODE_START`. The window runs from
**episode start**, so 0/50/100-minute events cannot chain into one 100-minute
episode. The ATR is frozen at episode start so future volatility cannot decide
clustering. Opposite direction always opens a new episode.

Every report states **events**, **unique episodes**, and **unique trade days**.

**Level universe:** 11 generators, exhaustive, each declaring formation rule,
availability rule, expiration, touch-update, invalidation, duplicate handling,
price, timeframe and session survival. Pivot availability is the confirmation
bar's close and is **never backdated** to the formation bar. Any additional
dynamic level construction is a new hypothesis family and enters the ledger
before its result is seen.

## I / J — feature specification and missingness

`research/FEATURE_SPEC_V2.json` gives the exact formula for all **29**
event-time features: ATR is Wilder RMA(14) on 5m with SMA seed; VWAP anchor,
reset, volume field and sigma formula; `vwap_slope` over 12 closed bars;
`level_age_min` from **availability**; `touch_count` excluding the sweep itself;
exact `wick_body_ratio` with the zero-body denominator floored at one tick;
`competing_liquidity_atr` nearest same-side with cap 10.0;
`htf_1h_dist_ref_atr` referenced to **exactly** the current trade day's first 1H
open; the 252-day percentile construction with average-rank ties; explicit
clip constants. No phrase such as "standard ATR" or "major level" survives.

**Winsorization constants are computed on the BURN-IN ONLY (2022-09-09 →
2023-08-31) and frozen there**, so clipping cannot be tuned on evaluable data.

**Missingness:** every univariate result reports eligible events before
missingness, events retained, episodes retained, trade days retained, and
percent missing. **A feature with >20% missingness on the evaluable set may
remain descriptive but cannot be promoted to a confirmatory predictor.** A
feature whose missing rule selects a favourable subset is thereby disqualified
from promotion rather than rewarded.

## K — multiple-testing control, frozen now

**One confirmatory test per feature against the PRIMARY 30-minute outcome.**
29 event-time features → a 29-test family.

**HOLM step-down family-wise error control, α = 0.05.** Holm because it controls
FWER without assuming independence among feature tests, which these are not.

Continuous features: **one** predeclared functional form each (Spearman rank
correlation against the primary outcome). Categorical features: **one**
predeclared omnibus test (Kruskal–Wallis across categories), never one
opportunity per category. Trying linear, then quintiles, then terciles, then
splines and reporting the best is prohibited; coarse bins are descriptive only
and are additional significance tests only if entered in the ledger as a new
exploratory analysis.

Secondary horizons are descriptive and **cannot independently promote a
feature**.

A feature is statistically supported only if **all five** hold: Holm-adjusted
primary test survives · CR1 interval supports the same direction · no
dependence-aware sensitivity gives a materially contradictory sign · effect
magnitude is economically nontrivial · subperiod evidence is directionally
stable.

## L — CR1 implementation, frozen

| | |
|---|---|
| cluster variable | **CME trade date** (`cme_session.trade_date`) |
| meat | `Σ_g (Σ_{i∈g} (x_i − x̄))²` |
| finite-sample correction | **G/(G−1)**; the `(n−1)/(n−K)` factor is exactly 1 for a mean (K=1) and is omitted, not approximated |
| critical value | **Normal**, z = 1.959964 at 95% |
| degrees of freedom | G−1, reported alongside every interval |
| implementation | `report_result.cr1_se` — the single implementation; no script recomputes it |
| single-event days | included; a cluster of size 1 contributes its own residual |
| empty clusters | impossible by construction (clusters are derived from observed events) |

**Day clustering does not solve multi-day volatility-regime dependence** and is
not claimed to. That is what the 5/10/20-day block and stationary bootstraps
probe, and they remain sensitivity checks.

## M — validation inspection budget

**ONE frozen promoted V2 architecture receives ONE primary validation
evaluation.**

If the architecture is modified after that result is seen, **validation is
contaminated for this research generation** and every subsequent validation use
is labelled **ADAPTIVE** in the ledger and in any result quoting it. The
inspect → adjust → re-inspect loop may not be run while calling validation
independent confirmation.

## O — guard terminology

Canonical: **`MMT_SPEND_STRESS_SET`**. Legacy `MMT_SPEND_HOLDOUT` still works so
older scripts do not silently bypass the guard, but warns. `guard()` covers both
the `stress_set` and legacy `holdout` partition names and refuses before reading
anything.
