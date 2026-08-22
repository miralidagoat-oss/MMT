# MMT — Quant Engine: Alpha Predictive Limit Matrix

Pine Script v6 indicator that detects liquidity-sweep rejection blocks, posts a
limit entry at the rejection-wick midpoint with an EWMA-volatility stop and a
fixed risk:reward target, then **grades its own historical signals** and shows
the results in an on-chart dashboard.

- **Maintained script:** `indicators/alpha_predictive_limit_matrix.pine` (v2)
- **Original submission:** `indicators/legacy/alpha_predictive_limit_matrix_v1.pine` — kept for reference only

## Audit findings (why v1's "backtest" was fiction)

Three defects made v1 decorative rather than predictive:

1. **The volatility engine was dead.** `logReturn = math.log(close / nz(close, close))`
   is `log(close/close) = 0` on every bar (the intent was `close[1]`). EWMA
   variance of a constant-zero series is zero, so `ewmaVolatility` was always 0
   and every "dynamic volatility stop" sat on the exact wick high/low — the
   single most stop-hunted price on the chart.
2. **Every setup filled itself on its own signal bar.** The mitigation loop ran
   on the bar that created the block, and the entry (wick midpoint) is by
   construction inside that bar's range, so `low <= entry and high >= entry`
   was true immediately. The yellow "limit hit" highlight carried zero
   information.
3. **There was no outcome accounting at all.** Nothing ever checked the take
   profit. Stops only greyed the box (including for orders that were never
   filled, which is not a loss). No win rate, no R tally — there was no
   backtest to evaluate.

Structural issues fixed alongside:

- `max_lines_count` was left at its default of 50 while boxes were capped at
  500, so entry/stop/TP lines silently vanished from all but the ~16 newest
  blocks while their boxes lived on.
- `ta.variance` was called inside a conditional branch (inconsistent-series
  behavior); it is now computed unconditionally and only consumed as the seed.
- The tracking array grew without bound and was re-scanned in full every bar;
  closed setups are now pruned and the managed set is capped (`maxTracked`).
- Setups never expired — a block could "fill" 200 bars after its zone stopped
  being drawn. Unfilled setups now expire after `validityBars`.
- The `optionsDev` input ("Dealer Option Delta Skew Sigma") and the
  `G_FLOW` group were never referenced anywhere. Removed.
- Signals used the live bar's close without `barstate.isconfirmed`, so they
  flickered in and out intrabar. Now gated on confirmed bars.
- Prices were formatted with `"#.#"` (one decimal — useless on FX/crypto);
  now `format.mintick`.
- The stop comment claimed "1.5 ATR" while the code hard-coded `0.2`; the
  multiplier is now an input (`stopSigma`, default 0.5σ).
- Symbols without volume data (many FX/index feeds) produced `na` signals;
  v2 falls back to a structural wick-dominance check.

## v2.1 hardening (flaws found re-auditing v2)

- **Order-flow confirmation read the wrong wick.** v2 confirmed signals with
  the *dominant* wick (`max(topWick, botWick)`), so a bullish low-sweep could
  be "confirmed" by a large upper wick — evidence against the setup. v2.1
  confirms with the rejection-side wick only (lower for longs, upper for
  shorts).
- **Degenerate zero-risk setups.** A signal bar opening exactly on its low
  put the long entry (wick midpoint) at the low itself, collapsing risk to ~0
  and stop/TP onto the entry. A minimum rejection-wick fraction
  (`minWickFrac`, default 25% of range) removes the case and raises signal
  quality.
- **Signals before the vol engine was seeded.** The first `seedLen` bars had
  `na` variance, giving stops with zero volatility buffer. Signals now wait
  for `engineReady`.
- **Correlated signal spam.** Choppy sweeps could fire near-identical setups
  on consecutive bars, padding the stats with pseudo-replicated trades. A
  per-direction cooldown (`cooldownBars`, default 5) suppresses re-fires.
- **Open trades could linger forever / vanish from accounting.** An optional
  time stop (`maxHoldBars`, default off) books open trades at market in
  fractional R; filled trades evicted by the tracking cap are booked the same
  way instead of silently disappearing.
