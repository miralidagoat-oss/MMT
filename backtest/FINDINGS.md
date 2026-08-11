# MNQ 5-minute: 220,699,136 strategies, and what actually survived

Full study of the MNQ 5-minute timeframe. Every number below is reproducible
from the scripts in this directory.

---

## TL;DR

1. **220,699,136 complete strategies** were evaluated on **7.6 years** of true
   5-minute Nasdaq-100 data (518,308 bars, 2019-01-02 → 2026-08-10).
2. **The best of them is not statistically distinguishable from noise.** Re-run
   the identical search on random triggers and the winners score just as high.
   At every mining depth the p-value is ≥ 0.14.
3. **The reason is structural, not a tuning failure.** Gross of costs, these
   setups have no edge — at 5m they are *significantly worse than entering at
   random* (t = −6.97). Then an MNQ round turn takes ~12% of a 5-minute ATR.
4. **One configuration did survive every robustness check**, at modest size:
   an expansion-regime long breakout, **PF 1.19, WR 48.4%, 319 trades/year**,
   profitable in all 8 calendar years and on held-out MNQ/NQ futures. Its
   excess over random entry is t = +2.84, which is significant for a single
   idea but **below the t = 6.20 bar** a 220.7M search demands. It ships as
   `indicators/mnq_expansion_breakout.pine` labelled exactly that way.

---

## 1. Data

Free futures feeds cap 5-minute history at 60 days — one volatility regime, far
too little to search a large space against. Instead the research set is
Dukascopy's Nasdaq-100 cash-index CFD (`USATECHIDXUSD`), rebuilt from raw tick
data into 5-minute bars.

| | |
|---|---|
| Bars | 518,308 (5m) |
| Span | 2019-01-02 → 2026-08-10 (7.6 years) |
| Source | Dukascopy tick data, 48,752 hourly files, 0.4% of hours missing |
| **Correlation vs MNQ** | **0.9834** on 5m log returns, beta 0.987 |

Regimes covered: 2019 +37%, 2020 +47% (COVID crash and recovery), 2021 +27%,
**2022 −33% (bear)**, 2023 +53%, 2024 +25%, 2025 +20%, 2026 +17%.

True MNQ and NQ 5-minute futures data (13,745 bars each, 70 days) was **never
used for search or selection** — held back purely to confirm the finalist.

## 2. The search

A strategy is `trigger × filter set × exit × direction`:

* **98 triggers** — liquidity sweeps, Donchian breakouts, failed breakouts,
  opening-range breaks and fades, VWAP reversion/reclaim, EMA pullbacks, RSI
  extremes, Bollinger reversion, compression breaks, prior-day reactions,
  momentum ignition/exhaustion, pin bars, session-extreme reversion.
* **75 filters** — session windows, day of week, trend regime, volatility
  regime, volume, location vs VWAP/prior-day, bar structure, momentum zones.
* **32 exits** — stop 0.5–2.0×ATR, target 1–3R, hold 2h/6h.

98 × 32 × 70,376 filter sets = **220,699,136 strategies**.

Made tractable by simulating each `(trigger, exit)` pair once, then storing
outcomes as **bitsets over trade index**. Any filtered variant's statistics
then reduce to popcounts — `popcount(F & W)`, `popcount(F & L)` — about 600
machine ops instead of millions. Throughput: **56M strategies/second**; the
full sweep runs in ~14 seconds.

**Costs are charged on every trade**: 1.00 index point round turn during RTH
($2.00/contract: ~$0.50/side commission, ~1 tick spread, ~1 tick stop
slippage), 1.75 points overnight where the book is thinner.

## 3. Why the winners are noise

Naive result on 60 days of MNQ: PF **5.72**, WR **67%**. The filter was
"Thursdays only". Running the *entire search* on time-of-day-matched random
triggers produced strategies scoring 13.3–16.3 against the real data's 17.09 —
**p = 0.077**.

On the full 7.6 years, stratified by how much filter mining is allowed:

| filter depth | strategies | observed | null mean (max) | p |
|---|---|---|---|---|
| 0 (no filters) | 3,136 | 4.59 | 4.79 ± 0.99 (6.31) | **0.67** |
| ≤ 1 | 238,336 | 10.78 | 9.40 ± 0.82 (10.99) | 0.14 |
| ≤ 2 | 8,940,736 | 14.11 | 13.99 ± 1.16 (16.43) | 0.43 |
| ≤ 3 | **220,699,136** | 16.27 | 14.92 ± 1.29 (17.06) | 0.19 |

Both curves rise together — mining lifts the *null* just as fast as the
observed best. At depth 0 the real data scores **below** the random-trigger
null. Nothing is significant anywhere.

Corroborating: `corr(train expectancy, validation expectancy)` across
candidates = **−0.19**. Training performance is mildly *anti*-predictive of
out-of-sample performance.

## 4. Why — the mechanism

**Pooled over 909,350 trades from all 98 families:**

| stop | gross exp | net exp | cost as % of R | gross PF | net PF |
|---|---|---|---|---|---|
| 0.5×ATR | −0.086 | −0.591 | **50.5%** | 0.84 | 0.30 |
| 1.0×ATR | −0.020 | −0.272 | 25.3% | 0.96 | 0.57 |
| 2.0×ATR | −0.017 | −0.143 | 12.6% | 0.97 | 0.85 |

