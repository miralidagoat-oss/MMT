# NQ 5-minute research protocol — FROZEN 2026-09-12

Version 1.0. Declared **before** the multi-year NQ dataset exists. Its purpose is
to stop the experiment being silently redefined each time a result disappoints.
Any change requires a new version number, a dated entry in the changelog below,
and an explicit statement of what had already been seen at the time.

## 0. Research history carried forward (not reset)

| Category | Count already examined |
|---|---|
| 5m configurations tested | ~38 (18 repair attempts, 14 ablation variants, 6 frontier variants) |
| Model architectures | 1 |
| Session variants | 4 |
| Exit variants | ~12 (breakeven grid) |
| Timeframes surveyed | 7 |

**This count does not reset when new data arrives.** Every future result is
reported against this prior search history.

## 1. Instrument, timeframe, objective

- **Market:** CME NQ, individual contracts, raw prices, roll per `ROLL_POLICY.md`
- **Execution timeframe:** 5-minute, aggregated deterministically from 1-minute
- **Primary metric:** expectancy in R per trade, with a **day-block-bootstrap**
  95% CI (days are the independent unit — see §3)
- **Secondary:** PF, win rate, trades/session, max drawdown in R, day-level
  statistics, long/short split, session split
- **Minimum acceptable frequency:** 1.0 trade per defined session. Below this the
  candidate is rejected regardless of expectancy.
- **Frequency objective:** 2–3+ per session, pursued via a Pareto frontier, never
  by loosening filters to hit a count.

## 2. Predeclared hypotheses

H1 Temporal/structural/storage parameter re-normalisation (3 categories, §9 of brief)
H2 Multi-bar manipulation event model (distribution examined before any window chosen)
H3 Session-anchored PO3 + causal accumulation detection (3 anchors only: Globex open, NY midnight, 09:30 cash)
H4 Displacement — tested as binary filter AND as continuous score component
H5 Liquidity hierarchy, ablated by tier (T1 PDH/PDL+overnight, T2 opening range+equal highs, T3 confirmed swings, T4 local pivots)
H6 Confirmed HTF context (5m / 5m+15m / 5m+1H / 5m+15m+1H)

**No hypothesis outside this list may be tested on the holdout.** New ideas go
into version 2.0 and are tested only on development data.

## 3. Dependence and inference

Trades on the same session are **not** independent. Measured on the 59-day NQ 5m
sample: 40% of trades overlap another in time, lag-1 autocorrelation +0.10,
daily long/short correlation +0.21, intracluster correlation by trade day −0.11.

**All confidence intervals use a block bootstrap resampling whole trading days**,
which preserves within-day structure whatever its sign. Trade-level SE may be
reported alongside but never as the headline.

## 4. Data partitions (chronological, never shuffled)

Assuming ≥5 years of NQ 1-minute data:

| Partition | Share | Use |
|---|---|---|
| Development | earliest 50% | debugging, hypothesis formation, free exploration |
| Validation | next 25% | selecting among predeclared variants only |
| **Final holdout** | latest 25% | **viewed once, after architecture is frozen** |

Plus rolling walk-forward: 12-month train → 3-month forward test, stepped 3
months, across the development+validation span only.

**The existing 59-day NQ 5m sample is labelled `recent-regime development
evidence`. It is NOT a holdout** — the shipped configuration has already been run
on it with a 60/40 split, long/short split and a 9-bucket session breakdown.

## 5. Costs (fixed now, not tuned later)

| Scenario | Commission+fees | Slippage |
|---|---|---|
| Optimistic | $2.50 round turn | 0 ticks |
| **Realistic (headline)** | **$4.00 round turn** | **1 tick each side** |
| Stressed | $4.00 round turn | 2 ticks each side |

Every headline result is reported at *realistic*. A candidate that is
unprofitable at *stressed* is flagged as cost-fragile regardless of its
headline.

## 6. Failure criteria — declared in advance

A hypothesis is **REJECTED** if any of:
- development expectancy improvement < 0 at realistic costs
- the improvement does not survive the day-block bootstrap (CI includes 0)
- trade frequency falls below 1.0/session
- the parameter's neighbours collapse (no plateau ≥ ±25% of the chosen value)
- sign disagreement with the NDX generalization check *and* a development CI
  that includes zero
- it is cost-fragile (negative at stressed slippage)

**INCONCLUSIVE** is a permitted and expected outcome. A failed hypothesis is
recorded, not retried with adjusted thresholds.

## 7. NDX status

NDX 5m is a **separate, secondary falsification set**. It answers only: "does
this behavioural hypothesis have the same directional effect in another
representation of Nasdaq-100 price action?" Sign agreement is the test.
Parameter equality is not required and NDX parameters are never transplanted.
**NQ and NDX trades are never pooled. NDX power is never reported as NQ power.**

## Changelog

- **1.0 — 2026-09-12** — initial freeze. Written before the multi-year NQ dataset
  was obtained; no multi-year NQ result had been seen by any author.
