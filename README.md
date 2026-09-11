# MMT — Quant Engine

Two Pine Script v6 indicators for CME index futures, each shipped with the
offline research that produced it and with its negative results written down
next to its positive ones.

| indicator | idea | verdict |
|---|---|---|
| [`indicators/po3_vwap_liquidity_sweep.pine`](indicators/po3_vwap_liquidity_sweep.pine) | PO3 (accumulation → manipulation → distribution) + session VWAP + liquidity-pool sweeps | small but real edge, **1H only**: +0.110R per trade over 2,004 CME futures trades (PF 1.47), independently reproduced at +0.070R over 1,544 trades of index-CFD data from a different vendor. 5m, 15m, 30m tested and negative. |
| [`indicators/alpha_predictive_limit_matrix.pine`](indicators/alpha_predictive_limit_matrix.pine) | liquidity-sweep rejection blocks with limit entries | earlier work; MNQ 1H only, PF 1.35 |

---

# PO3 · VWAP · Liquidity Sweep Engine

**File:** `indicators/po3_vwap_liquidity_sweep.pine` · **Instrument:** MNQ1!/NQ1!
(validated on MNQ, NQ, ES, YM, RTY) · **Timeframe: 1H.**

## The setup, in one paragraph

Build a map of the liquidity pools price is actually hunting — previous day and
week highs/lows, Asia and London session extremes, the initial balance, and
unswept fractal pivots, with equal highs/lows flagged because clustered stops
are the strongest magnet on the chart. Wait for price to **raid** one of them by
at least 0.35 ATR and then **close back** on the origin side within two bars.
Require that raid extreme to sit beyond the **weekly open**, so the leg reads as
manipulation — the Judas swing — rather than trend. Enter at the close of the
reclaim bar, stop 0.5 ATR beyond the raid extreme, target 3R, stop to breakeven
at +1R. Session VWAP with volume-weighted bands is drawn as fair-value context.

## What the research actually found

Everything below comes from `backtest/`, on Yahoo CME data: 1H series ≈ 2.4
years (13.7k bars) per instrument, shorter sub-hourly series, all with the
trailing partial bar dropped and malformed OHLC rows discarded.

### It works, modestly, on index futures at 1H

Pooled MNQ + NQ + ES + YM + RTY, 1H, **4-tick round-trip costs charged on every
trade**:

| | value |
|---|---|
| closed trades | 2,004 |
| wins / losses / breakeven scratches | 230 / 427 / 1,347 |
| **expectancy per closed trade** | **+0.110R**, 95% band **[+0.060, +0.159]** |
| net | +220R |
| win rate of the decisive (W+L) trades | 35.0%, CI [31.5%, 38.7%] |
| breakeven win rate at 1:3 | 25.0% |
| profit factor | 1.47 |
| average max drawdown per market | 12R |
| raid extreme *was* the 20-bar extreme | 45% of signals |

The expectancy band clears zero, which is the claim that matters. It is still a
*small* edge: about a tenth of an R per trade.

### How to read the profit factor and win rate — they can lie here

The breakeven rule turns most trades into 0R scratches. A scratch is excluded
from the win rate and contributes almost nothing to gross loss, so **both
headline statistics inflate as the breakeven trigger tightens, while the money
made barely moves.** Measured on the same ~2,000 trades, changing nothing but
the trigger:

| breakeven at | scratches | win rate (W+L only) | profit factor | **expectancy** | avg max DD |
|---|---|---|---|---|---|
| off | 0% | 27.9% | 1.13 | +0.094R | 29R |
| 0.15R | 75% | 39.5% | **1.72** | +0.122R | 9R |
| 0.25R (shipped) | 67% | 35.0% | 1.47 | +0.110R | 12R |
| 0.5R | 51% | 31.1% | 1.28 | +0.099R | 14R |
| 1.0R | 32% | 29.8% | 1.22 | +0.109R | 18R |
| 1.5R | 19% | 29.3% | 1.20 | +0.118R | 20R |

