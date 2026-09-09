# MMT — Quant Engine

Two Pine Script v6 indicators for CME index futures, each shipped with the
offline research that produced it and with its negative results written down
next to its positive ones.

| indicator | idea | verdict |
|---|---|---|
| [`indicators/po3_vwap_liquidity_sweep.pine`](indicators/po3_vwap_liquidity_sweep.pine) | PO3 (accumulation → manipulation → distribution) + session VWAP + liquidity-pool sweeps | small but real edge on index futures, **1H only**: pooled PF 1.22 over 1,997 trades after costs |
| [`indicators/alpha_predictive_limit_matrix.pine`](indicators/alpha_predictive_limit_matrix.pine) | liquidity-sweep rejection blocks with limit entries | earlier work; MNQ 1H only, PF 1.35 |

---

# PO3 · VWAP · Liquidity Sweep Engine

**File:** `indicators/po3_vwap_liquidity_sweep.pine` · **Instrument:** MNQ1!/NQ1!
(validated on MNQ, NQ, ES, YM, RTY) · **Timeframe: 1H.**

## The setup, in one paragraph

Build a map of the liquidity pools price is actually hunting — previous day and
week highs/lows, Asia and London session extremes, the initial balance, and
unswept fractal pivots, with equal highs/lows flagged because clustered stops
are the strongest magnet on the chart. Wait for price to **raid** one of them by
at least 0.35 ATR and then **close back** on the origin side within two bars.
Require that raid extreme to sit beyond the **weekly open**, so the leg reads as
manipulation — the Judas swing — rather than trend. Enter at the close of the
reclaim bar, stop 0.5 ATR beyond the raid extreme, target 3R, stop to breakeven
at +1R. Session VWAP with volume-weighted bands is drawn as fair-value context.

## What the research actually found

Everything below comes from `backtest/`, on Yahoo CME data: 1H series ≈ 2.4
years (13.7k bars) per instrument, shorter sub-hourly series, all with the
trailing partial bar dropped and malformed OHLC rows discarded.

### It works, modestly, on index futures at 1H

Pooled MNQ + NQ + ES + YM + RTY, 1H, **4-tick round-trip costs charged on every
trade**:

| | value |
|---|---|
| closed trades | 1,997 |
| wins / losses / breakeven scratches | 404 / 952 / 641 |
| win rate | **29.8%**, 95% CI **[27.4%, 32.3%]** |
| breakeven win rate at 1:3 | 25.0% |
| profit factor | **1.22** |
| net / expectancy | +217R, **+0.109R per trade** |
| max drawdown | 35R |
| raid extreme *was* the 20-bar extreme | 45% of signals |

The confidence interval's lower bound sits above the breakeven rate, so the
win-rate edge is significant at 95% on this sample. It is still a *small* edge:
a tenth of an R per trade.

### Per market and walk-forward, 1H, cost 4 ticks

| panel | trades | WR% | CI | PF | net R |
|---|---|---|---|---|---|
| MNQ in-sample (first 60%) | 243 | 26.6 | [20.5, 33.8] | 1.07 | +9R |
| **MNQ out-of-sample (last 40%)** | 174 | 35.1 | [26.9, 44.4] | **1.60** | +44R |
| MNQ full | 417 | 30.0 | [24.9, 35.6] | 1.26 | +53R |
| NQ full | 416 | 30.7 | [25.7, 36.3] | 1.31 | +61R |
| ES full | 359 | 27.8 | [22.6, 33.7] | 1.07 | +13R |
| YM full | 407 | 31.7 | [26.5, 37.3] | 1.33 | +64R |
| RTY full | 398 | 28.5 | [23.4, 34.2] | 1.13 | +26R |

Out-of-sample beat in-sample. That is the opposite of what overfitting looks
like, but it also means the in-sample 1.07 and the out-of-sample 1.60 bracket a
true value that this sample cannot pin down — treat ~1.2 as the estimate and the
spread as the honest uncertainty.

