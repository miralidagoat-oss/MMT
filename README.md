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

# MM MATRIX — Sponsorship, POI, Inducement

A second, independent script in this repo: an SMC/ICT structure engine that
marks break of structure, builds order-block points of interest from the leg
that broke it, tracks inducement liquidity, flips failed zones to breakers,
and signals on mitigation.

- **Maintained script:** `indicators/mm_matrix.pine` (v2)
- **Strategy build:** `indicators/mm_matrix_strategy.pine` — same detection
  engine, real orders, so the Strategy Tester does the accounting
- **Original submission:** `indicators/legacy/mm_matrix_v1.pine` — reference only

## What the engine does

1. **Structure.** Pivot highs/lows (`sw`) define swings. A close beyond an
   unbroken swing is a **BOS**; the first break against the prevailing trend
   is a **CHoCH**.
2. **Dealing range.** Anchored to the leg origin, not to the two most recent
   pivots. Above the midpoint is **premium** (sell side), below is
   **discount** (buy side).
3. **POI.** On a bearish BOS the engine looks back to the swing high that
   started the leg and takes the *extreme* up candle in that window — the
   origin of the move, not the first opposing candle it trips over. Mirrored
   for demand. The candle must be followed by real **displacement**
   (`dispATR`), and optionally by an unfilled **FVG**.
4. **Inducement.** The minor swing between price and the POI, where breakout
   stops rest. Locked on first assignment and back-checked across the pivot
   confirmation lag. `reqInd` withholds the signal until it is swept.
5. **Mitigation.** Price taps the zone, inducement is done, location and
   higher-timeframe bias agree, the bar closes in the trade's direction, and
   the R:R against the nearest unswept liquidity pool clears `minRR`.
6. **Breaker.** A zone price closes through flips direction once; a broken
   breaker dies.

## Audit findings (why v1 could not be traded)

1. **Instant false BOS in trends — the fatal one.** A pivot confirms `sw` bars
   late, and in a trending leg it confirms *below* the current close. v1 set
   `phLive := true` unconditionally, so `close > lastPH` was already true on
   the confirmation bar: a BOS fired roughly every `sw` bars and the chart
   filled with stacked POIs. v2 arms a level only if `ph > close` when it
   registers.
2. **`ta.highest` / `ta.lowest` called inside `if` blocks** — the same
   conditional-series-function defect documented for `ta.variance` in the
   Alpha Predictive v1 audit above. v2 needs neither call.
3. **The stop was unrelated to the zone.** `sponsor` was the extreme of the
   entire `poiDepth` window (25 bars by default), not the sponsoring candle,
   so every printed R understated real risk by multiples. Stops are now
   anchored to the POI candle.
4. **Both directions could signal on one bar.** The zone loop could set
   `sellSig` and `buySig` in the same pass, and `sigSL`/`sigType` were left
   holding whichever zone the loop touched last — so the risk display could
   pair a sell signal with a long's stop. v2 emits at most one signal per
   bar, the highest-R candidate wins, and the record is a typed object.
5. **`math.abs()` hid targets behind price.** `rew = math.abs(tgt - close)`
   printed a healthy R for a target on the wrong side of entry. Targets are
   now side-validated, and a setup that cannot clear `minRR` does not fire.
6. **No `barstate.isconfirmed`.** `close < open` flips throughout a forming
   bar, so signals, triangles and alerts flickered intrabar and repainted the
   last bar — Alpha Predictive v1 defect #6, repeated. All state mutation is
   now confirmed-bar only.
7. **The POI was not an order block.** "First opposing candle scanning back
   from the BOS bar" normally lands mid-impulse. v2 anchors the search to the
   swing that started the leg and takes the extreme opposing candle in it.
8. **Inducement swept during the confirmation lag could never register.**
   `z.ind` was assigned when the pivot confirmed and only checked forward from
   there, so the common case — price ran the level during those `sw` bars —
   never counted. Now back-checked with `ta.highest(high, sw + 1)`.
9. **`z.ind` was overwritten by every new qualifying pivot,** so the
   requirement drifted bar to bar. Locked on first assignment.
10. **Premium/discount used the two latest pivots,** possibly from different
    legs, so the equilibrium line jittered and `reqPD` gated on noise.
    Replaced with a real dealing range.

Structural issues fixed alongside:

- A bar could satisfy both `brkUp` and `brkDn`; v1 printed both labels and
  silently left `trend` bearish. The close's position in the bar now decides.
- The RBD/DBR/RBR/DBD detector never inspected bar `[2]` — the base — so it
  was really "two up bars then two down bars" and it spammed. The base must
  now be indecisive (`baseMaxB`) and both legs must be ≥ 1 ATR.