- **Optional EMA regime filter** (`useTrendFilter`, default off): longs only
  above the EMA, shorts only below, for testing trend alignment.
- Dashboard now shows live pending/open counts and time-exit totals; a signal
  alert with full entry/stop/target levels fires alongside the static
  alertconditions.

## v3 — selectivity release, with a real out-of-sample backtest

v3 adds three confluence gates on top of v2.1 — **all** must pass, so only
clean, textbook rejections signal:

- **Close-position gate** (`minClosePos`, 0.7): the signal bar must close in
  the top 30% of its range for longs (bottom 30% for shorts). A sweep that
  closes mid-bar is indecision, not rejection.
- **Sweep-depth gate** (`sweepSigmaIn`, 0.5σ): the raid must run at least
  half an EWMA sigma beyond the prior extreme. One-tick pokes are noise, not
  liquidity grabs.
- **Range-expansion gate** (`rangeExpMult`, 0.8×): the signal bar's range
  must be at least 0.8× its 20-bar average. Micro bars are not visible
  rejections.

Cooldown default rises to 10 bars. The EMA regime filter stays available but
**off** — backtesting showed it hurts everywhere, which makes sense: these
are mean-reversion signals, and demanding trend alignment deletes the good
counter-trend fills.

### Backtest methodology

The exact fill model (same pessimistic rules as below) was ported to Python
(`backtest/backtest.py`) and run on Coinbase spot data: BTC-USD, ETH-USD,
SOL-USD at 1h (4,200 bars ≈ 6 months each) and 6h (2,000 bars ≈ 16 months
each). Parameters were **walk-forward validated** (`backtest/walkforward.py`):
tuned on the first 60% of each 1h series, then evaluated untouched on the
last 40%.

- In-sample (tuning): PF 1.54, 27.8% WR at 1:4, +0.39R/trade
- **Out-of-sample (untouched last 40%): PF 3.20, 44.4% WR at 1:4,
  +1.22R/trade, 36 closed trades**

### Full-sample results, v3 defaults (RR 4, breakeven WR 20%)

| dataset | signals | fills | W | L | WR% | PF | net R | exp R | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| BTC-USD 1h | 30 | 26 | 11 | 15 | 42.3 | 2.93 | +29R | +1.12 | 7R |
| ETH-USD 1h | 29 | 24 | 9 | 15 | 37.5 | 2.40 | +21R | +0.88 | 7R |
| SOL-USD 1h | 33 | 24 | 6 | 18 | 25.0 | 1.33 | +6R | +0.25 | 6R |
| **1h pooled** | **92** | **74** | **26** | **48** | **35.1** | **2.17** | **+56R** | **+0.76** | — |
| BTC-USD 6h | 15 | 14 | 1 | 13 | 7.1 | 0.31 | −9R | −0.64 | 13R |
| ETH-USD 6h | 16 | 12 | 2 | 9 | 18.2 | 0.89 | −1R | −0.09 | 5R |
| SOL-USD 6h | 13 | 11 | 1 | 10 | 9.1 | 0.40 | −6R | −0.55 | 8R |

**The edge is strictly intraday.** On 6h the same logic loses on all three
symbols — swept levels on higher timeframes tend to keep going rather than
mean-revert. The dashboard shows a warning on charts above 2h. Selectivity
is the point: ~1 signal per 130 hourly bars per symbol, ~80% fill rate.

Reproduce: `python3 backtest/fetch_data.py data && python3 backtest/backtest.py data report '{}'`

### MNQ / NQ (Nasdaq futures) validation — v3.1 presets

The crypto-tuned defaults were tested unchanged on CME data (Yahoo Finance:
MNQ=F and NQ=F; 2 years of 1h, 60 days of 5m/15m/30m, 7 days of 1m, 4h
resampled from 1h) and **lost money pooled (PF 0.88)** — parameters do not
transfer across markets. MNQ was then tuned walk-forward on its own 1h
series (first 60% tune, last 40% untouched validation) and cross-validated
on full-size NQ (`backtest/mnq_walkforward.py`). MNQ wants deeper sweeps
(0.75σ), wider stops (1.5σ) and a lighter volume gate (0.8×); those now ship
as the **Index Futures (MNQ/NQ)** preset, the indicator's default. The
Crypto Intraday preset carries the previous defaults; Custom exposes the
manual inputs.