### Timeframe is not a free parameter

One parameter set, no per-timeframe tuning, cost 4 ticks:

| TF | MNQ PF | NQ PF | sample | verdict |
|---|---|---|---|---|
| 1m | 0.34 | 0.35 | 7 d | ❌ decisively bad |
| 5m | 1.23 | 1.11 | 60 d | ~ small sample |
| 15m | 0.87 | 0.85 | 60 d | ❌ |
| 30m | 1.11 | 1.16 | 60 d | ~ tiny sample (n≈45) |
| **1H** | **1.26** | **1.31** | 2.4 y | ✅ the only well-evidenced timeframe |
| 4H | 0.98 | 0.90 | 2.4 y | ❌ |

15m being negative between a positive 5m and 30m is the giveaway: below 1H the
samples are 45–160 trades and the sign is noise. **Trade this on 1H.** The
dashboard says so on every other timeframe.

### Time stability — pooled index futures by quartile of each series

| quartile | trades | WR% | PF | net R |
|---|---|---|---|---|
| Q1 | 490 | 28.3 | 1.13 | +32R |
| Q2 | 484 | 26.4 | 1.03 | +8R |
| Q3 | 491 | 34.9 | 1.53 | +120R |
| Q4 | 532 | 29.5 | 1.22 | +56R |

Positive in all four, but more than half the profit lands in Q3. Expect long
flat stretches.

### Cost sensitivity (profit factor, 1H)

| round-trip cost | MNQ | NQ | ES | YM | RTY |
|---|---|---|---|---|---|
| 0 ticks | 1.29 | 1.33 | 1.16 | 1.39 | 1.19 |
| 2 ticks | 1.27 | 1.32 | 1.11 | 1.36 | 1.16 |
| **4 ticks (published)** | **1.26** | **1.31** | **1.07** | **1.33** | **1.13** |
| 8 ticks | 1.24 | 1.29 | 0.99 | 1.27 | 1.07 |
| 16 ticks | 1.20 | 1.25 | 0.85 | 1.16 | 0.97 |

Costs are survivable because 1R is large: a median **385 ticks** on MNQ 1H, so
4 ticks is ~1% of R. That also means the stop is wide — about 96 index points,
$193 per MNQ contract. This is not a scalping model.

## Why I believe the signal, and not just the backtest

**The placebo test.** A stop/target scheme with a breakeven rule can look
profitable on *any* entry in a drifting market. So every real signal was
re-planted at random unrelated bars, keeping its direction, its risk distance in
ATR and byte-identical exit logic (`backtest/control.py`):

| market | real signals | matched random control |
|---|---|---|
| MNQ 1H | PF 1.22, +0.103R | PF 0.95, −0.026R |
| NQ 1H | PF 1.23, +0.113R | PF 1.05, +0.026R |
| ES 1H | PF 1.12, +0.060R | PF 1.04, +0.019R |
| YM 1H | PF 1.27, +0.132R | PF 0.90, −0.051R |
| RTY 1H | PF 1.24, +0.116R | PF 1.06, +0.030R |

The signal beats its own control on all five. The entries are doing the work,
not the management.

## What did NOT work — the negative results

These cost as much effort as the positive ones and matter more.

**Catching the bottom tick with a limit does not work.** The intuitive version
of this idea — rest a limit inside the sweep wick to get filled at the extreme —
was the *worst* option tested, on every market (`entry_mode` in
`backtest/cross_scan.py`): market-on-reclaim PF 1.19 pooled, limit-at-the-swept-
level 1.01, limit-at-the-wick-midpoint 1.00, and on the first candidate the wick
limit scored 0/4 markets positive. The reason is adverse selection: the limit
only fills when price comes back, and price mostly comes back when the reversal
is failing. Both wick modes still ship, clearly labelled, so the dashboard can
be watched degrading.

