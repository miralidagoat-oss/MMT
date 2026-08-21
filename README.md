# MMT — Nasdaq futures research

Three strategies, all walk-forward validated on 11.9 years of 1-minute data
with MNQ costs charged. Headline first, because the answer is not the one that
was asked for.

**NQ's intraday session has no edge in it. Its return happens overnight.**

| | intraday 09:30→15:55 | overnight 15:55→09:30 |
|---|---|---|
| drift | +2.13 pts/day | **+4.54 pts/day** |
| t-stat | +0.80 | **+2.18** |
| Sharpe | 0.23 | **0.63** |
| profitable years | 6 / 12 | **10 / 12** |

That single decomposition explains every result in this repo. Three
generations of intraday rules all landed at a profit factor near 1.00 because
they were dividing up a session whose total drift is statistically zero. The
money is in the window when the cash market is shut.

---

## The strategies, WR and PF by year

All numbers are **out-of-sample**: parameters for each year come only from
prior years. Costs charged every trade (MNQ: $1.20 commission + 1 tick
slippage per side).

### MMT-N — overnight hold, trend-filtered, vol-targeted  ← the one to trade

`indicators/mmt_n_overnight.pine` · `research/overnight.py`

| year | nights | WR % | PF | net pts | $ (1 MNQ) |
|---|---|---|---|---|---|
| 2017 | 257 | 56.4 | 1.38 | +974 | +1,947 |
| 2018 | 209 | 56.0 | 0.89 | −390 | −780 |
| 2019 | 219 | 56.2 | 1.08 | +340 | +679 |
| 2020 | 237 | 60.3 | 1.27 | +1,426 | +2,852 |
| 2021 | 258 | 57.8 | 1.16 | +1,311 | +2,621 |
| 2022 | **15** | 46.7 | 0.39 | −475 | −950 |
| 2023 | 237 | 50.2 | 1.15 | +989 | +1,979 |
| 2024 | 259 | 55.6 | 1.42 | +3,771 | +7,543 |
| 2025 | 211 | 59.7 | 1.68 | +6,277 | +12,555 |
| 2026 | 147 | 54.4 | 1.15 | +1,420 | +2,840 |
| **all** | **2,049** | **56.3** | **1.27** | **+15,643** | **+31,287** |

Sharpe 1.21 · t = +3.46 · max drawdown 2,063 pts · 8 of 10 years positive.

Look at 2022: fifteen nights. The trend filter took the strategy flat through
the bear market. Unfiltered, 2022 cost 3,382 points — more than any other
year made. **The filter is the strategy.** Do not switch it off because it
looks like it is missing trades.

### MMT-X — intraday multi-signal model

`research/model.py`. Ridge over 28 features (NQ microstructure + S&P and
bond cross-asset), triple-barrier labels, hyperparameters chosen on a
validation split, refit and traded each year forward.

| year | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | all |
|---|---|---|---|---|---|---|---|---|
| PF | 1.30 | 1.43 | 1.31 | 0.61 | 1.28 | 1.03 | 1.15 | **1.13** |
| WR % | 47.9 | 50.6 | 50.7 | 40.6 | 58.5 | 51.6 | 50.0 | **51.6** |

667 trades, +0.029R each. Six of seven years positive, which looks better
than it is: 667 trades is a thin sample and PF 1.13 at that count is not
significant. Worth noting for one reason only — the cross-asset features are
what lifted it. On NQ data alone the identical model returns **PF 0.92**.

### MMT-ORB — opening range breakout

`indicators/mmt_orb_nq.pine` · `research/orb.py`. PF 1.09, WR 39.2% over
2,639 OOS trades. Deflated Sharpe **PSR 0.071** — worse than the best of the
384 configurations searched to find it. Six consecutive losing years to 2020,
five winning years from 2021, negative in 2026. Shipped for completeness and
because the regime story is interesting. **Not recommended.**

---

## What MMT-N actually is, and what it is not

It is not alpha. It is the equity risk premium, collected in the window where
it accrues, with a trend overlay to sit out the regimes that do not pay it.
The night effect is documented across equity indices for two decades
(Cliff/Cooper/Gulen; Lachance; Boyarchenko et al.). You are being paid to hold
risk through the gap.

That has consequences you need to price in:

- **Deflated Sharpe PSR 0.890.** Short of the 0.95 bar. It is the only thing
  tested here that clears its null threshold at all, but it is not proven.
- **Gap risk is the real risk.** Worst night in the sample: −622 pts
  (−$1,245 on 1 MNQ, −$12,449 on 1 NQ). A geopolitical print can gap through
  any stop.