MNQ-preset results by timeframe (RR 4, breakeven WR 20%):

| timeframe | span | trades | WR% | PF | net R | verdict |
|---|---|---|---|---|---|---|
| **1H (MNQ)** | 2 y | 87 | 25.3 | **1.35** | +23R | ✅ tradeable |
| **1H (NQ cross-val)** | 2 y | 89 | 22.5 | **1.16** | +11R | ✅ confirms |
| 1H OOS only (MNQ) | last 40% | 30 | 23.3 | 1.22 | +5R | ✅ holds up |
| 1m | 7 d | 55 | 18.2 | 0.89 | −5R | ❌ |
| 5m | 60 d | 75 | 20.0 | 1.00 | 0R | ❌ breakeven pre-costs |
| 15m | 60 d | 24 | 16.7 | 0.80 | −4R | ❌ |
| 30m | 60 d | 16 | 12.5 | 0.57 | −6R | ❌ (sign flips between configs — noise) |
| 4H | 2 y | 13 | 7.7 | 0.33 | −8R | ❌ worst of all |

A 1:2-RR variant showed the same shape (1H PF 1.38 at 40.8% WR; everything
below 1H negative), so the conclusion is about the timeframe, not the RR
choice. **On MNQ, trade this on 1H only.** The dashboard warns whenever the
MNQ preset is active on a chart outside 45m–2h. Note the sub-hourly series
are short (7–60 days) — treat those verdicts as "no evidence of an edge",
not proof of the opposite; the 4H verdict matches the crypto 6h finding and
is more trustworthy.

### v3.2 — session gating + breakeven management (MNQ study)

A deeper study on MNQ/NQ 1h (`backtest/study_mnq.py`) tested the three levers
that could improve the raw PF-1.35 edge:

- **Direction:** longs PF 1.30 / shorts PF 1.44 on MNQ — both positive on
  both contracts, so both sides stay on.
- **Session:** signals essentially only fire 06:00–16:00 ET (volume gate
  kills Globex); the 09–12 ET open block carries most of the edge (PF 1.37)
  and the few evening signals lose. RTH-only (09:30–16:00 ET) improved OOS
  and cross-val at negligible trade cost.
- **Breakeven stop:** moving the stop to entry once the trade reaches +1R
  was the single biggest improvement — ~40% of former losses become 0R
  scratches. (BE at +1R beat +1.5R and +2R across the grid.)

Final MNQ configuration (RTH + BE@1R), all panels positive:

| panel | trades | W/L/BE | WR (dec.) | PF | net R |
|---|---|---|---|---|---|
| MNQ 1h in-sample (first 60%) | 51 | 9/22/20 | 29.0% | **1.64** | +14R |
| MNQ 1h out-of-sample (last 40%) | 29 | 5/14/10 | 26.3% | **1.43** | +6R |
| NQ 1h full (cross-val) | 81 | 11/35/35 | 23.9% | **1.26** | +9R |

Both rules ship in the MNQ preset (session 09:30–16:00 America/New_York,
BE trigger 1.0R) and are configurable in Custom mode. The crypto preset
keeps sessions off (24/7 market) and BE off (untested there). Scratches are
tracked separately on the dashboard and excluded from the win rate but
included in expectancy.

### Statistical honesty

- 74 pooled closed trades is a modest sample; the OOS PF of 3.20 comes from
  36 trades. The direction of the evidence is good; the point estimates are
  not gospel.
- No fees/slippage. Limit entries earn maker rebates on most venues, so the
  cost drag in R terms is small but not zero — roughly `fee% × (entry/risk)`
  per side.
- Crypto-only validation. Test on your market before trusting it there.
- All three 1h symbols were profitable, but SOL was materially weaker —
  expect dispersion across symbols.

## How v2 grades trades (fill model)

The accounting is deliberately **pessimistic** — OHLC bars don't reveal the
intrabar path, so every ambiguity is resolved against the strategy:

