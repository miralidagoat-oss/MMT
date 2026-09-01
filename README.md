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

# Nasdaq Short-Term Reversion — the model that actually validated

`strategies/nq_reversion.pine` (DAILY chart, MNQ1! / NQ1!) —
**[full write-up](docs/NQ_REVERSION_MODEL.md)**

Buy the close when the session finishes weak (IBS < 0.30); exit at the close of
the first session that closes higher. Long only. That's it.

| | span | return | **Sharpe** | t | max DD | exposure | trades |
|---|---|---|---|---|---|---|---|
| **NQ** | 10.0 y | +17.5%/yr | **1.15** | 3.64 | 19.6% | 48% | 455 |
| NQ buy & hold | | +20.8%/yr | 0.92 | 2.89 | 35.3% | 100% | — |
| **MNQ** | 7.3 y | +18.3%/yr | **1.13** | 3.04 | 19.6% | 51% | 344 |
| **QQQ** | 10.0 y | +19.2%/yr | **1.27** | 4.01 | 14.9% | 51% | 480 |
| ES | 10.0 y | +10.2%/yr | 0.79 | 2.51 | 21.4% | 49% | 446 |
| SPY | 10.0 y | +7.9%/yr | 0.63 | 1.99 | 23.2% | 50% | 462 |

Not more return than buy & hold — better *risk*: higher Sharpe, half the
drawdown, in the market half the time. First half of the sample Sharpe 1.18,
second half 1.12. Positive in every calendar year, including 2022 (+4.7% while
NQ fell 32.5%).

**Why it is believable where the ICT model was not:** every parameter is flat
across its whole range (IBS 0.15→0.50 all give Sharpe 1.01–1.20), it survives
5× realistic costs, and it holds on five instruments and both halves of ten
years. The failed candidates are kept in `backtest/edge_screen.py` in the form
they were tested — gap fade, gap continuation, 200-MA filtering, shorting strong
closes, overnight-only exits, all rejected.

**Its real risks:** long-only across a mostly-bull decade, it holds overnight,
and tight stops destroy it (a 1% stop cuts Sharpe 1.15 → 0.45 — you are
deliberately buying weakness). Details in the write-up.

```
cd backtest
python3 edge_screen.py ../ictdata      # the pre-registered screen, failures included
python3 reversion_model.py ../ictdata  # daily mark-to-market, all instruments
```

---

# ICT MNQ Model — indicator

`indicators/ict_mnq_model.pine` — the chart-tool version of the ICT strategy.
Marks the setup and levels, grades its own signals, fires alerts, places no
orders. Use `strategies/ict_mnq_sweep_mss.pine` when you want a Strategy Tester
P&L instead.

Draws live liquidity (PDH/PDL, Asia and London extremes, untaken swings), sweep
markers, the MSS label with the stop distance in points, the displacement FVG,
and entry/stop/target lines. The dashboard shows both HTF biases, session state,
stop and target in points and dollars, position size for your risk budget, and a
running simulated record.

**Non-repainting by construction:** every signal, label, zone and alert is gated
on `barstate.isconfirmed`; HTF structure uses `lookahead_off` and, by default,
only closed HTF candles; swing pivots appear only once confirmed.

**Long only ships ON** — short setups at this horizon lost on all six instruments
tested (t = −3.7 to −5.2 over 875 days).

**Verified before shipping.** `backtest/verify_indicator.py` is a faithful
transcription of the Pine decision path — including the exact HTF request
offsets and the pivot confirmation lag — run against real MNQ/NQ/ES 5m data. It
asserts the invariants a syntax check cannot: stop and target on the correct
side of entry, target exactly 2R, risk inside 0.5–1.0 ATR, every entry inside
09:30–13:30, max 2 signals per session, no duplicates, and that the logic fires
at all. All pass on all three instruments.

Expect roughly **0.23 signals per session** on MNQ at defaults — about one every
four days. Removing filters buys frequency and costs quality, in the order the
research predicted: long-only + HTF 36% at 2R (breakeven 33%), +shorts 30%, HTF
off 30%, both off 25%. Small samples, but the ordering is the point.