- **Stops do not help — measured on the real overnight path.** A first pass
  that only floored losses said tighter stops improved everything. That test
  was rigged: it never let a stop trigger on a night that would have
  recovered. Walking the actual 1-minute path from 15:55 to 09:30 reverses
  the conclusion:

  | stop | net pts | Sharpe | max DD | worst night |
  |---|---|---|---|---|
  | none | 15,252 | 1.12 | 2,063 | −622 |
  | 2.0× scale | 15,267 | 1.13 | 2,063 | −559 |
  | 1.5× scale | 14,449 | 1.05 | 2,851 | −605 |
  | 1.0× scale | 14,257 | 1.07 | **3,200** | −404 |

  A wide disaster stop is roughly free. Tighter stops cost about 1,000 points
  and make drawdown *worse*. Default is 2.0×, and it is there for the tail,
  not for risk control.
- **Correlated with everything else you own.** This is long index exposure. It
  does not diversify a stock portfolio; it concentrates it.
- **Observation, not a rule:** Monday nights are the only negative weekday
  (−2.65 pts mean vs +11 to +13 on Tue/Wed). Deliberately not built in — a
  five-way split of one sample is how post-hoc rules get born. Watch it
  forward.

---

## The data

`research/fetch_duka.py` + `research/repair_duka.py` pull per-day 1-minute
candles from the Dukascopy free datafeed for `USATECHIDXUSD` (Nasdaq-100).

- **3,561,730 one-minute bars, 2015-01-06 → 2026-07-28, 2,998 RTH sessions**
- Validated against the real contract over the 60-day overlap with Yahoo's
  `MNQ=F` 5-minute series: **return correlation 0.9894**, return volatility
  9.13bp vs 9.14bp, median 30-minute opening-range width 243.4pt vs 243.5pt.
  It is the same tape.

This matters because it is the thing the previous study could not have. Yahoo
caps intraday history at 7 days of 1m and 60 days of 5m, so every sub-hourly
verdict in the old README rested on 16 to 75 trades. Those verdicts were not
wrong so much as uninformative.

The first download pass silently lost 40% of the days: an empty HTTP body was
treated as "this day has no data", which is indistinguishable from a throttled
request. `repair_duka.py` retries until coverage stops improving and accepts
only a real 404 as absence. **Check coverage before trusting a backtest** —
1,226 trading days in what should be 2,900 is a data bug wearing a strategy's
clothes.

---

## Two bugs that each produced a fake edge

Both were caught by controls, not by reading the code. Both would have looked
like a discovery.

### 1. One leaking bar out of 390 manufactured an IC of −0.34

The overnight-range features scored an information coefficient of **−0.342
against end-of-day returns, z = −43, and were stable to three decimal places
across both halves of the sample** (−0.347 / −0.338). That is not a good
signal; that is an impossible one.

The cause: the overnight window for day D was defined as "not RTH, session
flipping at 18:00 ET", which put day D's own **16:00 print — the closing
price — inside day D's overnight high/low**. One bar per day. That bar leaks
the session's outcome into a feature used to predict that session, and it
leaks with exactly the sign of the effect being measured.

Fixed to "from D−1's 16:00 close up to, but not including, D's 09:30 open":

| feature → response | IC before | IC after | verdict |
|---|---|---|---|
| `on_range_pos` → EOD | −0.342 (z −43) | **+0.015 (z +1.0)** | artifact |
| `dist_onh` → EOD | −0.308 (z −37) | **+0.021 (z +0.9)** | artifact |
| `dist_onl` → EOD | −0.260 (z −21) | +0.019 (z +3.0) | weak |

Nothing else in the scan exceeded |IC| 0.02.

### 2. The weekday mapping deleted every Friday

`weekday = (day + 4) % 7` puts Sunday at 0, because 1970-01-01 was a Thursday
and Monday-zero indexing needs `+3`. Every `wd < 5` session filter in the
codebase was therefore keeping Sundays and **discarding all 600 Fridays**.
The panel was 2,408 sessions when it should have been 2,998. `core.py` now
asserts the mapping against five known calendar dates.

### The control that found the first one

The IC table alone cannot tell you which of its rows are real. Three nulls
were tried and they disagreed, which is the informative part:

- **synthetic random walk** → `on_range_pos` IC −0.19, t −122, era-stable. On
  data with no edge in it whatsoever.
- **day-permuted responses** → IC ≈ 0.00. This null breaks the shared `C_m`
  term between feature and response, so it cannot see that class of artifact
  at all — it dissolves the very thing in question.
