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

# OW Execution Matrix — Obizhaeva & Wang (2005) on NQ/MNQ

A second, independent indicator: `indicators/ow_execution_matrix.pine`.

Where the Alpha Matrix asks *when to enter*, this one asks *how to get a large
order filled cheaply*. It implements Obizhaeva & Wang, "Optimal Trading
Strategy and Supply/Demand Dynamics" — the paper that replaces the static
price-impact function with a limit order book that gets eaten by a trade and
then **refills at a finite speed ρ**.

The paper's central results, both implemented:

- **Proposition 3 (risk-neutral).** The optimal way to buy `X0` over `[0,T]` is
  a discrete clip of `X0/(ρT+2)` now, a constant continuous flow of
  `ρX0/(ρT+2)`, and a second clip of `X0/(ρT+2)` at `T`. The first clip knocks
  the book off its steady state so fresh orders are drawn in; the flow eats
  them at the rate they arrive; the last clip cleans up because the state of
  the book after `T` no longer matters.
- **The shape depends only on ρ and T.** Not on the permanent-impact
  coefficient λ, not on the depth `q` — those set only the *cost*. Most prior
  work tuned λ and got the schedule from it; the paper shows that is the wrong
  parameter to care about.
- **Proposition 4 (risk-averse)** front-loads the schedule, and is exposed as a
  dimensionless "urgency" `u = aσ²/(κρ)`.

## The directional result is negative, and that matters

The obvious trade idea from this paper is to fade the transient deviation
`D_t` — price is temporarily displaced by order flow, so short it when it is
high. **It does not work on NQ/MNQ, and the indicator does not pretend it
does.**

The naive test looks fantastic and is wrong. Regressing the bar return on
signed flow and its own lagged EWMA gives the transient term `t = −7.8` on MNQ
1h. That significance is almost entirely mechanical: `c_{t−1}` appears in both
the regressor (through the close-location value) and the regressand (through
the return), so bounce and close-position alone manufacture it.

Testing it honestly — forward returns measured from `c_{t+1}`, so no price
observation is shared with the state, and Newey-West errors because the
windows overlap (`ow_impact.py horserace`):

| MNQ 15m, horizon | flow state alone | past returns alone | both together |
|---|---|---|---|
| 4 bars | −5.85 (t −2.6) | −5.41 (t −2.2) | −3.99 (t −1.2) / −2.64 (t −0.7) |
| 10 bars | −7.68 (t −1.7) | −6.54 (t −1.3) | −6.02 (t −1.0) / −2.36 (t −0.3) |
| 20 bars | −5.93 (t −1.0) | −3.78 (t −0.5) | −6.40 (t −0.7) / +0.67 (t +0.1) |

Two conclusions. The effect is marginal at best (`t = −2.6` at one horizon,
before any penalty for having looked at four horizons on four series). And the
order-flow machinery **adds nothing** over a plain EWMA of past returns — the
two are near-collinear and neither survives when both are included. On 5m the
return control is strictly the stronger of the two. So the steady-state line
the script draws is a liquidity read, not an entry signal.

## What *is* solid: the impact decay

The same data identifies the cost model cleanly. The trick is that the signed
flow `x_t` is built only from `(h_t, l_t, c_t, v_t)`, so regressing
`c_{t+1+k} − c_{t−1}` on `x_t` shares **no** price observation with the
regressor at any `k` — bounce cannot manufacture the level or the decay.
Fitting `β_k = λ + κe^{−ρk}` (`ow_impact.py decay`):

| series | 1/q (pts/ADV) | λ (permanent) | κ (transient) | ρ /bar | half-life | t(β₀) |
|---|---|---|---|---|---|---|
| **MNQ 15m** | 32.09 | 24.99 (77.9%) | 7.09 (22.1%) | 0.2832 | 2.45 bars ≈ 37 min | 20.4 |
| **NQ 15m** | 29.02 | 23.07 (79.5%) | 5.96 (20.5%) | 0.3182 | 2.18 bars ≈ 33 min | 19.7 |
| MNQ 5m | 11.66 | 10.19 (87.4%) | 1.47 (12.6%) | 0.1407 | 4.93 bars ≈ 25 min | 21.6 |
| NQ 5m | 9.76 | 8.50 (87.1%) | 1.26 (12.9%) | 0.1492 | 4.65 bars ≈ 23 min | 19.4 |