- A limit fills when price trades through it on a bar **after** the signal bar.
- If the fill bar also trades through the stop, the trade books as a loss.
- TP is never credited on the fill bar.
- If stop and TP both print inside one bar, the stop wins.
- Wins book `+RR` R, losses `-1` R, at the posted levels (no slippage/fees).
- Time-stop and eviction exits book at the bar's close in fractional R; they
  count toward expectancy but not toward the TP-vs-stop win rate.

The dashboard shows signals, fill rate, wins/losses, expired setups, win rate
against the breakeven rate for the chosen RR (breakeven = `1/(1+RR)`, i.e.
**20% at 1:4**), net R, and expectancy per closed trade.

## Honest caveats

- This is an indicator-side simulation, not a `strategy()` backtest: no
  commission, slippage, or position sizing. Treat the expectancy line as an
  upper-bound sanity check, not a P&L forecast.
- Setups beyond `maxTracked` are evicted oldest-first (pending ones count as
  expired, filled ones book at market); on very signal-dense charts raise the
  cap or tighten the filters.
- With the time stop off (default), a filled trade runs until TP or stop is
  touched.

---

# MMT ICT / Orderflow Suite (MNQ 5m)

`indicators/mmt_ict_orderflow_suite.pine` — a Pine v6 **indicator** that grades
itself. It carries its own fill simulator, so Profit Factor, Win Rate,
expectancy, average R and max drawdown appear in the on-chart dashboard over
whatever history your plan loads. **No Strategy Tester, no paid plan.**

`backtest/ict_of_backtest.py` — a line-for-line Python port of that Pine file, used
to measure it on real MNQ data offline.

## The trade model

One model, scored — not a pile of unrelated signals:

1. **Liquidity raid.** Price takes out a tracked pool and closes back inside.
   Pools: PDH/PDL and prior-week high/low (RTH-only by default), Asian range,
   opening range, initial balance, prior-day value area, developing VAH/VAL,
   equal highs/lows, confirmed swing pivots, and the running session extreme.
2. **Displacement / MSS.** An expansion candle closes through the last opposing
   short-term structure point, leaving a fair value gap behind it.
3. **PD-array retrace.** A resting limit order in the FVG / order block / OTE
   (0.62–0.79) zone the displacement left behind.
4. **Target.** Fixed R, the nearest opposing liquidity pool, or the pool with a
   minimum-R floor — selectable.

Everything else is a **filter or a score component**: VWAP and its sigma bands,
a developing session volume profile (POC/VAH/VAL, built forward-only from
executed bars), cumulative volume delta from true intrabar data with divergence
detection, the opening range, ICT killzones, HTF and chart trend bias,
premium/discount, relative volume, ATR regime, a news blackout, and daily
trade/loss caps.

Nothing repaints: every decision is taken on a closed bar, higher-timeframe
requests are `lookahead_off` with a `[1]` offset, the profile is forward-only,
and entries are resting limit orders that can first fill on the bar *after* the
signal bar. The protective bracket is submitted together with the entry, so the
stop is live the instant the limit fills.

## What the measurement actually says

**Data available to this study: 13,828 MNQ 5-minute bars — 72 calendar days
(~48 sessions), 2026-06-10 to 2026-08-21.** That is the maximum intraday history
the free Yahoo endpoint serves for a 5-minute series. It is a small sample.

Fill model: limit fills at the limit price only; the stop is live on the fill
bar; market exits (time stop, EOD flat, daily stop) fill at the *next* bar's
open; stop exits pay 2 ticks of slippage; $0.62/contract/side commission. When a
bar contains both the stop and the target the **pessimistic** run books the
stop; the **optimistic** run books the target. The truth is between them.

MNQ 5m, risk-based sizing at $250/trade (pessimistic fills):

| preset    |   n | WR %  |  PF  | avg R | trades/day | 1st-half PF | 2nd-half PF | P(PF>1) |
|-----------|----:|------:|-----:|------:|-----------:|------------:|------------:|--------:|
| Precision |  34 | 52.9  | 1.49 |  0.20 |       0.71 |        1.56 |        1.43 |     85% |
| Balanced  |  63 | 39.7  | 1.10 |  0.05 |       1.23 |        1.05 |        1.15 |     62% |
| Volume    | 167 | 38.3  | 1.11 |  0.07 |       3.25 |        0.99 |        1.27 |     72% |