Profit factor moves 1.13 → 1.72 and the win rate 27.9% → 39.5%, while
expectancy spans +0.094R to +0.122R — a range of about **one standard error**,
i.e. flat. A tight breakeven does not earn more money. What it genuinely buys
is **variance**: average drawdown falls from 29R to 12R and R-volatility by a
third, which roughly doubles return per unit of risk. That is a real and
worthwhile improvement — it is just not the improvement the headline numbers
appear to show. **Judge any change by expectancy per closed trade.**

The 0.25R trigger ships because of that variance benefit; it was found by a
user running their own configuration, and the original parameter sweep had
tested {0, 0.5, 1.0, 1.5} and skipped 0.25 entirely.

### Per market and walk-forward, 1H, cost 4 ticks

| panel | trades | WR% | CI | PF | net R |
|---|---|---|---|---|---|
| MNQ in-sample (first 60%) | 243 | 30.0 | — | 1.24 | +16R |
| **MNQ out-of-sample (last 40%)** | 175 | 41.0 | — | **2.03** | +38R |
| MNQ full | 418 | 34.4 | [27.3, 42.3] | 1.52 | +54R |
| NQ full | 417 | 37.2 | [29.8, 45.2] | 1.71 | +68R |
| ES full | 360 | 36.0 | [27.7, 45.3] | 1.39 | +34R |
| YM full | 407 | 34.6 | [26.9, 43.3] | 1.43 | +39R |
| RTY full | 402 | 32.5 | [24.8, 41.3] | 1.28 | +25R |

Out-of-sample beat in-sample. That is the opposite of what overfitting looks
like, but it also means the in-sample 1.07 and the out-of-sample 1.60 bracket a
true value that this sample cannot pin down — treat ~1.2 as the estimate and the
spread as the honest uncertainty.

### Timeframe is not a free parameter — and 5 minutes does not work

This was tested properly rather than inferred. Yahoo caps 5-minute history at
60 days, which is one market regime and far too short to tune on, so 4 years of
1-minute Nasdaq-100 and 2 years of S&P-500 and Dow index CFD data were pulled
from Dukascopy (`backtest/fetch_dukascopy.py`) and **one 5-minute source was
resampled into six timeframes**, so bar size is the only variable that changes:

| TF | trades | WR% | 95% CI | PF | per-index PF (NDX / SPX / DJI) | all 3 positive |
|---|---|---|---|---|---|---|
| 5m | 4,964 | 26.0 | [24.5, 27.5] | 0.86 | 1.02 / 0.68 / 0.83 | 1 of 3 |
| 15m | 2,125 | 24.9 | [22.7, 27.1] | 0.90 | 1.03 / 0.76 / 0.84 | 1 of 3 |
| 30m | 1,478 | 24.9 | [22.3, 27.6] | 0.93 | 1.01 / 0.86 / 0.88 | 1 of 3 |
| **1H** | **1,184** | **28.3** | **[25.3, 31.5]** | **1.13** | **1.15 / 1.07 / 1.16** | **3 of 3** |
| 2H | 922 | 25.3 | [22.1, 28.8] | 0.99 | 1.10 / 0.87 / 0.91 | 1 of 3 |
| 4H | 618 | 26.4 | [22.5, 30.7] | 1.05 | 0.99 / 1.09 / 1.12 | 2 of 3 |

1H is the only row that is positive on every index *and* whose win-rate interval
clears the 25.0% breakeven. It is a genuine peak, not an artefact of which
dataset happened to be used — and it independently reproduces the futures
result on a different data vendor and different instruments.

**Why 1H and not 5m.** The pools this model hunts — previous day and week
extremes, Asia and London session ranges, the initial balance — are *day-scale*
structures. An hourly bar is the resolution at which raiding one and closing
back is a single decisive event. On 5m the same event fragments across many
bars, and the reclaim trigger fires on noise inside the leg.

### The 5-minute investigation, in full

The question was asked directly, so here is everything that was tried.

**The MNQ / NQ 5-minute backtest** (Yahoo continuous front-month, 2026-06-29 to
2026-09-09, 60 days, 4-tick round-trip costs, shipped parameters unchanged):

