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

## How v2 grades trades (fill model)

The accounting is deliberately **pessimistic** — OHLC bars don't reveal the
intrabar path, so every ambiguity is resolved against the strategy:

- A limit fills when price trades through it on a bar **after** the signal bar.
- If the fill bar also trades through the stop, the trade books as a loss.
- TP is never credited on the fill bar.
- If stop and TP both print inside one bar, the stop wins.
- Wins book `+RR` R, losses `-1` R, at the posted levels (no slippage/fees).

The dashboard shows signals, fill rate, wins/losses, expired setups, win rate
against the breakeven rate for the chosen RR (breakeven = `1/(1+RR)`, i.e.
**20% at 1:4**), net R, and expectancy per closed trade.

## Honest caveats

- This is an indicator-side simulation, not a `strategy()` backtest: no
  commission, slippage, or position sizing. Treat the expectancy line as an
  upper-bound sanity check, not a P&L forecast.
- Setups older than `maxTracked` stop being managed; on very signal-dense
  charts raise the cap or tighten the filters.
- A filled trade has no time stop — it runs until TP or stop is touched.