**These numbers do not survive an honest out-of-sample test.** Running the exact
same settings on six index futures over the same window, normalised to R so
position sizing cannot flatter the result:

| preset    |   n | WR %  |  avg R  |  SE   |   t   | 95% CI          |
|-----------|----:|------:|--------:|------:|------:|-----------------|
| Precision | 208 | 40.9  | −0.026  | 0.087 | −0.30 | [−0.195, +0.144]|
| Balanced  | 325 | 35.7  | −0.022  | 0.078 | −0.28 | [−0.175, +0.132]|
| Volume    | 885 | 35.1  | −0.047  | 0.048 | −0.99 | [−0.142, +0.047]|

Zero. Slightly negative after costs, and statistically indistinguishable from
random in every case.

Three further findings from the study that are worth more than the headline
numbers, because they were stable across the whole parameter space:

- **Breakeven stops hurt, consistently.** Moving the stop to entry at +1R cut PF
  in every configuration tested (Balanced: 1.10 → 0.57). Default is now OFF.
- **Scale-outs hurt slightly** and never improved PF. Default OFF — which also
  keeps the Strategy Tester honest (one entry = one closed trade).
- **Requiring a fair value gap as a hard gate is destructive** (Precision:
  34 trades → 6, PF 1.49 → 0.32). Displacement rarely leaves a clean FVG *and*
  a deep retracement. The FVG is now a score component, never a gate.
- **The killzone filter is the one filter that clearly earns its place**
  (Precision PF 1.49 → 0.89 with it off).

Also measured: the bar-resolution delta estimate (Pine's fallback when intrabar
data is unavailable) agrees in *sign* with true 1-minute delta only 76.6% of the
time, and its magnitudes correlate at r = 0.13. CVD built from the estimate is a
materially different series from the real one.

## How to get a number you can trust

72 days is not enough, and the answer is not the Strategy Tester — the panel
itself is free, but Deep Backtesting and the larger bar limits are not, so a
free plan only loads a few thousand 5-minute bars anyway. Two better routes:

**1. On the chart.** Drop the indicator on MNQ 5m. The dashboard grades every
historical signal the chart has loaded and shows PF, WR, expectancy, avg R and
max drawdown directly. Flip *"When one bar holds both stop and target"* between
the two settings and treat the pair as a range — see below.

**2. Offline, with as much history as you can get.** The backtester needs only
Python 3 (no numpy, no pandas, nothing to install) and downloads its own data on
first run:

```
python3 backtest/ict_of_backtest.py data presets      # the table above
python3 backtest/ict_of_backtest.py data report       # exits, score buckets, hours
python3 backtest/ict_of_backtest.py data final --cfg='{"thresh":9}'
python3 backtest/ict_of_backtest.py data diag         # where signals are discarded
python3 backtest/ict_of_backtest.py data cross        # the out-of-sample check
python3 backtest/ict_of_backtest.py --help
```

Yahoo caps 5-minute history at 60 days, so **export from your broker instead** —
that is how you get years rather than weeks:

```
python3 backtest/ict_of_backtest.py data presets --csv=~/mnq_5m.csv --tz=America/Chicago
```

Column names are matched case-insensitively with the usual broker aliases
(`Date/Time`, `Last`, `Vol`, …), newest-first files are re-sorted, and both unix
timestamps and datetime strings are accepted. `--tz` declares the timezone of
naive timestamps and **matters enormously** — get it wrong and every killzone,
the opening range and the Asian range land on the wrong bars. The loader checks
your data on every run and refuses to stay quiet about it:

```
  data check ok: 300s bars, settlement break at 17:00 ET, heaviest volume at 10:00 ET
```

It keys on the CME settlement halt (17:00–18:00 New York), which is a far
sharper landmark than a volume peak — a five-hour timezone error slides straight
past a volume test but cannot hide the empty hour.

## The intrabar problem, stated plainly