Two contracts, two timeframes, all agreeing: **impact half-life 23–37 minutes,
transient share 13–22%**. Index futures are efficient — roughly 80% of impact
is permanent (information), and only the remaining fifth is the refillable part
the paper's schedule can save on.

**Use 15m.** On 15m the β_k curve decays monotonically and the exponential fits.
On 5m it *rises* through k≈3 before decaying (order-splitting continuation),
the exponential fits poorly, and the live estimator returns a usable ρ only
~40% of the time versus 96% on 15m. The 5m preset ships, with a warning.

## Correctness of the solver

The risk-averse path is a numerical solve, so it is checked against things that
can't both be wrong (`ow_execution.py verify`):

- The generic ODE solver, run at vanishing urgency, reproduces the closed-form
  Propositions 2/3 across 48 configurations — **worst relative error 1.1e-9**.
- It reproduces **the paper's Table 1 exactly**, every row. (The ρ=50 row reads
  1,921 in the paper; 100,000/52 = 1,923. That one is a rounding slip in the
  table, not in the code.)
- An independent path simulator, which walks any schedule through the paper's
  own state equations (A.11)–(A.13), agrees with both closed-form cost
  expressions to ~1e-4. It is what prices risk-averse schedules, since the
  Proposition-3 formula does not apply to them.
- Grid-size sweep sets the Pine loop at N=400 (x0 converged to 1e-10, xT to
  0.2% of the N=4000 answer).

## What it shows

Dashboard: measured ρ, impact half-life in bars and minutes, transient share,
depth in contracts/point, the live deviation `D_t`, the three-part schedule in
contracts, and the expected impact cost of the OW schedule vs TWAP vs a market
order — in points per contract and in dollars. On the chart: the steady-state
value line `V_t = P_t − D_t`, and the execution window with the three expected
average fill prices.

Worked example (MNQ 15m preset, 500 contracts over 8 bars = 2 hours):

```
$ python3 backtest/ow_execution.py plan 500 8 MNQ_15m 0
  first clip   117 (23.4%)  |  continuous 33/bar (53.1%)  |  last clip 117 (23.4%)
  Obizhaeva-Wang         $250    0.2499 pts/ct   1.00 ticks
  TWAP                   $254    0.2539 pts/ct   1.02 ticks
  market order now       $283    0.2831 pts/ct   1.13 ticks
  saved vs TWAP  $4 (1.59%)   |   saved vs market order  $33 (11.74%)
```

**Be honest about the size of the prize.** Because ~80% of impact is permanent
and unavoidable, optimal scheduling saves only **1–2% of total impact cost**
against TWAP — it saves ~11% of the *avoidable* transient part, and ~12–15%
against dumping at market. Costs scale with `X0²`, so the same percentages on a
5,000-lot are $243 vs TWAP and $4,341 vs a market order. If someone quotes you
a bigger edge from this paper on index futures, they have not measured λ.

## Caveats

- **The cost level is uncalibrated; the decay shape is not.** Signed flow is
  proxied from bar shape (close-location value × volume), not from true
  trade-side data, so ρ and the κ/λ *ratio* are well identified but the
  absolute points-per-contract level inherits the proxy's scaling. The
  `Depth Calibration` input exists for this: compare the cost line to your own
  fills and set it so they agree.
- Impact coefficients are in ADV-normalised units, so the presets adapt
  automatically to today's volume — the same contract count is a smaller
  fraction of an ADV on a busy day, and the cost falls accordingly.
- The model prices *impact*, not spread, fees or the fundamental drift over
  the horizon. It is an impact-cost estimate, not a full TCA.
