# MMT — MNQ trading research

Four TradingView (Pine Script v6) indicators, each shipped with the real-data
backtest that grades it.

| indicator | file | what it is |
|---|---|---|
| **MNQ Reversal Blocks** | `indicators/mnq_reversal_blocks.pine` | 60-point blocks at session levels, drawn with the daily trend and graded strictly on candle closes: a 45-point reversal 78% of the time, about half going on to 100+. PRIME blocks — the day after a strong day with the trend, just beyond yesterday's close — went on to 100+ 80% of the time when first touched in the opening half hour (grade A, about 8 a year) and 70% later in the session (grade B) — [details](#mnq-reversal-blocks) |
| **MNQ Exhaustion Reversals** | `indicators/mnq_exhaustion_reversals.pine` | tiered daily-close reversals that tested as real: oversold bounces (standard / Monday–Tuesday / deep / capitulation) and rare blow-off tops — [details](#mnq-exhaustion-reversals) |
| MNQ Reversal Zones | `indicators/mnq_reversal_zones.pine` | no-lag zones on prior highs/lows with a live scorecard; tested at chance — [details](#mnq-reversal-zones) |
| Alpha Predictive Limit Matrix | `indicators/alpha_predictive_limit_matrix.pine` | sweep-rejection limit setups for the 1H chart — [details](#alpha-predictive-limit-matrix) |

---

# MNQ Reversal Blocks

**The rule:** blocks 60 points deep, graded strictly — a candle of the chart
closing beyond the block breaks it, a wick does not — and every zone is on
the chart before price gets there.

**What a 60-point block delivers under that rule:** a reversal of 45 points,
78% of the time on a 5-minute chart and 75% on a 1-minute chart — in sample,
out of sample and (76%) over ten years. About half of all blocks (53%) go on
to 100 points, which is what coin-flip copies of the data give too.

**The exception: PRIME blocks.** The day after a strong day with the daily
trend, a block on the trend's side at an overnight level just beyond
yesterday's close is PRIME. First touched in the cash session's opening half
hour (grade A), it went on to a 100-point reversal **79.7%** of the time on a
5-minute chart over ten years (79 blocks: 78.0% before November 2022, 82.8%
since), 81.0% on a 15-minute chart and 72.2% on a 1-minute chart. First
touched later in the session (grade B), 70.0% (70 blocks). The same rule on
coin-flip copies of the data gives 53–55%. The zone is drawn hours before
price reaches it. It is rare — about 8 grade A and 7 grade B blocks a year —
and these are small samples: see [PRIME blocks](#prime-blocks).

**The rules**

- A block starts at a session level known in advance and extends 60 points
  beyond it: Asia session high / low (18:00–03:00 ET), the 18:00 open, the
  midnight open, London session high / low (03:00–09:30), opening range high
  / low (09:30–10:00), the 09:30 open, first-hour high / low (09:30–10:30).
  The opens are support while price is above them and resistance while
  below. Each block is drawn on the first candle after its level is
  complete, only while price is still outside it, and never on top of a live
  block on the same side. Prior day and prior week highs and lows are off by
  default: they are where a block held least often in ten years.
- **Trend:** support blocks are drawn only when yesterday's close is above
  its 50-day average, resistance blocks only when it is below. In a downtrend
  the chart therefore shows shorts only, and in an uptrend longs only.
- **Touch:** a candle trades into the block. **Hit:** price reverses 45
  points from the extreme it made at the block. **Broken:** a candle closes
  beyond the far side before the hit — and a candle that closes beyond the
  block breaks it whatever its wick did. **100+:** a block that was hit goes
  on to reverse 100 points, still with no close beyond it. **Open:** touched,
  neither hit nor broken by the end of the next trade day.
- Hit rate = hit / (hit + broken). A block is never marked hit after a
  candle of the chart has closed beyond it.

## PRIME blocks

**The rule** — everything is known before price gets there:

1. Yesterday closed at least 0.75 average daily ranges (14-day) away from
   the close before it, in the direction of the daily trend: a strong up day
   above the 50-day average, or a strong down day below it.
2. The block is on the trend's side (support in an uptrend, resistance in a
   downtrend) and its level was made overnight: Asia or London session high
   / low, the 18:00 open or the midnight open.
3. That level is on the **far side of yesterday's close** — below it for
   support, above it for resistance — by no more than 0.40 average daily
   ranges. The overnight session has already traded back through yesterday's
   close, but not far.
4. The first touch decides the grade: **PRIME A** if it comes 09:30–10:00 ET,
   **PRIME B** if it comes 10:00–16:00. Touched before 09:30 or after 16:00,
   the block is an ordinary one.

A block that meets 1–3 is outlined as a PRIME candidate the moment it is
drawn (03:00 ET for the Asia levels and the opens, 09:30 for the London
levels). About 45 candidates are drawn a year; about 8 become grade A and 7
grade B. "Yesterday's close" is the close of the last candle that starts
before 16:15 ET, read from the chart's own candles, so the script and the
backtest use the same price whatever the daily bar's close is set to.

**The mechanism, as far as the data shows it.** After a strong day in the
direction of the trend, the cash session's opening push goes back through
yesterday's close and takes out the overnight low (the overnight high, in a
downtrend) — and usually fails there. The reading is that whoever missed
yesterday's move is waiting to buy that dip once the cash session's volume
arrives, and that the stops resting under the overnight low are what the
opening push comes for. What is measured, not read in: the effect needs the
strong day, the trend's side, the far side of yesterday's close and the cash
session; it is strongest in the opening half hour; and it does not need any
particular kind of level (tables below).

**Results** (`rb_blocks.py run --trend`, `rb_prime.py charts`; went on to
100+, blocks in brackets):

| chart, period | **PRIME A** | PRIME B | A and B together | all blocks |
|---|---|---|---|---|
| **5-minute, 10 years** (2017-03 → 2026-11, sizes scaled to price) | **79.7%** (79) | 70.0% (70) | 75.2% (149) | 53.5% |
| — before 2022-11 | 78.0% (50) | 69.7% (33) | 74.7% (83) | 53.1% |
| — since 2022-11 | 82.8% (29) | 70.3% (37) | 75.8% (66) | 54.0% |
| 3-minute, 10 years | 79.7% | 64.3% | 72.5% | 52.1% |
| 10-minute, 10 years | 82.3% | 72.9% | 77.9% | 56.0% |
| 15-minute, 10 years | 81.0% | 74.3% | 77.9% | 56.8% |
| 30-minute, 10 years | 78.5% | 78.6% | 78.5% | 58.2% |
| 1-minute, 10 years | 72.2% | 55.7% | 64.4% | 48.5% |
| **5-minute, last 4 years, fixed 60 / 100 points** | **80.0%** (20; coin-flip data 53.3%) | 69.7% (33; 54.9%) | 73.6% (53; 54.2%, z = +3.3) | 52.9% (51.3%) |
| — 2022-11 → 2024-11 | 80.0% (10) | 66.7% (12) | 72.7% (22) | 51.2% |
| — 2024-11 → 2026-11 | 80.0% (10) | 71.4% (21) | 74.2% (31) | 54.2% |
| 15-minute, last 4 years | 80.0% (20) | 75.8% (33) | 77.4% (53) | 55.4% |
| 1-minute, last 4 years | 75.0% (20; coin-flip data 47.4%) | 63.6% (33; 51.0%) | 67.9% (53; 49.2%, z = +3.2) | 47.8% (47.6%) |
| real MNQ futures, last 50 trade days, 5-minute | none | 1 block, it went on to 100+ | | 48.7% |

The 45-point hit rate on a 5-minute chart over ten years: PRIME A 96.2%,
PRIME B 87.1%, all blocks 75.9%. PRIME A by year, went on to 100+: 2017 80%
(5 blocks), 2018 85% (13), 2019 100% (3), 2020 86% (7), 2021 70% (10), 2022
69% (13), 2023 80% (10), 2024 86% (7), 2025 83% (6), 2026 80% (5). Grade A
resistance blocks 81.2% (32), support blocks 78.7% (47); Asia levels 78.1%
(32), London levels 82.2% (45). On charts above 30 minutes no candle starts
between 09:30 and 10:00, so there is no grade A.

**What it takes** (5-minute, 10 years; went on to 100+, before / since
2022-11 in brackets; `rb_prime.py where`):

| | blocks | went on to 100+ |
|---|---|---|
| **PRIME A** — far side of the close, first touched 09:30–10:00 | 79 | **79.7%** (78.0% / 82.8%) |
| PRIME B — far side of the close, first touched 10:00–16:00 | 70 | 70.0% (69.7% / 70.3%) |
| same days, NEAR side of the close (0 to 0.40), first touched 09:30–10:00 | 27 | 44.4% (38.9% / 55.6%) |
| same days, near side of the close, first touched 10:00–16:00 | 26 | 73.1% (80.0% / 68.8%) |
| same days, more than 0.40 ranges beyond the close | 76 | 51.3% (53.1% / 48.1%) |
| same days and place, block AGAINST the trend's side | 138 | 54.3% (58.3% / 50.0%) |
| same place and side, yesterday quiet (under 0.4 ranges either way) | 351 | 50.7% (50.2% / 51.4%) |
| same place and side, yesterday 0.4–0.75 ranges with the trend | 147 | 59.9% (64.3% / 54.0%) |
| same place and side, yesterday 0.75+ ranges AGAINST the trend | 77 | 59.7% (55.6% / 65.6%) |
| PRIME candidates first touched before 09:30 | 198 | 51.5% (50.9% / 52.2%) |
| PRIME days, levels made in the cash session (opening range, 09:30 open, first hour) | 337 | 54.6% (53.2% / 56.7%) |
| every overnight block on the trend's side, any day, first touched 09:30–10:00 | 844 | 55.5% (55.8% / 54.9%) |
| every block on the trend's side that is not PRIME | 5,134 | 52.9% (52.5% / 53.4%) |

Two things in that table carry the rule. The side of yesterday's close: at
the open, a block on the near side of the close is in the path of the push
back to the close and held 44% of the time, a block just beyond the close
80%. And the open itself is not special on other days: overnight blocks
first touched 09:30–10:00 on any day score 55.5%.

By where the level sits against yesterday's close on PRIME days (ranges; + =
the far side): −0.40 to −0.20: 43.8% (16 blocks), −0.20 to 0: 64.9% (37), 0
to 0.10: 82.0% (50), 0.10 to 0.25: 65.3% (49), 0.25 to 0.40: 78.0% (50), 0.40
to 0.60: 50.0% (42), beyond 0.60: 52.9% (34). By how early the first touch
comes: before 09:45 80.0% (60 blocks), before 10:00 79.7% (79), before 10:30
78.5% (93), before 11:00 77.9% (104), before 12:00 76.9% (121), all session
75.2% (149); from 10:00 on 70.0%.

**The same pattern on a wider set of levels.** About ninety level families,
each graded on its own (`rb_prime.py families`): every level that existed
before 09:30, on the trend's side, on PRIME days, against the same on quiet
days.

| | went on to 100+, PRIME days | quiet days |
|---|---|---|
| far side of the close (0 to 0.40), first touched 09:30–10:00 | **72.5%** (658 events; 70.5% / 76.3% before / since 2022-11; first such level of the day 72.2% on 151 days) | 53.6% |
| far side of the close, first touched 10:00–16:00 | 62.7% (820; first level of the day 63.1% on 149 days) | 53.5% |
| near side of the close (0 to 0.40), first touched 09:30–10:00 | 55.0% (313) | 50.6% |
| near side of the close, first touched 10:00–16:00 | 63.0% (281) | 49.4% |
| more than 0.40 beyond the close, 09:30–10:00 / later | 53.0% / 54.3% | 43.8% / 55.1% |

Far side of the close, all session, by family: Asia session high / low 76.0%
(75 blocks; 51.6% on quiet days), overnight high / low 74.6% (169; 50.1%),
London session high / low 72.4% (152; 51.3%), **arbitrary levels 69.6%** (46;
51.0%), swing highs / lows ±2 hours 69.1% (249; 53.2%), round 100s 66.7% (57;
60.7%), all levels that existed before 09:30 pooled 67.1% (1,478; 53.5%),
levels made after 09:30 60.7% (4,289; 53.7%), session VWAP 58.3% (192;
56.0%). By distance beyond the close, pooled: 0–0.10: 74.4%, 0.10–0.20:
67.8%, 0.20–0.30: 63.0%, 0.30–0.40: 60.7%, 0.40–0.60: 51.3%; on the near
side 60.5% within 0.20 and 53.6% further. Arbitrary levels in the same
place score close to what the session levels score: it is the day, the place
and the time, not the kind of level. The session levels are used because
they are the edge of the overnight range.

**How it moves with its sizes** (went on to 100+ for grades A and B
together, blocks in brackets; `rb_prime.py grid`):

| yesterday's move with the trend, at least | 0.50 | 0.60 | **0.75** | 0.90 | 1.00 | 1.25 |
|---|---|---|---|---|---|---|
| 5-minute | 66.8% (250) | 69.7% (208) | **75.2% (149)** | 75.5% (102) | 78.4% (74) | 85.7% (42) |
| 15-minute | 72.8% | 73.6% | 77.9% | 77.5% | 79.7% | 85.7% |
| 1-minute | 57.6% | 58.7% | 64.4% | 63.7% | 63.5% | 66.7% |

| level beyond yesterday's close by no more than … (move 0.75) | 0.25 | 0.30 | **0.40** | 0.50 | 0.60 | no limit |
|---|---|---|---|---|---|---|
| 5-minute | 73.7% (99) | 74.4% (117) | **75.2% (149)** | 72.6% (175) | 69.6% (191) | 67.1% (225) |
| 15-minute | 76.8% | 76.9% | 77.9% | 76.0% | 72.8% | 71.1% |
| 1-minute | 62.6% | 63.2% | 64.4% | 63.4% | 60.7% | 58.7% |

With the near side of the close included as well (the rule as first
shipped), the 5-minute figure is 70.8% on 202 blocks. A bigger move
yesterday looks better on the script's own blocks (78.4% at 1.0, 85.7% at
1.25) but not on the wider set of levels, where the first far-side level of
the day goes on to 100+ on 72.5% of 236 days at 0.75, 73.1% of 119 days at
1.0 and 68.3% of 60 days at 1.25. The move size is an input of the script
and stays at 0.75.