A 5-minute MNQ bar is often wide enough to contain both your stop and your
target. Which one filled first is not in the data — 5-minute OHLC does not
record the tick sequence. So every number here comes as a **range**: the
conservative run books the stop, the optimistic run books the target, and the
dashboard reports what percentage of trades were decided this way
(*"Coin-flip trades %"*). If that figure is high, the backtest is measuring
luck, not the model. It is the reason the ATR-relative minimum stop exists.

## Choosing win rate vs reward:risk

They are not independent — breakeven win rate is `1 / (1 + RR)`:

| target RR | breakeven WR | WR for PF 1.5 | WR for PF 2.0 |
|-----------|-------------:|--------------:|--------------:|
| 1.0 : 1   |       50.0 % |        60.0 % |        66.7 % |
| 1.5 : 1   |       40.0 % |        50.0 % |        57.1 % |
| 2.0 : 1   |       33.3 % |        42.9 % |        50.0 % |
| 3.0 : 1   |       25.0 % |        33.3 % |        40.0 % |

`PF = (WR x RR) / (1 - WR)`. Asking for the highest win rate, the highest profit
factor, the highest RR and the most trades at once is asking for four things that
trade against each other; the presets are three chosen points on that curve.


## The 10,000-configuration search

`backtest/ict_search.py` samples 10,000 random configurations across every
meaningful lever — threshold, the three hard gates, stop placement, entry
depth, target logic, R multiples, ATR stop bounds, breakeven, scale-outs,
pivot/structure/sweep lookbacks, displacement thresholds, zone type, OTE
levels, time stop, RVOL gates, HTF confirm, seven killzone combinations and
long/short-only variants.

The same 10,000 are then run against a **null series**: identical timestamps,
identical volumes, identical volatility and fat tails (σ 0.000895, p99/p50 |r|
= 8.22 on both), but a structureless price path built by permuting bar
returns. Volatility clustering falls from 0.29 to −0.01, so no trend, level or
mean-reversion survives. Whatever score the best of 10,000 reaches there is
what luck alone buys at this sample size.

| percentile | real t | null t | real PF | null PF |
|---|---:|---:|---:|---:|
| 50% | −0.497 | −0.551 | 0.847 | 0.894 |
| 90% | +0.724 | +0.766 | 1.183 | 1.266 |
| 95% | +1.068 | +1.042 | 1.337 | 1.411 |
| 99% | +1.710 | +1.634 | 1.667 | 1.753 |
| max | +3.360 | +2.613 | 2.654 | 2.266 |

Real configurations exceeding the null's 95th percentile: **5.3%** (5.0%
expected under no edge). Exceeding the 99th: **1.1%** (1.0% expected).
Mann-Whitney across the whole distribution: **z = +1.31**, inside the ±1.96
band. And if both samples came from the same distribution, the chance that the
best real configuration beats the best null configuration is **49.9%** — so
"the winner cleared the noise bar" is a coin flip, not evidence.

Correlation between in-sample and out-of-sample t across the 250 leaders:
**+0.144**. Only 19% of them are positive on the five untouched markets. The
in-sample ranking carries essentially no information about the future.

Two harness bugs were found and fixed during this work, both of which had
produced confident wrong answers:

- `prep()` consumes 18 parameters. The harness called it once with defaults
  and reused the result for all 10,000 configurations, silently freezing the
  killzone selection (all seven variants were identical), pivot length, both
  bias EMAs and the HTF timeframe. Caught by re-running the reported winner
  through the ordinary CLI: search said PF 1.16, the rebuild said PF 0.72.
  Every nominated configuration is now re-evaluated from scratch and discarded
  if it does not reproduce.
- `full_picture()` tested `sym in S.DATA` while `S.DATA` is keyed by
  `(market, pivot, killzone)` tuples, so the check never matched and
  out-of-sample silently reported as exactly zero.


## Overfitting audit of the "Max frequency" preset

Run after the preset was added, on the configuration that was added:

**Time-ordered thirds of its own test period.** Not stable — it loses money
across the middle third.

| third | trades | WR | PF | avg R |
|---|---:|---:|---:|---:|
| 1 | 88 | 51.1% | 1.61 | +0.432 |
| 2 | 92 | 32.6% | **0.76** | **−0.162** |
| 3 | 104 | 40.4% | 1.20 | +0.123 |