| | signals | W | L | BE | WR% | 95% CI | PF | net R | exp R | trades/day | median 3R target |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MNQ 5m | 159 | 33 | 77 | 48 | 30.0 | [22.2, 39.1] | 1.23 | +18R | +0.114 | 3.1 | 131 pts |
| NQ 5m | 160 | 31 | 80 | 48 | 27.9 | [20.4, 36.9] | 1.11 | +9R | +0.056 | 3.1 | 128 pts |
| **pooled** | | 64 | 157 | 96 | **29.0** | **[23.4, 35.3]** | **1.17** | +27R | +0.085 | | |

That looks tradeable, and it is the number to be most careful with. The
confidence interval includes the 25.0% breakeven rate, so it is **not
significant**, and over the same 60 days the same settings return ES 0.71,
YM 0.89 and RTY 1.01 — the edge does not exist on the sibling markets. Over
years, S&P 5m is 0.68 and Dow 5m is 0.83.

**What was tried to rescue it, and failed.** Each was corroborated on markets
held back from the choice:

- *Deeper sweeps.* On Nasdaq this is monotone and strong — 5m PF rises 1.02 →
  1.06 → 1.13 → 1.26 → 1.45 as the minimum sweep depth goes 0.35 → 1.5 ATR, and
  the **gross** profit factor rises too (1.125 → 1.54), so it is signal quality
  and not just a wider stop diluting costs. But S&P stays at 0.90 and the rule
  is unusable on the real contract: at 1.5 ATR, MNQ 5m produces **9 signals in
  60 days** and loses (PF 0.59).
- *A participation filter* (reclaim volume vs its 20-bar average) looked like
  the find of the study on 60 days of futures — monotone 0.92 → 0.97 → 1.07 →
  1.24 on the held-back markets — and did not survive 4 years of Nasdaq (0.81).
- *Twelve combinations* of deeper sweeps with volume, VWAP stretch, breakeven
  off, RR 4, wider stops, daily PO3, Globex-only. **Not one was positive on all
  three indices**; S&P 5m was negative in every single one (0.57–0.90).
- *Scaling the fractal pivot window* so a 5m pivot spans the same wall-clock
  time as a 1H pivot (5 → 96 bars). Worse at every step.
- *Capping risk* so targets stay reachable. Below 1 ATR it produces **zero**
  signals — a market entry at the reclaim close cannot produce tight risk.

**Why costs bite harder at 5m.** The gross edge at 5m is real but smaller, and
the stop is much closer, so a fixed per-trade cost is a far larger share of R:

| TF | trades | gross expR | net expR (4 ticks) | cost drag | median 1R |
|---|---|---|---|---|---|
| 5m | 2,267 | +0.062 | +0.012 | 0.050R | 17.7 pts |
| 15m | 974 | +0.039 | +0.015 | 0.024R | 33.5 pts |
| 1h | 567 | +0.088 | +0.078 | 0.010R | 73.0 pts |

At 5m, costs eat **80%** of the gross edge. At 1H they eat 12%.

**On "3R trades targeting at least 30 points".** That constraint is already
satisfied and then some — it is not the binding problem. With RR 3, the median
target is **131 points on MNQ 5m** and about **290 points on MNQ 1H**; only
0.8% of 5m setups would have a target under 30 points. A `Min target size`
input enforces a floor anyway. Note the flip side: a 3R target of 131 points
implies a **44-point stop**, roughly $88 per MNQ contract. Getting a 30-point
target at 3R would need a 10-point stop, and the matched-control test in
`study_geometry.py` shows stops that tight simply get run.

### Time stability — pooled index futures by quartile of each series

| quartile | trades | WR% | PF | net R |
|---|---|---|---|---|
| Q1 | 490 | 28.3 | 1.13 | +32R |
| Q2 | 484 | 26.4 | 1.03 | +8R |
| Q3 | 491 | 34.9 | 1.53 | +120R |
| Q4 | 532 | 29.5 | 1.22 | +56R |

Positive in all four, but more than half the profit lands in Q3. Expect long
flat stretches.

### Cost sensitivity (profit factor, 1H)