- Equal-high/low pools were drawn and then never swept, retired, or consulted.
  They are now retired on sweep and used as the primary take-profit target.
- Consecutive BOSes stacked near-identical zones. `dedup` skips a zone
  overlapping a live one of the same direction.
- `alertcondition` takes a static string, so v1's webhooks carried no prices.
  v2 adds `alert()` with symbol, timeframe, direction, entry, stop, target
  and R.
- No cooldown between signals; `coolBars` added.
- Degenerate zero-risk setups (stop on the wrong side, or within one tick of
  the close) are rejected rather than divided by.

## Self-grading

Like Alpha Predictive, the indicator build books every signal it prints to its
stop or its target and reports **win rate and expectancy in R, split by setup
type** (Type 1 / Type 3 / BRK / BRK+IDM). That split is the point: it is the
only way to see whether `reqInd` actually earns its keep on your instrument.

Accounting is deliberately pessimistic: a bar that touches both levels is
booked a **loss**, no target credit is given on the signal bar, and unresolved
trades are closed at market after `maxHold` bars and booked at their real R.

**These are on-chart estimates, not a backtest.** For real numbers use
`indicators/mm_matrix_strategy.pine`, set commission and slippage for your
instrument, and walk it forward with the date-window inputs — tune on an early
slice, verify on an untouched later one. The defaults here are *not* validated;
unlike the Alpha Predictive presets, no walk-forward has been run on MM MATRIX
yet.

## MM MATRIX walk-forward study (1m / 5m)

Run with `backtest/mm_backtest.py` (a port of the v2 engine) and
`backtest/mm_walkforward.py`. Tuned on the first 60% of each series,
evaluated on the untouched last 40%. Costs are charged in R via `cost_r`
(0.10R on MNQ, 0.05R on crypto) because a fixed tick cost is a different
fraction of risk on every trade and omitting it flatters 1m enormously.

Data: MNQ 1m (7d, Yahoo) and 5m (60d, Yahoo); BTC/ETH/SOL 1m and 5m
(20k bars each, Coinbase).

### The headline result is negative

| Set | Configs | Best out-of-sample |
|---|---|---|
| Crypto **1m**, 3 markets | 1296 | **−0.017R** expectancy, PF 0.98, n=703 — every finalist negative |
| Crypto **5m**, 3 markets | 1296 | **−0.111R** expectancy, PF 0.86, n=134 — every finalist negative |
| MNQ **5m**, 1 market | 1296 | +0.228R expectancy, PF 1.27, n=63 |

**There is no measured edge on 1-minute data.** Across 1296 configurations on
three markets with 700+ out-of-sample trades, the best surviving configuration
still loses. That is a large enough sample to take seriously.

On 5m the picture is split: crypto negative, MNQ positive. One market with 63
out-of-sample trades is not evidence of an edge — it is a single sample that
happened to be positive. In-sample expectancy on MNQ was +0.45R and
out-of-sample +0.23R; halving from IS to OOS is the standard overfitting
signature even after walk-forward selection.

### Defaults

Set from the best MNQ 5m out-of-sample configuration: `sw = 4`,
`dispATR = 1.0`, `minRR = 3.0`, `slATR = 0.10`, `eqTol = 0.25`,
`maxHold = 100`, inducement and premium/discount both required.

`slTicks` is deprecated in favour of `slATR`. A tick buffer is not portable:
100 ticks is 25 points on MNQ and one dollar on BTC.

### What measured differently than expected

Three of these contradict reasoning that sounded right beforehand, which is
the point of running the test:

| Change | MNQ 5m out-of-sample PF |
|---|---|
| Baseline | 1.27 |
| **Require FVG in departure leg** | **0.81** — a liability, not a filter |
| **Blackout the London cash session** | **0.71** — it removes the London/NY overlap |
| RTH only (13–20 UTC) | 1.79, but n=22 — too small to act on |
| Inducement required OFF | 1.29 (n=91) vs 1.27 (n=63) — inconclusive, not the clear winner it looked |
| Stop buffer 100 ticks | 1.76 (n=34) vs 1.27 — worse on the full sample, better OOS; sample too small to call |
| `minRR` 1.5 instead of 3.0 | 1.10 |
| `eqTol` 0.66 instead of 0.25 | 1.14 |

`maxHold = 25` on 5m does not hurt returns, but it does inflate the reported
win rate: most trades exit as small-positive timeouts, which the dashboard
books as wins. Win rate on short holds is not comparable to win rate on long
ones.

### Overfitting risk

The engine has roughly twelve interacting parameters that affect signals. Any
setting chosen by watching the on-chart dashboard is overfitted by
construction, because that dashboard is scored on the same bars used to pick
it. Change parameters only against a held-out slice.