**Per-market out of sample.** Positive on 2 of 5, and the pooled confidence
interval spans zero.

| market | trades | avg R | t |
|---|---:|---:|---:|
| NQ | 265 | +0.156 | +1.79 |
| MES | 278 | +0.101 | +1.13 |
| ES | 283 | −0.030 | −0.37 |
| YM | 256 | −0.025 | −0.28 |
| RTY | 296 | −0.073 | −0.88 |
| **pooled** | **1378** | **+0.024** | **+0.63**, 95% CI [−0.051, +0.099] |

**Plateau or spike.** 51 single-parameter perturbations: 50 of 51 stay
positive on MNQ, but only **32 of 51** stay positive out of sample. That gap
is itself the overfitting signature — the in-sample surface is flat because
the whole neighbourhood is fitted, while the out-of-sample surface is not.

By comparison the 40-trade Precision configuration is positive on 4 of 5
markets with pooled t = +1.80. Neither is significant; the low-frequency one
is closer.

The preset stays in the dropdown because gathering 120 trades a month beats
gathering 16 a year when the goal is to find out whether anything is real.
Its tooltip now says outright that it is the most overfit setting in the file.

## Statistics moved onto the chart

A profit factor printed on 30 trades is a rumour. The dashboard now carries:

- **Edge t-stat** — average R over its own standard error, labelled
  SIGNIFICANT only at t ≥ 1.96
- **Trades for 95% proof** — `(1.96 × sd / avgR)²`, the sample this edge size
  would need before significance is even possible, next to what you have
- **Closed trades** flags "(too few to judge)" under 30, and profit factor and
  win rate grey out rather than showing an authoritative-looking number

On the 72-day sample: Max frequency reads t = 1.51, needs 476 trades, has 284.
Precision reads t = 1.07, needs 136, has 40.

## Corrected in this pass

- `"If price never retraces → Market"` was not a market order. It set the entry
  to the signal bar's close and still rested a *limit* there, so a long only
  filled if price traded back down to that level. Renamed "Limit at signal
  close" and documented; behaviour unchanged so the measurements still hold.


## A bug that mattered: the coin-flip metric under-counted

The "Coin-flip trades %" row existed to stop the dashboard presenting an
intrabar artifact as a result. It counted only bars holding BOTH the stop and
the target. It missed the larger case: a favourable level touched on the
**fill bar**, where the extreme may have printed before the limit filled.

On a real user configuration (score 10, MSS/FVG off, aggressive fill, tighter
stop, breakeven on, "nearest pool min 1R" target, 33% scale at 0.75R) the row
displayed **0%**. The true rate was **67%** — six of nine trades reversed
outcome between the two intrabar assumptions:

| intrabar rule | WR | PF | avg R |
|---|---:|---:|---:|
| Target first (optimistic) | 88.9% | **9.46** | +1.022 |
| Stop first (conservative) | 22.2% | **0.56** | −0.138 |

Same trades, same signals. The metric built to catch exactly this said the
sample was clean. Now counted correctly, and the row appends
"RESULTS UNRELIABLE" above 30%.

Tight stop + near target + aggressive fill is the combination that produces
it: the entry fills early in a bar that can still reach a 1R target before it
closes. The "Max frequency" preset by contrast runs at **1.4%** ambiguity.

## Getting more trades without diluting the edge

Loosening filters spreads one edge thinner. Running the *same* selective
configuration across genuinely different instruments samples that edge more
times instead. Max frequency preset, per market:

| market | trades | avg R | t |
|---|---:|---:|---:|
| MNQ | 284 | +0.127 | +1.51 |
| MES | 278 | +0.101 | +1.13 |
| **MNQ + MES** | **562** (11.7/day) | **+0.114** | **+1.87** |

Nearly double the trades, per-trade edge essentially unchanged, and the
t-statistic *improves* because the sample grew.

Two warnings. **NQ and MNQ are the same underlying**, as are ES and MES —
trading both is leverage, not diversification, and pooling them overstates
significance. And on that same underlying the two feeds disagree: MES gives
+0.101 while ES gives −0.030. A strategy cannot work on the S&P through one
contract and fail through another; that gap is the noise floor of a 72-day
sample, visible directly.