The self-grading panel is a *pessimistic simulation*, not a backtest: the stop
wins any same-bar tie, the target is never credited on the signal bar, and no
commission or slippage is charged. The underlying model is still the unvalidated
one — see the ICT section below.

---

# ICT MNQ Strategy — Sweep → MSS → Displacement

`strategies/ict_mnq_sweep_mss.pine` is a Pine v6 **`strategy()`** (real orders,
auditable Strategy Tester P&L — not an indicator). 5-minute execution on MNQ,
filtered by 30m + 1H structure.

- **How to trade it:** [`docs/ICT_MNQ_PLAYBOOK.md`](docs/ICT_MNQ_PLAYBOOK.md)
- **Research code:** `backtest/ict_engine.py` (model + pessimistic fill model +
  commission/slippage in R), `ict_edge.py` (does the event predict anything?),
  `ict_conditions.py` (which confluence conditions it), `ict_combo.py`,
  `ict_study.py` (walk-forward + pooled grid search), `ict_data.py` (fetch).

```
cd backtest
python3 ict_data.py ../ictdata      # MNQ NQ ES MES QQQ SPY, 5m/15m/30m/1h/1d
python3 ict_edge.py ../ictdata      # unconditional edge test
python3 ict_conditions.py ../ictdata  # confluence attribution
python3 ict_combo.py ../ictdata     # the combined filter, all six markets
```

## The trade

1. **Sweep** — price raids a live pool (PDH/PDL, Asia or London range extreme,
   untaken 5m swing) and **closes back inside** it.
2. **MSS** — within ~6 bars a candle **closes** through the swing that stood
   before the raid, with a body ≥ 0.25 ATR.
3. **Filter** — 30m **and** 1H structure must already point that way; entries
   only 09:30–13:30 ET; max 2/day.
4. **Entry** — on the shift candle's close (see below).
5. **Risk** — stop 1.0 ATR (~43 pts on MNQ), target 2R, breakeven at +1R, flat
   15:55 ET.

## What the testing found

Six markets (MNQ, NQ, ES, MES, QQQ, SPY), ~71 days of 5m and ~875 days of 1h
from Yahoo, commission and slippage charged in R throughout.

**Held up:**

- **HTF alignment is the edge.** Counter-trend shifts lost on 5 of 6 markets
  (MNQ −0.76 ATR/event, t = −2.18); aligned-and-not-PM was positive on 5 of 6
  (MNQ +1.26 ATR, t = +2.10).
- **NY PM is the worst session** on every sample — hence the 13:30 cutoff.
- **Entry timing was the biggest execution lever.** The textbook FVG-retracement
  limit filled ~40% of setups and collected the ones that stalled; entering on
  the shift close gave ~2.5× the trades and a better factor (pooled PF 1.29 vs
  1.00). The script keeps both so you can check it.
- **Stops under ~0.75 ATR destroy it.** Measured MAE after a valid setup averages
  ~1.5 ATR.

**Did not hold up — stated plainly:**

- **The raw pattern has no edge.** Unfiltered on MNQ 5m: forward move −0.06 ATR,
  43% right-side, MFE 0.93 vs MAE 1.05. Slightly worse than a coin flip. All of
  the model's edge comes from the filters.
- **4H/Daily gating made it worse** on all three 5m markets. Ships OFF.
- **On the long sample it does not work.** 875 days of 1h, 390–970 trades:
  PF **0.80–1.01**, and the HTF filter *hurt* there. The encouraging 5m numbers
  come from 71 days.
- **The 5m sample cannot prove anything.** MNQ and NQ — the same market on two
  feeds, same 71 days — came out with opposite signs (+0.6R vs −4.3R). Yahoo
  caps sub-hourly history at ~60 days, so a few hundred trades simply aren't
  available here.

**Bottom line:** a correctly specified model with defensible, consistent-direction
filters. Not a validated edge, and not presented as one. Backtest it on your own
data before risking size.

## VWAP

Right direction, weak, and mostly redundant with the HTF filter (on MNQ, 68 of
89 events were already on the "correct" VWAP side). It ships **off** as a
direction filter. Use VWAP as context — target/magnet, trend-vs-balance read —
not as permission.
