# MMT v4 Trading Indicator — Backtest Results

> ## ⚠️ RETRACTED — DO NOT TRADE ON THESE NUMBERS
>
> **The figures in this document are wrong.** They were produced by a study
> that hard-coded Eastern Time as a fixed `UTC-4` offset, so the RTH session
> filter was shifted by an hour for roughly five months of every year.
>
> Correcting the timezone removes **33 of the 80 trades** and **72% of the
> reported profit**:
>
> | | Below | Corrected |
> |---|---|---|
> | Trades | 80 | **47** |
> | Profit factor | 1.51 (IS 1.64 / OOS 1.43) | **1.24** |
> | Net R | +18.8R | **+5.3R** |
>
> A full adversarial audit found the corrected edge is **not statistically
> distinguishable from zero** (32.5% probability the true edge is negative;
> p = 0.287 against random entry; 75% of all profit from a single trade).
>
> **See [`AUDIT.md`](AUDIT.md) for the complete analysis.** The content below
> is retained only as a record of what was originally claimed.

## Summary

The **mmt_session_sweep_strategy.pine** script is based on the highest-performing configuration found across 2 years of MNQ/NQ/ES testing. Only the **1-hour timeframe** carries statistical edge; all shorter timeframes (1m, 5m, 15m, 30m) and longer timeframes (4H, daily) fail to recover trading costs out-of-sample.

---

## Walk-Forward Validation (MNQ 1H)

The strategy was validated using walk-forward analysis: in-sample training on the first 60% of data, out-of-sample verification on the untouched final 40%.

| Metric | In-Sample | Out-of-Sample |
|--------|-----------|----------------|
| **Trades** | 51 | 29 |
| **Win Rate** | 29.0% | 26.3% |
| **Profit Factor** | 1.64 | 1.43 |
| **Net R** | +14R | +6R |
| **Expectancy/Trade** | +0.27R | +0.21R |

### Interpretation

- **Robust edge:** OOS profit factor (1.43) only 12.8% below IS (1.64) — strong generalization
- **Conservative win rate:** 26% winners = mean-reversion strategy, not trend-following
- **Positive expectancy:** Every 5 trades generate ~+1R profit, enough to survive 6-loss streaks
- **Sample size:** 29 OOS trades is statistically meaningful; edge is not noise

---

## Cross-Validation on NQ (2 Years, Full Sample)

Tested the same engine parameters on the microquant (NQ) over the full 2-year period without walk-forward split:

| Metric | Result |
|--------|--------|
| **Trades** | 81 |
| **Win Rate** | 23.9% |
| **Profit Factor** | 1.26 |
| **Net R** | +9R |
| **Avg Trade** | +0.11R |

This validates that the edge is consistent across ticker and holds on 2× sample size.

---

## Rejected Timeframes (Sub-Hourly)

All shorter timeframes were tested with identical engine parameters. **None** generated positive edge after trading costs:

### 1-Minute Bars (7 days data)
| Metric | Value |
|--------|-------|
| **Trades** | 55 |
| **Win Rate** | 34.5% |
| **Profit Factor** | 0.89 |
| **Net R** | **-5R** |
| **Status** | ❌ Failed — costs kill the edge |

### 5-Minute Bars (60 days)
| Metric | Sweep Engine | ORB Config |
|--------|-------------|-----------|
| **Trades** | 49 | — |
| **Win Rate** | — | 36.1% |
| **Profit Factor (IS)** | 1.00 | 1.40 |
| **Profit Factor (OOS)** | — | **0.40** |
| **Net R** | **Breakeven** | **-6R OOS** |
| **Status** | ❌ Failure | ❌ Overfitting disaster |

*Note: Opening Range Breakout configuration collapsed 71% from IS to OOS.*

### 15-Minute Bars (60 days)
| Metric | Value |
|--------|-------|
| **Trades** | 24 |
| **Profit Factor** | 0.80 |
| **Net R** | **-4R** |
| **Status** | ❌ Failed |

### 30-Minute Bars (60 days)
| Metric | Value |
|--------|-------|
| **Trades** | 16 |
| **Win Rate** | 43.8% |
| **Profit Factor** | 0.57 |
| **Net R** | **-6R** |
| **Status** | ❌ Failed — sign flips between configs |

### 4-Hour Bars (2 years)
| Metric | Value |
|--------|-------|
| **Trades** | 13 |
| **Profit Factor** | 0.33 |
| **Net R** | **-8R** |
| **Status** | ❌ Worst performer — too few signals |

---

## Risk Analysis (2-Year MNQ Sample)

### Per-Trade Risk Distribution

| Percentile | Risk ($USD per MNQ contract) |
|-----------|---------------------------|
| **Median** | $221 |
| **Mean** | $252 |
| **p75** | $302 |
| **p90** | $382 |
| **Maximum** | ~$1,040 |

Risk varies per bar because stops are computed dynamically using the EWMA volatility engine. Volatile days generate larger risk envelopes.

### Historical Drawdown

- **Maximum Drawdown:** 5–8R (~$1,100–1,800 per contract)
- **Peak drawdown occurred during:** March–April 2024 (post-CPI volatility)
- **Recovery time:** ~6–8 weeks

---

## Account Sizing — $25,000 Base

The script ships configured for a **$25,000 account** (`initial_capital = 25000`,
Account Size input = 25000, Max Risk per Trade = 2%).

### Where $25,000 Puts You

Median trade risk is ~$221 per MNQ contract; mean ~$252. Against $25,000 at
**1 contract**:

| Trade risk | $ per contract | % of $25,000 |
|-----------|----------------|--------------|
| Median | $221 | **0.88%** |
| Mean | $252 | **1.01%** |
| p90 | $382 | **1.53%** |
| Worst observed | ~$1,040 | **4.16%** |

This is a comfortable, professional-grade risk budget. The typical loss costs
under 1% of equity, and even the single worst risk envelope in two years of
data stays inside a survivable 4%. The 2% guard ($500) sits above p90, so it
never blocks a normal setup — it only catches the extreme volatility tail.

### Drawdown in Dollars

Historical maximum drawdown was 5–8R. At 1 contract and mean R ≈ $252:

- **5R ≈ $1,260 → 5.0% of the account**
- **8R ≈ $2,016 → 8.1% of the account**

A six-trade losing streak (the worst in the sample) is roughly a 6% dip. That
is a drawdown you can sit through without changing behaviour, which is the
entire point of sizing at this level.

### Expected Return at $25,000

- **~30 signals/year × +0.21R OOS expectancy × ~$252 mean R ≈ $1,590/year gross**
- **After commissions and slippage: ~$1,200–1,500/year net**
- **≈ 5–6% annual return on the $25,000**

That is the honest number for **1 contract**. The strategy's return scales with
contract count, not with idle equity — the extra capital above the risk
requirement buys drawdown tolerance, not yield.

### When to Add a Second Contract

At 2 contracts the median trade risks $442 (1.8% of $25k) — still fine — but
p90 becomes $764 (3.1%) and the tail hits $2,080 (**8.3% on a single trade**).
That tail is too hot for $25,000.

**Recommendation: stay at 1 contract until equity reaches ~$45,000–50,000**,
where 2 contracts reproduces today's risk profile. If you want to run 2
contracts sooner, enable **Hard-Block Oversized Signals** with the 2% budget —
it will skip roughly half the signals, which is the correct trade-off.

---

## Script Parameters (Validated, Do Not Tune)

These parameters were frozen after achieving 1.64 IS / 1.43 OOS profit factor on 80 trades. Re-tuning on the full dataset will overfit.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Sweep Lookback** | 12 bars | 1H ≈ 5 trading hours; captures session extremes |
| **Max Body/Range** | 0.33 | Rejects high-volume bars; targets price rejection |
| **Min Rejection Wick** | 0.35 | At least 35% of range must extend past extreme |
| **Min Close Position** | 0.70 | Close must be 70%+ away from wick to confirm rejection |
| **Sweep Depth (σ)** | 0.75 | Significant but not extreme liquidation sweep |
| **Range Expansion** | 1.0× 20-bar avg | Volatility screen; rejects quiet bars |
| **Stop Distance (σ)** | 1.5 | Risk envelope; aggressive stop, ~1% of account/trade |
| **Risk:Reward Ratio** | 4:1 | TP = Entry ± 4× Risk |
| **Breakeven Trigger** | +1.0R | Move stop to entry after gaining 1R |
| **Validity (bars)** | 24 | Unfilled orders expire after 24 bars (~24H on 1H chart) |
| **Cooldown (bars)** | 10 | Minimum 10 bars between signals in same direction |
| **Session** | RTH 9:30–16:00 ET | No premarket/afterhours signals; avoids wide overnight gaps |
| **Commission** | $0.80/side | Typical retail broker cost; adjust per your broker |
| **Slippage** | 1 tick | Pessimistic assumption; realistic for limit orders |

---

## Expected Real-World Behavior

### Signal Frequency
- **~2–3 signals per week** during normal market conditions
- **~30 signals per year** on average
- Signals concentrate between 9:30–13:00 ET (morning mean-reversion edge strongest)

### Trade Outcome Distribution

Over 100 trades at scale:
- **~74 trades** scratch at breakeven or are stopped immediately (-0R to -1R)
- **~20 trades** are losses (mean loss: -1R per losing trade)
- **~6 trades** are winners (mean win: +4R per winning trade)

### Return Profile
- **Profitable years:** 2/2 (2023–2024 both positive)
- **Max consecutive losers:** 6 trades (≈ 6% of a $25,000 account at 1 contract)
- **Typical win streak:** 2–3 consecutive winners, then 3–4 losers (no momentum edge)

---

## Why Other Timeframes Failed

1. **Sub-hourly (1m–30m):** Sweep engine designed for session-structural levels (PDH/PDL, overnight extremes, opening range). On 5-minute bars, 12-bar lookback = 60 minutes ≈ one price impulse. Not enough data to distinguish structural rejection from noise. Costs ($1.50 round-trip on MNQ) are too high relative to per-trade edge.

2. **Longer-term (4H–daily):** Signal frequency drops to 1–2 per month. Historical sample (2 years) provides only ~13 4H signals, not enough to estimate true Profit Factor. Also, overnight gaps (London open, news) create slippage risk incompatible with limit orders.

3. **Opening Range Breakout (tested separately):** IS Profit Factor 1.40 collapsed to OOS 0.40 — classic overfitting. The grid search over 720 configurations found a local optimum on the in-sample data that did not generalize.

---

## Conclusion

**mmt_session_sweep_strategy.pine** should be traded **exclusively on the 1-hour MNQ timeframe** with:
- **Account:** $25,000, **1 contract** (median risk 0.88%, worst-case tail 4.2%)
- **Expected annual return:** ~$1,200–1,500 net (**5–6% on $25,000**)
- **Expected max drawdown:** 5–8R ≈ **$1,260–2,016 (5–8% of equity)**
- **Historical win rate:** 26–29%
- **Profit Factor:** 1.43 out-of-sample
- **Scale to 2 contracts at ~$45,000–50,000 equity**, not before

All other timeframes tested showed **negative expectancy after costs** and should not be traded.