| round-trip cost | MNQ | NQ | ES | YM | RTY |
|---|---|---|---|---|---|
| 0 ticks | 1.29 | 1.33 | 1.16 | 1.39 | 1.19 |
| 2 ticks | 1.27 | 1.32 | 1.11 | 1.36 | 1.16 |
| **4 ticks (published)** | **1.26** | **1.31** | **1.07** | **1.33** | **1.13** |
| 8 ticks | 1.24 | 1.29 | 0.99 | 1.27 | 1.07 |
| 16 ticks | 1.20 | 1.25 | 0.85 | 1.16 | 0.97 |

Costs are survivable because 1R is large: a median **385 ticks** on MNQ 1H, so
4 ticks is ~1% of R. That also means the stop is wide — about 96 index points,
$193 per MNQ contract. This is not a scalping model.

## Why I believe the signal, and not just the backtest

**The placebo test.** A stop/target scheme with a breakeven rule can look
profitable on *any* entry in a drifting market. So every real signal was
re-planted at random unrelated bars, keeping its direction, its risk distance in
ATR and byte-identical exit logic (`backtest/control.py`):

| market | real signals | matched random control |
|---|---|---|
| MNQ 1H | PF 1.22, +0.103R | PF 0.95, −0.026R |
| NQ 1H | PF 1.23, +0.113R | PF 1.05, +0.026R |
| ES 1H | PF 1.12, +0.060R | PF 1.04, +0.019R |
| YM 1H | PF 1.27, +0.132R | PF 0.90, −0.051R |
| RTY 1H | PF 1.24, +0.116R | PF 1.06, +0.030R |

The signal beats its own control on all five. The entries are doing the work,
not the management.

**Independent replication on a second data vendor.** The whole result was
re-run on Dukascopy index-CFD series — a different vendor, different
instruments (cash indices, not futures), and a different four-year window:

| series | trades | WR% | 95% CI | PF | exp R |
|---|---|---|---|---|---|
| Nasdaq-100 1H | 567 | 28.2 | [24.0, 32.8] | 1.15 | +0.078 |
| S&P-500 1H | 296 | 28.1 | [22.2, 34.7] | 1.07 | +0.037 |
| Dow-30 1H | 321 | 28.8 | [23.2, 35.1] | 1.16 | +0.080 |
| **pooled** | **1,184** | **28.3** | **[25.3, 31.5]** | **1.13** | **+0.068** |

Positive on all three, and the pooled interval clears the 25.0% breakeven. The
1H result therefore stands on eight instruments across two independent data
sources. It is also weaker here (1.13 vs 1.22), which is the honest direction
for a second look to move.

## What did NOT work — the negative results

These cost as much effort as the positive ones and matter more.

**Catching the bottom tick with a limit does not work.** The intuitive version
of this idea — rest a limit inside the sweep wick to get filled at the extreme —
was the *worst* option tested, on every market (`entry_mode` in
`backtest/cross_scan.py`): market-on-reclaim PF 1.19 pooled, limit-at-the-swept-
level 1.01, limit-at-the-wick-midpoint 1.00, and on the first candidate the wick
limit scored 0/4 markets positive. The reason is adverse selection: the limit
only fills when price comes back, and price mostly comes back when the reversal
is failing. Both wick modes still ship, clearly labelled, so the dashboard can
be watched degrading.

**Tight stops on the swept extreme do not work.** A dedicated test
(`backtest/study_geometry.py`) put the model's own stop just beyond every raid
extreme and compared it against a matched random stop at the same ATR distance:
30.7% vs 30.6% at 1:2. **The swept extreme holds no better than an arbitrary
level.** Stop buffers below 0.35 ATR degrade results monotonically.

**All three VWAP filter roles failed.** Tested on four instruments that took no
part in tuning: the stretch gate (raid must be N σ from VWAP) was neutral to
harmful, VWAP-reclaim confirmation scored 1/4 markets positive, and targeting
VWAP instead of a fixed R was the single worst change tested — 0/4 markets
positive, pooled PF 0.75. The edge here is continuation after the reclaim, not
reversion to fair value. VWAP is drawn because it is useful context; all three
filters ship **off**, and the reason is in the script header.

