# MMT — MNQ trading research

Two TradingView (Pine Script v6) indicators, each shipped with the real-data
backtest that grades it.

| indicator | file | what it is |
|---|---|---|
| **MNQ Reversal Zones** | `indicators/mnq_reversal_zones.pine` | no-lag reversal zones with a live scorecard — [details](#mnq-reversal-zones) |
| Alpha Predictive Limit Matrix | `indicators/alpha_predictive_limit_matrix.pine` | sweep-rejection limit setups for the 1H chart — [details](#alpha-predictive-limit-matrix) |

---

# MNQ Reversal Zones

**The brief:** mark the top and bottom ticks of 100+ point MNQ reversals, with
no lag, using only things that have an edge, proven on real data.

**The result:** that indicator cannot be built, and the data shows why. Every
reversal idea was tested on 1,212 sessions of real 1-minute Nasdaq-100 data
against a null model. None of them calls tops or bottoms better than chance by
a margin that survives scrutiny. What *can* be built honestly is here: zones
that are drawn before price arrives, marks that print on the bar they happen,
and a scorecard that shows the hit rate next to the chance rate so the script
can never look better than it is.

| what gets marked (target 100 pts) | reversed | chance | points per mark, before costs | verdict |
|---|---|---|---|---|
| **Tap** — first touch of a zone, zero lag | 14.6% | 17.2% | **−3.2** (t = −5.9 vs null) | reliably worse than chance |
| **Reclaim, bottoms** — a bar closes back above a swept low | 23.3% | 22.5% | **+2.3** (t = +1.3 vs null) | best thing tested; not proven |
| **Reclaim, tops** — a bar closes back below a swept high | 18.9% | 19.8% | −0.4 (t = −1.1 vs null) | no edge |

In plain words: **fading the first touch of a level loses. Waiting for a
failed breakdown to close back above the level roughly breaks even. Tops
showed nothing.**

## The arithmetic no indicator escapes

Put a marker anywhere and ask one question: does price travel 100 points away
from it (a reversal) before it runs X points past it (heat)? In a market with
no memory the answer is `X / (100 + X)`. Here is that question asked 60,000
times at random moments on the **real MNQ contract** (1-minute bars,
2026-10-12 → 2026-11-10):

| heat allowed past the marker | 5 | 10 | 15 | 20 | 30 | 40 | 50 | 75 | 100 | 150 | 200 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| reversed 100 pts first | 4.9% | 9.1% | 12.9% | 16.5% | 23.0% | 28.7% | 33.4% | 42.7% | 50.0% | 60.2% | 66.4% |
| `X / (100 + X)` | 4.8% | 9.1% | 13.0% | 16.7% | 23.1% | 28.6% | 33.3% | 42.9% | 50.0% | 60.0% | 66.7% |

Real MNQ sits on the line to within a few tenths of a percent. That is the
whole problem with "top tick" tools: precision (small X) and hit rate are the
same dial. A marker that is right 9 times in 10 on a 100-point reversal needs
about 900 points of room. An indicator has an edge only to the extent it
beats this line, so everything below is measured against it.

## What the indicator draws

**Zones** — each is created the moment its level becomes known and never moves
afterwards. A top zone sits on a prior high, a bottom zone on a prior low; its
depth (default 0.06 × the 20-session average range) is how far past the level
price may run before a tap is called failed.

| zone | level | known at (New York) |
|---|---|---|
| ONH / ONL | overnight high / low, 18:00 → 09:30 | 09:30 |
| LOH / LOL | London high / low, 03:00 → 09:30 | 09:30 |
| ASH / ASL | Asia high / low, 18:00 → 03:00 | 03:00 |
| PDH / PDL | prior-day RTH high / low | 18:00 |
| 5DH / 5DL | 5-session high / low | 18:00 |
| PWH / PWL | prior-week high / low | 18:00 |
| ORH / ORL | opening range, 09:30 → 10:00 | 10:00 |
| IBH / IBL | initial balance, 09:30 → 10:30 | 10:30 |
| AMH / AML | morning session, 09:30 → 12:00 | 12:00 |
| SWH / SWL | intraday swing high / low | once price has retraced 0.2 × ADR from it |

**Tap** (`▼ ONH`, `▲ SWL`) — the first bar that trades at the level, marked on
that bar at the level price, the instant it happens. The alert fires on the
touch, not on the bar close. This is the zero-lag mark, and it is the one the
backtest says not to fade.

**Reclaim** (`⟲ SWL`) — after a tap, the first *later* bar that closes back
inside the level within 30 minutes, provided price never ran more than
0.2 × ADR beyond it. Marked on that bar at its close. This costs one bar close
of lag: over the backtest the mark printed a median 23 points behind the
sweep low (33 points over the last 12 months, when ranges were larger). It is
never painted back onto the low. Top reclaims are counted on the scorecard
but hidden by default, because they showed no edge.

**Scorecard** — for taps and reclaims, top and bottom: how many, how many
reached the target, how many failed, hit %, the chance % for the same risk,
and points per mark. The hit % is coloured only when it differs from chance by
two standard errors or more. Underneath it prints the 1,212-session backtest
line, because a 1-minute chart only loads a few sessions of history.

**No repainting, by construction.** Levels come from sessions that have
closed. Daily and weekly context uses completed bars only. A tap is "high ≥
level", which cannot un-happen inside a bar. A reclaim is evaluated only on a
confirmed bar close. Nothing is ever moved or back-dated.

## Backtest

### Data — real prices only

| source | what | span |
|---|---|---|
| Dukascopy historical feed, `USATECH.IDX/USD` | 1-minute bars of a Nasdaq-100 CFD quoted from the futures | 2022-01-20 → 2026-11-09, 1,616,040 bars; evaluated from 2022-03-01 (1,212 sessions) |
| Yahoo Finance, `MNQ=F` | the actual CME contract | 1-minute: 22 sessions (2026-10-12 → 11-10); 5-minute: 50 sessions (2026-09-01 → 11-10) |
| Yahoo Finance, `NQ=F` daily | long-term trend, daily-scale test | 2000-09 → 2026-11 |

Free intraday history for the MNQ contract itself only goes back about a
month, so the long study uses the CFD and the contract is used as a check.
The CFD is a fair stand-in: over the 27,066 one-minute bars where both exist,
their 1-minute returns correlate **0.9935** (5-minute: 0.9987) with no lead or
lag, and average 1-minute ranges are 15.4 vs 16.3 points. Only the absolute
price differs, by the futures basis (226 → 104 points over that month).

### Method

- **Engine** (`backtest/rz_engine.py`) walks the bars exactly as the Pine
  script does. `backtest/rz_pine_mirror.py` is a statement-by-statement
  transliteration of the Pine script; it reproduces the engine's counts, hits,
  fails and points exactly on 1-minute, 5-minute and real MNQ bars.
- **Pessimistic grading.** A tap fails when price trades beyond the far edge
  of the zone; a reclaim fails when price trades back through the sweep
  extreme (+ 0.01 × ADR). Inside one bar the failing side is always assumed to
  print first, and a hit is never credited on the bar that created the mark.
  Marks unresolved after 600 minutes are closed at the market.
- **Null model** (`backtest/rz_null.py`). Every bar of the real series is
  kept — its range, its place in the day — but each bar and each gap is
  mirrored up/down with probability ½. Volatility clustering and the
  time-of-day profile survive; direction becomes a coin flip. The identical
  rules are run on 10 such copies. "Edge" below always means real minus null.
- **Points, not just hit rate.** Real breakdowns run deeper than scrambled
  ones, so real bottom reclaims carry wider stops (32 vs 28 points) and a
  mechanically higher hit rate. Comparing raw hit rates overstated the reclaim
  edge (it looked like +3.5 points of hit rate, z = 4.7). Points per mark, and
  hit % against each mark's own chance %, are the fair comparisons and are
  what is reported.
- **No costs.** Figures are before commissions and slippage (roughly 1 point
  per round trip on MNQ).

### Results — 1-minute, 1,212 sessions, target 100 points

| | marks | hit % | chance % | null hit % | pts / mark | null pts | edge (pts) | t |
|---|---|---|---|---|---|---|---|---|
| Taps (12.0 per session) | 14,504 | 14.60 | 17.18 | 16.08 | −3.21 | −0.93 | −2.28 | −5.88 |
| Reclaims, bottoms (2.4 per session) | 2,957 | 23.31 | 22.46 | 19.85 | +2.28 | +0.89 | +1.39 | +1.33 |
| Reclaims, tops | 3,129 | 18.93 | 19.81 | 19.78 | −0.38 | +0.63 | −1.01 | −1.09 |

Points per mark by year:

| | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|
| Taps | −4.03 | −1.28 | −2.33 | −4.89 | −3.60 |
| Reclaims, bottoms | −2.72 | +3.75 | +4.87 | +2.87 | +1.97 |
| Reclaims, tops | +3.47 | −1.94 | −1.85 | −0.44 | −0.28 |

- Taps lose in every year. No zone family is an exception that holds up:
  intraday swing highs/lows, the most common zone (8,854 taps), reverse 1.7
  points of hit rate *less* often than the null (z = −4.2). Two of the ten
  families were positive (London +3.6, z = 2.0; 5-session +3.0, z = 1.4),
  which is what ten tries at chance produce.
- Bottom reclaims are positive in four of five years and negative in the 2022
  bear market — the one year top reclaims were positive. Split by the
  200-session trend, bottom reclaims average +2.9 points per mark above it
  (2,184 marks) and +0.2 below it (743 marks).
- Against zero the bottom-reclaim figure has t = 2.2; against the null, 1.3.
  After about a point of costs it is roughly break-even.

Same rules on other data and settings:

| | taps: pts / mark (edge, t) | bottom reclaims | top reclaims |
|---|---|---|---|
| 5-minute chart, 1,212 sessions | −3.34 (−2.37, t = −6.0) | +1.57 (+1.25, t = +0.8) | −2.20 (−2.55, t = −1.9) |
| target 50 pts | −3.35 (−2.12, t = −7.1) | +0.94 (+0.51, t = +0.7) | +1.58 (+1.34, t = +2.0) |
| target 200 pts | −2.90 (−2.21, t = −4.4) | +2.67 (+1.44, t = +1.0) | −1.82 (−2.44, t = −2.0) |
| target 0.2 × ADR | −3.38 (−2.36, t = −6.7) | +0.89 (−0.02, t = 0.0) | +0.63 (+0.23, t = +0.3) |
| **real MNQ=F**, 1-minute, 22 sessions | −2.70 (−2.96, t = −1.0), 330 taps | +3.49 (+7.16, t = +0.8), 71 marks | +11.03 (+10.81, t = +1.2), 63 marks |
| **real MNQ=F**, 5-minute, 50 sessions | −6.42 (−5.75, t = −2.9), 654 taps | −7.97 (−7.98, t = −1.0), 108 marks | +3.13 (−0.01, t = 0.0), 120 marks |

The tap result is the same everywhere it can be measured, including on the
real contract. The reclaim result never reaches significance in either
direction; the real-MNQ samples are a month or two and far too small to
settle a 1–2 point effect.

## Everything else that was tried

Each idea was turned into a causal marker and run through the same null model
(`backtest/rz_research.py`). "Lift" is hit rate minus the null's, in
percentage points, for a reversal of 0.2 × ADR before 0.06 × ADR of heat
(chance ≈ 23%), on 2022-03 → 2026-11 unless noted.

| idea | what happened |
|---|---|
| First touch of prior-day / overnight / London / Asia / weekly / multi-day highs & lows, opening range, initial balance, intraday swings (25,874 touches) | At or below chance across the board. Swings −2.7 (z = −6.3), prior-day −4.1 (z = −3.1), opening range −3.0, overnight −2.3, prior-week −4.3. Best family: the high/low from three sessions back, +1.1 (z = 0.5). |
| Context at the touch: time of day, extension from open / prior close, approach speed, RSI, day range used, multi-day trend, confluence of levels … 33 features, gradient-boosted model, blocked cross-validation (24,483 taps) | AUC **0.509** — no skill. Predicted reversal rate ranges 15% → 27% across deciles; the actual rate is flat at ~20%. |
| Level confluence | An early version counted levels that the reversal itself later created. That look-ahead leak alone lifted the model's AUC from 0.49 to 0.62. Fixed, the effect is zero. Most "confluence" backtests have this bug. |
| Fade a fast move (0.08–0.8 × ADR within 5–120 minutes; 15 settings, 390–41,912 events each) | Lift between −2.7 and +1.6; the one setting beyond two standard errors is negative. In RTH, spikes up continue slightly (−0.9, z = −4.5). |
| Fade the preceding move at a fixed clock time (39 times × 3 lookbacks = 117 cells) | Unstable. Fading the last 30 minutes at 15:00 ET: **−5.5** (z = −3.5) in 2022-03 → 2024-12, **+5.7** (z = +3.0) in 2025-01 → 2026-11. Across all 117 cells the lifts in the two periods are uncorrelated (r = −0.10). The only two cells beyond two standard errors with the same sign in both periods are negative (02:00 and 18:00 ET: the move continues). |
| ES / NQ divergence at a new 4-hour extreme (joint null, 2026-02 → 2026-11) | NQ at a new extreme while ES is not: −0.3 (z = −0.2). When ES confirms: −2.6 (z = −2.5) — a slight continuation. |
| Round numbers (real MNQ=F prices, 1-minute and 5-minute files) | x000 levels +3.9 (39 touches) and +6.6 (71 touches), z ≤ 1.3 — too few to call. x500, x250/x750 and other hundreds: nothing beyond noise. |
| Volume climax at a new 30-minute extreme (real MNQ=F volume) | Lift between −6.3 and +1.8 across volume buckets, |z| ≤ 1. |
| Failed breakout — a bar closes back inside the level | The only idea with anything in it, and what the reclaim tier is. See above. |
| Daily bars, real NQ=F since 2000 | Oversold closes do bounce: after RSI(2) < 10 the next session averaged +0.31% in 2021–2026 (t = 2.2) and +0.28% in 2000–2012, against +0.06% and +0.01% on all days. Overbought closes do **not** fall (+0.12%). It is a bottoms-only effect on a daily scale; a drift that size shifts the odds of a 100-point intraday bet by about one percentage point. |

The only robust finding is negative: levels break slightly more often than
they hold. That agrees with the published work on intraday momentum (below).

## What this means in practice

- **Do not fade the first touch of a level.** It is the one statement here
  with strong statistics behind it, and it costs about 3 points per attempt.
- **If you trade reversals at these levels anyway**, the reclaim of a swept
  low is the least-bad timing: about 3 in 10 reach 100 points in the current
  volatility, with the sweep low as the natural invalidation (a median 37
  points away over the last 12 months). Treat it as a way to define risk, not
  as a prediction.
- **There is no tested way to time tops.**
- A tool that appears to mark exact tops and bottoms on past data is
  repainting, or showing only its winners. The table at the top of this
  section is why.

## Using it

1. TradingView → Pine Editor → paste `indicators/mnq_reversal_zones.pine` →
   Add to chart. Use MNQ or NQ with the full electronic session visible.
2. Chart timeframe: 1 minute matches the backtest; 5 minutes was tested too.
   Sessions end at :00 or :30, so any timeframe that divides 30 minutes
   (1, 2, 3, 5, 10, 15, 30) works.
3. Alerts: "Any alert() function call" delivers taps on the touch and
   reclaims on the bar close, with the level and the failure price in the
   message. Separate alert conditions exist for top taps, bottom taps, bottom
   reclaims and top reclaims.
4. Inputs: reversal target (default 100 points), zone depth (0.06 × ADR or
   fixed points), reclaim window, which zone families to draw, whether to
   show top reclaims.

The script was written without access to TradingView's compiler, which does
not run outside TradingView. Its logic is verified against the backtest by
the transliteration above and its structure by a lint, but it has not been
compiled. If TradingView reports an error on first load it will name a line.

## Limits

- The long history is a CFD, not the futures contract. It does not trade
  16:15–18:00 New York, and the Sunday 18:00–20:00 reopen was not downloaded.
- Yahoo's MNQ feed has gaps and at least one bad bar (2026-10-30 15:03 New
  York, a 1,268-point one-minute "range" no other source shows); it is
  repaired by `rz_data.clean_yahoo` and the repair is reported at run time.
- No commissions or slippage.
- On a continuous futures chart the price jumps on contract roll days, so
  levels carried over from the old contract (prior-day, weekly, 5-session)
  are offset by the roll gap for that session.
- If two zones are tapped on the same bar, both are marked but only one
  `alert()` is sent for that bar.
- 1,212 sessions cover one bear market (2022) and one long advance. The
  bottom/top asymmetry reversed in the bear market, so it may be a statement
  about the trend rather than about bottoms.
- The parameters (zone depth 0.06 × ADR, 30-minute reclaim window, 0.2 × ADR
  swings) were chosen while looking at the 2025–2026 half of the data and
  then run on 2022–2024. They were not optimised, and the conclusions do not
  depend on them, but they are not a pre-registered protocol either.

## Reproduce

```bash
pip install numpy pandas requests numba scikit-learn
```

```bash
python3 backtest/rz_data.py yahoo data/yahoo
```

```bash
python3 backtest/rz_data.py duka data/nq USATECHIDXUSD 2022-01-20 2026-11-09
```

```bash
python3 backtest/rz_backtest.py duka data/nq --start 20220301 --null 10 --by-year --trend-daily data/yahoo/NQ_1d.csv
```

```bash
python3 backtest/rz_backtest.py csv data/yahoo/MNQ_1m.csv --daily data/yahoo/MNQ_1d.csv --trend-daily data/yahoo/MNQ_1d.csv --null 40
```

```bash
python3 backtest/rz_pine_mirror.py duka data/nq --start 20250601 --trend-daily data/yahoo/NQ_1d.csv
```

```bash
python3 backtest/rz_research.py law --duka data/nq --yahoo data/yahoo --start 20250701
```

`rz_research.py` also takes `proxy`, `levels`, `ml`, `shock`, `clock`,
`round`, `volume`, `smt` (needs `--spx` with `USA500IDXUSD` day files) and
`daily`. The Dukascopy feed is slow and throttled; the full download takes
one to several hours. Add `--tf 5` to `rz_backtest.py` for the
5-minute chart, `--set target_pts=200` and the like for other settings.

## What the published research says

Read from abstracts and summaries, not full texts.

- Published support and resistance levels do interrupt intraday trends more
  often than arbitrary levels, in FX
  ([Osler 2000](https://www.newyorkfed.org/medialibrary/media/research/epr/00v06n2/0007osle.pdf)).
  Take-profit orders cluster *at* round numbers and stop-losses just
  *beyond* them, so levels produce both reversals and accelerations
  ([Osler 2003](https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr125.pdf),
  [Osler 2005](https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr150.pdf)).
- Intraday index returns show momentum, not reversal: the first half hour
  predicts the last
  ([Gao, Han, Li & Zhou 2018](https://econpapers.repec.org/RePEc:eee:jfinec:v:129:y:2018:i:2:p:394-414)),
  more so when dealers are short gamma
  ([Baltussen, Da, Lammers & Martens 2021](https://www3.nd.edu/~zda/intramom.pdf)).
- Breaks out of the time-of-day "noise area" tended to continue
  ([Zarattini, Aziz & Barbon 2024](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172));
  an out-of-sample test over 2024-05 → 2026-03 found the edge had largely
  gone ([Paz](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7290621)).
- The overnight drift in equity futures
  ([Boyarchenko, Larsen & Whelan 2023](https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr917.pdf))
  was flat over 2021–2025
  ([Liberty Street Economics, 2026](https://libertystreeteconomics.newyorkfed.org/2026/07/the-disappearing-overnight-drift/)).
- Large opening moves in index futures reversed intraday in 1987–2002, but
  the significance dropped sharply after a bid-ask adjustment
  ([Grant, Wolf & Yu 2005](https://ideas.repec.org/a/eee/jbfina/v29y2005i5p1311-1327.html)).
  An earlier study found the reversals profitable after costs, though not by
  much ([Fung, Mok & Lam 2000](https://scholars.hkbu.edu.hk/en/publications/intraday-price-reversals-for-index-futures-in-the-us-and-hong-kon/)),
  and on Nasdaq-100 futures the overnight move tends to reverse intraday
  ([Yu, Rentzler & Wolf 2005](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=712168)).
- Returns to short-term reversal are payment for providing liquidity and rise
  with volatility ([Nagel 2012](https://www.nber.org/papers/w17653)).
- After a directional change of a given size, the average further move is
  about that same size
  ([Glattfelder, Dupuis & Olsen 2011](https://arxiv.org/abs/0809.1040)).
- No independent, out-of-sample test of fair-value gaps or order blocks was
  found; the published "backtests" are vendor pages.

---

# Alpha Predictive Limit Matrix

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
