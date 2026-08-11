# MMT — Quant Engine: Alpha Predictive Limit Matrix

Pine Script v6 indicator that detects liquidity-sweep rejection blocks, posts a
limit entry at the rejection-wick midpoint with an EWMA-volatility stop and a
fixed risk:reward target, then **grades its own historical signals** and shows
the results in an on-chart dashboard.

- **Tradeable strategy:** `indicators/mmt_session_sweep_strategy.pine` —
  Pine v6 `strategy()` port of the validated MNQ/NQ 1H configuration, with
  TradingView-native backtesting, commission/slippage modeling, a breakeven
  manager, risk guard, and alerts. **Start here if you trade MNQ.**
- **Research indicator:** `indicators/alpha_predictive_limit_matrix.pine` —
  the self-auditing indicator (grades every signal in parallel)
- **Original submission:** `indicators/legacy/alpha_predictive_limit_matrix_v1.pine` — kept for reference only

## v4 — the intraday hunt (Aug 2026): three strategy families tested, none beat the 1H engine

The goal was an edge for the sub-hourly timeframes (1m–30m) where the sweep
engine had shown none. Three families were built and tested on fresh data
(MNQ + NQ + ES; 60 days of 1m–30m, 2 years of 1h; the house pessimistic fill
model **plus round-trip costs** — commission + 2 ticks slippage, charged in
points per trade: MNQ 1.5 pt, NQ 0.75 pt, ES 0.6 pt):

1. **NY-open Opening Range Breakout** (`backtest/orb_study.py`) — 720-config
   grid (OR 5/15/30m × stops × targets × breakeven × direction filters ×
   entry cutoffs), walk-forward split, plus a 2-year first-hour-breakout
   proxy on hourly data. **Dead.** The best in-sample config (PF 1.40)
   collapsed out-of-sample (PF 0.40), and the 2-year proxy loses on all
   three symbols in *both* years (MNQ PF 0.53, NQ 0.52, ES 0.59; −212R on
   MNQ over 590 trades). Post-2023 index futures punish naive open momentum.
2. **Failed-breakout fade of the opening range** (same script,
   `fade-structural` mode) — since breakouts lose, fade the failed ones:
   poke beyond the OR extreme, close back inside, revert. **No edge:** best
   2-year config PF 1.05 ≈ zero after costs; nothing passes a
   both-years-positive + cross-symbol screen.
3. **Level-anchored sweep engine** (`backtest/level_study.py`) — a single
   pre-registered test, zero tuning: the exact v3.2 signal gates with the
   rolling 12-bar extremes replaced by the day's real liquidity levels
   (prior-day H/L, overnight H/L, 30-min opening range). **Not better.**
   With an end-of-day flat the RR-4 economics die (targets need multi-day
   room); without it, 2-year hourly PF is 1.03 vs the rolling engine's
   1.35–1.64. Sub-hourly samples were tiny (n≤13 per TF) and mixed-sign.

Reproduce (fetches ~60d intraday + 2y hourly from Yahoo):

```
python3 backtest/fetch_yahoo.py backtest/data_mnq MNQ=F
python3 backtest/fetch_yahoo.py backtest/data_nq  NQ=F
python3 backtest/fetch_yahoo.py backtest/data_es  ES=F
python3 backtest/orb_study.py sweep backtest/data_mnq
python3 backtest/orb_study.py fade-structural backtest/data_mnq backtest/data_nq
python3 backtest/level_study.py backtest/data_mnq backtest/data_nq backtest/data_es
python3 backtest/study_mnq.py backtest/data_mnq backtest/data_nq   # re-validation
```

**Conclusion: on current MNQ there is no validated sub-hourly entry edge in
any of these families. The one edge that keeps re-validating is the 1H
sweep-rejection engine.** The v3.2 MNQ preset was re-confirmed on data
through Aug 2026 — same numbers as the original study:

| panel | trades | WR (decisive) | PF | net R |
|---|---|---|---|---|
| MNQ 1h in-sample (first 60%) | 51 | 29.0% | **1.64** | +14R |
| MNQ 1h out-of-sample (last 40%) | 29 | 26.3% | **1.43** | +6R |
| NQ 1h full (cross-val) | 81 | 23.9% | **1.26** | +9R |

### The strategy script

`indicators/mmt_session_sweep_strategy.pine` packages that configuration as
a real `strategy()`: open it in the Pine editor, add it to an **MNQ 1H**
chart, and TradingView's Strategy Tester will show the win rate, profit
factor and equity curve on your own data feed — verify it yourself, don't
trust this README. Defaults: 1 contract, $0.80/side commission, 1 tick
slippage, RTH signal gate (09:30–16:00 ET), breakeven at +1R, 1:4 target,
24-bar limit expiry.

Honest differences from the study: the script trades **one position at a
time** (the study graded overlapping signals independently), and
TradingView's broker emulator resolves same-bar stop/target ambiguity with
its own OHLC-path heuristic where the study always books the stop — so the
tester will run slightly *more optimistic* than the study tables. The
study's numbers are the conservative reference. Parity that is enforced:
the target order is withheld on the fill bar, the breakeven stop arms only
after the exit checks and takes effect the next bar, and signals are
confirmed-bar only (no repaint).

By default the script **disables signals on unvalidated timeframes** (its
guard accepts 45m–2h). That is a feature, not a limitation — see the table:

### Which timeframe should you trade? (MNQ, evidence through Aug 2026)

| chart | verdict | evidence |
|---|---|---|
| 1m | ❌ no edge found | sweep engine PF 0.89 (7d); every ORB/fade family negative |
| 5m | ❌ no edge found | sweep engine PF 1.00 pre-cost (60d); ORB dead; level engine n=9 noise |
| 15m | ❌ no edge found | sweep engine PF 0.80; level engine PF 0.65–0.69 (60d) |
| 30m | ❌ no edge found | sign flips between configs — noise |
| **1H** | ✅ **trade this** | walk-forward + cross-val + re-validation: OOS PF 1.43 |
| 4H | ❌ negative | PF 0.33 (2y); worst tested; matches crypto 6h finding |

If you take one thing from this repo: **the market you are trading pays
patience at 1H and punishes activity below it.** More screens ≠ more edge.
Roughly 2–3 signals fire per week, almost all between 09:30 and 16:00 ET.

### Money, risk, and the honest math (read this)

The validated config's stop distances are volatility-scaled. Measured over
the 2-year sample: **median risk ≈ $221 per MNQ contract per trade** (mean
$252, p90 $382, max ~$1,040). Expectancy out-of-sample is ≈ +0.2R per trade
≈ **$45/contract/trade**, at ~30 trades/year ≈ **$1,300–1,600/year per
contract**, with historical drawdowns of 5–8R (≈ $1,100–1,800).

What that means by account size, risking one contract per signal:

| account | risk/trade (median) | verdict |
|---|---|---|
| $500 | 44% of the account | **do not trade — one loss ≈ half the account; ruin is near-certain** |
| $2,000 | 11% | still ruin-grade risk; a normal 5-loss streak ≈ −55% |
| $4,500 | ~5% | aggressive; survivable only with perfect discipline |
| $11,000+ | ~2% | the standard professional risk budget |

There is no setting in this or any script that changes that arithmetic —
MNQ is $2/point and the volatility is what it is. A "higher win rate"
does not fix it either: the engine's decisive win rate is ~26% *by
design* (63% of entries scratch at breakeven; the 1:4 winners pay for
everything). Chasing high-WR configurations was tested — every one of them
had PF < 1. **The profit factor pays, not the win rate.**

If your account is small: run the strategy on paper (TradingView paper
trading) until you have ≥3 months of live-signal evidence that your fills
match the tester, and treat funded-trader evaluations as what they are — a
fee-based business with its own failure odds, not free capital. No
indicator, this one included, can promise profit. This repo's value is that
it tells you the truth about where the edge is and — just as important —
where it is not.

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