- **path permutation** (`edge_search.path_null_panel`) → the decisive one.
  Each day keeps its real overnight context but receives another day's
  intraday path, volatility-matched. Every shared-term and horizon-shrinkage
  effect survives intact; only the genuine link is destroyed.

Under the third null the leak was unmissable. **A significance test whose null
does not preserve the geometry of your estimator is not a significance test.**

---

## What was tested and what it did

### The original premise: liquidity sweep + reclaim

`research/probe.py` measures forward excursion after a sweep of a *named*
level (prior-day, overnight, opening-range extremes) with a close back inside
— a stricter and better-motivated setup than the rolling-N-bar sweep the old
indicator used. No entry model, no exit model, no costs, against a matched
baseline of every other bar in the same session window:

| timeframe | MFE/MAE, fade | MFE/MAE, continuation | baseline |
|---|---|---|---|
| 5m | 1.05 | 0.96 | 1.00 |
| 15m | 1.01 | 0.99 | 1.00 |
| 30m | 0.95 | 1.05 | 1.00 |
| 60m | 0.93 | **1.08** | 1.00 |

The setup selects volatile moments — conditional MFE 3.08σ against a baseline
2.27σ — but **symmetrically**. It predicts that something will happen, not
which way. At 30m and 60m the *continuation* side is the better one, which is
the opposite of what the indicator was built to do.

The old README's "MNQ 1h, PF 1.35, 87 trades" was noise. So was the "OOS PF
3.20" from 36 trades. A single 60/40 split is one draw.

### Everything else

`research/edge_search.py` scans 13 causal features against 30m/60m/EOD
forward returns on a 179,020-observation grid; `research/events.py` runs the
documented intraday effects as event studies with MNQ costs charged.

- **Intraday momentum** (Gao, Han, Li & Zhou 2018 — first half-hour predicts
  last half-hour, documented on ES/SPY): **does not replicate on NQ**.
  −0.97pt/day, t = −1.53. Flipped, it is also negative. Both signs lose.
- **Time-of-day drift**: nothing above |t| 2.4, and what there is concentrates
  entirely in 2021+.
- **Day-of-week, gap, VWAP distance, realised-vol ratio, range position,
  distance to prior-day levels**: all |IC| < 0.02, none surviving the null.

---

## MMT-ORB detail, and why costs govern your timeframe

The full ORB numbers are in the table above. Two things from that study
generalise beyond it.

**Cost drag by decision timeframe.** Friction is fixed per trade, so the
faster you trade the more of any edge it eats. This should govern your
timeframe choice more than any pattern:

| tf | 1m | 3m | 5m | 15m | 30m | 60m |
|---|---|---|---|---|---|---|
| cost, R/trade | 0.147 | 0.077 | 0.063 | 0.037 | 0.027 | 0.020 |

At 1 minute you are spotting the market a 15% handicap on every trade. This
is why "scalp the 1-minute for top-tick entries" does not work arithmetically,
before any question of whether the pattern is real.

**MNQ vs NQ.** Commission does not scale with contract size, so the same
trade costs 1.10pt round turn on MNQ and 0.71pt on NQ — a third less drag.
Trade NQ if you can carry the size; trade MNQ if you cannot, and accept the
handicap.


## The failure checklist

Carried forward from the earlier audits, plus what this pass added. Every item
is enforced by an assertion or a control, not by intention.

**Caught previously** — dead volatility engine (`log(close/close)` ≡ 0);
setups filling on their own signal bar; no outcome accounting at all;
order-flow confirmation reading the wrong wick; zero-risk degenerate setups;
signals firing before the vol engine seeded; correlated signal spam; trades
evicted from the ledger without booking; crypto-tuned parameters applied to
MNQ (PF 0.88 — parameters do not transfer across markets); an EMA trend filter
that hurt a mean-reversion setup.

**Caught in this pass:**

| # | Failure | Guard now in place |
|---|---|---|
| 1 | 16:00 bar leaking the close into the overnight range → fake IC −0.34 | overnight window defined by explicit session boundaries; path-permutation null |
| 2 | `(day+4)%7` deleting every Friday | `core._selftest` asserts the mapping against known dates |
| 3 | NaN poisoning `cumsum` → all-NaN variance ratio | NaN-safe rolling mean; `core._selftest` |
| 4 | 40% of days silently missing from the download | `repair_duka.py`; coverage printed before every study |
| 5 | Reporting a tuned config on the sample that tuned it | walk-forward only; in-sample numbers are not quoted |
| 6 | Ignoring how many configs were searched | deflated Sharpe on every headline result |
| 7 | No fees or slippage anywhere | costs charged in points on every trade; sensitivity table published |
| 8 | Verdicts from 16–75 trades | 2,998 sessions; nothing reported under ~250 trades |
| 9 | ET session clock approximated as UTC−4 | real IANA tz with DST transitions |
| 10 | A stop test that could only ever improve results (it floored losses but never let a stop trigger on a night that recovered) | stops walked on the real 1-minute path; the honest test reversed the conclusion |
| 11 | Hyperparameters picked by my own judgement after seeing results | nested walk-forward — the intraday model drops from PF 1.04 to 0.92 when the grid is chosen honestly, which is the size of that bias |