**Tight stops on the swept extreme do not work.** A dedicated test
(`backtest/study_geometry.py`) put the model's own stop just beyond every raid
extreme and compared it against a matched random stop at the same ATR distance:
30.7% vs 30.6% at 1:2. **The swept extreme holds no better than an arbitrary
level.** Stop buffers below 0.35 ATR degrade results monotonically.

**All three VWAP filter roles failed.** Tested on four instruments that took no
part in tuning: the stretch gate (raid must be N σ from VWAP) was neutral to
harmful, VWAP-reclaim confirmation scored 1/4 markets positive, and targeting
VWAP instead of a fixed R was the single worst change tested — 0/4 markets
positive, pooled PF 0.75. The edge here is continuation after the reclaim, not
reversion to fair value. VWAP is drawn because it is useful context; all three
filters ship **off**, and the reason is in the script header.

**A VWAP σ band is not a Gaussian σ.** 16.5% of MNQ 1H bars close beyond ±2σ of
session VWAP where normal theory says 5%, and the median |z| is 1.24 against a
Gaussian 0.67. "2σ" is not a rare event on a VWAP band. Any threshold picked
from normal-distribution intuition will be far looser than intended.

**It does not generalise beyond equity indices.** Same settings, cost 4 ticks,
on markets that selected nothing:

| CL | GC | SI | NG | 6E | ZN | BTC | ETH |
|---|---|---|---|---|---|---|---|
| 1.08 | 0.84 | 1.05 | 1.03 | 0.81 | 0.69 | 1.16 | 0.93 |

Rates (ZN 0.69) and FX (6E 0.81) are notably bad. This is an equity-index-
futures model; treat anything else as untested.

**The PO3 open gate is worth about 0.05 PF.** With the weekly open it improves
the held-out pool from 1.14 to 1.21 — real, but it is a refinement on top of
"deep sweep, reclaimed", which is where the edge actually lives. Requiring the
close to reclaim the open as well looked superb on the tuning market (PF 1.73)
and evaporated on the holdout (1.03). It ships off.

**A session filter looked like the best find of the study and was a mirage.**
Restricting to the NY AM killzone scored PF 1.78 on MNQ and 0.99 with 1/4
markets positive on the four held-back instruments. Sessions are off.

## How the parameters were chosen (the anti-overfitting protocol)

1. **Structural constants are conventional, not fitted**: pivot half-width 5,
   ATR 14, initial balance 60 minutes, equal-level tolerance 0.10 ATR.
2. **Every threshold is in ATR or VWAP-σ units**, so one parameter set is
   meaningful across instruments and timeframes.
3. **The raw effect was measured before anything was fitted**
   (`backtest/study_po3.py`): a symmetric double-barrier test against the
   instrument's own baseline drift, with Wilson intervals. The first, naive
   formulation *failed* this test — 46.6% vs a 48.5% baseline — which is what
   redirected the work toward sweep depth and away from wick limits.
4. **One axis at a time from a baseline, never a global grid argmax**
   (`backtest/scan.py`). A parameter is only adopted where its neighbours agree
   — a plateau, not a spike.
5. **Every choice is corroborated on four instruments that never selected it**
   (`backtest/cross_scan.py`). Where MNQ and the holdout pool disagreed, the
   holdout won. This is what caught the NY-AM session trap.
6. **Values are taken from plateau middles**, not argmaxes: the stop buffer is
   flat from 0.35 to 0.75 ATR on the holdout, so it ships at 0.50.
7. **MNQ's out-of-sample window is scored only at the end.** After the first
   corroboration round the scan was fixed to score MNQ on its in-sample 60%
   only. *Disclosure:* the first round did read MNQ full-sample PF for a coarse
   axis sweep, so that window is not perfectly virgin. The cross-asset holdout
   and the placebo test are untouched by any selection.
8. **Only two coordinate-ascent rounds were run**, then parameters were locked.

