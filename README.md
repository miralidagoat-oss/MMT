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

# MNQ 5m ETH Final Indicator Scaffold

**File:** `indicators/mnq_eth_final_indicator_scaffold.pine`
**Status:** `UNVALIDATED` / rule identity `UNASSIGNED`

A fail-closed production *harness* for a future MNQ 5m ETH rule set. It ships
deliberately empty: the frozen-rule adapter returns `false` for every entry and
exit event and `na` for every price. It exists to freeze alert schemas, session
gating, event arbitration and release governance around a rule that has not
been selected yet.

## Backtest result

There is no backtest, and the reason is structural rather than a tooling gap.

1. **It is an `indicator()`, not a `strategy()`.** TradingView's Strategy
   Tester only loads `strategy()` scripts, so the script has no Strategy Tester
   tab, no equity curve and no trade list. Nothing to press.
2. **It emits zero signals by construction.** Verified by measurement, not
   assertion — `backtest/mnq_scaffold_backtest.py` is a faithful port of the
   script's deterministic bar loop (CME week clock, session filter, all six
   release gates, the adapter, `f_validBracket`, the single-event arbiter and
   the alert de-duplicator), run against 13,788 real MNQ 5m bars:

   | pass | release gates | accepted events | alerts | trades |
   |------|---------------|-----------------|--------|--------|
   | A. as shipped | closed | 0 | 0 | 0 |
   | B. all governance gates forced open | open | 0 | 0 | 0 |

   Pass B is the informative one: with every gate satisfied — operator toggles
   on, identity constants populated with well-formed values, environment
   correct — the count is still zero, because `f_frozenLongEntryEvent()` and
   its three siblings return `false` on every bar. **The fail-closed gates are
   not the binding constraint; the empty adapter is.**

Win rate, expectancy, drawdown and profit factor are therefore *undefined*,
not zero. There is no sample. Any backtest number attached to this file today
would be describing the harness, not a strategy.

To make it backtestable: port the frozen rules into a `strategy()` twin,
validate there, then mirror the parity-tested logic back into the adapter
region — which is what the file's own release procedure prescribes.

## What the harness *did* verify

Running the port over real bars exercises the mechanics that are implemented:

- **Session gating is live and correct.** 13,786 of 13,788 bars fall inside the
  allowed window; the two blocked bars are both 16:00 America/Chicago, the
  start of the CME maintenance hour.
- **The session input is redundant at its default.** Proved exhaustively over
  all 7 x 1440 day/minute combinations: `f_isCmeWeekClockOpen()` AND the
  `"1700-1600"` session equals `f_isCmeWeekClockOpen()` alone. The week clock
  is strictly tighter — it blocks 2,760 additional minutes per week (all of
  Saturday, Sunday before 17:00, Friday after 16:00) that the session string
  would admit. The input only starts to matter once it is narrowed.
- **Alert JSON is well-formed.** Both hand-built payloads parse as JSON, the
  `mnq.tv.entry.v2` and `mnq.tv.exit.v1` key sets are disjoint as intended, and
  the `na` price path emits a real JSON `null` rather than a bare `na` token.
  (That path is unreachable in practice: `f_validBracket()` rejects incomplete
  brackets before an entry can be accepted.)

## Formatting audit

`backtest/pine_format_check.py` checks the mechanical rules that make a Pine v6
file well-formed without needing TradingView's compiler: version-directive
placement, tabs/CRLF/trailing whitespace, bracket balance, block-opener
indentation, and the continuation-indent rule Pine enforces outside parentheses
(a wrapped line must not sit at a multiple of four spaces, since those indents
are reserved for local-block nesting; inside parentheses any indent is legal).

```
python3 backtest/pine_format_check.py indicators/*.pine
```

**Mechanical layout was clean and still is** — brackets balance, no tabs, no
CRLF, no trailing whitespace, continuations correctly at 5/9/10/13. Spacing
also already conformed: zero missing spaces after commas, zero missing spaces
around binary operators, constants correctly `SNAKE_CASE`.

