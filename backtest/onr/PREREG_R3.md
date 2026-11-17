# Research round 3: pre-registration (written and committed 2026-11-17, before any round-3 result was computed)

Earlier rounds already tested (see README): last-half-hour momentum, noise-area momentum, 5-minute ORB, volatility
regimes, overnight buy vs sell (long-only overnight), eval trading the funded book, eval pools, consistency add-on,
bracket width, news skip, Lucid products and sizes, payout policy. None of those is retested here.

## Literature behind this round

- **Drawdown-constrained sizing.** Grossman & Zhou (1993, *Mathematical Finance* 3(3)): with a floor that trails the
  peak, the optimal risky position is proportional to the surplus above the floor (here: Lucid's cushion). The book
  now risks a fixed day budget until the cushion is almost gone.
- **Timid vs bold play.** Dubins & Savage (*How to Gamble If You Must*): to reach a goal before ruin, a player with an
  edge should bet small, one without an edge should bet big. The eval risks 30% of the max loss per trade.
- **Overnight drift timing.** Boyarchenko, Larsen & Whelan (2023, *RFS* 36(9)): the overnight equity premium accrues
  around the European open (2-3 a.m. ET). NY Fed, *The Disappearing Overnight Drift* (July 2026): flat since 2021.
- Considered and not tested (low prior or too few events): pre-FOMC drift (Kurov, Wolfe & Gilbert 2021: disappeared
  after 2015); turn-of-the-month (Etula et al. 2020; evidence ends ~2013, settlement moved to T+1 in 2024).

## Setup for every account test

Lucid Flex 50K, maximum-allowed payouts, $1.34 per MNQ round turn, eval at $115, 90% split (the shipped v2.2 setup =
BASE). Periods: **selection 2011-18**, **validation 2019-26**, and the trailing 4 years (Nov 14 2022 -> Nov 13 2026)
reported. 12 start dates per period (every 21 sessions). Primary metric: net per year of 5 funded 50K accounts + eval
pool. Also reported: one account, longest gap without a payout, worst 12 months, eval pass rate.

**Noise band:** four placebo runs of BASE with trivial changes (score threshold 0.715 and 0.722; Auto-size reference
345 and 355). Band = the largest |placebo - BASE| in that period, pool net per year.

## Decision rule (fixed now)

A change is ADOPTED only if, for the 5 x 50K pool, it beats BASE by more than the noise band in BOTH 2011-18 and
2019-26, and its longest gap is not more than 1.0 month worse than BASE in either half. Within a family, the variant
with the highest 2011-18 pool net is the only one taken to validation. Leg modifications (E, F) must also have a
positive paired per-trade difference vs the current leg in both halves. If more than one family passes, their
combination must beat each single change in both halves, else only the single best is adopted.

## Hypotheses

| ID | Family | Exact change | Variants |
|---|---|---|---|
| A | Funded sizing by cushion (Grossman-Zhou) | day risk budget = min(600 x M, f x cushion, cushion - 10 x M); contracts per leg = max(1, round(Auto x min(1, f x cushion / (600 x M)))) | f = 0.4, 0.6 |
| B | Funded day budget level | day budget 800 x M instead of 600 x M (fits overnight + pyramid + IB on the same day) | one |
| C | Eval risk per trade (timid play) | eval stop cap and per-trade target cap both x k | k = 0.5, 0.75 |
| D | Eval triggers | (D1) 09:35 drive only, never the overnight; (D2) skip overnight SELL signals in the eval only | two |
| E | Pyramid second add | add N more at +0.30 ADR from the first entry; stop then at least at the first add's price | one |
| F | Overnight exit 04:00 ET (European-open timing) | overnight trades (eval and funded) exit at 04:00 instead of 09:30; eval news skip off (no longer holds through 08:30) | one |

Diagnostics (reported, no decisions): G1 overnight buy-signal edge by 4-year block and by exit hour; G2 the pyramid and
IB legs on the S&P 500 CFD (would MES diversify the book?) and their monthly correlation with the NQ book.
