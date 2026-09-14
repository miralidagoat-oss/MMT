# MMT — Trading Research

Two Pine Script v6 indicators, both of which **grade their own historical
signals on your chart** instead of asking you to trust a screenshot.

| Script | What it trades |
|---|---|
| `indicators/mmt_ict_precision_model.pine` | **MMT ICT Precision Model** — the full ICT Module-1 stack: liquidity raid → displacement/MSS → PD-array entry → draw on liquidity, one A+ setup per killzone (Asia / London / NY AM) |
| `indicators/alpha_predictive_limit_matrix.pine` | Alpha Predictive Limit Matrix v3.2 — a single-bar liquidity-sweep rejection model with an EWMA-volatility stop, validated on MNQ 1H |

Supporting code: `backtest/ict_engine.py` + `backtest/ict_backtest.py` (offline
port of the ICT model with self-tests and walk-forward), `backtest/backtest.py`
and friends (the Alpha Matrix study), `tools/pinelint.py` (static checks for
the Pine sources).

---

# 1 · MMT ICT Precision Model

`indicators/mmt_ict_precision_model.pine`

An ICT intraday model that only takes the sequence it can define, posts a limit
order at a PD array, targets the next pool of liquidity, and then keeps score of
itself honestly — win rate, profit factor, expectancy, net R, drawdown, setups
per day, and a breakdown by killzone and by entry-array type.

## The trade, in four beats

Nothing fires unless all four print in order, inside an enabled killzone:

1. **RAID** — price sweeps a *documented* liquidity pool by at least
   `sweepATR × ATR` and closes back inside it. Documented means the model put
   that level on the chart earlier: PDH/PDL, prior settlement, PWH/PWL, the
   Asia or London session high/low, equal highs/lows, a swing PH/PL, the close
   of the swing candle (PHC/PLC), or an NDOG/NWOG edge.
2. **DISPLACEMENT → MSS** — a candle with a body of at least `dispATR × ATR`
   closes through the nearest unbroken swing on the other side of the raid, and
   the leg leaves a **fair value gap**. No FVG, no displacement, no trade. A
   three-candle FVG can only be confirmed on the candle *after* the
   displacement, so the shift and the gap are two separate beats: the model
   marks the MSS, then waits up to `fvgWindow` bars for the gap to print.
3. **E&R ENTRY** — a limit is posted on the retracement into the PD array of
   that leg. Type 1 **FVG** (the IOFED entry), Type 2 **Order Block / Breaker**
   mean threshold, Type 3 **Rejection Block** from the sweep candle's wick. The
   model takes the array price will touch *first* that still keeps risk inside
   the cap, and the level has to sit inside the allowed quadrant of the raid →
   MSS dealing range.
4. **DOL** — the target is the next untapped pool of liquidity, not a round
   multiple. If no pool pays `minRR`, the setup is discarded (or falls back to a
   fixed R:R, if you set `fallbackRR`).

Stop goes beyond the raid extreme plus a buffer — the swept low/high is the one
level the algorithm has already proven it wanted.

## Every Module-1 concept, and where it lives

