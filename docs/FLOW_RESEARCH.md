# Options flow & order flow for MNQ — data survey, indicator, and backtest

This document covers the free options-flow and order-flow data that exists, which
of it can actually reach a TradingView chart, and what 15 years of Nasdaq-100
data says when you build the obvious strategies on top of it.

The headline is a negative result, and it is the most valuable thing here:
**none of the classic intraday order-flow setups beat a random-signal baseline
on this data.** Details and caveats below.

---

## 1. The free data landscape

### 1a. Options flow

| Source | What you get | Free? | Reachable from Pine? |
|---|---|---|---|
| `CBOE:VIX`, `VIX9D`, `VIX3M`, `VIX6M`, `VIX1Y` | Implied-vol term structure | Yes on TradingView (CBOE index feed) | **Yes** — `request.security()` |
| `CBOE:VVIX` | Vol-of-vol | Yes | **Yes** |
| `CBOE:SKEW` | Tail-risk / OTM put demand | Yes | **Yes** |
| `CBOE:VXN` | **Nasdaq-100** implied vol — the correct vol index for MNQ | Yes | **Yes** |
| `CBOE:PCC` / `PCCE` / `USI:PC*` | Put/call ratios (total, equity, index) | Varies by plan | Usually |
| `CBOE:VX1!`, `VX2!` | VIX futures term structure / carry | Delayed free | Yes |
| cdn.cboe.com CSVs | Daily volume + put/call archives back to 2003 | Yes | No — Pine cannot make HTTP calls |
| CBOE delayed quotes JSON | Full chains, OI, greeks, 15-min delayed | Yes | No |
| SpotGamma / GEXfocus / FlashAlpha / OptionsGEX | GEX, gamma flip, call/put walls, 0DTE flow | Freemium | No |

**The hard constraint that governs everything:** Pine Script has no HTTP client.
It can only read symbols that exist on TradingView. So "options flow" inside an
indicator means the CBOE volatility complex and put/call ratio symbols — not
gamma exposure, not dealer positioning, not the chain. Any TradingView script
claiming live GEX is either using a hand-maintained input table or making it up.

**Working around it honestly:** true GEX is unavailable, but its *observable
consequences* are measurable on the chart itself:

- **Variance risk premium** `VRP = VIX − realized vol`. Measured at **+4.24 vol
  points** on average across the 15-year sample, which matches the published
  variance-risk-premium literature — a good validation that the computation is
  right.
- **Variance ratio** (Lo–MacKinlay) `Var(k-bar) / (k · Var(1-bar))`. Below 1 the
  tape mean-reverts (consistent with dealers long gamma); above 1 it trends
  (short gamma). Measured mean **0.966** over the sample — the index is mildly
  mean-reverting on average, consistent with dealers usually being long gamma.

### 1b. Order flow

| Source | What you get | Free? | Reachable from Pine? |
|---|---|---|---|
| `request.security_lower_tf()` | Intrabar OHLCV → delta, CVD, imbalance | Yes | **Yes** — this is the real one |
| `ta.requestVolumeDelta()` | Built-in CVD helper | Yes | Yes |
| TradingView up/down volume from 1-second data | Finer classification | Premium plans | Yes, plan-gated |
| CME MBO / MBP-10 (Databento etc.) | True book, real footprint | **No** — paid | No |
| Bookmap / Sierra / Jigsaw | DOM, tape, iceberg detection | Paid | No |

Genuine limitation worth stating plainly: real order flow means trades classified
against the bid/ask from tick data. What Pine gives you — and what this backtest
used — is *lower-timeframe bar direction* as a proxy. It is the best free
approximation, and it is not the same thing.

---

## 2. Data actually used for the backtest

Network egress in the build environment blocked every market-data host
(cboe.com, Yahoo, FRED, Stooq, Nasdaq). Public GitHub reads were permitted, so:

- **NAS100 1-minute OHLCV, 2005-01 → 2020-05** — 4,283,343 bars, from
  [FutureSharks/financial-data](https://github.com/FutureSharks/financial-data)
  (Oanda). The Nasdaq-100 is the index MNQ/NQ track.
- **VIX daily OHLC, 1990 → 2026** — from
  [datasets/finance-vix](https://github.com/datasets/finance-vix) (CBOE).

Timestamps were verified as UTC empirically, by confirming the tick-volume
profile peaks at the US cash open rather than by trusting the file format.

**What this data is not:** it is not CME futures data. Volume is Oanda tick
volume (count of price updates), not contract volume. And the sample ends in
May 2020, so it contains **no 0DTE era** — the gamma dynamics of 2022+ are
entirely untested here.

---

## 3. Method

- **Splits:** train 2005–2014, validation 2015–2017, **test 2018–2020 held back
  and untouched** until the final run.
- **Fills:** signal on a confirmed bar, entry at the **next bar's open**. Stop
  wins any bar where stop and target both print. Time stop books at the close.
- **Costs:** 0.75 index points round trip (≈1 tick spread + commission), charged
  in *points* not percent — an MNQ tick is 0.25pt regardless of index level, so
  the same cost was ~5bp of notional in 2005 and under 0.4bp today.
- **Lookahead control:** VIX and realized vol are lagged one full session, so a
  bar inside session *T* only sees data through *T−1*.
- **Engine validation:** a random-signal control and a perfect-foresight control
  were run to establish the neutral baseline and confirm the engine can detect
  real edge. Random → PF 0.826 ± 0.060 with costs (1.051 without). Oracle → PF
  2.59. **Any strategy scoring near 0.83 has no information.**

---

## 4. Results

### 4a. Intraday order-flow strategies — all fail

Profit factor, stop 1.0 ATR / target 2.0 ATR, costs charged. Random baseline
with costs = **0.826**.

| TF | strategy | train PF | val PF | TEST PF | TEST n |
|---|---|---|---|---|---|
| 5min | vwap_reversion | 0.654 | 0.785 | 0.862 | 1,368 |
| 5min | vwap_reversion_flow | 0.661 | 0.826 | 0.860 | 552 |
| 5min | sweep_fade | 0.681 | 0.769 | 0.820 | 2,962 |
| 5min | sweep_fade_flow | 0.711 | 0.844 | 0.899 | 1,027 |
| 5min | momentum_flow | 0.682 | 0.853 | 0.949 | 2,530 |
| 5min | regime_adaptive | 0.680 | 0.796 | 0.867 | 1,035 |
| 15min | sweep_fade_flow | 0.787 | 1.048 | 0.919 | 366 |
| 15min | momentum_flow | 0.828 | 0.968 | **1.072** | 859 |
| 60min | sweep_fade | 0.870 | 1.036 | 0.759 | 272 |
| 60min | momentum_flow | 0.892 | 0.939 | 0.941 | 59 |
| 60min | regime_adaptive | 0.703 | 0.969 | 0.747 | 72 |

Every column sits at or below the 0.826 random baseline. The two cells above 1.0
in the TEST column (15min momentum_flow 1.072, 15min sweep_fade_flow in val)
are not edges — they flip sign between splits, which is what noise looks like.

**The order-flow confirmation filter is actively harmful.** At every threshold
and horizon tested, adding delta confirmation *reduced* the measured edge:

| setup | gross edge | t-stat |
|---|---|---|
| `\|vwap_z\|>2.0`, 24-bar horizon, no filter | **+1.79 bp** | +2.91 |
| same, plus delta divergence filter | +0.16 bp | +0.13 |

Raw feature spreads (top quintile minus bottom, forward return) were 0.2–0.6 bp
for delta imbalance, delta z-score, relative volume and absorption — all below
the ~1.4 bp round-trip cost. **The information is not there at this resolution.**

### 4b. The one real effect: overnight vs intraday

| split | overnight | t | intraday | t |
|---|---|---|---|---|
| train 2005–2014 | **+3.79 bp/day** | +2.85 | **+0.02 bp/day** | +0.01 |
| val 2015–2017 | +3.70 bp/day | +1.67 | +1.51 bp/day | +0.56 |
| TEST 2018–2020 | +2.96 bp/day | +0.65 | +2.66 bp/day | +0.55 |

Intraday drift on the training decade is **+0.02 bp/day, t = 0.01** — as close to
exactly zero as a financial time series gets. This single number explains why
every intraday strategy above failed: there is no directional premium to harvest
between 09:30 and 16:00. This replicates the well-documented overnight-return
literature (Cliff, Cooper & Gulen).

Note honestly that the *differential* narrows sharply in the test window
(2.96 vs 2.66) — the effect is weaker in recent data.

### 4c. Trading the overnight window, 1 MNQ contract

| split | n | win rate | PF | t | net P&L | max DD |
|---|---|---|---|---|---|---|
| train 2005–2014 | 2,516 | 52.1% | 1.051 | +0.85 | $1,180 | $1,125 |
| val 2015–2017 | 755 | 55.0% | 1.125 | +1.05 | $1,608 | $1,522 |
| **TEST 2018–2020** | 595 | 57.6% | 1.053 | +0.36 | $1,540 | **$5,790** |

Positive in all three splits — but statistically strong in none (no t > 2), and
in the test window **max drawdown ($5,790) was nearly four times the net profit
($1,540)**, courtesy of the COVID crash. This is a marginal effect, not a system.

### 4d. Things that looked good and then died out of sample

Reported because suppressing them would be the whole problem with backtests:

- **VIX-regime gate on the overnight trade.** Train PF 1.17 (t = 1.98), looked
  like the options-flow thesis working. Validation: PF 1.02, **t = 0.14**. Dead.
- **OPEX-Friday intraday short** (the gamma-unwind trade). Train −23.4 bp/day
  (t = −2.91, n = 118), test PF 5.29 — but validation t = −0.12. Inconsistent,
  and n is tiny. Not tradeable on this evidence.

---

## 5. What the indicator ships as

`indicators/mnq_flow_matrix.pine` (Pine v6). Given the above, it is built as a
**regime and flow instrument panel**, not a signal generator:

- Options-flow block: VIX / VIX9D / VIX3M / VVIX / SKEW, term-structure slope,
  variance risk premium, variance-ratio gamma proxy, long/short-gamma call.
- Order-flow block: true intrabar delta via `request.security_lower_tf()`,
  session CVD, imbalance, absorption, relative volume — with a graceful fallback
  when lower-timeframe data is unavailable.
- Structure: session VWAP with sigma bands, liquidity-sweep marks.
- Overnight-drift markers for the one validated effect.
- **A self-grading panel** that runs the same pessimistic fill model on your
  actual chart and shows signals / win rate vs breakeven / PF / expectancy.

The signal engine defaults to **Off**, and the three modes are labelled as
research tools, because on this data none of them beat random. The order-flow
confirmation toggle carries a tooltip saying it tested as a negative. The
grading panel exists so that no one has to take these claims on faith — point it
at your own symbol and timeframe and read the numbers.

---

## 6. Honest limits

1. **Proxy data, not CME.** Oanda tick volume is not exchange volume, and
   bar-direction classification is not bid/ask classification. Real footprint
   data from CME might carry edge this test cannot see. This is a negative
   result about *free* order-flow proxies, not about order flow as a concept.
2. **Sample ends May 2020.** No 0DTE regime, no 2022–2026 data. The gamma
   dynamics most people mean by "options flow" today are untested here.
3. **No true GEX anywhere in this work.** No free historical chain was reachable;
   the gamma read is an inference from price behaviour, not a measurement of
   dealer books.
4. **NAS100 CFD ≠ MNQ futures.** Highly correlated, but basis, roll and session
   structure differ.
5. **No put/call ratio series.** Gist hosting was blocked, CBOE was blocked, so
   this dimension went untested.
6. Single market, single instrument. No cross-validation on ES/RTY/YM.

## 7. Reproduce

```bash
python3 backtest/of/load_data.py      # build parquet from the two public repos
python3 backtest/of/explore.py        # feature-level predictive analysis
python3 backtest/of/explore2.py       # conditional setup scan
python3 backtest/of/explore3.py       # overnight/intraday decomposition
python3 backtest/of/results.py        # the tables above
```