**A VWAP σ band is not a Gaussian σ.** 16.5% of MNQ 1H bars close beyond ±2σ of
session VWAP where normal theory says 5%, and the median |z| is 1.24 against a
Gaussian 0.67. "2σ" is not a rare event on a VWAP band. Any threshold picked
from normal-distribution intuition will be far looser than intended.

**It does not generalise beyond equity indices.** Same settings, cost 4 ticks,
on markets that selected nothing:

| CL | GC | SI | NG | 6E | ZN | BTC | ETH |
|---|---|---|---|---|---|---|---|
| 1.08 | 0.84 | 1.05 | 1.03 | 0.81 | 0.69 | 1.16 | 0.93 |

Rates (ZN 0.69) and FX (6E 0.81) are notably bad. This is an equity-index-
futures model; treat anything else as untested.

**The PO3 open gate is worth about 0.05 PF.** With the weekly open it improves
the held-out pool from 1.14 to 1.21 — real, but it is a refinement on top of
"deep sweep, reclaimed", which is where the edge actually lives. Requiring the
close to reclaim the open as well looked superb on the tuning market (PF 1.73)
and evaporated on the holdout (1.03). It ships off.

**A session filter looked like the best find of the study and was a mirage.**
Restricting to the NY AM killzone scored PF 1.78 on MNQ and 0.99 with 1/4
markets positive on the four held-back instruments. Sessions are off.

## Making it better: what was tested after the parameters were locked

Once the entry rules were settled, the obvious next levers were tested the same
way — on the CME futures **and** on the independent index-CFD series, judged by
expectancy per closed trade with error bars. Almost all of them failed, which is
worth knowing before you try them.

### Exit management: three popular ideas, all rejected

| change | futures expR | CFD expR | verdict |
|---|---|---|---|
| baseline (shipped preset) | **+0.110R** | **+0.070R** | — |
| bank 50% at 1R, rest runs to 3R | +0.088R | +0.053R | worse on both |
| bank 30% at 2R, rest runs | +0.104R | +0.068R | no better |
| trail stop 1.0 ATR from +1R | −0.148R | −0.177R | **destroys it** |
| trail stop 2.0 ATR from +2R | −0.022R | −0.057R | **destroys it** |

**Do not trail this model.** Every trailing variant was negative on 0 of 5
futures and 0 of 3 CFDs. The reason is structural: only about a third of
decisive trades win, so the 3R winners carry the whole result, and a trail
clips exactly those. Partial exits are not catastrophic, just pointless — they
cut return and variance in the same proportion, then lose the difference to the
extra exit ticket.

### Re-entering after a breakeven scratch: clearly negative

Two thirds of trades scratch, which invites the thought that those setups were
right but early. They were not. Re-entering every scratched setup at its
original entry, stop and target:

| | trades | win rate | breakeven | expectancy |
|---|---|---|---|---|
| futures | 1,122 | 20.9% | 25.0% | **−0.189R** |
| CFD | 889 | 20.5% | 25.0% | **−0.215R** |

A scratched setup is dead. Getting out flat was the correct outcome.

### Selectivity: there is nothing left to filter out

Every signal is logged with the features knowable when it fired, then bucketed
(`backtest/study_features.py`). Across pool count, pool type, sweep depth,
reclaim lag, reclaim size, relative volume, session and direction —
**every bucket is positive on both datasets.** Higher relative volume and
higher volatility are mildly better and lower volume mildly worse, but all
buckets still make money and the intervals overlap. Filtering would discard
positive-expectancy trades, which is why the hard volume gate tested neutral
earlier. There is no dead weight to remove.

### The one change that did work: where the stop moves to

Every rejected idea above changed *when* a trade ends. This one changes only
*where the stop goes* when it moves, and it is the first thing in the whole
study that improved the experience without costing anything.

Moving the stop to exact breakeven means any pullback to entry ends the trade,
which is why 67% of trades become 0R scratches. Moving it only **halfway back**
leaves part of the original risk on, so ordinary noise cannot end the trade:

| stop moves to | trigger | managed exits | decisive trades | WR% | expectancy | avg DD |
|---|---|---|---|---|---|---|
| never moves | — | 0% | 1,993 | 27.9% | +0.094R | 29R |
| exact breakeven | +0.25R | 67% | 657 | 35.0% | +0.110R | 12R |
| exact breakeven | +1R | 32% | 1,356 | 29.8% | +0.109R | 18R |
| **halfway back** | **+0.5R** | **43%** | **1,131** | **40.1%** | **+0.105R** | **19R** |
| halfway back | +1R | 27% | 1,451 | 34.4% | +0.115R | 23R |

Halfway-back at +0.5R gives **72% more trades that actually resolve**, a win
rate of 40.1% instead of 35.0%, the same expectancy inside one standard error,
and it is *better* on the held-out CFD data (+0.080R vs +0.070R). Positive on
all five futures and all three CFDs. The cost is drawdown, 19R against 12R.

That combination ships as a second preset, **"Index Futures 1H — fewer
scratches"**. Both presets share every signal rule and differ only in stop
management, which the parity suite now asserts: a check fails if the two
presets ever diverge on anything but the two breakeven fields.

### A second round of upgrades, also rejected

Four more ideas were tested the same way. All four failed, and the pattern is
the point:

| change | futures expR | CFD expR | verdict |
|---|---|---|---|
| baseline | **+0.110R** | **+0.070R** | — |
| time stop after 6 bars | +0.057R | +0.036R | worse |
| time stop after 24 bars | +0.099R | +0.051R | worse |
| target nearest opposing pool (ERL→IRL) | +0.056R | +0.033R | halves it |
| signal within 20 bars of the weekly open | +0.119R | +0.080R | same, ¼ the trades |
| daily period, within 8 bars of the open | +0.179R | **−0.067R** | overfit trap |
| stop beyond the swept level, not the extreme | +0.067R (3/5) | +0.099R (3/3) | datasets disagree |

**The design principle, now demonstrated eight independent ways.** Trailing
stops, partial exits, re-entry after a scratch, time stops and targeting the
next liquidity pool all failed for the *same* reason: only about a third of
decisive trades win, so the 3R runners carry the entire result, and every one
of those ideas clips them. **Do not add anything that cuts a winner short.**

The PO3-timing test deserves a note because it is the most seductive: gating to
the first 8 bars of the daily period scores +0.179R on the futures, the best
single number in this whole study — and −0.067R on the CFDs, with 1 of 3
markets positive. That is exactly what a fitted artefact looks like.

### And the corollary: does letting winners run *further* help?

It does not, once compounding is accounted for. Raw expectancy keeps climbing
with the target, but variance climbs faster, and variance is what caps position
size:

| R:R | futures expR | optimal risk | max DD | growth at a fixed 2% risk, 400 trades |
|---|---|---|---|---|
| 1:2 | +0.073R | 9.7% | 11.9R | 1.67x |
| **1:3** | **+0.110R** | **10.7%** | **13.2R** | **2.18x** |
| 1:3.5 | +0.115R | 10.0% | 14.6R | 2.24x |
| 1:6 | +0.116R | 6.7% | 29.9R | 2.12x |
| 1:8 | +0.129R | 5.8% | 27.0R | 2.23x |

1:8 has the highest average trade and the *lowest* safe size. Everything from
1:3 to 1:8 compounds within 5% of the same rate, and 1:3 does it with half the
drawdown. The target is settled at 3.

### The one large improvement left is not a setting

The signals are far less correlated across index futures than the indices
themselves are, because they fire at different times off different levels.
Daily R correlation of the strategy's own returns:

| | MNQ | NQ | ES | YM | RTY |
|---|---|---|---|---|---|
| **NQ** | 0.95 | 1.00 | 0.15 | 0.08 | 0.10 |

MNQ and NQ are the same instrument (0.95) — running both just doubles your size.
Everything else is nearly uncorrelated. Levering each basket to the **same**
drawdown NQ alone produces (11.35R):