| Concept | Implementation |
|---|---|
| **DOL** (draw on liquidity) | Target selection: nearest untapped pool that pays `minRR`; live draw shown on the dashboard |
| **Ticks & contract size** | `f_contracts()` — tick value = `syminfo.pointvalue × syminfo.mintick` (MNQ ⇒ $0.50, NQ ⇒ $5.00); contracts = account × risk% ÷ (stop ticks × tick value), printed on the label and in the alert |
| **Range settlement** | Prior daily close tracked as a `SETTLE` pool, drawn as a level, and used as half the bias test |
| **Range indicator** | Asia and London session-range boxes, projected forward, plus dealing-range quadrants |
| **PLC / PHC** | The *close* of the candle that made the swing, stored as its own pool |
| **PL / PH** | Confirmed pivot swings → pools and structure levels |
| **E&R, 3 types** | Type 1 FVG · Type 2 OB/Breaker · Type 3 Rejection Block — selectable, and tallied separately on the dashboard so you can see which type actually pays |
| **Market structure 1–4** | Unbroken-swing tracking, BOS vs MSS (a break *against* the prevailing structure), displacement requirement, order-flow state on the dashboard |
| **RB / iRB** | Rejection block built from the sweep candle's wick; flips polarity when closed through |
| **FVG / iFVG** | Three-candle gap ≥ `fvgATR × ATR`; a gap closed through inverts and works the other way |
| **OB** | The last opposing candle before the displacement leg; entry at its mean threshold |
| **Breaker** | An order block that gets closed through — the inverted OB, labelled `BRK` |
| **Quadrants** | 25 / 50 / 75 of the dealing range drawn on every setup; the entry quadrant is a hard gate and a true discount/premium fill scores a point |
| **IOFED** | The FVG entry: limit at the consequent encroachment of the displacement gap |
| **Opening price** | Midnight, 08:30 and 09:30 ET opens captured and drawn; the midnight open is half the bias test |
| **FP** (fair price) | Equilibrium of the dealing range — the CE fallback entry, and the discount/premium score |
| **SSA** | Premium/discount array selection: longs only work bullish arrays below equilibrium, shorts the mirror |
| **SMT** | `request.security` on the sibling index (NQ↔ES, YM/RTY→ES, auto-detected); a divergence at the raid scores a point |
| **Seek and destroy** | Both sides of *major* liquidity raided repeatedly in one session day ⇒ the model stands down for the rest of the day |
| **MMXM** | Consolidation → raid → MSS → retrace → draw; the consolidation stage before the raid scores a point |
| **NWOG / NDOG** | The session-break gap, detected from the bar-time discontinuity, drawn as a box with its CE and added as pools |
| **HRL / LRLR** | Obstacles between entry and draw (untapped pools + unmitigated opposing arrays); above `hrlMax` the setup is rejected, zero obstacles scores a point |
| **8:30 fibs** | The 08:30–09:00 ET range; an entry in its CE band or 0.62–0.79 OTE band scores a point |

Two honest notes on the mapping: **FP** and **SSA** are not universal ICT
acronyms, so they are interpreted here as *fair price (equilibrium / CE)* and
*sellside–buyside array selection (the PD array matrix)*. If your module means
something else by them, they are the only two items that would need rewiring —
everything else maps one-to-one.

## Hard gates vs scored confluence

**Hard gates** (any one fails ⇒ no setup): inside an enabled killzone · the
four-beat sequence · entry inside the allowed quadrant · risk between
`minRiskATR` and `maxRiskATR` · a draw that pays `minRR` · obstacles ≤ `hrlMax`
· not a seek-and-destroy day · killzone and daily quotas not spent.

**Score** (0–9, needs `minScore`, default 3): SMT divergence · raid took major
liquidity (grade ≥ 2) · opening price *and* settlement agree with the direction
· zero obstacles to the draw (LRLR) · MMXM consolidation before the raid · a
real PD array rather than the CE fallback · 08:30 fib confluence · NDOG/NWOG
interaction · filled in true discount/premium.

`minScore` is the selectivity dial: raise it for fewer, cleaner setups; lower it
for more.

## Three setups a day, by construction

`maxPerKz = 1` and `maxPerDay = 3` with Asia, London and NY AM enabled means the
model takes at most one A+ setup per killzone — three a day, Asia and New York
carrying the workload, London available. Defaults are ET: Asia `2000-0000`,
London `0200-0500`, NY AM `0830-1130`, NY PM off. If a limit never fills, it
frees its killzone slot (`freeOnExp`), so a missed retracement doesn't cost you
the session. Open trades are flattened at 16:00 ET.

## Management

Stop to breakeven at +1R by default (this is what turned losses into scratches
in the MNQ study behind the other indicator in this repo), optional partial at a
configurable R, optional time stop, and the end-of-day flatten. Scratches are
tracked separately: they are excluded from the win rate and included in
expectancy.

## The dashboard

Live state (bias, draw on liquidity, current killzone and quota, day profile,
setups used) over self-audit stats: signals, fill rate, target hits, stop outs,
breakeven scratches, expired and flattened, win rate against the breakeven rate
implied by the average winner, profit factor, net R, expectancy, max drawdown in
R, setups per day, net R split by killzone, and a win-loss record by entry-array
type. Every number is computed by the same pessimistic accounting described
below — it is the model marking its own homework in public.