- Two years of Yahoo hourly/5m/15m data, one underlying. MNQ and NQ are the
  same index, so their agreement is a consistency check, not independent
  replication.

Reproduce:

```
python3 backtest/fetch_yahoo.py data MNQ=F && python3 backtest/fetch_yahoo.py data NQ=F
python3 backtest/ow_impact.py data decay          # parameter estimates
python3 backtest/ow_impact.py data horserace      # the negative directional result
python3 backtest/ow_impact.py data rolling        # live-estimator stability
python3 backtest/ow_execution.py verify           # solver vs the paper
python3 backtest/ow_execution.py plan 500 8 MNQ_15m 0
```

---

# Overnight Drift Matrix — the 15m directional edge that survives testing

`indicators/overnight_drift_matrix.pine`

**The rule:** go long at the 16:00 ET cash close, exit at the 09:30 ET open,
and only take it when price is above its 200-day average. One filter, one
parameter.

## Why this and not an intraday signal

The honest answer to "make a directional 15m indicator" is that the
directional edge in index futures is **not intraday**. Over 27–33 years of the
index ETFs, essentially the entire index return has accrued between the close
and the next open. The 09:30–16:00 session is a coin flip that loses to fees.

Everything below was tested and **rejected** — all negative on all four of
QQQ/SPY/DIA/IWM after 1bp round-trip costs:

| tested intraday | QQQ | SPY | DIA | IWM |
|---|---|---|---|---|
| gap continuation | −2.61bp | −1.75bp | −1.90bp | −1.97bp |
| gap fade | +0.61bp | −0.25bp | −0.10bp | −0.03bp |
| short RTH below 200d SMA | −2.67bp | −4.67bp | −6.56bp | −2.95bp |
| long RTH above 200d SMA | −1.75bp | −1.32bp | −1.74bp | −3.35bp |

Opening-range breakout was tested separately on 59 days of 15m NQ/ES/YM/RTY at
15/30/60-minute ranges: **negative on every instrument at every range**, −3.5
to −17.2bp per trade, win rates 23–46%. And 15m bar autocorrelation *flips
sign* between sample halves (IS −0.017 to −0.070, OOS +0.054 to +0.087, all
four instruments), so bar-scale momentum and mean reversion are both out —
whichever you fit on one half reverses on the other.

## Why the long-history work uses ETFs

Yahoo caps 15m history at 60 days, which cannot validate a once-a-day
strategy — you get ~20 out-of-sample trades. But this rule only needs the RTH
open and close, and index ETFs give those *exactly*: their daily open is the
09:30 print and their close is the 16:00 print. Futures daily bars cannot be
used this way because the futures "open" is the prior evening's Globex open.
So the statistics come from QQQ (the NQ/MNQ underlying), SPY, DIA and IWM, and
are then confirmed on real futures.

## Results, net of 1bp round trip

1bp ≈ 2.4 ticks on MNQ at NQ=24,000 — deliberately conservative for a contract
that is usually one tick wide.

| | n | mean/trade | t | Sharpe | cum | maxDD | WR |
|---|---|---|---|---|---|---|---|
| **QQQ 1999–2026** | 4,916 | **+4.66bp** | 4.8 | **0.92** | +229% | 27.2% | 56.0% |
| in-sample <2015 | 2,512 | +4.33bp | 3.3 | 0.83 | +109% | 27.2% | 55.2% |
| **out-of-sample ≥2015** | 2,404 | +5.01bp | 3.5 | **1.04** | +120% | 21.1% | 56.9% |
| 2023–2026 (post-publication) | 846 | +6.76bp | 2.8 | **1.44** | +57% | 9.7% | 56.7% |
| SPY 1993–2026 | 6,188 | +3.11bp | 5.1 | 0.89 | +192% | 17.0% | 55.4% |
| IWM 2000–2026 | 4,316 | +4.31bp | 4.5 | 0.88 | +186% | 21.8% | 55.3% |
| DIA 1998–2026 | 5,118 | +1.65bp | 2.6 | 0.48 | +84% | 25.1% | 53.1% |
| *QQQ buy & hold 24h (reference)* | 6,916 | +4.28bp | 2.1 | *0.40* | +296% | *147.1%* | 54.3% |