| traded | trades | net R | max DD | peak open | net R at equal drawdown |
|---|---|---|---|---|---|
| NQ only | 417 | +68R | 11.35R | 3 | **+68R** |
| NQ + ES | 777 | +102R | 13.45R | 6 | +86R |
| NQ + ES + RTY | 1,179 | +127R | 13.13R | 7 | +110R |
| **NQ + ES + YM + RTY** | 1,586 | +166R | 14.16R | 8 | **+133R** |
| MNQ + NQ | 835 | +122R | 22.71R | 6 | +61R — *worse than NQ alone* |

Spreading the same risk over four index futures nearly **doubles return at
equal drawdown**, with no parameter change at all. Running MNQ alongside NQ
does the opposite.

### How much to risk per trade

Bootstrapped from the 2,004 actual R outcomes over a 400-trade run (roughly two
years on one market):

| risk/trade | median final equity | 5th percentile | paths that halved |
|---|---|---|---|
| 1% | 1.51x | 1.06x | 0% |
| 2% | 2.18x | 1.08x | 0% |
| 3% | 2.89x | 1.11x | 1% |
| 5% | 5.01x | 0.89x | 9% |
| 8% | 7.38x | 0.20x | 29% |

Above 5% the tail dominates. The simulation draws trades independently, so real
drawdowns cluster and are worse than this — **1–2% is the sane range.** The
dashboard now sizes the most recent signal from its actual stop distance and
the contract's point value.

## How the parameters were chosen (the anti-overfitting protocol)

1. **Structural constants are conventional, not fitted**: pivot half-width 5,
   ATR 14, initial balance 60 minutes, equal-level tolerance 0.10 ATR.
2. **Every threshold is in ATR or VWAP-σ units**, so one parameter set is
   meaningful across instruments and timeframes.
3. **The raw effect was measured before anything was fitted**
   (`backtest/study_po3.py`): a symmetric double-barrier test against the
   instrument's own baseline drift, with Wilson intervals. The first, naive
   formulation *failed* this test — 46.6% vs a 48.5% baseline — which is what
   redirected the work toward sweep depth and away from wick limits.
4. **One axis at a time from a baseline, never a global grid argmax**
   (`backtest/scan.py`). A parameter is only adopted where its neighbours agree
   — a plateau, not a spike.
5. **Every choice is corroborated on four instruments that never selected it**
   (`backtest/cross_scan.py`). Where MNQ and the holdout pool disagreed, the
   holdout won. This is what caught the NY-AM session trap.
6. **Values are taken from plateau middles**, not argmaxes: the stop buffer is
   flat from 0.35 to 0.75 ATR on the holdout, so it ships at 0.50.
7. **MNQ's out-of-sample window is scored only at the end.** After the first
   corroboration round the scan was fixed to score MNQ on its in-sample 60%
   only. *Disclosure:* the first round did read MNQ full-sample PF for a coarse
   axis sweep, so that window is not perfectly virgin. The cross-asset holdout
   and the placebo test are untouched by any selection.
8. **Only two coordinate-ascent rounds were run**, then parameters were locked.

## Verification: the indicator is the engine

`backtest/verify_pine_parity.py` re-expresses the **Pine file's** control flow —
read block by block out of the `.pine`, not copied from the engine — and diffs
it against the research engine signal by signal.

```
MNQ_1h 418/418   NQ_1h 417/417   ES_1h 360/360   YM_1h 407/407  RTY_1h 402/402
MNQ 1m 75  5m 159  15m 65  30m 45  4h 194   — all exact
2,242 signals: 0 extra, 0 missing, 0 mismatched entry/stop/target
```

It also asserts that the constants the Pine ships in its validated preset are
exactly the parameters that were tested, so the indicator cannot faithfully
reproduce a configuration nobody validated.

**Two real bugs were caught by this test rather than by review**, both fixed:

- *Session ranges merged across holiday gaps.* The Pine seeded each session's
  range off "was the previous bar in this window". On NQ, a Sunday-23:00 bar and
  the Tuesday-00:00 bar after a holiday are both inside the 18:00–02:00 Asia
  window but belong to different trade days, so two days' Asia ranges merged and
  a signal was lost. The session block now keys off minutes-since-18:00-ET and
  resets per trade day, exactly as the engine does.