## Verification: the indicator is the engine

`backtest/verify_pine_parity.py` re-expresses the **Pine file's** control flow —
read block by block out of the `.pine`, not copied from the engine — and diffs
it against the research engine signal by signal.

```
MNQ_1h 418/418   NQ_1h 417/417   ES_1h 360/360   YM_1h 407/407  RTY_1h 402/402
MNQ 1m 75  5m 159  15m 65  30m 45  4h 194   — all exact
2,242 signals: 0 extra, 0 missing, 0 mismatched entry/stop/target
```

It also asserts that the constants the Pine ships in its validated preset are
exactly the parameters that were tested, so the indicator cannot faithfully
reproduce a configuration nobody validated.

**Two real bugs were caught by this test rather than by review**, both fixed:

- *Session ranges merged across holiday gaps.* The Pine seeded each session's
  range off "was the previous bar in this window". On NQ, a Sunday-23:00 bar and
  the Tuesday-00:00 bar after a holiday are both inside the 18:00–02:00 Asia
  window but belong to different trade days, so two days' Asia ranges merged and
  a signal was lost. The session block now keys off minutes-since-18:00-ET and
  resets per trade day, exactly as the engine does.
- *Pivot pruning evicted live levels.* When the pool cap was hit, swept pivots
  held slots and pushed out older *unswept* ones, silently dropping the signals
  those would have produced.

## Reproducing

```bash
python3 backtest/fetch_yahoo.py data_po3 MNQ=F      # and NQ=F, ES=F, YM=F, RTY=F
python3 backtest/study_po3.py       data_po3 MNQ    # is there a raw effect at all?
python3 backtest/study_geometry.py  data_po3 MNQ_1h # does the swept extreme hold?
python3 backtest/scan.py            data_po3 MNQ_1h # one axis at a time
python3 backtest/cross_scan.py      data_po3 4 1h   # corroborate on held-out markets
python3 backtest/evaluate.py        data_po3 4      # final panels
python3 backtest/control.py         data_po3 MNQ_1h,NQ_1h,ES_1h,YM_1h,RTY_1h
python3 backtest/verify_pine_parity.py data_po3 MNQ_1h,NQ_1h,ES_1h
```

## Using it on TradingView

Load on **MNQ1! or NQ1!, 1-hour**, keep the `Index Futures 1H — validated`
preset. The dashboard grades its own signals live, with the win rate always
shown against the breakeven rate for the chosen R:R, and charges the round-trip
cost you set (4 ticks by default) against every closed trade — so its net R is
comparable with the tables above.

A single chart shows one instrument on one timeframe, so its numbers will be
noisier than the pooled figures here; a few dozen trades cannot distinguish PF
1.2 from PF 0.9.

**No repainting.** There is no `request.security()` call in the script; every
level is built from closed chart bars, fractal pivots only become visible five
bars after the fact, and session levels only become pools once the session has
closed. Signals commit on bar close.

## Honest limitations

- The edge is ~0.11R per trade. Position sizing, discipline and cost control
  matter more than the signal does.
- It is an indicator-side simulation, not a `strategy()`: no position sizing, no
  margin, no partial fills, one unit per trade.
- Intrabar path is unknowable from OHLC, so every ambiguity is resolved against
  the strategy: the stop wins same-bar ties, the target is never credited on the
  entry bar, and breakeven is armed only after that bar's exit checks.
- 2.4 years of 1H data per instrument, and the five index futures are highly
  correlated — 1,997 pooled trades are fewer independent observations than they
  look.
- Sub-hourly conclusions rest on 7–60 day samples. "No evidence of an edge" is
  not the same as "proof there is none", except at 1m where the result is
  emphatic.
- Yahoo continuous front-month data is not tick-accurate CME data and has no
  roll adjustment.

---

# Alpha Predictive Limit Matrix (earlier work)

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
