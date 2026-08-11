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