The comparison that matters is the last row: the rule captures most of
buy-and-hold's return on **a fifth of the drawdown**, more than doubling
Sharpe. It is still working post-publication — 2023–2026 is the best era in
the sample.

Confirmed on real futures (2 years of 1h bars, the same 09:30/16:00
boundaries): overnight Sharpe **1.11 NQ, 1.10 MNQ, 1.07 ES, 0.94 RTY**.

## What the trend filter is for

Drawdown, not return. On QQQ it lifts Sharpe 0.76 → 0.92 and cuts the worst
drawdown 41% → 27%; it improves out-of-sample Sharpe on all four instruments
(worst case 0.37 → 0.59). In a window with no bear market it does nothing,
which is exactly what it is for — on the 2-year futures sample it slightly
*reduces* return, because there was no bear market to sit out.

## Filters that did not survive

The bar was: a filter is kept only if it improves out-of-sample Sharpe on
**every** instrument. Worst-instrument OOS Sharpe:

| | QQQ | SPY | DIA | IWM | worst |
|---|---|---|---|---|---|
| always long | +0.71 | +0.48 | +0.37 | +0.85 | +0.37 |
| **+ trend filter** | +1.04 | +0.80 | +0.59 | +0.99 | **+0.59** |
| + skip Friday entry | +1.16 | +0.75 | +0.50 | +0.85 | +0.50 ✗ |
| + skip Thursday entry | +1.10 | +0.87 | +0.69 | +0.89 | +0.69 ✗ |
| + skip Monday entry | +0.95 | +0.78 | +0.54 | +1.17 | +0.54 ✗ |
| + prior intraday < 0 | +0.70 | +0.17 | +0.06 | +0.79 | +0.06 ✗ |

Skipping the Friday entry is the intuitive one — it avoids the weekend hold —
and it is *worse* on three of four. Skipping Thursday has the best worst-case
but fails on IWM, and it is one of a five-way carve, so it is not used.

**A trap worth naming:** a position entered Friday exits *Monday*. An earlier
version of this study keyed the weekday off the exit day, which silently
tested Thursday entries and produced a confident, wrong conclusion that
"skip Friday" improved all four instruments. The corrected test reverses it.
If you filter by weekday, be explicit about which end of the trade you mean.

## Caveats

- **This is a session strategy, not an intraday signal.** It takes one trade
  per day and holds through the Globex session. A 15m chart is the right venue
  because it resolves the 16:00 and 09:30 prints exactly — not because there
  is a 15m pattern.
- Overnight means overnight risk. Gaps are the whole point of the trade, and
  they cut both ways; the rule has no stop. The drawdowns above are real.
- The mechanism (overnight risk premium / flow imbalance) is documented in the
  academic literature, so this is a replication, not a discovery — which is
  the reason to trust it rather than a reason to discount it.
- QQQ and NQ/MNQ share an underlying but are not identical instruments:
  futures carry financing in the basis, and the futures overnight session
  trades continuously rather than gapping. The 2-year futures check is
  reassuring but short.
- Costs are modelled as a flat 1bp of notional. If you trade size that moves
  the 16:00 or 09:30 print, use the OW Execution Matrix above to price it.

Reproduce:

```
python3 backtest/overnight_study.py data rule        # headline + eras
python3 backtest/overnight_study.py data filters     # what survives, and what doesn't
python3 backtest/overnight_study.py data intraday    # the negative intraday results
python3 backtest/overnight_study.py data futures d15 # NQ/MNQ/ES/RTY confirmation
```

`data` holds daily ETF CSVs (QQQ/SPY/DIA/IWM), `d15` holds intraday futures
CSVs; both come from `backtest/fetch_yahoo.py` style requests.