**The simple trade** — fade the first touch of the block's edge, exit when a
candle closes beyond the block; no costs or slippage; points at today's
price in the ten-year rows:

| | take 45 pts: wins | points a block | take 100 pts: wins | points a block |
|---|---|---|---|---|
| **PRIME A, 5-minute, 10 years** (79) | **82.3%** | **+21.4 ± 5.8** | 63.3% | +29.0 ± 10.9 |
| — before 2022-11 / since | 82.0% / 82.8% | +19.8 ± 7.8 / +24.2 ± 8.6 | 58.0% / 72.4% | +16.4 ± 14.6 / +50.6 ± 15.3 |
| PRIME A, 15-minute, 10 years | 86.1% | +24.3 ± 6.1 | 73.4% | +47.2 ± 10.2 |
| PRIME A, 1-minute, 10 years | 77.2% | +19.0 ± 5.4 | 55.7% | +24.5 ± 9.6 |
| PRIME A, 5-minute, last 4 years, fixed points (20) | 85.0% | +26.5 ± 10.2 | 70.0% | +48.2 ± 18.2 |
| PRIME B, 5-minute, 10 years (70) | 72.9% | +10.5 ± 7.0 | 55.7% | +20.4 ± 10.9 |
| all other blocks, 5-minute, 10 years (5,134) | 59.8% | −6.4 ± 0.9 | 42.3% | −5.2 ± 1.3 |

