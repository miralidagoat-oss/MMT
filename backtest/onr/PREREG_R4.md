# Research round 4: consistency and money (written and committed 2026-11-18, before any round-4 result was computed)

The user's goal: steadier years and more money. Rounds 1-3 (README, PREREG_R3.md) are not repeated. This round adds a
descriptive study of 1 to 5 funded accounts and three pre-registered families aimed at the weak years.

## Setup for every run

Lucid Flex 50K, shipped v2.2 rules, maximum-allowed payouts, $1.34 per MNQ round turn, $115 per eval, 90% split.
CFD minute bars, Feb 15 2011 - Nov 13 2026. **12 start dates** per run: the first usable session plus 0, 5, ..., 55
sessions (all inside the first 3 months), each run to the end of the data; every figure is the mean over the 12 runs
unless it says median. Periods: **selection 2011-18**, **validation 2019-26**, and the last 4 years (12 starts from
Nov 14 2022) reported. "Full years" for yearly metrics: 2012-2018 and 2019-2025.

Metrics of N funded accounts with an eval reserve (up to 2N accounts in all, at most one new eval a day):
- **M** net to you per year (payouts x 90% - eval fees);
- **W** worst full calendar year;
- **L** number of losing full calendar years;
- **D** deepest drop of the running net from its high.

## Part 1 (descriptive, no decision): 1, 2, 3, 4 and 5 funded accounts

N = 1..5, max_funded = N, max_total = 2N. Report for each N:
- every calendar year's net (median, lowest and highest of the 12 start dates);
- M, W, L, D;
- worst 12 months, longest gap without a payout, months with a payout, evals bought a year;
- the most cash out of pocket before payouts covered it (lowest point of the running net).

## Part 2: hypotheses (5 funded accounts)

| ID | Family | Exact change | Variants |
|---|---|---|---|
| T | Eval-buying throttle by strategy regime | buy no new eval on a session when one funded account's trades (full day budget, fresh account each day, sessions before this one only) summed to less than $0 over the last N sessions; funded accounts and evals already running are untouched | N = 63, 126 |
| R | Risk level | contracts per leg and the day budget both x k (Auto reference 350k per $1,000 of max loss, budget 600k x M); eval unchanged | k = 0.5, 0.75, 1.25, 1.5 |
| V | Eval reserve size | at most 7 or 8 accounts in all instead of 10 (5 funded + 2 or 3 evals) | 7, 8 |

**Noise bands:** four placebo runs of BASE (score threshold 0.715 and 0.722; Auto reference 345 and 355). For each period
and metric, band = the largest |placebo - BASE|.

## Decision rule (fixed now)

A change is ADOPTED only if, in BOTH 2011-18 and 2019-26, one of these holds:
- **consistency route:** W improves by more than W's band AND M does not fall by more than M's band;
- **money route:** M improves by more than M's band AND W does not fall by more than W's band.

Within a family, the variant taken to validation is the one passing the 2011-18 test with the largest W improvement
(consistency route first, then money route by largest M). If none passes 2011-18, the family is rejected. Families
that pass are combined only if the combination also passes against BASE in both halves. The last 4 years are reported,
never used to decide.