**What genuinely worked, and still does:** breakeven-at-+1R management (it
converts roughly 40% of losses into scratches — the largest single
improvement found across all versions); volatility-normalised stops; strict
walk-forward; cross-validation on a correlated instrument; pessimistic
tie-breaking in the fill model.

---

## Layout

```
research/
  core.py            bars, resampling, ET session clock, indicators (self-testing)
  engine.py          execution simulator, MNQ cost model, trade ledger
  strategy.py        liquidity-sweep signal generation (causality self-tested)
  probe.py           forward-excursion edge probe vs matched baseline
  edge_search.py     feature/response scan + the three nulls
  events.py          ORB / intraday-momentum / time-of-day event studies
  orb.py             MMT-ORB strategy and its walk-forward
  overnight.py       MMT-N: the overnight strategy + honest stop study
  validate_night.py  MMT-N walk-forward, deflated Sharpe, tail risk
  report.py          regenerates the headline WR/PF-by-year table
  model.py           MMT-X: ridge over 28 features, nested walk-forward
  xpanel.py          cross-asset alignment (S&P, VIX, bonds, gold, FX)
  validate.py        walk-forward, deflated Sharpe, block bootstrap
  diagnose.py        report on the ORB OOS ledger
  fetch_duka.py      1-minute Nasdaq downloader
  fetch_symbol.py    generic multi-instrument downloader
  repair_duka.py     coverage repair
indicators/
  mmt_n_overnight.pine   MMT-N as a Pine v6 strategy()   <- the one to trade
  mmt_orb_nq.pine        MMT-ORB as a Pine v6 strategy()
  alpha_predictive_limit_matrix.pine   original sweep indicator (superseded)
```

Reproduce:

```
pip install numpy
python3 research/fetch_duka.py 2015 && python3 research/repair_duka.py 5
cd research
python3 core.py && python3 engine.py && python3 strategy.py   # self-tests
python3 probe.py            # the sweep premise
python3 edge_search.py      # feature scan against the null
python3 events.py           # documented effects
python3 overnight.py        # the intraday/overnight decomposition
python3 report.py           # MMT-N headline: WR and PF by year
python3 diagnose.py         # walk-forward ORB + significance
```

---

## If you want to keep hunting

The infrastructure is the asset. Three directions the evidence actually points
at, none of them tested here:

1. **Order flow.** Everything above is OHLCV. The information that plausibly
   predicts a sweep's outcome — resting size, aggressor imbalance, book
   depletion — is not in a candle. This is the most likely place for a real
   intraday edge and it needs a different data subscription (Databento
   MBO/MBP-10 for CME).
2. **Cross-asset conditioning.** NQ intraday conditioned on ES, VIX term
   structure, rates, or the NQ/ES spread. Costs nothing to test with the
   existing harness.
3. **Event conditioning.** FOMC, CPI, NFP, opex, quarter-end. Small samples
   per event type, but the effects are large where they exist.

Run each through `edge_search.py` with the path-permutation null before
believing anything, and quote deflated Sharpe on whatever survives.

Cross-asset conditioning has now been tested and is the reason MMT-X exists:
S&P relative value and bond moves lifted the intraday model from PF 0.92 to
1.13. That is real but thin. The obvious extensions, in order of expected
value:

1. **Order flow.** Everything here is OHLCV. Resting size, aggressor
   imbalance and book depletion are not in a candle, and they are the most
   likely place for a genuine intraday edge. Databento MBO/MBP-10 for CME.
2. **VIX term structure.** The VIX spot download is in `research/data`;
   contango/backwardation as a regime input for MMT-N is the single cheapest
   improvement available, because MMT-N is a risk-premium harvest and the
   term structure prices that premium directly.
3. **Event conditioning.** FOMC, CPI, NFP, opex. Small per-event samples but
   large effects where they exist — and MMT-N holds overnight through all of
   them, which is exactly where its tail risk lives.
