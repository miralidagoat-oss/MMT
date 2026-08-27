# Pre-registration — 2023-2025 out-of-sample test

**Written BEFORE the test was run. Committed so the thresholds cannot be revised
after seeing the result.**

## What is being tested

The ON-range breakout strategy with the user's tuned parameters:

| Parameter | Value |
|---|---|
| ATR length | 19 |
| Stop | 1.25 × ATR |
| Target | 0.393 × stop |
| Breakout margin | 0 |
| Cooldown | 8 bars |
| Max hold | 47 bars |
| Gap guard | 1.5 × ATR |
| Session | ON range 18:00→09:30 ET, flat 16:45 ET |
| Size | 2 micros |

These were tuned on **Aug 2026** data (PF 1.756, WR 79.73%, n=74). 2023-2025 is
therefore genuine out-of-sample — the parameters have never seen it.

## Why a threshold is needed

At a 0.393 payoff the **mechanical breakeven win rate is 71.8%**. A high win
rate is guaranteed by the bet shape and proves nothing on its own. Profit factor
must be judged against what chance produces at the same trade count.

Null distribution measured by Monte-Carlo random entries with identical brackets
on real MNQ 5m data:

| n | null PF p95 | null PF p99 |
|---|---|---|
| 42 | 1.798 | 3.439 |
| 90 | 1.523 | 1.776 |
| 182 | 1.354 | 1.518 |
| 338 | 1.180 | 1.280 |
| 515 | 1.147 | 1.213 |

Fit: **PF p95 ≈ 1 + 4.78/√n**, **PF p99 ≈ 1 + 7.00/√n**

## Pre-registered thresholds

Expected trade count for 2023-2025 (≈750 trading days at 4.1-5.4 trades/day):
**3,000-4,000 closed trades.**

| Trades | PF must beat (p95) | (p99) |
|---|---|---|
| 750 | 1.175 | 1.256 |
| 1,500 | 1.123 | 1.181 |
| 3,000 | 1.087 | 1.128 |
| **3,800** | **1.078** | **1.114** |

## Decision rule — fixed in advance

| Result at ~3,800 trades | Conclusion |
|---|---|
| **PF ≥ 1.25** | Edge very likely real. Prior estimate of 25-40% rises substantially. |
| **PF 1.11 – 1.25** | Real but modest edge. Tradeable at conservative size. |
| **PF 1.08 – 1.11** | Marginal. Beats chance nominally; thin margin over costs. |
| **PF < 1.08** | Inside noise. The Aug 2026 result was luck. Do not fund. |
| **PF < 1.00** | Losing strategy. Reject outright. |

**Additional mandatory checks — a good pooled PF does not pass on its own:**

1. **Per-year PF for 2023, 2024, 2025 separately.** If one year carries the
   result while the others sit near or below 1.0, this is regime-dependent,
   not an edge.
2. **Win rate must exceed 71.8%.** Below that it loses money regardless of
   how the PF prints.
3. **Trade count must be 3,000-4,000.** Far fewer means the window did not
   actually cover the period, and the test is not what it appears to be.
4. **Long vs short split.** Both sides should be positive; if the whole result
   is one direction, half the logic is dead weight.

## Standing caveat

The same rule tested on 612 trading days of MNQ **1h** data returns PF 0.85.
A strong 5m result would not erase that, but it would suggest the effect is
genuinely timeframe-specific rather than absent.