**Fill model (deliberately pessimistic — OHLC bars hide the intrabar path):** a
limit fills only on a bar *after* the one that posted it; a fill bar that also
trades the stop books the loss immediately; the target is never credited on the
fill bar; if stop and target print inside one bar the stop wins; breakeven and
partials arm only on bars with no exit and take effect the next bar.

## Validation status — read this before you size up

**No market data was reachable from the session that wrote this code.** Yahoo,
Binance, stooq and Polygon were all refused at the network policy (403 on
CONNECT), so there is **no walk-forward study of this model on MNQ/NQ bars**,
and the shipped defaults are *structural* — derived from the ICT rules and from
risk sanity — not fitted to any market. I can't hand you a profit factor I did
not measure.

What **was** verified, by `python3 backtest/ict_backtest.py selftest`:

- **The model detects the pattern it claims to trade.** A hand-built textbook
  sequence (quiet range → sweep of a swing low → displacement clearing the
  short-term high with an FVG → retrace → expansion) produces exactly one long,
  entry between stop and target, 6.1R to the draw, booked as a win.
- **The accounting balances.** Net R equals the sum of booked trades, gross win
  minus gross loss equals net R, and the closed count matches the outcome
  tallies, across thousands of synthetic bars.
- **No look-ahead.** On six random walks the model averages **−0.04R per trade**
  — noise pays nothing, which is exactly what an honest engine does on noise. A
  materially positive expectancy on random data would have meant the engine was
  peeking at the future.
- **No trade ever exits on the bar that posted it**, and the killzone/daily
  quotas are never exceeded.

The walk-forward tool is honest about itself too: tuned on the first 60% of a
random walk it reports PF 2.13, and the untouched last 40% gives PF 0.11. That
is the tool refusing to flatter noise — which is the behaviour you want when you
point it at real bars.

## Validating and tuning it on your own market

```bash
python3 backtest/fetch_yahoo.py data MNQ=F     # 60 days of 5m/15m, 2 years of 1h
python3 backtest/ict_backtest.py selftest      # engine checks, no data needed
python3 backtest/ict_backtest.py run  data                      # every CSV
python3 backtest/ict_backtest.py run  data/MNQ_5m.csv '{"min_score": 4}'
python3 backtest/ict_backtest.py wf   data/MNQ_5m.csv           # 60/40 split
```

`ict_engine.py` is a faithful port of the Pine logic — same rules, same
pessimistic fill model — so whatever the `wf` run validates can be typed
straight into the indicator's inputs. Known differences: the Pine script reads
PDH/PDL/settlement from TradingView's daily bars while the port aggregates the
intraday series into CME trading days (18:00–17:00 ET), and SMT needs a second
CSV offline (it is automatic in Pine). Pass the instrument's tick size when it
is not a Nasdaq future — `'{"tick": 0.25}'` is the default, ES/MES is also 0.25,
gold 0.1, most FX 0.00001.

**Frequency dials**, in the order worth trying: `minScore` (3 → 2 loosens,
3 → 4 tightens) · `hrlMax` · `fallbackRR` (set 2.0 to trade when no pool pays,
0 to skip) · `sweepATR` and `dispATR` (lower = more raids and softer
displacement) · the killzone windows themselves · `entryValid` (how long a limit
waits for its retracement).

## Honest limitations

- This is an indicator-side simulation, not a `strategy()` backtest: no
  commission, slippage or position sizing in the R tally. Limits earn maker
  fills on futures, but the fill assumption is still optimistic in fast markets.
- The dashboard numbers are the model's record *on the chart you are looking
  at*. Change symbol, timeframe or inputs and they change with it — that is the
  point of it grading itself rather than quoting me.
- Designed for 1m–15m intraday charts; 5m is the reference. On higher
  timeframes the killzone logic stops meaning anything.
- SMT needs the sibling contract to exist on your data feed. If it can't
  resolve, that confluence point is simply never awarded — the script does not
  break.
- Three setups a day is a *ceiling*, not a promise. On quiet days the sequence
  does not print and the correct number of trades is zero.

---

# 2 · Alpha Predictive Limit Matrix

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