Gross PF ≈ 1.00. **These setups are coin flips before costs.** Median 5-minute
ATR is only ~11 points, so a $2 round turn is 13–50% of the risk on every trade.

**The alpha test.** Signals vs random entries, same direction, same exits, zero
costs — any difference is pure signal quality:

| timeframe | signal exp | random exp | alpha | t |
|---|---|---|---|---|
| **5m** | +0.0337 | +0.0460 | **−0.0123** | **−6.97** |
| 15m | +0.0542 | +0.0641 | −0.0099 | −3.16 |
| 1h | +0.0674 | +0.0776 | −0.0102 | −1.60 |
| 4h | +0.1077 | +0.0911 | +0.0166 | +1.33 |

At 5 minutes these classic setups are **significantly worse than random entry**
before paying anything — they systematically fire into adverse selection.

**Timeframe does not rescue it.** Cost/R falls 10× from 5m to 4h and net PF
climbs 0.83 → 0.98, but never crosses 1.0, because gross PF stays ~1.00 at
every timeframe. Higher timeframes are *less bad*, not good.

## 5. What did survive

One configuration passed every check:

> **Long Donchian breakout (12-bar), restricted to volatility expansion.**
> Filters: ATR percentile > 66, |close − VWAP| ≥ 1.5 ATR, price outside the
> prior-day range. Stop 2.5×ATR, target 1.5R, 6-hour time stop, one position
> at a time.

| slice | trades | WR | PF | net R |
|---|---|---|---|---|
| NDX 7.6y | 2,423 | 48.4% | **1.19** | +222.8 |
| 2019 | 316 | 50.6% | 1.28 | +42.3 |
| 2020 | 307 | 47.2% | 1.15 | +23.5 |
| 2021 | 288 | 51.0% | 1.37 | +49.0 |
| **2022 (bear)** | 295 | 45.4% | **1.03** | +4.6 |
| 2023 | 369 | 48.0% | 1.22 | +40.7 |
| 2024 | 339 | 50.4% | 1.23 | +38.0 |
| 2025 | 311 | 48.2% | 1.13 | +19.9 |
| 2026 YTD | 198 | 44.4% | 1.05 | +4.9 |
| **MNQ 70d (held out)** | 47 | 51.1% | **1.17** | +3.6 |
| **NQ 70d (held out)** | 50 | 50.0% | 1.14 | +3.1 |

~319 trades/year, max drawdown 20.4R.

**Why this one is credible:**

* **Filters are monotone and additive**, not a lucky conjunction — the raw
  breakout is PF 0.99, +volatility 1.12, +outside-prior-day 1.29, all three
  1.33 (overlapping basis).
* **Broad parameter plateau, not a spike** — all 25 stop/RR cells ≥ 1.06, and
  lookbacks 12/24/48/96 all give PF 1.33–1.39.
* **Positive in all 8 calendar years**, including the 2022 bear market.
* **Confirmed on two independent instruments** never used in the search.
* Economically coherent: breakouts pay during expansion, bleed during rotation.

**Why it is still not proof:**

* Excess over matched-random entry is **t = +2.84**. Significant for a single
  pre-registered idea (p ≈ 0.005); the selection-corrected bar for a 220.7M
  search is **t = 6.20**. It does not clear it.
* **The short mirror loses** (PF 0.89 vs long 1.33). Part of the return is long
  exposure to an index that rose 365% over the sample.
* Overlapping trades inflate everything. On an overlapping basis this shows PF
  1.33 and 944 trades/year; restricted to one position at a time — the only
  tradeable version — it is PF 1.19 at 319 trades/year. **The 3.4× overlap is
  where most "amazing" 5m backtests come from.**
* 2022 and 2026 are ~breakeven (PF 1.03, 1.05). The edge concentrates in
  trending years.

## 6. Honest expectations

PF ~1.19 at ~48% win rate is a **thin** edge. Round-turn cost is ~12% of R, so
if real slippage is double the modelled 1.0 point, expectancy roughly halves.
The strategy is best read as *"buy confirmed expansion in an index that trends
up"* — it monetises upside volatility expansion and treads water otherwise.

## Reproducing

```bash
pip install numpy pandas numba scipy requests
python3 fetch_dukascopy.py ./cache ./data/NDX_5m.csv 2019-01-01 2026-08-11
python3 fetch_yahoo.py ./data MNQ=F && python3 fetch_yahoo.py ./data NQ=F
python3 run_study.py data/NDX_5m.csv data/MNQ_5m.csv data/NQ_5m.csv out
python3 tf_study.py data/NDX_5m.csv out/tf.json
```

| file | role |
|---|---|
| `fetch_dukascopy.py` | tick download → 5m bars, resumable |
| `qlib.py` | indicators, numba simulation kernels, bitset machinery |
| `features.py` | the 98 triggers and 75 filters |
| `search.py` | the 220.7M-strategy sweep |
| `validate.py` | permutation null, deflated Sharpe, walk-forward, bootstrap |
| `run_study.py` | full pipeline |
| `tf_study.py` | cost-barrier study across timeframes |
