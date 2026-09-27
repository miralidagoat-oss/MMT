# MMT — Quant Engine

Two Pine Script v6 indicators:

- **Alpha Predictive Limit Matrix** — everything up to the LEDGER section.
- **LEDGER · Trapped-Crowd Reversal Zones** — see
  [its section](#ledger--trapped-crowd-reversal-zones) at the end.

**Alpha Predictive Limit Matrix** is a Pine Script v6 indicator that detects liquidity-sweep rejection blocks, posts a
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

## LEDGER — Trapped-Crowd Reversal Zones

- **Maintained script:** `indicators/ledger.pine` (v3.1)
- **Original submission:** `indicators/legacy/ledger_v3.pine`, kept for reference only.

Two zigzag trackers (swing, 0.2× ADR, and MAJOR, 0.4× ADR) build a
volume-at-price histogram for every leg. When a completed leg then gives back
80% of its move, the volume now underwater is a **trapped crowd**. The zone is
drawn at that crowd's volume-weighted breakeven, ± half the spread of its
entries, because that is where its members get out flat. Zones get tested,
then spent. They die only on an accepted break (a quick sweep and reclaim
leaves them alive), decay with a half-life, and are dimmed when a trend day
is heading into them. **DOUBLE** marks a zone that also overlaps a
short-term absorption node from the v1 engine.

Reading the chart: purple = trapped buyers above price (resistance), orange =
trapped sellers below (support). A solid frame means MAJOR, stacked (both
crowd sizes) or ×N (several distinct crowds), or the strongest fresh zone on
its side. Gold frame = DOUBLE. Dotted and faded = spent, or in the path of a
trend day. Labels read `▼ 21,532.50  MAJOR · DOUBLE · 38% ADV`, where the
percentage is the decayed trapped volume relative to an average day.

### v3 → v3.1 audit: bugs fixed

1. **Trend-day context was dead on RTH-only charts.** Sessions were found only
   by price moving in or out of RTH. Charts with no bars between sessions
   (stocks without extended hours, futures on an RTH session) have back-to-back
   "in RTH" days. So after day one the RTH open never reset, the noise area
   never learned, and the bar counter ran off its 400-slot table. On 33
   synthetic RTH-only sessions the old logic found 1 session start and 0 ends;
   v3.1 finds 33 starts and 32 ends (the last session is still open). A date
   change now also starts a session.
2. **The noise area was indexed by bar count, not time of day.** One missing
   bar (an illiquid minute) shifted every later bar of that day onto the wrong
   historical slot. Sub-minute charts, or RTH windows longer than 400 minutes,
   lost the band part-way through the day. It is now indexed by minute of the
   session and sized to the session.
3. **The first session in the chart history used a mid-session bar as its
   "RTH open".** A session seen from partway through is now skipped.
4. **No zones at all on symbols without volume** (SPX, most FX and CFD feeds).
   Every histogram weight was `nz(volume) = 0`, so the trapped volume was always
   0. The short-term nodes were empty too, so DOUBLE never fired either. On
   symbols that report no volume, every bar now weighs 1.
5. **Crowds were double-counted on merges.** A swing leg inside a MAJOR leg is
   the same traders, but the merge added both, inflating the "% of a day's
   volume" figure and the zone ranking. Zones now carry the time span of their
   volume: overlapping merges keep the larger count, disjoint ones add. In
   the synthetic runs, 9 of 10 merges were overlaps.
6. **Merges decayed fresh volume as if it were old.** `q += sv` against the
   zone's birth time decayed a crowd trapped today by the zone's whole age, and
   a zone could reach max age right after being reinforced. v3.1 decays the old
   mass first, adds the new crowd, and restarts the clock. A merged zone also
   re-centres on the pooled crowd (volume-weighted mean and pooled spread)
   instead of ignoring where the new crowd sits. It stays put when moving it
   would drop it onto price.
7. **"Spent" also fired on breakouts.** After a touch, any close more than two
   half-heights away counted as spent, including closes *through* the zone. So
   a zone that was being broken got labelled as one that had already worked.
   Only a reaction on the rejection side counts now.
8. **Each tracker's first leg was bogus.** It started on whatever bar the chart
   history began with and had a partial histogram, so it could file a zone from
   a leg smaller than the threshold. That leg is no longer emitted.
9. **Divergence was meaningless on ES and on non-NQ charts.** The correlated
   symbol defaulted to ES on every chart. On ES it compared ES with itself, which
   can never trigger. The move ratio was also fixed at NQ/ES's 1.25. Auto mode
   now picks NQ for S&P charts and ES for everything else, and estimates the
   ratio from the two symbols' average daily range in %. A custom symbol equal
   to the chart's own is detected and turned off.
10. **The dashboard showed "0 pts" on FX and other low-priced symbols**
    (`"#"` / `"#.##"` formats). Prices are now tick-formatted.
11. **Map-size runtime error risk.** A Pine map holds at most 50,000 keys, and
    very fine tick sizes on long legs could approach that (BTC at $0.01 × 8
    gives $0.08 bins). Bins are now floored at ADR/400, fixed once per chart,
    and writes are capped.
12. **Contradictory inputs.** A MAJOR size ≤ the swing size duplicated every
    zone as STACKED, and a min height above the max height inverted the clamp.
    MAJOR tracking now switches off in that case, and the clamp orders its
    bounds.
13. **Trend context ran on daily and higher charts**, where an intraday noise
    area means nothing. It is intraday-only now.

### Improvements

- **Better cost basis:** each bar's volume is spread across its range by exact
  bin overlap, not dropped at `hlc3`. This matters from 15m up, where one bar
  spans many bins and would otherwise fall entirely on one side of the
  "underwater" cut.
- **Simpler tracker:** `pendMin`/`pendMax` are gone. The first bar to reverse
  by the threshold is always the furthest bar since the extreme: any earlier
  one would have triggered first. So that bar's low or high is the new
  extreme. On 10 synthetic runs (~1,300 legs) the legs are identical to v3's,
  apart from the dropped first leg.
- **Alerts:** `alert()` on a zone's first test (optionally also on new zones),
  plus `alertcondition()`s for resistance and support tests.
- **Cleaner display:** consistent visual hierarchy, shorter labels (spent zones
  unlabelled), a dashboard showing the nearest zone each side with its distance
  in ADR, dashboard position and text-size inputs, and tooltips on the
  non-obvious inputs.

Behaviour changes you may notice against v3: zone heights on 15m+ charts
shift slightly (range-spread volume); stacked zones show a lower (correct)
"% ADV"; the divergence ratio defaults to auto (set it to 1.25 to match v3 on
NQ).

### Verification and limits

- No TradingView compiler is available offline. The script was syntax-checked
  with the `pynescript` parser, and its engine (trackers, trap/merge,
  lifecycle, pruning, session detection) was ported line by line to Python.
  Invariants were checked on synthetic 1-minute data, both 24h futures and
  RTH-only: legs alternate; each starts at the previous extreme and is at
  least its threshold; bar weight is conserved; zones sit inside the leg they
  came from.
- These are logic checks, not an edge study. Nothing here measures how often
  price actually reverses at these zones.
- RTH windows that cross midnight aren't supported. The dashboard says "check
  the RTH hours".