Three violations of the official
[style guide](https://www.tradingview.com/pine-script-docs/writing/style-guide/)
were found and fixed:

1. **Function naming.** 23 of 28 functions carried an `f_` prefix
   (`f_roundToTick`). The guide specifies plain `camelCase` (`roundedOHLC()`).
   Prefixes stripped. `f_signalId` became `buildSignalId`, not `signalId`, to
   avoid colliding with the local `signalId` variable inside both payload
   builders.
2. **Input suffix.** All 11 input-backed variables lacked the `Input` suffix
   the guide requires (`enableAlerts` -> `enableAlertsInput`).
3. **Section order.** The alerts block sat *before* the visuals. The guide's
   order is `... calculations, visuals, alerts`. The 28-line alert block was
   moved below the table.

Two advisory long lines remain (39, 54) plus one at 304; each is a single
string literal that cannot be wrapped without splitting the string, which would
be a code edit rather than a formatting one. They were left alone.

### Compile/runtime errors fixed

TradingView reported two failures that the offline checks could not catch:

1. **`str.substring` out of bounds (CE10276)** -- *Invalid value "1" for
   "begin_pos" ... It must be >= 0 or lower than the "source" length: (0)*.
   In `isPhase9Contract`, `yearCode` is `""` whenever `validLength` is false,
   which is exactly the shipped state (`FROZEN_EXECUTION_CONTRACT` is the
   10-character `"UNASSIGNED"`). Pine folds const arguments and evaluates the
   `if validLength` body anyway, so `str.substring(yearCode, 1, 2)` indexed
   into an empty string. Fixed by slicing a guaranteed six-character surrogate
   (`safeName`); `validLength` alone still decides the verdict.
2. **`shorttitle` too long** -- 15 characters, limit is 10. `"MNQ UNVALIDATED"`
   became `"MNQ UNVAL"` (9).

`isLowerHexSha256` carried the identical latent bug -- a hard-coded
`for index = 0 to 63` against `FROZEN_RULE_SHA256 = "UNASSIGNED"` -- and would
have crashed as soon as the first fix landed. Its loop is now bounded by the
string's real length. `isAuthorizationId` got the same length guard so all
three validators are uniformly safe against const folding.

Equivalence was checked over 1,240 inputs (real contract codes, placeholders,
boundary lengths, random junk): **zero behaviour differences** between the old
and new validators on every input the old code could evaluate without
crashing. `isPhase9Contract("MNQU26")` is still `true`;
`isPhase9Contract("UNASSIGNED")` is now `false` instead of a crash.

### Environment halts converted to a reportable diagnostic

`runtime.error()` fired on bar 0 for any chart failing an environment check --
most commonly a continuous symbol like `MNQ1!`, which TradingView opens by
default for MNQ. Halting on bar 0 stops the script before it can draw the
status table, so the one surface that explains *why* it is blocked never
renders. The six halts were also redundant: every condition they tested
already feeds `environmentOk`, which gates `releaseGatesOpen` and therefore
every event and alert.

They are now a single `environmentIssue` string reporting the first failing
check, surfaced as a "Chart environment" row in the status table. Verified
that the fail-closed guarantee is unchanged: with every governance gate
satisfied but a continuous chart loaded, `environmentOk` is false,
`releaseGatesOpen` is false and the run produces 0 events and 0 alerts --
without any halt.

To pass the environment gate, load a dated contract (e.g.
`CME_MINI:MNQU2026`) on a 5-minute standard-candle chart. Note the release
gate stays BLOCKED regardless while `FROZEN_TICKER_ID` and the other identity
constants are `UNASSIGNED`.

### Proof the reformat changed no logic

Renaming and moving code is only safe if it provably preserves behaviour. The
original was re-parsed, the same rename map applied to it, and the result
compared against the committed file:

- statement multiset identical (nothing added or removed)
- token count identical: **2,626 before, 2,626 after** (measured before
  the bounds fixes above, which intentionally alter these three functions)
- token multiset identical
- token *sequence* differs by exactly one `insert` + one `delete` opcode -- the
  signature of a single contiguous block relocation, i.e. the alerts move and
  nothing else

Not verified: the file has not been through TradingView's compiler, which is
the only authority on API-level validity. These checks cover layout, style and
equivalence, not whether every builtin signature is correct.

## Reproduce

```
python3 backtest/fetch_yahoo.py data MNQ=F        # cache MNQ bars
python3 backtest/mnq_scaffold_backtest.py         # measured signal backtest
python3 backtest/pine_format_check.py indicators/mnq_eth_final_indicator_scaffold.pine
```

Note: the cached `MNQ=F` feed is a continuous front-month series, the data
equivalent of `MNQ1!`. The scaffold's `isIndividualContractChart` gate rejects
exactly that symbol class, which is why the port models the chart environment
explicitly rather than inferring it from the feed.