A grade A loss averages 88 points. The 100-point target is measured from the
edge of the block, so it wins less often than the 79.7%, which is measured
from the extreme price made inside the block.

**What to hold against it**

- **They are small samples.** 79 grade A blocks put the 79.7% somewhere
  between about 71% and 89%; a single year has 3 to 13 of them.
- **The rule was found on the same ten years it is reported on**, in three
  steps: the day (yesterday's move, the trend), then the side of yesterday's
  close, then the time of the first touch. Each step held in both halves of
  the history and on the wider set of levels, the sizes sit on a plateau,
  and coin-flip data scores 53% — but none of that replaces trading it
  forward, which has not been done. Many other splits were looked at on the
  way (yesterday's close location and range, gap, overnight range, VIX,
  dealer gamma, weekday, speed into the block); none held on the wider set
  and none is in the rule.
- **80% is a 3- to 15-minute-chart number.** On a 1-minute chart a single
  1-minute close beyond the block breaks it, and grade A scores 72%.
- **It is rare.** About 8 grade A blocks a year, and none on most days.
- **The data is a Nasdaq-100 CFD quoted from the futures**, not the MNQ tape,
  and there is no second market: the feed that supplied it now refuses bulk
  requests, so the S&P 500 could not be tested the same way. The 50 days of
  real MNQ data hold one PRIME block (grade B).
- **There is no older, independent sample.** A daily-bar stand-in (the
  bounce from the day's low to the close when that low is near yesterday's
  close) shows nothing after such days — not in 1962–2016 and not in the
  last ten years either — so daily data can neither confirm nor refute what
  happens inside the session.

## All blocks

**Results** — real 1-minute Nasdaq-100 data (`rb_blocks.py run --trend`):

| period, chart | touched | hit | broken | **hit rate** | went on to 100+ |
|---|---|---|---|---|---|
| in sample, 2022-11 → 2024-11, 5-minute | 763 | 595 | 168 | 78.0% | 51.2% |
| **out of sample, 2024-11 → 2026-11, 5-minute** | 1,036 | 807 | 229 | **77.9%** | 54.2% |
| last 4 years, 5-minute | 1,800 | 1,403 | 397 | **77.9%** (scrambled data: 77.4%) | 52.9% (51.3%) |
| last 4 years, 1-minute | 1,801 | 1,344 | 457 | 74.6% (75.9%) | 47.8% (47.6%) |
| out of sample, 1-minute | 1,037 | 782 | 255 | 75.4% | 47.5% |
| last 4 years, 15-minute | 1,790 | 1,379 | 411 | 77.0% | 55.4% |
| **10 years, 2017-03 → 2026-11**, 5-minute, sizes scaled to price | 5,283 | 4,010 | 1,273 | **75.9%** | 53.5% |
| real MNQ futures, last 50 trade days, 5-minute | 115 | 82 | 33 | 71.3% | 48.7% |
| real MNQ futures, last 22 trade days, 1-minute | 62 | 49 | 13 | 79.0% | 43.5% |

Ten years by year: 2017 76.0%, 2018 75.7%, 2019 77.1%, 2020 74.3%, 2021
75.4%, 2022 72.3%, 2023 79.3%, 2024 77.1%, 2025 74.7%, 2026 78.7%. In the
ten-year run the block depth and the reversal sizes are 60, 45 and 100
points at today's price and the same percentage of price earlier. 2.4 blocks
are drawn a day and 1.7 are touched.

**What each change is worth** (5-minute chart; last 4 years / 10 years):

| version | hit rate | went on to 100+ | touched a day |
|---|---|---|---|
| earlier version, with prior-day blocks | 76.4% / 75.7% | 52.3% / 52.5% | 3.3 |
| prior-day blocks off, midnight open and first-hour blocks added | 77.6% / 76.4% | 52.0% / 52.7% | 3.5 |
| **+ trend filter (the script's default)** | **77.9% / 75.9%** | **52.9% / 53.5%** | 1.7 |
| + skip rule (a switch, off by default) | 77.5% / 75.9% | 53.1% / 53.6% | 1.3 |

Dropping the prior-day blocks is what raises the hit rate. The trend filter
leaves the hit rate where it was, adds about one point to the share that
reaches 100+, and halves the number of blocks. The skip rule — a block
touched while fading the overnight gap, a fast move or a stretched RSI is
greyed out — removes blocks that hit just as often once the trend filter is
on (the skipped blocks: 79.3% over 4 years, 75.9% over 10), so it ships as a
switch that is off. PRIME marks blocks; it does not add or remove any.

**Hit rate by reversal size** (5-minute chart, last 4 years; 1-minute chart
in brackets):

| reversal that counts | 40 | 45 | 50 | 55 | 60 | 75 | 100 |
|---|---|---|---|---|---|---|---|
| hit rate | 80.9% (78.7%) | **77.9% (74.6%)** | 75.6% (71.8%) | 72.8% (68.6%) | 69.5% (64.9%) | 61.9% (57.0%) | 53.0% (47.8%) |

**The Pine logic is checked against the backtest.** `rb_pine_mirror.py` is a
statement-by-statement Python transliteration of the script; it and the
engine grade every block identically on 5-minute and on 1-minute candles
(1,792 / 1,793 blocks with the trend filter, 3,560 / 3,562 without, with the
skip rule on and off, PRIME flag and grade included: no differences), and
on the real MNQ futures files as well (105 / 200 blocks on 5-minute candles,
52 / 92 on 1-minute), where the 16:15–17:00 candles that the day's
reference close must leave out are present. The script also parses cleanly
with an ANTLR grammar of Pine Script (`pynescript`), which rejects
deliberately broken copies. It has not been run through TradingView's own
compiler here.

**Every kind of block scores the same.** Twenty-three block types, all 60
points deep, graded by the same rules (`rb_zoo.py`):

| block type | hit rate, 10 years | went on to 100+ | hit rate, last 4 years (scrambled data) |
|---|---|---|---|
| fair-value gaps | 77.3% | 52.2% | 77.0% (77.0%) |
| 09:30 open | 77.2% | 53.7% | 77.7% (78.0%) |
| **arbitrary levels** | **77.1%** | 52.4% | 75.6% (77.5%) |
| opening range high / low | 77.0% | 53.1% | 78.9% (78.5%) |
| order blocks (last opposite candle before a displacement) | 76.7% | 52.2% | 77.3% (76.7%) |
| 18:00 open | 76.5% | 52.6% | 77.8% (77.0%) |
| Asia / London session high / low | 75.6% / 75.5% | 50.9% / 53.7% | 77.3% / 77.3% |
| round numbers, 100s and 250s | 75.4% / 75.0% | 49.8% / 50.2% | 76.6% / 74.8% |
| swing highs / lows, ±1 hour and ±4 hours | 74.3% / 73.4% | 50.0% / 50.1% | 75.7% / 74.7% |
| prior day high / low | 72.4% | 48.1% | 73.3% (76.5%) |
| prior week high / low | 72.4% | 46.3% | 77.2% (77.7%) |

Order blocks and fair-value gaps given their own depth (the zone size, kept
inside 10–60 points) hit 51.0% and 45.1%, because they are shallower.

**What the hit rate does not mean**

- **It is not prediction.** The same blocks on direction-scrambled copies of
  the data (`rz_null.py`) hit 77.4% against 77.9% real. The hit rate comes
  from block depth against reversal size, and the levels add nothing to it.
  PRIME blocks are the one exception found: 94.3% hit against 77.5% on
  scrambled data, 73.6% to 100+ against 54.2% (grade A: 80.0% against 53.3%).
- **Ordinary blocks are not a trading edge.** Fading the first touch of a
  block's edge for 45 points and exiting on the break close won 61.0% of the
  time and averaged −2.1 ± 1.4 points per block (a loss averages 76 points);
  the same trade on scrambled data averages −2.2.
- **Earlier versions overstated it.** The first version broke a block only
  when a 2-hour candle closed beyond it, which scored 70% for 100-point
  reversals while marking blocks held after the chart's own candles had
  closed straight through them. That option is gone from the script.

## What has the highest probability of a reversal

`rb_hunt.py` grades about ninety kinds of level and a dozen conditions around
the touch by the same strict rules (60-point block, hit = 45 points, 100+,
a close beyond the block breaks it). No published study tests any of these
on index futures; the figures that circulate are vendor claims.

**Level types.** Of 85 types with at least 100 graded blocks in the last 4
years, hit rates run from 72.6% to 82.0% against a scrambled-data chance of
75–79%. Two are 2 points or more above chance, 25 are 2 points or more below.

| level type | hit rate, last 4 years (chance) | went on to 100+ | hit rate, 10 years |
|---|---|---|---|
| 09:30 open ± 1 average daily range | 82.0% (75.3%), 161 blocks | 57.8% | 79.0% |
| — the same at ± 0.75 / ± 1.25 / ± 1.5 ranges | 73.7% / 75.0% / — | 47.3% / 56.9% | 73.3% / 76.8% / 73.3% |
| first-hour (initial balance) high / low | 78.7% (78.1%) | 49.5% | 76.2% |
| initial balance + 0.5 × its range | 78.9% (77.9%) | 52.7% | 77.7% |
| 09:30-anchored VWAP ± 3σ | 78.9% (76.3%) | 51.2% | 76.4% |
| session VWAP ± 1σ / 2σ / 3σ | 77.2% / 76.1% / 76.1% (76.6%) | 50.6% / 49.7% / 49.6% | 76.7% / 76.1% / 75.8% |
| return to VWAP from 1σ away | 77.2% (76.5%) | 51.5% | 76.4% |
| order block after a sweep of the 24-hour high / low | 77.6% (76.4%) | 52.7% | 77.2% |
| fair-value gap after such a sweep | 77.6% (77.2%) | 50.4% | 78.0% |
| order blocks / fair-value gaps, all | 77.3% (76.8%) / 77.0% (77.0%) | 51.3% / 50.8% | 76.7% / 77.3% |
| Asia / London session high / low | 77.3% (76.7%) / 77.3% (78.3%) | 51.9% / 53.0% | 75.6% / 75.5% |
| 18:00 open / 09:30 open | 77.8% (77.0%) / 77.7% (77.5%) | 54.8% / 51.8% | 76.5% / 77.2% |
| floor pivot point | 76.2% (75.7%) | 50.7% | 79.2% |
| 38.2 / 61.8% retracement of the prior day | 75.1% (77.0%) | 47.6% | 78.3% |
| value-area high / low (time at price) | 73.1% (76.4%) / 76.7% (76.5%) | 50.3% / 48.2% | 77.3% / 76.2% |
| point of control (time / volume) | 74.0% (77.4%) / 73.0% (75.6%) | 47.9% / 47.4% | 75.4% / 76.5% |
| swing highs / lows, ±1 hour / ±4 hours | 75.7% (76.3%) / 74.7% (76.3%) | 50.4% / 51.0% | 74.3% / 73.4% |
| arbitrary levels | 75.6% (77.8%) | 48.8% | 77.1% |
| floor pivots R1 / S1 | 73.2% (77.2%) | 48.9% | 73.3% |
| prior cash-session high / low | 73.1% (76.5%) | 49.6% | 73.5% |
| **prior day high / low** | **73.3% (76.5%)** | 50.1% | **72.4%** |
| 5 / 10 / 20-day high / low | 76.3% / 77.4% / 76.0% | 51.1% / 51.1% / 53.4% | 72.3% / 72.0% / 70.8% |
| prior week high / low | 77.2% (77.0%) | 47.8% | 72.4% |

The best figure, the 09:30 open ± one average daily range, is not supported
by its neighbours at ± 0.75, ± 1.25 and ± 1.5 ranges, so it is treated as
luck: with 85 types tested, one that good is expected. The consistent finding
is at the bottom: the prominent highs and lows — prior day, multi-day, prior
week — are where a block holds LEAST often over ten years, 4–6 points below
arbitrary levels. Dropping the prior-day blocks from the earlier script lifted
it from 76.4% to 77.3% over the last 4 years; on their own they hit 72.3%
over ten.

**Conditions at the touch** (session, day and week extremes and opens; each
level once per day; `rb_hunt.py conditions`, `combo`). Found in the last 4
years, then checked on the six years before:

| condition | hit rate / went on to 100+, 2016-11 → 2022-11 | 2022-11 → 2026-11 |
|---|---|---|
| all | 74.9% / 51.4% | 76.4% / 51.9% |
| prominent highs / lows (day, multi-day, week, month) | 72.7% / 49.5% | 74.7% / 49.0% |
| fading the overnight gap, a fast move (> 2σ in the last hour) or an RSI(14) stretched past 75 | 72.5% / 47.9% | 74.8% / 47.6% |
| none of those three | 75.7% / 52.5% | 76.9% / 53.2% |
| **session level, daily trend at your back (support above the 50-day average, resistance below), none of the three** | **76.6% / 54.2%** | **77.1% / 54.5%** |
| prominent high / low against the trend or with one of the three | 72.4% / 48.1% | 74.5% / 47.1% |

In the last 4 years the favourable group went on to 100+ in 54.4% and 54.0%
of blocks in the two halves against 49.0% and 52.9% on scrambled data; the
gap / fast-move / stretched-RSI group hit 73.1% against 77.2% (z = −5.9) in
the first half and 74.8% against 77.6% in the second. Time of day, weekday,
volatility, how much of the day's range was used, distance from VWAP and the
exhaustion-close sessions each moved the hit rate by 2 points or less, and
not the same way in both samples.

**Built into the indicator and run through the engine** (one block per
level, no overlapping blocks), these conditions are worth less than the table
suggests: the trend filter adds about one point to the 100+ rate and nothing
to the hit rate, and the gap / fast-move / RSI rule adds nothing once the
trend filter is on — see "What each change is worth" above.

**Result.** By level type and by what is happening at the touch, the most
reliable block hits 77–79% for 45 points and goes on to 100+ about 54% of the
time; the least reliable hits 72–73% and 47–48%. The market shows mild
continuation, not reversal, at the places traders watch most and after fast
moves. No kind of level and no condition at the touch produces a
high-probability 100-point reversal from a 60-point block. What does is the
kind of day — see [PRIME blocks](#prime-blocks) and the next section.

## Mechanisms that were tested

A reversal that can be seen in advance needs buying or selling that is tied
to a price and known beforehand. Each candidate was tested on session-level
blocks by the same strict rules (`rb_mech.py`, `rb_deep.py`; 26,659 graded
blocks over ten years, 52.1% of which went on to 100+; chance in brackets
where scrambled copies were run on the last 4 years):

| mechanism | data | went on to 100+ |
|---|---|---|
| dealer gamma: dealers long gamma sell rallies and buy dips, short gamma the opposite | SqueezeMetrics daily S&P 500 GEX, 2011 → | 10 years: short gamma 53.9%, highest third 51.9%. 4 years: 55.0% (53.8%) and 49.2% (49.6%). The 45-point hit rate does rise with gamma, 73.1% → 79.2% |
| dark-pool buying (DIX) on the side of the reversal | same file | lowest fifth 52.4%, middle 52.4%, highest fifth 51.1% |
| VIX term structure (VIX / 3-month VIX) and VIX level | Yahoo | 50.9–53.4% and 50.5–53.5% across all buckets |
| QQQ $5 / $10 option strikes, carried to index points at the prior 16:00 ratio | Yahoo | 50.1% (50.4%) / 50.3% (50.2%); Fridays 54.3% / 55.1% on 245 / 158 blocks |
| leveraged-ETF rebalancing: fading a day already up or down 1%+ in the last hour | prices | 48.6% (183 blocks) |
| overnight dealer inventory (Boyarchenko, Larsen, Whelan): support when Europe opens, 02:00–04:00 | prices | 53.6% |
| monthly expiry / other Fridays | calendar | 53.2% / 51.9% |
| over thirty conditions known before the touch (how the level was made, what today's earlier blocks did, choppiness, speed), and a gradient-boosted model on all of them judged on later years | prices, VXN | each moves the rate by a few points; the model's best fifth: 55.1% against a 52.5% base (10 years), and no better than the same model on scrambled data over 4 years |
| once a block has already reversed 60 points | — | 76% go on to 100, but that describes a move already under way, not a zone seen in advance: dropped |
| **the day after a big move**: yesterday moved 1.5%+ against the direction being faded | prices | **57.1%** (57.3% / 56.9% in the two halves), against 51.2% after a flat day |

Only the last one moved the rate in both halves. Narrowed to the trend's
side, the cash session, the overnight levels, the far side of yesterday's
close and, for grade A, the opening half hour — each step checked in both
halves and on a wider set of levels — it became the PRIME rule. Dealer gamma is the most plausible of the others and does show in the
45-point hit rate; it does not lift the share that reaches 100.

**Commands.** `data/nq` holds the Dukascopy 1-minute day files
(`rz_data.py duka`), `data/yahoo` the Yahoo files (`rz_data.py yahoo`), and
`data/mech/DIX.csv` the public SqueezeMetrics file
(`squeezemetrics.com/monitor/static/DIX.csv`).

The indicator's backtest, PRIME included, with chance from 24 scrambled copies:

```bash
python3 backtest/rb_blocks.py run --duka data/nq --start 20221109 --warm 120 --trend --null 24
```

Ten years, sizes scaled to price (add `--tf 1` or `--tf 15` for the other charts):

```bash
python3 backtest/rb_blocks.py run --duka data/nq --start 20170301 --warm 110 --trend --scale
```

```bash
python3 backtest/rb_blocks.py run --duka data/nq --start 20221109 --warm 120 --trend --tf 1 --null 10
```

Real MNQ futures:

```bash
python3 backtest/rb_blocks.py run --csv data/yahoo/MNQ_5m.csv --daily data/yahoo/MNQ_1d.csv --trend
```

The Pine logic against the engine, block by block:

```bash
python3 backtest/rb_pine_mirror.py --duka data/nq --start 20221109 --warm 120
```

```bash
python3 backtest/rb_pine_mirror.py --csv data/yahoo/MNQ_5m.csv --daily data/yahoo/MNQ_1d.csv --tfs 5
```

Where the PRIME rule comes from, its sizes swept, the place and the time of
the touch, the chart candle size, and every level family on PRIME days:

```bash
python3 backtest/rb_prime.py landscape --duka data/nq --start 20170301 --warm 110 --scale
```

```bash
python3 backtest/rb_prime.py grid --duka data/nq --start 20170301 --warm 110 --scale --tfs 5 1 15
```

```bash
python3 backtest/rb_prime.py where --duka data/nq --start 20170301 --warm 110 --scale
```

```bash
python3 backtest/rb_prime.py charts --duka data/nq --start 20170301 --warm 110 --scale --tfs 1 3 5 10 15 30 60
```

```bash
python3 backtest/rb_prime.py families --duka data/nq --start 20170301 --warm 110 --scale
```

The mechanisms:

```bash
python3 backtest/rb_mech.py gamma --duka data/nq --start 20221109 --gex data/mech/DIX.csv --yahoo data/yahoo --null 4
```

```bash
python3 backtest/rb_mech.py flows --duka data/nq --start 20170301 --scale --null 0
```

```bash
python3 backtest/rb_mech.py strikes --duka data/nq --start 20221109 --yahoo data/yahoo --null 4
```

```bash
python3 backtest/rb_deep.py model --duka data/nq --start 20170301 --vxn data/yahoo/VXN_1d.csv --scale --split 20221109
```

Level types, conditions at the touch, and the twenty-three block types:

```bash
python3 backtest/rb_hunt.py levels --duka data/nq --start 20221109 --vxn data/yahoo/VXN_1d.csv --null 6
```

```bash
python3 backtest/rb_hunt.py conditions --duka data/nq --start 20221109 --vxn data/yahoo/VXN_1d.csv --null 6
```

```bash
python3 backtest/rb_hunt.py combo --duka data/nq --start 20161110 --vxn data/yahoo/VXN_1d.csv --scale --null 0
```

```bash
python3 backtest/rb_zoo.py --duka data/nq --start 20161110 --scale --null 0
```

Paste `indicators/mnq_reversal_blocks.pine` into the Pine Editor on MNQ or
NQ, on a 3 to 15 minute chart: that is where grade A scores 80% (a 1-minute
chart scores it 72%). The grading logic is the one `rb_blocks.py` runs.

---

# MNQ Exhaustion Reversals

Built on the reversal effects that survived testing. It does not use prior
highs or lows. Every signal is decided by a **completed daily close**; the
session after it is the bounce (or fade) session.

| tier | rule at the daily close | NQ futures 2000–2026, next session | closes | t | MNQ futures 2019–2026 |
|---|---|---|---|---|---|
| standard | RSI(2) < 10, or third down close in a row | **+0.24%** (5 sessions: +0.77%) | 836 | 3.0 | +0.39% (219) |
| prime | a standard close on a Monday or Tuesday | **+0.49%** (+1.10%) | 319 | 3.5 | +0.79% (80) |
| deep | RSI(5) < 20 | **+0.53%** (+1.07%) | 276 | 3.2 | +0.68% (73) |
| capitulation | RSI(14) < 30 | **+1.13%** (+1.56%) | 114 | 3.4 | +1.26% (28) |
| blow-off top | RSI(14) ≥ 80 | **−0.43%** (−0.40%) | 37 | −2.7 | −0.83% (14) |
| every session | | +0.05% (+0.22%) | 6,587 | | +0.08% |

At 27,700 on MNQ, +0.49% is about 135 points and +1.13% about 310. These are
the numbers the indicator's own scorecard logic produces on Yahoo daily bars
(`rz_tiers.py scorecard`).

Why the bottom tiers are believed:

- **Every era, every market.** Each bottom tier is positive in 2000–12,
  2013–20 and 2021–26 on NQ futures, ES futures, QQQ, SPY and the Nasdaq-100
  index (`rz_tiers.py eras`). Prime closes: +0.40% / +0.53% / +0.70% on NQ,
  +0.37% / +0.44% / +0.49% on ES.
- **It scales with the cause.** Next-session return by RSI(2) at the close:
  0–5 → +0.32%, 5–10 → +0.19%, 10–20 → +0.17%, 20–35 → +0.03%, 35–65 → −0.06%.
- **Found in a blind sweep, not hand-picked.** `rz_daily_sweep.py` grades
  about 105 daily conditions: of 50 bottom conditions 29 clear t > 2 and 17
  have the right sign in all six era × market cells; of 55 top conditions
  only 5 clear t > 2.
- **The entry that tested best is the signal close itself.** Waiting for a
  dip the next session fills 68% / 43% / 16% of the time (0.25 / 0.5 / 1 ATR
  below) and earns less per signal than buying the close (`rz_tiers.py
  entry`). On QQQ about half of the bounce arrives overnight and half in the
  day session (`rz_tiers.py split`).

What it is not:

- **Not a bottom or top tick.** The session after a signal still trades a
  median 0.40 of a daily range below the signal close. The edge is in the
  average of many signals.
- **The blow-off top is the weakest tier.** 37 closes in 26 years, bunched
  into 15 episodes; clear on the Nasdaq (−0.43%, t = −2.7; QQQ −0.43%), faint
  on the S&P (ES −0.11%, SPY −0.24%). Counted per episode, the five-session
  move is −0.41% (t = −0.6). Every other top idea tested was followed by
  normal-to-higher sessions.
- **Not a promise.** About 4 in 10 bounce sessions still close lower.
- **Hourly volume and VIX add nothing reliable** (`rz_tiers.py hourly`, real
  MNQ=F, 2024-06 → 2026-11): the best cell, a 2-range down hour on double
  volume, is +1.6 hourly ranges over 24 hours at z = 2.2 on 72 cases, which is
  what 26 tests produce by luck. Highs on heavy volume or with a rising VIX
  kept rising.

What the indicator draws: a tint over each bounce / fade session with the
signal close as a line; **trigger lines**, the exact price today's daily close
must finish beyond to trigger each tier (derived from the RSI formula, known
when the session opens, verified exact on 100,000 real-bar checks by
`rz_tiers.py lines`); and a scorecard that grades every tier on the symbol's
own daily history against every other session.

## Everything non-level that was tried

`backtest/rz_edge_hunt.py`, same null-model standard, 2022-03 → 2026-11,
1-minute data. Edges are the move in the fade direction, real minus null, in
% of the average daily range (0.5% ≈ 2–4 points).

| idea | result |
|---|---|
| 142 idea × side cells on 1 / 5 / 15 / 60-minute bars: RSI(14) and RSI(2) extremes, stochastic, Bollinger z-score, stretch from EMA 20/50/200 in ATRs, distance from the session average in sigmas, bar streaks, pin bars and engulfing bars at an extreme, RSI divergence (504,550 markers) | Structure exists (27 cells beyond 2 standard errors against ~6 by chance) but it is tiny. Every one of the strongest fade edges is a **bottom**: price 2–2.5σ below the session average +0.5 to +0.6% over the next hour (t ≈ 3.4), 1-minute Bollinger −2σ to −3σ +0.2 to +0.6%. Fading **overbought** readings loses: RSI(14) above 80 on 1-minute bars −1.3% (t = −4.0). Strongly oversold 5–60 minute readings also continue lower (RSI(14) below 30 on 60-minute bars −3.0%, t = −2.9). |
| Fade the overnight gap or overnight move at 09:30 (16 cells) | One cell beyond two standard errors (up-gaps over half a daily range: +5.0% in 60 minutes, 136 cases), which is the count chance gives. |
| Published intraday momentum: first half hour predicts the last | Absent in 2022–2026: correlation −0.016 (t = −0.5). |
| Follow a confirmed directional change | +0.52% of the daily range at a 0.2 × ADR change (t = 2.8); nothing at 0.3. |
| Daily exhaustion: RSI(2) / RSI(5) / RSI(14), down streaks, close in the bottom of the day's range, lower Bollinger, big down days, VXN and VIX spikes, weekday (about 105 conditions) | Bottoms positive in nearly every cell and era; the indicator uses the most consistent. Backwards: a hammer at a 10-day low (−0.33%, t = −2.7) and a Friday down more than 1% (−0.26%). Gap signals at the open: nothing. |

## Using it

Paste `indicators/mnq_exhaustion_reversals.pine` into the Pine Editor on MNQ or
NQ, any timeframe. The signal is judged on completed daily bars only. Like the
zones script, it has not been run through TradingView's compiler.

```bash
python3 backtest/rz_tiers.py scorecard --yahoo data/yahoo --file MNQ_1d.csv
```

```bash
python3 backtest/rz_tiers.py eras --yahoo data/yahoo
```

```bash
python3 backtest/rz_daily_sweep.py --yahoo data/yahoo
```

```bash
python3 backtest/rz_edge_hunt.py dose --yahoo data/yahoo
```

```bash
python3 backtest/rz_edge_hunt.py intraday --duka data/nq --start 20220301
```

`rz_edge_hunt.py` also takes `daily`, `path`, `line`, `gap` and `momentum`.
`rz_tiers.py` also takes `split`, `entry`, `lines` and `hourly`. The daily
commands need `NDX_1d.csv`, `QQQ_1d.csv`, `SPY_1d.csv`, `VXN_1d.csv` and
`VIX_1d.csv` next to the futures files, and `hourly` needs `VIX_1h.csv`
(`rz_data.py yahoo` fetches them).

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
