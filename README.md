# MMT — Nasdaq futures intraday research

This repo started as a Pine indicator that faded liquidity sweeps on MNQ/NQ and
reported a profit factor of 1.35. This pass rebuilt the evidence base from
scratch: 11.9 years of 1-minute Nasdaq data, a cost model, an execution
simulator that resolves fills on the minute clock, and a validation harness.

**The headline is negative, and it is the most useful thing here.** The sweep
setup this repo was built on has no measurable forward edge. Neither does any
of the eleven other intraday predictors tested against it. The one candidate
left standing — an opening-range breakout — is positive in walk-forward but
fails its significance test once you account for how many configurations were
searched to find it.

That result cost a lot of compute to establish and it is worth more than
another indicator would have been. Details below, including the two bugs that
each produced a spectacular fake edge before being caught.

---

## What you should actually take away

| Question you asked | Answer the data gives |
|---|---|
| Best timeframe? | **15m–60m for decisions, 1m for execution.** Not because higher is magic, but because friction is fixed per trade: it costs 0.147R per trade at 1m and 0.020R at 60m. At 1m you must out-earn a 15% handicap on every trade. |
| Top/bottom-tick entries with high RR and no tradeoff? | Not available. A limit at the extreme is a *worse* fill rate, not a free better price — that is the tradeoff, and it is priced. Across the whole sweep study, entering closer to the extreme bought a better price and lost more than it gained in missed trades. |
| MNQ or NQ? | **NQ if you can carry it.** Costs are 0.71pt round turn on NQ versus 1.10pt on MNQ — a third less drag for the identical trade, because commission does not scale with the 10x contract size. |
| Is there an elite edge in here? | Not one that survives validation. What survives is the *machinery* to test the next idea in an afternoon instead of three versions of self-deception. |

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

## MMT-ORB — the one candidate, and its honest numbers

`indicators/mmt_orb_nq.pine`, `research/orb.py`. Break of the opening range,
stop at the far side, risk capped, flat at 15:55 ET. Shipped as a Pine
`strategy()` rather than an indicator so TradingView's engine grades it
independently of my Python.

**Anchored walk-forward, 8 folds, parameters chosen only on prior data, MNQ
costs charged, stitched out-of-sample:**

```
n = 2,639   WR 39.2%   PF 1.09   +0.043R/trade   net +113.8R   maxDD 29.7R
```

And then the tests that matter:

| test | result | reading |
|---|---|---|
| Deflated Sharpe (Bailey & López de Prado) | **PSR 0.071** | per-trade Sharpe 0.031 vs a 0.058 null threshold for a 384-config search — **the result is worse than the best of 384 coin flips** |
| t-stat, 2,639 OOS trades | +1.58 | not significant |
| Block bootstrap, expectancy | +0.042R, 5–95%: **+0.002 to +0.083** | the low end is zero |
| Bootstrap drawdown | median 42.9R, 95th pct **79.8R** | a plausible drawdown is 70% of the entire 11-year gain |
| Buy and hold 09:30→15:55, same period | **$15,745** vs ORB's $20,883 | the margin over doing nothing clever is inside the noise |

**Per year, out-of-sample:**

```
2016  -5.1R   2017  -3.2R   2018 +26.6R   2019  +3.7R
2020  +0.6R   2021  +0.4R   2022 +31.8R   2023  +0.8R
2024 +34.7R   2025 +32.9R   2026  -9.4R (partial)
```

Four years produced essentially all of it. On the raw un-walk-forward version
the split is starker: **six consecutive losing years to 2020, five consecutive
winning years from 2021, negative again in 2026.** That is a regime change —
plausibly the 0DTE/retail-flow era — not a stable edge. It may persist. You
cannot tell from this data, and anyone who tells you otherwise is selling.

Costs are not what kills this one; the edge is simply small:

| setup | round-turn cost | as fraction of avg 74pt risk | net expectancy |
|---|---|---|---|
| MNQ, modelled | 1.10pt | 0.015R | +0.034R |
| MNQ, 2-tick slippage | 1.60pt | 0.022R | +0.025R |
| NQ (10x contract) | 0.71pt | 0.010R | **+0.041R** |

Cost drag by decision timeframe, from the sweep study — this is the number
that should govern your timeframe choice more than any pattern:

| tf | 1m | 3m | 5m | 15m | 30m | 60m |
|---|---|---|---|---|---|---|
| cost, R/trade | 0.147 | 0.077 | 0.063 | 0.037 | 0.027 | 0.020 |

---

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

**What genuinely worked, and still does:** breakeven-at-+1R management (it
converts roughly 40% of losses into scratches — the largest single
improvement found across all versions); volatility-normalised stops; strict
walk-forward; cross-validation on a correlated instrument; pessimistic
tie-breaking in the fill model.

---

## Layout

```
research/
  core.py          bars, resampling, ET session clock, indicators (self-testing)
  engine.py        execution simulator, MNQ cost model, trade ledger
  strategy.py      liquidity-sweep signal generation (causality self-tested)
  probe.py         forward-excursion edge probe vs matched baseline
  edge_search.py   feature/response scan + the three nulls
  events.py        ORB / intraday-momentum / time-of-day event studies
  orb.py           MMT-ORB strategy and its walk-forward
  validate.py      walk-forward, deflated Sharpe, block bootstrap
  diagnose.py      final report on the OOS ledger
  fetch_duka.py    1-minute history downloader
  repair_duka.py   coverage repair
indicators/
  mmt_orb_nq.pine              MMT-ORB as a Pine v6 strategy()
  alpha_predictive_limit_matrix.pine   previous sweep indicator (superseded)
```

Reproduce:

```
pip install numpy
python3 research/fetch_duka.py 2015 && python3 research/repair_duka.py 5
cd research
python3 core.py && python3 engine.py && python3 strategy.py   # self-tests
python3 probe.py          # the sweep premise
python3 edge_search.py    # feature scan against the null
python3 events.py         # documented effects
python3 diagnose.py       # walk-forward ORB + significance
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
