# NQ 5-minute research protocol — v1.1, FROZEN 2026-09-12

Supersedes v1.0. Declared **before** the multi-year NQ dataset exists and before
any paid data request. No strategy result was produced while writing this
revision. Changes require a new version, a dated changelog entry, and a
statement of what had already been seen.

## 0. Research history — carried forward, never reset

| Category | Already examined |
|---|---|
| 5m configurations | ~38 (18 repair attempts, 14 ablations, 6 frontier variants) |
| Model architectures | 1 |
| Session variants | 4 |
| Exit variants | ~12 (breakeven grid) |
| Timeframes surveyed | 7 |

**This count does not reset when new data arrives.** Every future result is
reported against this prior search history.

---

## 1. THE FINAL HOLDOUT GETS EXACTLY ONE USE

H1–H6 are developed, falsified, compared, selected, combined and rejected using
**only** development data, validation data, and the walk-forward procedure.

The holdout may **not** decide: whether any hypothesis works; which liquidity
hierarchy is best; whether displacement is included; which HTF combination wins;
any parameter value; any session rule.

**Sequence:**

1. **Development** → build and falsify hypotheses.
2. **Validation** → select architecture and parameters.
3. **Walk-forward on development + validation** → robustness confirmation.
4. **FREEZE** — all logic, parameters, session definitions, cost assumptions,
   entry rules, exit rules, HTF logic, roll handling. Recorded as a git commit
   SHA plus a SHA-256 of the frozen config. Nothing may change after this.
5. **Holdout run ONCE.**

**If the holdout fails, that is the reported result.** The system is not
repaired against it. Any further work is a **new research generation** requiring
genuinely new future data, or it is explicitly labelled contaminated. The
holdout may never again be described as untouched once opened.

---

## 2. Instrument, timeframe, objective

- **Market:** CME NQ, individual contracts, raw prices, roll per `ROLL_POLICY.md` v1.1
- **Execution:** 5-minute, aggregated deterministically from 1-minute
- **Primary metric:** expectancy in R per trade with **multi-scale block-bootstrap** CI (§7)
- **Secondary:** PF, win rate, trades/session, max drawdown in R, day-level stats, long/short, session split

---

## 3. TRANSACTION COSTS — unambiguous, in dollars

**NQ contract facts:** tick = 0.25 index points · tick value = **$5.00** ·
point value = **$20.00** per contract.

### HEADLINE ("realistic") — every headline number uses this

| Component | Per side | Round trip |
|---|---|---|
| Broker commission | $1.00 | $2.00 |
| Exchange + clearing + regulatory fees | $1.00 | $2.00 |
| **TOTAL FEES** | **$2.00** | **$4.00 ROUND TRIP** |
| Entry slippage (1 tick) | — | $5.00 |
| Exit slippage (1 tick) | — | $5.00 |
| **TOTAL HEADLINE ROUND-TRIP FRICTION** | | **$14.00 per NQ contract** |

The $4.00 fee figure is **round trip, not per side.**

| Scenario | Fees (RT) | Slippage | **Total RT friction** |
|---|---|---|---|
| Optimistic | $4.00 | 0 ticks | **$4.00** |
| **Realistic (headline)** | **$4.00** | **1 tick each side** | **$14.00** |
| Stressed | $4.00 | 2 ticks each side | **$24.00** |

### Application order — dollars first, then R

```
friction_$      = fees_$ + entry_slip_ticks*5 + exit_slip_ticks*5   (per contract)
initial_risk_$  = initial_stop_distance_points * 20                 (per contract)
net_R           = gross_R - friction_$ / initial_risk_$
```

**A single universal R-cost must NOT be subtracted from every trade.** Stop
distances differ, so identical dollar friction is a different R cost on each
trade. At $14 friction: a 30-point stop ($600) pays 0.023R; a 10-point stop
($200) pays 0.070R — a 3× difference.

**Disclosure:** every result reported in this project *before* v1.1 used the
engine's tick-based approximation (`cost_ticks × tick / risk_points`), which
conflates fees with slippage and does not scale fees by point value. Those
numbers are not directly comparable to anything produced under v1.1.

---

## 4. Partition boundaries — warm-up, purge, embargo