- *Pivot pruning evicted live levels.* When the pool cap was hit, swept pivots
  held slots and pushed out older *unswept* ones, silently dropping the signals
  those would have produced.

## Reproducing

```bash
# CME futures (Yahoo continuous front-month: 1H ~2.4y, 5m/15m/30m 60d, 1m 7d)
python3 backtest/fetch_yahoo.py data_po3 MNQ=F      # and NQ=F, ES=F, YM=F, RTY=F

# multi-year 1-minute index data, because Yahoo caps 5m history at 60 days
python3 backtest/fetch_dukascopy.py data_long USATECHIDXUSD NDX 4
python3 backtest/fetch_dukascopy.py data_long USA500IDXUSD  SPX 2
python3 backtest/fetch_dukascopy.py data_long USA30IDXUSD   DJI 2

python3 backtest/study_po3.py       data_po3 MNQ    # is there a raw effect at all?
python3 backtest/study_geometry.py  data_po3 MNQ_1h # does the swept extreme hold?
python3 backtest/scan.py            data_po3 MNQ_1h # one axis at a time
python3 backtest/cross_scan.py      data_po3 4 1h   # corroborate on held-out markets
python3 backtest/cross_scan.py      data_po3 4 5m data_long/NDX MNQ,NQ,ES,YM,RTY
python3 backtest/report.py          1h 4 '{}' data_po3:MNQ,NQ,ES,YM,RTY
python3 backtest/evaluate.py        data_po3 4      # final panels
python3 backtest/control.py         data_po3 MNQ_1h,NQ_1h,ES_1h,YM_1h,RTY_1h
python3 backtest/verify_pine_parity.py data_po3 MNQ_1h,NQ_1h,ES_1h
```

The CFD series are cash-index contracts, not futures: no roll, no basis, and
broker tick volume rather than exchange volume. They are used to test whether a
rule survives across regimes and instruments, never to quote a futures P&L —
and the shipped configuration uses no volume-dependent filter, so the volume
difference cannot flatter it.

## Using it on TradingView

Load on **MNQ1! or NQ1!, 1-hour**, keep the `Index Futures 1H — validated`
preset. The dashboard grades its own signals live, with the win rate always
shown against the breakeven rate for the chosen R:R, and charges the round-trip
cost you set (4 ticks by default) against every closed trade — so its net R is
comparable with the tables above. Its last row reports the **measured** result
for whatever timeframe the chart is on, so the evidence sits next to the live
statistics rather than in this file.

The chart defaults to a **Clean** style: only the named institutional levels are
drawn, each from where it formed to the current bar with a small right-edge tag,
and each signal is a single glyph whose full setup — swept level, entry, stop,
target, risk and reward in points — lives in its tooltip. `Detailed` adds every
tracked fractal pivot, keeps swept levels greyed, and prints the setup inline.
Drawing is completely decoupled from the model: changing the style cannot change
a single signal.

A single chart shows one instrument on one timeframe, so its numbers will be
noisier than the pooled figures here; a few dozen trades cannot distinguish PF
1.2 from PF 0.9.

**No repainting.** There is no `request.security()` call in the script; every
level is built from closed chart bars, fractal pivots only become visible five
bars after the fact, and session levels only become pools once the session has
closed. Signals commit on bar close.

## Honest limitations

- The edge is ~0.11R per trade. Position sizing, discipline and cost control
  matter more than the signal does.
- It is an indicator-side simulation, not a `strategy()`: no position sizing, no
  margin, no partial fills, one unit per trade.
- Intrabar path is unknowable from OHLC, so every ambiguity is resolved against
  the strategy: the stop wins same-bar ties, the target is never credited on the
  entry bar, and breakeven is armed only after that bar's exit checks.
- 2.4 years of 1H data per instrument, and the five index futures are highly
  correlated — 1,997 pooled trades are fewer independent observations than they
  look.
- Sub-hourly conclusions rest on 7–60 day samples. "No evidence of an edge" is
  not the same as "proof there is none", except at 1m where the result is
  emphatic.
- Yahoo continuous front-month data is not tick-accurate CME data and has no
  roll adjustment.

---

# Alpha Predictive Limit Matrix (earlier work)

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