The model carries state: liquidity pools, session levels, VWAP accumulators,
HTF state, structural lookbacks, PO3 state, pool TTL, rolling volatility.
Cutting bars at a timestamp produces missing state or leakage.

- **Warm-up:** 30 calendar days of bars precede each partition, used **solely**
  to initialize causal state. No trade whose **entry bar** falls in warm-up is
  evaluated or counted anywhere.
- **Partition assignment:** a trade belongs to the partition containing its
  **entry bar**. Its exit may use bars beyond the boundary (causally fine).
  **Partitions never share a trade** and no trade is double-counted.
- **Embargo:** **1 full trade day** after each boundary in which no trade may
  enter, so no position straddles the seam.
- **No open position originating in training may generate validation or holdout
  P&L.**
- **No parameter selection may use any information from a later partition.**
- Any feature requiring a longer lookback than the warm-up extends the warm-up,
  not the embargo.

### Partitions (chronological, never shuffled)

| Partition | Share | Use |
|---|---|---|
| Development | earliest 50% | debugging, hypothesis formation, free exploration |
| Validation | next 25% | selecting among predeclared variants only |
| **Final holdout** | latest 25% | **one run, after freeze** |

Walk-forward: 12-month train → 3-month forward test, stepped 3 months, across
**development + validation only**.

**The existing 59-day NQ 5m sample is `recent-regime development evidence`, not
a holdout** — the shipped config has already been run on it with a 60/40 split,
long/short split and 9-bucket session breakdown.

---

## 5. Parameter plateau — applied by parameter type

The principle is a plateau, not a needle. The implementation differs by type.

| Type | Examples | Requirement |
|---|---|---|
| **Continuous** | sweep depth ATR, stop buffer ATR, displacement threshold | Predeclared neighbourhood; require **≥5 contiguous tested values** whose expectancy sits within 1 SE of the chosen one |
| **Small integer** | reclaim window in bars, consecutive closes | Test **n−2, n−1, n, n+1, n+2** where sensible; neighbours must not collapse |
| **Temporal (minutes)** | cooldown, pool TTL, raid duration | Predeclared grid; require a contiguous stable region spanning **at least a 2× ratio** |
| **Categorical** | session anchor, entry style, HTF combination | Rank stability across **≥3 development sub-windows**; the winner must not depend on one window |
| **Liquidity tiers** | T1–T4 inclusion | Ablate by tier; each retained tier must show incremental value in **≥2 of 3** development sub-windows |

**±25% is not applied blindly** and is withdrawn as a universal rule.

---

## 6. Session definitions — frozen before frequency is measured

**PRIMARY FREQUENCY DENOMINATOR — the CME trade day.** 18:00 ET → 17:00 ET, one
per weekday. The frequency target *"2–3+ legitimate opportunities per session"*
means **2–3+ per CME trade day**. Failure floor: **1.0 per trade day**.

**SECONDARY, reported separately: RTH sub-session** 09:30–16:00 ET.

**TIME-OF-DAY ANALYSIS BUCKETS — diagnostic only, never a frequency denominator:**
Overnight 18:00–02:00 · London 02:00–07:00 · NY premarket 07:00–09:30 · NY open
09:30–10:30 · NY morning 10:30–12:00 · Midday 12:00–14:00 · NY afternoon
14:00–15:00 · Power hour 15:00–16:00 · Post 16:00–18:00.

**These definitions are frozen and may not be changed to flatter a trade count.**
Treating each of the 9 buckets as a "session" would imply 20–27 trades/day and is
explicitly forbidden.

---

## 7. Uncertainty at three dependence scales

Day blocks preserve intraday structure but destroy multi-day regime dependence.
All three are computed and reported for every headline result:

1. **Naive trade-level SE** — reported, never the headline.
2. **Day-cluster** — CR1 cluster-robust SE + 1-day block bootstrap.
3. **Multi-day blocks** — moving-block bootstrap at predeclared lengths
   **{5, 10, 20 trading days}**, plus a stationary bootstrap with mean block
   length 5 days.

**Block lengths are predeclared and fixed. The one producing significance is
never selected.** Headline conclusions respect the **most conservative**
dependence-aware interval among them.

---

## 8. MDE is recomputed from the ingested data

The figures below are **planning estimates from 59 days of NQ 5m only** and are
**not binding**:

> planning estimate: MDE ≈ 0.34R ± 0.02R at n=155 / 48 independent days;
> ~557 trading days (~2 years) to detect +0.10R.

Once genuine NQ data is ingested, MDE is recalculated from that dataset's actual
trade variance, independent-day count, observed clustering, serial dependence,
and the planned α/power — and **reported with its assumptions**. If it differs
materially from the planning estimate, **the estimate is updated, not defended**.

---

## 9. More data is not expected to create an edge

The four-year 5m proxy result — **+0.013R, PF 1.02, 95% band [−0.057, +0.083]**
— stays in the research record. The purpose of genuine multi-year NQ data is
**not** to make that significant. It is to determine whether H1–H6 produce a
reproducible improvement surviving genuine NQ data, transaction costs, parameter
perturbation, regime change, walk-forward, and one untouched holdout.

**If the conclusion is that the 5-minute system has no economically meaningful
edge, that is the reported conclusion.** No optimization until one appears.

---

## 10. Predeclared hypotheses

- **H1** Parameter re-normalisation in three categories — temporal → elapsed
  minutes; structural → normalized by ATR / volatility / completed structural
  events, *not* by wall-clock inheritance from the 1H model; storage → split into
  `POOL_TTL_MINUTES` (economic relevance) and `MAX_ACTIVE_POOLS` (resource cap).
- **H2** Multi-bar manipulation event model — stage timestamps recorded (level
  identified → penetration begins → raid extreme → rejection → reclaim →
  optional displacement). The empirical duration distribution is examined
  **before** any candidate window is declared; only coarse economically
  reasonable ranges follow.
- **H3** Session-anchored PO3 + causal accumulation. Exactly **three** anchors:
  Globex trade-day open, NY midnight, 09:30 cash open. No other start times.
- **H4** Displacement — tested **both** as binary permission filter **and** as a
  continuous contribution to setup quality, with marginal value assessed after
  controlling for sweep quality.
- **H5** Liquidity hierarchy ablated **by tier**: T1 PDH/PDL + overnight
  extremes + major session H/L · T2 opening range + equal highs/lows + major
  confirmed structure · T3 significant dynamic swing liquidity · T4 minor local
  pivots. Pivot **occurrence time** and **confirmation time** are recorded
  separately; only confirmation time is usable.
- **H6** Confirmed HTF context: 5m alone / 5m+15m / 5m+1H / 5m+15m+1H. Only
  fully closed HTF bars. **The 1H result (+0.183R) is treated as a hypothesis,
  not established fact** — it emerged from the ~38-configuration search above and
  has not been validated on untouched data.

New ideas require v2.0 and are testable on development data only.

---

## 11. Failure criteria — declared in advance

REJECT if any of: development expectancy improvement < 0 at headline costs; the
improvement does not survive the **most conservative** bootstrap (CI includes 0);
frequency falls below 1.0/trade-day; the type-appropriate plateau test (§5)
fails; sign disagreement with NDX generalization *and* a development CI including
zero; negative at stressed friction ($24 RT).

**INCONCLUSIVE is permitted and expected.** A failed hypothesis is recorded, not
retried with adjusted thresholds.

---

## 12. NDX status

Secondary falsification set only. Answers one question: *does this behavioural
hypothesis have the same directional effect in another representation of
Nasdaq-100 price action?* Sign agreement is the test; parameter equality is not
required and NDX parameters are never transplanted. **NQ and NDX trades are
never pooled. NDX power is never reported as NQ power.**

## Changelog

- **1.1 — 2026-09-12** — holdout reduced to a single post-freeze use; calendar
  roll fallback corrected and its uncertainty disclosed; costs made
  dollar-explicit ($14 RT headline) and applied per-trade before R conversion;
  warm-up / purge / embargo defined; plateau rule made type-specific; primary
  frequency denominator frozen as the CME trade day; bootstrap extended to three
  dependence scales; MDE demoted to a non-binding planning estimate. No strategy
  result produced during this revision.
- **1.0 — 2026-09-12** — initial freeze.
