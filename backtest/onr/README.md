# ONR Book: independent review and MNQ backtest (2026-11-17)

Review of `indicators/onr_book.pine` (v1 as received, commit `77b0f72`), the v2.1 fixes and the v2.2 research round, with a Python replica of
the script's exact logic (`engine.py`, `account.py`, `portfolio.py`) run on 2011–2026 minute data and on real MNQ
futures, including several Lucid accounts side by side.

## Verdict

- **Your MNQ file only (Nov 23-25 2026):** every published figure now comes from your MNQ futures file (Dec 2019 - Nov 20 2026) and nothing else for prices. Over the last 5 years your Topstep plan (50K, 5 XFAs + 5 Combines, Standard payouts, No Activation Fee path) made $73,075 a year after every cost, worst full year $47,523, and your Lucid plan (5 funded + 5 evals with the add-on, each closed after its 4th payout) $58,262. On Nov 24 the S&P input's 119 missing or mistimed sessions (most of Feb-Jul 2023) were taken from Dukascopy and every result was rerun; on Nov 25 every result was rerun again at your $1.00 commission per MNQ round turn ($0.50 in + $0.50 out; it was $1.34). See *Your MNQ file only* below; the bullets after this one are the research's findings on its earlier series.
- **Research round 7 (Nov 27 2026):** 1,556 configurations of 13 published strategy families on your MNQ file, picked on
  2019-2022 and judged once on 2023-2026. Four passed (a 5-minute ORB, the noise area, Crabel's stretch breakout,
  Mondays); three are the book's own intraday-momentum edge. In the prop pools, only adding the 5-minute ORB as a fourth
  funded leg passes rule 5Y in all three account types. Indicator v2.7 adds it as an optional leg, on by default for
  Topstep 50K and 150K only. See "Research round 7" below.
- **Research round 8 (Nov 28 2026):** charging the overnight trade only its actual loss (variant AL) passed the
  pre-registered rule in Topstep 150K and Lucid 50K with the add-on but failed Topstep 50K; not adopted. See "Research
  round 8" below.
- **Research round 9 (Nov 28 2026):** another assistant's blind rebuild of the book (settings re-chosen on data before
  2024) was run in our pools. Skipping the funded overnight trade fails there too, in all three accounts tested
  (Topstep 50K, Lucid 50K add-on, Lucid 25K), so the trade stays. On our data the blind rebuild made 79-93% of the
  as-built book's 2024-26 daily Sharpe at 1 MNQ a leg. See "Research round 9" below.
- **Your plan rerun with the ORB leg (Nov 28 2026; indicator v2.7.2):** with the leg in Topstep 50K / 150K XFAs from
  day one, the full plan made more ($310,621 for a typical start after 3 years against $259,137), but a slow start
  with $1,000 ran out of money in 21 of 153 starts against 2 without the leg. Switched on once the spare cash reaches
  $25,000 (the plan's 150K step), it made the most in both: $313,381 for a typical start (worst start $223,013), and
  in the slow start 2 run-outs, as without it, and $322,035 after 4 years against $285,452. Indicator v2.7.2's Auto
  waits for that step. See "Your plan with the ORB leg" below.
- **Overfitting:** no knife-edge. Every parameter tested degrades smoothly and keeps its sign in both halves; the
  09:35 entry time is the most "picked" choice. What is fitted is the research narrative: several header numbers
  were measured on the same data the rules were chosen on, and some do not reproduce (table below).
- **The big v1 problem was sizing, not signals:** funded legs were always 1 MNQ. When NQ's daily range was 30–100
  points (2011–2019) that risked $30–$100 a trade, could not make $100 qualifying days, and payouts stalled for
  years. That is what the "14-month dry spell" mostly measured. v2 sizes funded legs by ADR (still 1 MNQ today).
- **Second real mistake (found in the multi-account review):** the 09:35 pyramid and the 10:30 IB breakout could point
  opposite ways. Inside one account that is long and short at once (impossible in a netted futures account, ~1 day a
  year); across copy-traded accounts, an eval's 09:35 trade against a funded account's IB short is the cross-account
  hedging Lucid prohibits (~22 days a year). v2.1 places the IB order only on the drive's side on drive days.
- **The last 5 years first** (Nov 15 2021 – Nov 13 2026, the window now given priority): 5 funded 50K accounts with
  5 evals in reserve netted $49,103 a year at the $115 list price, and $51,566 at the user's $88.20 discount price.
  Every full year was positive; the worst was 2023 ($11,081, or $13,010 at $88.20), when only 23% of evals passed.
  - Rounds 3–5 re-scored on these 5 years: none of 18 changes passed.
  - Round 6 (no overnight trade, or the eval's IB breakout in its place) did not pass either.
  - See "The last 5 years first", "Research round 6" and "At your eval price" below.
- **Real NQ futures (Nov 19):** on a user-supplied 5-year NQ futures file (repaired, gap to Nov 2026 filled), the
  strategy holds up: about $61k a year for 5 funded + 5 evals over the last 5 years, worst 12 months +$22k (40%) /
  +$32k (add-on). The CFD it was built on matched the futures trade by trade, except that the CFD misses parts of
  Feb-Jul 2023, which made 2023 look worse than it was. On futures the 50% add-on passes more evals and pays sooner,
  but its income gain shrinks to about +$0.3k a year. The website, the indicator's panel and its live alarm bands
  now use these futures results. See "Real NQ futures" below.
- **Lucid's move-to-live rule (Nov 19):** 5 funded + 5 evals is already Lucid's maximum (10 accounts per household,
  at most 5 funded). But Lucid moves a trader live after a Flex account's 5th payout, closing every sim account, and
  the earlier pool figures let accounts cycle instead. Under the rule the maximum makes about $48k a year on real
  futures (not $62k). Closing each account right after its 4th payout keeps the pool cycling: about $58.8k, if Lucid
  does not move you live for other reasons. See "Lucid's move-to-live rule" below.
- **New Lucid prices (Nov 23):** $88.20 a 50K eval and $50.30 a 25K eval, the add-on $10 more. Every Lucid figure was
  rerun: the Lucid plan now makes about $58.5k a year (it was $59.3k), and Topstep's figures do not change. Starting
  with only $500, one Lucid 25K eval at a time (40% rule) ran out of money least often of 8 ways in. See "New Lucid
  prices" below.
- **Final review (Nov 18):** the indicator and the backtest match line by line. The indicator's tooltips now give 50K
  numbers and its live alarm uses the last 5 years. One new finding: Lucid's paid 50% consistency add-on raised
  5 funded + 5 evals by about $11.9k a year over the last 5 years before its own price (+$4.3k a year in 2011–21).
  By rule 5Y it is worth buying below about $16 an eval. See "Final review" below.
- **Last 4 years only** (Nov 2022 – Nov 2026): same conclusions; 5 funded 50K accounts with
  max-allowed payouts netted ~$51k a year (25K: ~$32k), with 2023 the drought year. See "Last 4 years only" below.
- **Dry spells cannot be removed completely.** About half of them were times the strategy itself lost money; the
  other half were times it made money but the eval kept failing. More accounts run as an eval pool fix much of the
  second kind (longest gap 12 → 8 months in 2011–18, 8 → 6.5 in 2019–26) but nothing fixes the first kind.

## Your MNQ file only (Nov 23-25 2026): every result

**Every figure in this section, on the website and in both indicators' texts comes from your MNQ futures file and nothing else for prices**: `MICRONASDAQ100_futures_5m_2019-12-01_2026-11-23.parquet`, 5-minute bars from 2019-12-01 18:00 ET to 2026-11-20 16:55 ET (492,923 bars, 1,803 sessions), used as recorded. The Nasdaq-100 CFD (HistData `NSXUSD`, 2011-2026), your earlier NQ export and Yahoo's MNQ bars are no longer used anywhere; the sections after this one are the history of the research on them, and their figures are not your file's. The only other input is the S&P 500 series the overnight signal reads (as the indicator reads OANDA's `SPX500USD`); no trade is on the S&P.

Windows: the **last 5 years** are Nov 15 2021 - Nov 20 2026 (research rule 5Y); **since Dec 20 2019** starts at the file's first tradable session (the 14-day range needs 14 full sessions); full years are 2020-2025 (2019 is Dec 20-31 and 2026 ends Nov 20). Every figure is after your commission of $1.00 per MNQ round turn ($0.50 to enter and $0.50 to exit; see *The commission* below), the firm's 10% share of each payout and every eval or Combine fee, including the failed ones; money figures are the mean of 12 start dates (Nov 15 2021 and every 5 sessions after it) unless a row says otherwise.

### The file and its checks (`prep_mnq.py`)

- Checked before use: times sorted and on the 5-minute grid, every price on MNQ's 0.25 tick, every bar's high and low around its open and close, no bar in the daily 17:00-18:00 ET halt. Nothing was filled, repaired or adjusted.
- 8 restarts inside a session after 45 minutes or more without a bar (2020-03-16 (4), 2020-03-18 (2), 2020-06-30, 2025-11-28); 63 day sessions with fewer than 78 five-minute bars: 59 holidays and early closes, and 4 days missing a bar or two (2020-03-09, 2020-03-12, 2020-03-16, 2020-03-18).
- It is the front contract as it traded: the price jumps at each quarterly roll, always at a session's 18:00 ET open, when the plan holds nothing; trades and ranges are measured inside a session, so no roll changes a trade.

### The S&P 500 input of the overnight signal (`prep_spx_ext.py`, `spx_clock.py`, `fill_spx.py`)

HistData's `SPXUSD` 1-minute bars (an S&P 500 CFD, the research's own source), then Dukascopy's `USA500IDXUSD` after HistData's last session (Nov 13 2026). Where HistData is complete and on time, its bars are Dukascopy's to the cent. Two repairs:

1. **Clock** (`spx_clock.py`): in the week of 2023-03-13, the week of 2023-03-20, the week of 2025-10-27 HistData's clock was an hour early; each week's bars were moved by the hour that matches its 5-minute moves to MNQ's (2023-03-13: r 0.04 -> 0.93; 2023-03-20: r 0.02 -> 0.93; 2025-10-27: r -0.10 -> 0.94).
2. **Missing day sessions** (`fill_spx.py`, Nov 24 2026): 119 sessions had no full S&P day session behind them (13 half-hour buckets from 09:30 to 16:00), so the backtest skipped the overnight trade after each, and the scores after the long 2023 gap took their 60-session features across it. HistData misses most of the day session from Feb 21 to Jul 28 2023 (as its `NSXUSD` does, see *A defect in the CFD*), its clock is an hour early on 8 days of Mar 2020 (12 of 13 buckets), it has nothing on Nov 30 2020 and 7 buckets on Jan 8 and Jan 12 2024. Each of these sessions is Dukascopy's (UTC day files, so exact New York times), at HistData's level. Checks:
   - on the 54 complete sessions both sources have (the days around each gap, and the Oct 28 2019 clock-change week inside the first scores' 60-session lookback, before your file starts), 100.00% of 70,037 shared minutes are identical to the cent (open, high, low and close), and each replaced alone by Dukascopy's bars keeps its score (largest difference 0.0000; same signal 54 of 54);
   - the filled sessions' 5-minute moves match MNQ's at r = 0.909;
   - every session MNQ has, day session against MNQ at the recorded time and an hour either way: an hour off before the fill on 8 sessions (2020-03-09, 2020-03-12, 2020-03-13, 2020-03-16, 2020-03-17, 2020-03-18, 2020-03-23, 2020-03-24), after it on none;
   - full MNQ day sessions with no S&P score for that evening: 119 before, 0 after.

**What the fill changed** (your Topstep plan, last 5 years; one funded 50K account's overnight trade since Dec 20 2019; both columns at the $1.34 commission of that rerun):

| | Before the fill | After |
|---|---|---|
| Topstep 50K plan, net a year | $70,534 | $72,332 |
| Worst full year | $48,875 | $49,512 |
| Lucid plan (add-on, closed after the 4th payout), net a year | $61,795 | $60,709 |
| Overnight trades a year (one funded account) | 83.1 | 87.0 |
| Overnight trade, net a year / t | +$2,550 / 1.17 | +$2,514 / 1.14 |
| 2023, one funded account: net / overnight leg | +$5,999 / -$2,510 | +$8,392 / -$2,349 |

### The commission: $1.00 per MNQ round turn (Nov 25 2026)

Every result in this section was rerun on Nov 25 2026 at your commission: $0.50 to enter and $0.50 to exit one MNQ contract, $1.00 a round turn (it was $1.34, a typical prop-firm all-in rate). The lower commission is in every trade's result, and it also widens each eval bracket's stop a little (the stop leaves room for the commission: at 50K, 2 MNQ, about 0.17 point), so a few evals pass or fail on another day and a 10-account plan's 5-year path shifts a little either way. Those shifts are inside the backtest's noise bands; the trades of one funded account are the same.

| | At $1.34 | At $1.00 |
|---|---|---|
| One funded 50K account trading every session, last 5 years: trades / net a year | 1,784 / $21,357 | 1,784 / $21,730 |
| Eval pass rate, Lucid 50K, 40% rule / add-on (an eval started every session) | 43.1% / 43.2% | 43.4% / 43.2% |
| Topstep 50K plan, net a year / worst full year | $72,332 / $49,512 | $73,075 / $47,523 |
| Topstep 150K plan, net a year | $133,340 | $136,013 |
| Lucid plan (add-on, closed after the 4th payout), net a year | $60,709 | $58,262 |
| Lucid, 40% rule, closed after the 4th payout, net a year | $56,095 | $55,669 |
| Your plan, a typical start's 3 years (worst start) | $262,147 ($177,157) | $259,137 ($167,620) |

### Topstep (`topstep_sim.py`, `topstep25k.py`): 5 XFAs with 5 Combines behind them, one new Combine a session

| Size, payout path (No Activation Fee path) | Net a year | Worst full year | Worst 12 months | Deepest drop | Combines passed | Since Dec 20 2019: net a year / worst full year |
|---|---|---|---|---|---|---|
| 50K, Standard | $73,075 | $47,523 | $27,801 | -$8,835 | 43.4% | $74,773 / $49,172 |
| 50K, Consistency | $42,619 | $27,000 | $0 | -$3,246 | 26.4% | $43,713 / $25,133 |
| 100K, Standard | $122,070 | $94,944 | $28,274 | -$11,920 | 35.0% | $121,433 / $79,682 |
| 100K, Consistency | $58,665 | $36,000 | $0 | -$5,488 | 22.9% | $58,940 / $37,121 |
| 150K, Standard | $136,013 | $41,061 | $31,168 | -$19,694 | 35.0% | $131,253 / $41,061 |
| 150K, Consistency | $84,344 | $54,000 | $0 | -$8,473 | 23.5% | $78,836 / $48,521 |
| 50K, Standard, Standard fee path ($49 a month + $149 activation) | $71,711 | $44,761 | $27,352 | -$7,537 | 43.4% | $73,969 / $49,921 |
| 25K Labs Static, Standard (at most 5 Combines a month) | $32,201 | $10,091 | $8,237 | -$2,412 | 46.3% | $30,511 / $10,091 |
| 25K Labs Static, Consistency (at most 5 a month) | $32,243 | $6,931 | $6,694 | -$2,700 | 46.9% | $33,325 / $6,900 |

Fewer XFAs at 50K (Standard, No Activation Fee path, N XFAs + N Combines, last 5 years): 1: $15,985 a year (worst full year $11,048); 2: $30,512 a year (worst full year $23,264); 3: $44,801 a year (worst full year $30,248); 4: $56,363 a year (worst full year $37,430); 5: $73,075 a year (worst full year $47,523).

### Lucid Flex 50K (`live50k.py`, `scale_sizes.py`, `futures_site.py`): 5 funded + 5 evals

| Plan, last 5 years | Net a year | Worst full year | Worst 12 months | Deepest drop | The pool's evals passed |
|---|---|---|---|---|---|
| Add-on ($98.20 an eval), each account closed after its 4th payout (your plan) | $58,262 | $40,987 | $26,013 | -$8,838 | 45.8% |
| 40% rule ($88.20), closed after the 4th payout | $55,669 | $29,081 | $22,752 | -$8,644 | 45.3% |
| Add-on, Lucid's rules: moved live at the first 5th payout | $65,175 | $37,731 | $27,407 | -$8,249 | 48.0% |
| 40% rule, moved live at the first 5th payout | $52,260 | $29,081 | $23,276 | -$8,114 | 44.4% |

With the 40% rule, closing after the 4th payout made $55,669 a year against $52,260 going live. With the add-on, going live made more, $65,175 against $58,262, with a weaker worst full year ($37,731 against $40,987); that gain rests on this backtest's simple model of a live account (Lucid moves you live after a 5th payout and closes every sim account), so the indicator still closes each account after its 4th payout by default.

Other sizes (each account closed after its 4th payout; add-on / 40% rule, last 5 years): 25K $31,133 / $29,868 a year; 100K $71,608 / $67,995 a year; 150K $97,079 / $90,136 a year. 1 to 5 funded accounts with as many evals behind them (your Lucid plan's rules: the add-on, each closed after its 4th payout): 1: $11,634; 2: $24,493; 3: $35,415; 4: $46,390; 5: $58,262.

The 50% add-on at $10 an eval: +$2,593 a year against the 40% rule over the last 5 years (+$3,584 if it were free; noise band $3,040), worst full year $40,987 against $29,081; it pays for itself up to $36.17 an eval. Rule 5Y fails at $10 (and at every price tested, $0 to $50): from Dec 20 2019 to Nov 14 2021 the difference was -$6,757 a year, outside that window's noise band of $1,592 (it passed before the S&P input was filled). Over the last 5 years its worst full year is clearly better, but its money gain is inside that window's noise band; whether to keep buying it is your call.

**Eval options** (`options50k.py --mnq`; an eval started on every session, Lucid 50K). The wide bracket stays the best; the 08:30 news skip makes no real difference on your file (43.4% with it against 43.2% without over the last 5 years, 41.6% against 42.0% since Dec 20 2019; it is kept as a risk rule):

| Option | Last 5 years: passed / median sessions | Since Dec 20 2019 |
|---|---|---|
| default (40% rule, wide bracket, news skip) | 43.4% of 1296 / 9 | 41.6% of 1787 / 9 |
| 50% consistency add-on | 43.2% of 1295 / 8 | 41.3% of 1786 / 8 |
| medium bracket x0.75 | 41.4% of 1296 / 7 | 37.5% of 1787 / 7 |
| tight bracket x0.5 | 38.2% of 1296 / 6 | 38.4% of 1787 / 7 |
| no news skip | 43.2% of 1293 / 9 | 42.0% of 1784 / 9 |

### Your plan (`plan_search.py`): 48 monthly start dates from Dec 2019 to Nov 2023, 3 years each

Topstep 50K 5 XFAs + 5 Combines from day one (have about $11,000 ready: the most of your own money any start needed was $10,165); Lucid 50K with the add-on at $11,000 of spare cash; each new Topstep Combine 150K by the range rule at $25,000; the $15,000 car at $51,000: each step once the spare cash covers that setup's own worst fall since Dec 20 2019 (5 funded + 5 evaluations, the worst of 12 start dates, rounded up; Topstep 50K $11,000). A typical start had $259,137 of spare cash after 3 years, after every fee and the 30% tax set-aside (1 start in 10 below $182,447, worst $167,620). These are the plan's figures without the v2.7 ORB leg; with indicator v2.7.2's default (the leg in Topstep 50K / 150K XFAs from the $25,000 step) the same plan made $313,381 for a typical start (1 in 10 below $247,360, worst $223,013): see "Your plan with the ORB leg" below. Of the plans needing about the same own money, 4 made a little more for a typical start, up to $261,158 (they stepped up sooner on less cash, or took Lucid to 150K by the range rule too): a gap under 4%, within what 48 overlapping starts can tell apart, so the plan keeps its rule of a full reserve before each step. Steps reached (months after the start, median / 9 in 10 by / latest): Add Lucid 50K (spare cash $11,000) 5.1 / 10.3 / 13.6; Topstep 150K by the range rule ($25,000) 9.3 / 13.5 / 15.6; The $15,000 car ($51,000) 12.9 / 17.5 / 20.3.

### The last 60 days on real MNQ (`export_charts.py`, `topstep_charts.py`, `mnq_real50k.py`)

Sep 9 - Nov 20 2026 (53 sessions), cut from the same file (`prep_mnq.py --cut`; each session's 14-day range from the file's own earlier sessions, `engine.adr_seed`). One funded 50K account: 78 trades, 46.2% winners, +$16,937 after $168 commission (overnight 19 trades +$3,691, pyramid 25 +$10,990, IB breakout 34 +$2,256). Evals or Combines started every session: 33 of 50 passed. 5 funded + 5 evals made +$2,461 at Lucid (add-on) and +$2,541 at Topstep in those 10 weeks, most of the time spent passing evals.

### The indicator (`indicators/onr_book.pine` and `onr_book_addon50.pine`, v2.7.2)

Both editions quote the figures above, and their live alarm bands are `results_nqfut_5y_addon_fee8820/alarm_bands.csv`. v2.7 (Nov 27 2026) adds the 5-minute ORB leg from research round 7 (see "Indicator v2.7" below), on by default for Topstep 50K and 150K only; with the leg on, the alarm bands are `results_r7/v27_alarm_bands.csv`. v2.7.1 adds an optional switch to skip the overnight trade in funded and live accounts, off by default (see "Checked: two proposals" below). v2.7.2 (Nov 28 2026) makes Auto wait for the plan's 150K step: the leg starts in Topstep 50K / 150K XFAs once "PLAN: my spare cash has reached $25,000" is ticked, and its plan text quotes the rerun (see "Your plan with the ORB leg" below). v2.6.6 (Nov 25 2026) changes no rule: the commission input defaults to your $1.00 per MNQ round turn ($0.50 to enter and $0.50 to exit), and every quoted figure and the alarm bands come from the $1.00 rerun. v2.6.5 (Nov 24) changed no trade either. A check of every session in your file found three that halt early without being in the indicator's half-day list: the Good Fridays of 2021, 2023 and 2026 (Apr 2, Apr 7 and Apr 3), when the jobs report fell on Good Friday and CME traded from 18:00 ET Thursday to 09:15 ET Friday. An overnight trade cannot wait for its 09:30 exit on those mornings, so the panel now says so from the Thursday evening and an alert at 09:05 ET says to close it. The backtest exits it at 09:15, the session's last bar, and so does the indicator's own trade list. The next such Good Friday is Apr 7 2034. The one other early halt in the file, Jan 9 2025 (a national day of mourning), stopped at 09:30 ET, so its 09:30 exit still works.

### Reproduce

```bash
cd backtest/onr
python3 -I prep_mnq.py MICRONASDAQ100_futures_5m_2019-12-01_2026-11-23.parquet ../../data_mnq/NQFUT.npz
python3 -I prep_mnq.py --cut ../../data_mnq/NQFUT.npz 2026-09-09 ../../data_live_mnq/MNQ_5m_60d.npz   # the last 53 sessions
cp ../../data_mnq/NQFUT.npz* ../../data_live_mnq/   # the whole file beside it: engine.adr_seed's earlier sessions
python3 -I fetch_dukascopy.py ../../data/duk_spx USA500IDXUSD 2026-11-09 2026-11-20   # the S&P past HistData's end
python3 -I prep_spx_ext.py ../../data ../../data/duk_spx ../../data_mnq/SPXUSD_ext.npz
python3 -I spx_clock.py ../../data_mnq/NQFUT.npz ../../data_mnq/SPXUSD_ext.npz ../../data_mnq/SPXUSD_clock.npz
python3 -I fetch_dukascopy.py ../../data/duk_fill USA500IDXUSD 2023-02-12 2023-08-04
python3 -I fetch_dukascopy.py ../../data/duk_fill USA500IDXUSD 2020-03-01 2020-03-31
python3 -I fetch_dukascopy.py ../../data/duk_fill USA500IDXUSD 2020-11-22 2020-12-07
python3 -I fetch_dukascopy.py ../../data/duk_fill USA500IDXUSD 2024-01-01 2024-01-19
python3 -I fetch_dukascopy.py ../../data/duk_fill USA500IDXUSD 2019-10-27 2019-11-01
python3 -I fill_spx.py ../../data_mnq/SPXUSD_clock.npz ../../data/duk_fill ../../data_mnq/NQFUT.npz ../../data_mnq/SPXUSD.npz
cp ../../data_mnq/SPXUSD.npz* ../../data_live_mnq/
# every result folder (the website's, the indicator texts' and the workbook's), in this order:
FD=../../data_mnq; LD=../../data_live_mnq
ONR_MAX_PAY=4 ONR_EVAL_FEE_50K=98.20 ONR_EVAL_CONS=0.5 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py $FD results_v23_nqfut_5y_addon 2021-11-15
ONR_MAX_PAY=4 ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py $FD results_v23_nqfut_5y 2021-11-15
ONR_MAX_PAY=4 ONR_EVAL_FEE_50K=98.20 ONR_EVAL_CONS=0.5 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py $FD results_v23_nqfut_addon 2019-12-20
ONR_MAX_PAY=4 ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py $FD results_v23_nqfut 2019-12-20
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 ONR_EVAL_CONS=0.5 python3 report50k.py $FD results_nqfut_addon_fee8820 2019-12-20 && python3 make_kpis.py results_nqfut_addon_fee8820 results_nqfut_addon_fee8820/kpis.csv 'Dec 20 2019 - Nov 20 2026' '2020-2025'
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py $FD results_nqfut_fee8820 2019-12-20 && python3 make_kpis.py results_nqfut_fee8820 results_nqfut_fee8820/kpis.csv 'Dec 20 2019 - Nov 20 2026' '2020-2025'
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 ONR_EVAL_CONS=0.5 python3 report50k.py $FD results_nqfut_5y_addon_fee8820 2021-11-15 && python3 make_kpis.py results_nqfut_5y_addon_fee8820 results_nqfut_5y_addon_fee8820/kpis.csv 'Nov 15 2021 - Nov 20 2026' '2022-2025'
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py $FD results_nqfut_5y_fee8820 2021-11-15 && python3 make_kpis.py results_nqfut_5y_fee8820 results_nqfut_5y_fee8820/kpis.csv 'Nov 15 2021 - Nov 20 2026' '2022-2025'
ONR_EVAL_FEE_50K=88.20 python3 futures_site.py $FD results_futsite_fee8820
ONR_EVAL_FEE_50K=88.20 python3 live50k.py $FD results_live_fee8820
ONR_EVAL_FEE_50K=88.20 ONR_ADDON_FEE_50K=10 python3 live50k.py $FD results_live_fee8820_addon10
python3 scale_sizes.py $FD - results_scale_sizes
python3 topstep_sim.py $FD - results_topstep && python3 topstep_sim.py --tables $FD - results_topstep && python3 topstep_months.py $FD - results_topstep
ONR_TS_PAYMIN=125 python3 topstep_sim.py $FD - results_topstep_paymin125 && ONR_TS_PAYMIN=125 python3 topstep_sim.py --tables $FD - results_topstep_paymin125
python3 topstep25k.py $FD - results_topstep25k
python3 topstep_why.py $FD results_topstep_why
python3 startcash.py $FD - results_startcash
ONR_EVAL_FEE_50K=88.20 python3 export_v23.py $FD results_v23_trades_fee8820
ONR_EVAL_FEE_50K=98.20 ONR_EVAL_CONS=0.5 ONR_MAX_PAY=4 ONR_ADDON_FEE_50K=10 python3 export_charts.py $LD results_v23_charts $FD results_v23_nqfut_5y_addon results_v23_nqfut_addon && python3 make_kpis.py results_v23_nqfut_5y_addon results_v23_charts/kpis.csv 'Nov 15 2021 - Nov 20 2026' '2022-2025' results_v23_charts
ONR_MAX_PAY=4 python3 site_v23.py $FD - $LD results_v23_site && ONR_MAX_PAY=4 python3 site_v23.py --fut-tables $FD results_v23_site && rm -rf results_v23_site/_fut_tmp
python3 topstep_report.py $FD results_v23_nqfut_5y_addon results_topstep_report
python3 topstep_charts.py $LD $FD results_v23_charts results_topstep_report results_topstep_site
python3 export_v23_xlsx.py results_v23_trades_fee8820/ONR_v2.3_backtest.xlsx   # then recalculate its formulas (LibreOffice)
python3 mnq_real50k.py $LD && ONR_EVAL_CONS=0.5 ONR_MAX_PAY=4 python3 mnq_real50k.py $LD
python3 plan_search.py $FD - results_plan_search && python3 budget_table.py results_plan_search
python3 topstep_sim.py $FD - /tmp/topstep_verify && python3 -c "import json; a=json.load(open('results_topstep/runs.json')); b=json.load(open('/tmp/topstep_verify/runs.json')); assert a==b; print('runs.json identical')"
python3 options50k.py --mnq $FD results_options_mnq
```

## Research round 7 (Nov 27 2026): published strategies on your MNQ file

The question: do published strategies, from papers, websites and trading practice, work better than the ONR book or
alongside it, on your MNQ file? Every configuration and indicator mix was tested.

**Files:**
- `PREREG_R7.md`: the plan, committed before any result, with two addenda written before the results they cover.
- `research7.py`: the strategies, the screen and the controls.
- `r7_accounts.py`: the prop-account test.
- `results_r7/`: every number below. `net_adr_1tick.npy` and `all_configs.json` are rebuilt by `research7.py screen`.

### What was tested

- **Strategies:** 13 families, 1,556 configurations, from:
  - academic papers: Zarattini, Aziz & Barbon 2024 (noise area); Zarattini & Aziz 2023 (5-minute ORB on QQQ; VWAP);
    Gao et al. 2018 and Baltussen et al. 2021 (last half-hour momentum); Lucca & Moench 2015 (pre-FOMC);
    Lakonishok & Smidt 1988 and Ariel 1990 (turn of month, pre-holiday); Boyarchenko et al. 2023 (overnight drift);
  - classic trading books: Crabel 1990 (ORB, NR4/NR7, the stretch); Williams (volatility breakout); Connors (RSI(2));
    Pagonidis (IBS);
  - trading practice: gap fades, the Globex range, ICT's Silver Bullet, and 402 configurations of 5-minute indicators
    and mixes of them (EMA, MACD, RSI, Bollinger, Donchian, Supertrend, Keltner, ADX and VWAP filters).
  - A 2026 study of 14 signal families on 5-minute MNQ (Mesfin) and independent replications of the ORB and VWAP
    papers were read to avoid known traps.
- **Execution, stricter than the book's own backtests:**
  - decisions on closed bars, market orders at the next bar's open;
  - $1.00 a round turn plus 1 tick of slippage on every market and stop fill;
  - targets need a 1-tick trade-through, and the stop wins a bar with both;
  - prices across sessions adjusted for the 17 contract rolls.
- **Checks before any result:**
  - in the same harness, the book's three legs reproduce the engine trade for trade;
  - hand-made bars pass through every fill rule;
  - a look-ahead test cut the data mid-session at 7 moments: all 3,679 entries made before each cut were identical.
    This test caught and fixed one bug: a VWAP filter compared adjusted closes with an unadjusted VWAP.
- **Choosing and judging:**
  - Each family's configuration was picked on Dec 2019 - Dec 2022 only.
  - It was judged once on Jan 2023 - Nov 2026 by five tests: t >= 2; at least 3 of 4 years positive; better than 95%
    of 400 random-side (or random-day) copies; still positive at 2 ticks a fill; at least 30 trades.

### The strategies, out of sample (Jan 2023 - Nov 20 2026, 1 MNQ a trade, after all costs)

| | Family (source) | Configuration picked on 2019-2022 | Design t | Trades | t | $ at 1 MNQ | Years + | Verdict |
|---|---|---|---|---|---|---|---|---|
| F1 | ORB, first-candle direction (Zarattini & Aziz) | the first 5 minutes' direction, stop 0.10 ADR, target 10R, a move of at least 0.05 ADR | 3.11 | 742 | 2.20 | $9,238 | 4 of 4 | **passes** |
| F2 | ORB breakout orders (Crabel) | 15-minute range, orders until 11:00, stop at the other side, target 2R, after an NR4 day | 3.26 | 238 | 0.82 | $1,192 | 2 | fails |
| F3 | Noise area (Zarattini, Aziz & Barbon) | 21-day bands x 1.5, checked every 30 minutes, gap-adjusted, flips at the opposite band | 3.12 | 367 | 2.97 | $20,268 | 4 of 4 | **passes** |
| F4 | Last-hour momentum (Gao et al.; Baltussen et al.) | 10:00-15:00 direction traded 15:00-16:00 | 3.05 | 968 | -1.44 | -$5,716 | 1 | fails |
| F5 | VWAP (Zarattini & Aziz) | VWAP trend from 10:00, checked every 30 minutes, 0.1 ADR band | 3.56 | 979 | 0.92 | $5,136 | 3 | fails |
| F6 | Opening gap | fade gaps of 0.1 ADR or more at 09:30, stop 0.25 ADR, out by 11:00 | 1.82 | 804 | 0.52 | $785 | 2 | fails |
| F7 | Overnight (Globex) range | stop orders beyond the overnight high/low until 11:00, stop 0.5 ADR, target 2R | 1.19 | 847 | 1.51 | $11,171 | 4 | fails (t, random sides) |
| F8 | Volatility breakout (Crabel's stretch; Williams) | stop orders at the open +/- 0.2 x stretch until 13:00, stop 0.25 ADR | 3.19 | 775 | 3.45 | $27,261 | 4 of 4 | **passes** |
| F9 | Calendar days | long every Monday 09:30-16:00 | 1.66 | 200 | 3.60 | $14,738 | 4 of 4 | **passes** |
| F10 | Daily mean reversion held overnight (Connors; Pagonidis) | RSI(2) <= 5 long / >= 95 short, 18:10 -> 16:00 | 2.14 | 140 | -0.15 | $2,366 | 2 | fails |
| F11 | 5-minute indicators and mixes | EMA 20/50 cross with VWAP side, 2 ATR stop | 3.26 | 585 | 0.01 | -$682 | 3 | fails |
| F12 | ICT Silver Bullet | 10:00-11:00 window, target 2R | 0.46 | 143 | -0.18 | $282 | 2 | fails |
| F13 | Overnight drift (Boyarchenko et al.) | long 18:10 -> 02:00 every night | 1.38 | 1,006 | 0.98 | $2,880 | 3 | fails |
| | **The book's own legs, same costs** | 09:35 pyramid / IB breakout / overnight trade | 0.98 / 3.00 / 0.78 | 485 / 736 / 321 | 3.36 / 2.19 / 0.98 | $21,398 / $9,319 / $6,221 | 4 / 4 / 3 | |

`results_r7/decisions.csv` has every test, `all_configs.csv` all 1,556 configurations and `walkforward.csv` the
re-picked-every-year record. The t statistics are on trades measured in ADR units and the dollars in points, so the
two can differ in sign when a strategy's results are near zero (F10, F11).

**What survived, and what it means:**
- Three of the four survivors (F1, F3, F8) are intraday momentum after the open: the same edge the book's 09:35
  pyramid and IB breakout trade. Their daily results correlate 0.23-0.41 with the book: F1 and F8 mostly through the pyramid (0.49, 0.44), F3
  through the IB breakout (0.25).
- F9 is a calendar effect, and it is real in this file:
  - Mondays' 09:30-16:00 move averaged +40.8 points in 2023-26 (t 3.7) and +22.4 points in 2020-22;
  - Thursdays averaged -40.3 points in 2023-26;
  - its correlation with the book is 0.10.
- Everything else failed out of sample:
  - last-hour momentum, VWAP trading, gap fades, the Globex range, daily mean reversion, overnight drift;
  - the 5-minute indicators and mixes: the family's pick failed, and only 1 of the 402 configurations reached t 2
    in 2023-26 (median t -0.30);
  - ICT's Silver Bullet, as in the 2011-2026 test that found it negative after costs.
- **Overfitting:**
  - The probability of backtest overfitting across all 1,556 configurations is 7.4% (CSCV, 16 blocks). Per family,
    0.00-0.39 for the four survivors.
  - The deflated Sharpe ratio, counting all 1,556 tries, puts every design-period winner below significance. The
    design period alone proves nothing; the single out-of-sample look is the evidence.
  - Re-picking the best configuration every year gave t 3.91 (F8), 3.39 (F9), 2.60 (F1) and 2.52 (F3) over 2022-2026.

### The survivors in your prop accounts

**Setup:**
- Accounts: Lucid 50K 5 funded + 5 evals (40% rule, and with the add-on; each closed after its 4th payout) and
  Topstep 50K 5 XFAs + 5 Combines. 12 start dates each, the published conventions.
- Three ways a survivor joined:
  - a fourth funded leg in the $1,200 day budget, skipped if it would oppose an open position;
  - an eval trigger on sessions the book's two eval trades leave empty;
  - a replacement for a book leg it beat out of sample.
- With the book's legs alone, the new account classes reproduce the published ones event for event.
- Rule 5Y uses 8 placebo runs as its noise band:
  - Lucid 40%: +/-$3,040 a year (worst year +/-$9,633);
  - Lucid add-on: +/-$3,251 (+/-$3,094);
  - Topstep: +/-$14,308 (+/-$18,872).

**Net a year, last 5 years** (change against the book; PASS = rule 5Y in that account type):

| Variant | Lucid 40% | Lucid add-on | Topstep | 2023-26 only (40% / add-on / Topstep) |
|---|---|---|---|---|
| The book (published) | $55,669 | $58,262 | $73,075 | $60,745 / $58,977 / $76,597 |
| + F1 as a fourth funded leg | $55,223 (-$446, worst year +$16,001) PASS | $62,313 (+$4,051) PASS | $90,515 (+$17,440) PASS | $49,858 / $63,472 / $98,080 |
| + F3 | $62,272 (+$6,603) PASS | $64,617 (+$6,355) PASS | $79,618 (+$6,543) | $54,962 / $59,153 / $81,453 |
| + F8 | $64,179 (+$8,510; worst year -$17,808) | $68,780 (+$10,518; worst -$34,439) | $100,175 (+$27,100; worst -$40,781) | $60,330 / $69,487 / $100,237 |
| + F9 | $63,859 (+$8,190) PASS | $69,719 (+$11,458; worst -$11,257) | $83,331 (+$10,256; worst -$21,206) | $73,987 / $79,101 / $98,789 |
| F8 instead of the overnight trade | $69,285 (+$13,616) PASS | $71,585 (+$13,323; worst -$7,183) | $105,534 (+$32,459) PASS | $66,910 / $73,227 / $118,068 |
| F9 instead of the overnight trade | $75,087 (+$19,419; 2019-21 worse) | $70,380 (+$12,118) PASS | $97,048 (+$23,973) PASS | $82,293 / $74,921 / $115,324 |
| F8 instead of the IB | $59,589 (+$3,920) PASS | $62,838 (+$4,576; worst -$5,249) | $97,838 (+$24,763) PASS | $58,543 / $62,193 / $93,161 |
| F1 / F3 instead of the overnight trade | -$12 / +$9,116 | -$2,753 / +$11,367 | +$19,990 PASS / +$27,494 PASS | |
| F3 / F9 instead of the IB | -$25,848 / -$31,757 | -$16,823 / -$21,907 | -$16,840 / -$41,834 | |
| F8 instead of the pyramid | -$2,968 | -$5,522 | +$8,374 (worst year -$41,609) | |
| Eval triggers F1 / F8 / F9 | +$4,211 / +$9,955 / -$2,128 | +$1,951 / +$7,861 PASS / -$1,688 | +$2,523 / +$4,836 / +$2,336 | |

Every variant, account and window is in `results_r7/accounts.csv`, years in `accounts_years.csv`, and 1-tick stress
results in `accounts_slip1.json`.

**At 1 tick of slippage a fill** (change against the book at 1 tick, last 5 years; 2023-26 in brackets):
- + F1: +$5,722 (-$10,356) / +$4,305 (+$1,333) / +$22,001 (+$26,955).
- + F8: +$3,487 (-$6,247) / +$12,040 (+$9,790) / +$29,853 (+$29,491).
- F8 instead of the overnight trade: +$10,057 (+$1,109) / +$10,378 (+$4,072) / +$36,046 (+$32,240).
- F9 instead of the overnight trade: +$12,465 (+$16,436) / +$8,716 (+$9,932) / +$31,438 (+$38,418).
- F8 instead of the IB: -$1,249 (-$4,231) / +$3,231 (-$1,980) / +$15,213 (+$14,819).

**One funded account trading every session** (no account rules; the change's own effect without the pools' path
noise):
- The book: $21,787 a year over the last 5 years.
- Adding F8: +$14,290 (+$13,682 in 2023-26).
- Adding F1: +$5,671 (+$4,831).
- Adding F3: +$3,667; adding F9: +$1,826.
- F8 instead of the overnight trade: +$14,349; F9 instead of it: +$5,531; F8 instead of the IB: +$8,039.

`results_r7/book_every_session.csv`.

**Topstep 25K** (Labs Static plan of `topstep25k.py`: 5 XFAs + 5 Combines, Standard payouts, at most 5 Combines a
month; checked after the account test, so descriptive; `r7_ts25k.py`, `results_r7/topstep25k.csv`). With the book's
legs alone it reproduces the published $32,201 event for event.

| Topstep 25K, net a year | Book | + F1 | Change |
|---|---|---|---|
| Last 5 years | $32,201 | $35,782 | +$3,581 (worst year $10,091 -> $14,746) |
| 2023-26 | $38,811 | $39,372 | +$561 |
| Last 5 years, 1 tick | $31,334 | $30,559 | -$775 |
| 2023-26, 1 tick | $37,106 | $33,400 | -$3,706 |

At 25K the $500 daily loss limit and the 6-micro cap per leg leave little room for a fourth leg, so F1 adds almost
nothing there; its gain is a 50K result.

### Verdict

- **Only one change passes rule 5Y in all three account types: adding F1**, the 5-minute ORB, as a fourth funded leg.
  The leg:
  - goes in the direction of the first 5 minutes when that move is at least 0.05 ADR;
  - uses a 0.10 ADR stop and a 1 ADR (10R) target;
  - holds to 16:00 at the book's funded size.
  - It is a cousin of the 09:35 pyramid. It reads the same 5 minutes at a lower bar, so on drive days it adds size in
    the same direction and can never point the other way; on weaker opens it trades alone.
  - **In 2023-26 alone it is mixed:** Lucid 40% -$10.9k a year, Lucid add-on +$4.5k, Topstep +$21.5k.
- **F8 is the strongest new leg** on one account (+$14k a year) but raises drawdowns. In the pools, 2023 fell to
  about $7k-11k against $41k-59k for the book alone, so it fails as an addition.
  - As a replacement for the overnight trade it passes in 2 of 3 account types.
  - So does F9 in place of the overnight trade. In 2023-26 it is the best variant in the Lucid 40% pool and second
    in the other two. But it has no stop: in 8-15 funded accounts per 5-year run a Monday loss went through the
    drawdown floor. That never happens with the book's own legs, whose stops always fit inside the remaining cushion.
- **Indicator v2.7 adds F1** as an optional leg, the only change the pre-registered rule supports (next section). The
  replacements are not in it: they pass in only some of the account types.

### Indicator v2.7: the 5-minute ORB leg (Nov 27 2026; `r7_v27.py` → `results_r7/v27_*.csv`)

- **The leg** (input "FUNDED: 5-minute ORB leg"):
  - at 09:35 ET, if the first 5 minutes moved at least 0.05 ADR, N MNQ in that direction;
  - stop 0.10 ADR, target 1 ADR, exit 16:00;
  - taken after the pyramid, inside the day budget; funded and live accounts only, not on half days.
  - It reads the same 5 minutes as the 09:35 drive at a lower bar, so it always faces the pyramid's way (asserted on
    all 626 drive days of the last 5 years).
- **Auto** (the default) turns it on for Topstep 50K and 150K XFAs only; since v2.7.2, only once the input "PLAN: my
  spare cash has reached $25,000" is ticked (see "Your plan with the ORB leg"). Topstep, 5 XFAs + 5 Combines, Standard
  payouts, 12 start dates, net a year:

| Topstep | Last 5 years: book / + ORB | Worst full year: book / + ORB | Rule 5Y | 1 tick: book / + ORB | 2023-26: book / + ORB |
|---|---|---|---|---|---|
| 25K Static | $32,201 / $35,782 | $10,091 / $14,746 | PASS | $31,334 / $30,559 | $38,811 / $39,372 |
| 50K | $73,075 / $90,515 | $47,523 / $43,264 | PASS (pre-registered) | $67,891 / $89,892 | $76,597 / $98,080 |
| 100K | $122,070 / $141,350 | $94,944 / $59,366 | fail | $109,530 / $129,487 | $126,630 / $151,262 |
| 150K | $136,013 / $185,383 | $41,061 / $140,283 | PASS | $135,613 / $189,889 | $148,311 / $181,647 |

  - 50K is the pre-registered test (`r7_accounts.py`). 25K, 100K and 150K were run afterwards with the same rule and
    their own placebo noise bands, so they are descriptive.
  - Auto leaves 25K off: it loses at 1 tick of slippage and adds $561 a year in 2023-26. It leaves 100K off: its worst
    full year falls by $35,578, beyond the noise band. Lucid stays off: in the Lucid 40% pool the leg made $10.9k a
    year less in 2023-26.
  - The 150K worst full year swings between runs: at 1 tick it is $38,435 for the book and $37,480 with the leg.
- **The IB never trades against an open ORB trade.** On a day without a drive with the ORB trade still open at
  10:30, the IB side against it is held back: placed once that trade closes, or the IB is cancelled for the day if
  the price reaches it first.
  - The backtest lets that held side fill in the same 5-minute bar the ORB trade closes. A trader cannot, because the
    order is not at the broker yet, so the indicator waits for the next bar. That skips 7 IB trades in 5 years, worth
    +$647 in all to one 50K account.
  - Across accounts, a copy with the leg and one without can face opposite ways on a rare day (1 in the last 5
    years). Lucid copies on Auto never run the leg.
- **Live alarm bands** while the leg is on come from the same test with it (`v27_alarm_bands.csv`). With the book's
  legs alone the same code reproduces the published bands exactly.
- **Position size:** one direction can hold 4 N with the leg (pyramid 2 N, ORB N, IB N) instead of 3 N, and the panel
  shows it. Check it against your XFA's Scaling Plan limit.
- **The plan with the leg:** rerun on Nov 28 2026 (`plan_v27.py`; see "Your plan with the ORB leg" below).
- **Checks:**
  - A line-for-line Python copy of the new Pine code ran on every session of the last 5 years. All 938 ORB trades
    equal the backtest's to the cent. On the 280 days without a drive that had both an ORB trade and a backtest IB
    trade, 273 IB outcomes match; the other 7 are the same-bar cases above.
  - Both editions parse with `pynescript`, with no undeclared or twice-declared names.
  - Every figure the indicator quotes comes from `results_r7/accounts.csv` or `results_r7/v27_topstep_sizes.csv`.

### Checked: two proposals for v2.7 from another assistant (Nov 27 2026; indicator v2.7.1)

The user brought two proposals from another assistant:
1. funded and live accounts should skip the 18:10 overnight trade by default (evals keep it);
2. the 5-minute ORB should be tested on 2011-2020 and turned off if it loses there, because "opening-range breakouts
   flipped around 2021".

Both were checked on this research's own engine and account classes (`check_proposals.py`, `check_actual_loss.py`,
`check_orb_cfd5.py`, `r7_skip.py` → `results_r7/proposals*.json`, `orb_cfd5.json`, `skip_*.csv`). The MNQ file starts in
Dec 2019, so 2011-2020 uses the Nasdaq-100 and S&P 500 CFDs of the earlier research (HistData, 1-minute bars).

**Proposal 1, skip the overnight trade in funded accounts: partly right, but it costs money.**
- **Right:** the funded overnight trade (stop 0.5 ADR, no target, out at 09:30) is weak. At 1 MNQ it made about $0.79 a
  trade on the Nasdaq-100 CFD in 2011-2019, and no year was significant. Its good years were 2020 (+$33 a trade on
  the MNQ file), 2024 (+$20), 2025 (+$14) and 2026 (+$59).
- **Right:** its 0.5 ADR risk is held in the day budget all day, so it can crowd out the later legs.
- **Right:** without it, more funded accounts reach a first payout (one account started every 5 sessions):

| Funded accounts alone | Topstep 50K rules: book / no overnight | Lucid 50K rules: book / no overnight |
|---|---|---|
| NQ CFD 2011-2020 | 67.8% / 77.3% reach a payout (1.13 / 1.22 payouts each) | 46.0% / 50.9% (0.80 / 0.83) |
| NQ CFD 2011-2015 | 83.3% / 93.9% | 48.7% / 57.0% |
| NQ CFD 2016-2020 | 59.7% / 69.5% | 42.9% / 51.1% |
| MNQ 2021-2026 | 53.6% / 57.1% (1.71 / 1.47 payouts each) | 54.3% / 57.1% (1.12 / 1.11) |
| MNQ 2024-2026 | 52.8% / 62.4% | 53.6% / 62.4% |

  The proposal's "in 2024-26 skipping did a bit worse (55.7% -> 52.2%)" did not show here.
- **Wrong:** that this makes more money. It failed rule 5Y in every pool (`results_r7/skip_accounts.csv`; 5 funded +
  5 evals, net a year). Over the last 5 years it made less in two pools and at most $2,550 a year more in the other two
  (Lucid 40%, and Topstep with the ORB leg: both gains inside the noise band); in Dec 2019 - Nov 2021 it made less in all
  four, by $8,560 to $39,840 a year. (Corrected Nov 28 2026: this line first said it made less in every pool.)

| | Last 5 years | Worst full year | Dec 2019 - Nov 2021 | 2023-26 |
|---|---|---|---|---|
| Topstep 50K: book / no overnight | $73,075 / $69,742 | $47,523 / $40,239 | $65,030 / $46,203 | $76,597 / $68,987 |
| Lucid 50K 40%: book / no overnight | $55,669 / $57,013 | $29,081 / $32,634 | $57,594 / $37,583 | $60,745 / $57,862 |
| Lucid 50K add-on: book / no overnight | $58,262 / $53,831 | $40,987 / $33,126 | $50,837 / $42,277 | $58,977 / $54,889 |
| Topstep 50K with the ORB leg: with / without the overnight | $90,515 / $93,065 | $43,264 / $48,656 | $112,280 / $72,440 | $98,080 / $106,970 |

  - Topstep 50K, years 1 / 2 / 3 from 48 monthly start dates (Dec 2019 - Nov 2023): book $46,295 / $75,200 / $71,673,
    no overnight $44,558 / $72,471 / $68,128. That is lower in every year. The proposal reported the opposite
    ($44.0k / $54.0k / $31.1k with the trade, $46.7k / $58.7k / $53.9k without).
  - On the NQ CFD, 2011-2020, Topstep 50K: $25,967 a year with it, $21,433 without.
  - More accounts reach a first payout without it, and in most windows they also make a few more payouts each
    (Topstep rules, Nasdaq-100 CFD 2011-2020: 1.13 against 1.22), but not at Topstep on your file over 2021-26 (1.71
    with the trade against 1.47 without). The pools without it made much less in Dec 2019 - Nov 2021, which holds 2020,
    the trade's best full year on your file (+$33 a trade at 1 MNQ). (Corrected Nov 28 2026: this line first said the
    accounts pay out less over their lives, which holds only for that one window.)
- **Its third variant:** keep the trade, but charge the day budget only its actual loss once it closes at 09:30. The
  proposal says this "also fails". On reaching a payout it is no better than the book (CFD 2016-20 58.8%, MNQ 2021-26
  51.8%). On money it is the best of the three: Topstep 50K $80,022 a year over the last 5 years (worst year $61,657),
  $61,731 in Dec 2019 - Nov 2021. Both changes against the book are within the noise, so it fails rule 5Y too. It was
  not pre-registered, so it is a candidate for a later round, not a change.

**Proposal 2, the ORB before 2021: wrong for this rule on NQ.** The proposal's −0.064R (t −2.70) came from a
different ORB rule, as it says itself. The v2.7 rule, in R (result / 0.10 ADR), is below. It matches round 7's F1 leg on
all 1,295 MNQ sessions.

| ORB, 2011-2020 | Mean R | t | Years up |
|---|---|---|---|
| Nasdaq-100 CFD, 1-minute bars | +0.331 | 4.14 | 9 of 10 |
| Nasdaq-100 CFD, 5-minute bars | +0.325 | 4.08 | 9 of 10 |
| Nasdaq-100 CFD, 5-minute bars, 1 tick of slippage on every fill | +0.222 | 2.82 | 7 of 10 |
| S&P 500 CFD, 5-minute bars | +0.057 | 0.69 | 6 of 10 |
| S&P 500 CFD, 5-minute bars, 1 tick | −0.267 | −3.44 | 2 of 10 |

On the MNQ file: 2020 +0.41R; 2021-2026 +0.34R (t 3.56, 6 of 6 years). On NQ it did not flip in 2021. On the S&P 500 it
loses after costs: the proposal's warning holds for ES, which the indicator does not trade.

**What went into the indicator (v2.7.1):**
- A switch "FUNDED / LIVE: skip the overnight trade", **off by default**, with these figures in its tooltip.
  - When it is on, each skipped signal is followed as if traded, and the panel shows what the skipped trades would
    have made: the review the proposal asked for.
  - The followed result equals the engine's funded overnight trade on all 602 signal nights of the MNQ file.
  - Its live alarm bands come from the same tests (`skip_alarm_bands.csv`).
- The ORB leg stays on Auto, with the 2011-2020 results in its tooltip.
- Both editions parse with no undeclared or twice-declared names, and every new figure matches the result files.

## Research round 8 (Nov 28 2026): the overnight trade's charge to the day budget (pre-registered in `PREREG_R8.md`)

**Variant AL:** a funded account keeps the overnight trade, but once it closes (stop or 09:30) its charge to the day
budget becomes its actual loss, commission included: nothing for a win, instead of its 0.5 ADR risk held all day.
- The idea came from round 7's checks of another assistant's proposals.
- The rules below were committed before any run (`r8_actual_loss.py` → `results_r7/r8_*.csv`, `r8_decision.json`).
- With AL off, both account classes reproduce their published counterparts event for event, and every baseline
  equals its published figure.

**Verdict: not adopted.** It needed rule 5Y in all three plan accounts and failed Topstep 50K. Nothing in the indicator
changes.

| Account (MNQ file, 12 start dates, net a year) | Last 5 years: book / AL | Worst full year: book / AL | Dec 2019 - Nov 2021: book / AL | 1 tick, last 5 years: book / AL | Rule 5Y |
|---|---|---|---|---|---|
| A1 Topstep 50K, ORB leg on | $90,515 / $96,577 | $43,264 / $50,536 | $112,280 / $106,600 (−$5,680, band $4,909) | $89,892 / $82,167 | **fail** |
| A2 Topstep 150K, ORB leg on | $185,383 / $227,730 | $140,283 / $119,628 | $209,135 / $215,028 | $189,889 / $194,075 | PASS |
| A3 Lucid 50K add-on | $58,262 / $62,982 | $40,987 / $45,581 | $50,837 / $48,079 | $55,231 / $59,116 | PASS |
| A4 Lucid 50K 40% (not decided on) | $55,669 / $60,424 | $29,081 / $36,732 | $57,594 / $49,541 | $53,837 / $58,960 | fail |

- **A1 Topstep 50K:**
  - Over the last 5 years AL added $6,062 a year (band $14,308) and its worst full year rose by $7,272 (band $18,872):
    both within the noise.
  - In Dec 2019 - Nov 2021 it lost $5,680 a year, beyond that window's band of $4,909.
  - At 1 tick of slippage on every fill it lost money: $82,167 against $89,892 a year, and $89,807 against $99,160 in
    2023-26.
- **The holdout (Nasdaq-100 CFD, Feb 2011 - Dec 2019, no ORB leg; no-harm test):**
  - Topstep 50K $21,112 / $20,984 a year (band $2,300), worst full year unchanged;
  - Lucid 50K add-on $28,078 / $31,019 (band $2,134);
  - both pass.
- AL helps the larger accounts, but the rule asks for all of the user's plan accounts, and on Topstep 50K, the account
  the plan starts with, it is not robust.

## Your plan with the ORB leg (Nov 28 2026; `plan_v27.py` → `results_plan_v27/`; indicator v2.7.2)

The question: what does your plan make with indicator v2.7's 5-minute ORB leg, which Auto turned on in Topstep 50K and
150K XFAs? `plan_v27.py` reruns `plan_search.py` (the 31 plans and the $500 / $1,000 starts) and the slow start quoted
on Nov 25, with those XFAs on round 7's account class with the leg; everything else is unchanged.

**Checks:**
- With the book's legs only (`--parity`), every output equals `results_plan_search/` byte for byte (the reserves, all
  1,872 plan runs, both rounds, the car table, the steps and the three budget files), and the slow start equals the
  Nov 25 figures on every quantile.
- `--variants` and `--switch-budget` run every variant below through one run function, which first reproduces the
  published plan, the published budget runs (every field of every run) and the plain rerun exactly.
- The plan's step amounts are each setup's worst fall since Dec 20 2019 (5 funded + 5 evaluations, the worst of 12
  start dates, Dec 20 2019 - Mar 10 2020). With the leg they shrink: Topstep 50K $10,165 → $3,705 (reserve $11,000 →
  $4,000), 150K $24,468 → $16,946 ($25,000 → $17,000); round 7's own pool code gives the same falls to the dollar. Those
  12 start dates are the leg's best, though: over the 48 monthly starts Topstep 50K alone with the leg still needed up to
  $10,545 of your own money ($10,165 without it). The plan keeps its published amounts.

**The full plan and the slow start, four ways** (`variants_final.csv`, `variants_slow_start.csv`). The full plan: 48
monthly start dates Dec 2019 - Nov 2023, 3 years each, money added whenever needed. The slow start: one Lucid 25K eval
at a time ($50.30, 40% rule), then Topstep 1 + 1 at $3,000 of spare cash, 2 + 2 at $5,000, 5 + 5 at $9,000, Lucid 50K
with the add-on at $11,000 and Topstep 150K by the range rule at the 150K amount; never more money than the start; 153
starts every 5 sessions Dec 20 2019 - Nov 2022, 48 months each. After every fee and the 30% tax set-aside:

| Full plan, 48 starts | Your money in, most | Deepest fall | 3 years: typical | 1 in 10 below | worst | 3rd year, typical | Worst 12 months | Car, typical month |
|---|---|---|---|---|---|---|---|---|
| Published, no ORB leg ($11,000 / $25,000 / $51,000) | $10,165 | -$34,868 | $259,137 | $182,447 | $167,620 | $91,766 | $16,175 | 12.9 |
| Leg from day one, at its own reserves ($11,000 / $17,000 / $43,000) | $10,545 | -$25,775 | $310,621 | $262,443 | $214,791 | $133,070 | $27,520 | 10.5 |
| Leg from day one, at the published amounts | $10,545 | -$25,775 | $296,677 | $260,132 | $215,193 | $131,974 | $27,520 | 11.3 |
| **Leg from $25,000 (v2.7.2)** | $10,165 | -$30,845 | $313,381 | $247,360 | $223,013 | $132,234 | $30,567 | 12.3 |

| Slow start | Ran out of money | After 2 years, typical | After 3 years | After 4 years | Ahead after 4 years |
|---|---|---|---|---|---|
| $1,000: published, no ORB leg | 2 of 153 | $17,066 | $108,728 | $285,452 | 99% |
| $1,000: leg from day one, at its own reserves | 21 of 153 | $8,547 | $90,596 | $250,207 | 86% |
| $1,000: leg from day one, at the published amounts | 21 of 153 | $8,851 | $88,284 | $250,207 | 86% |
| **$1,000: leg from $25,000 (v2.7.2)** | 2 of 153 | $16,919 | $131,934 | $322,035 | 99% |
| $3,000: published, no ORB leg | 3 of 153 | $71,165 | $161,858 | $366,551 | 98% |
| $3,000: leg from day one, at its own reserves | 10 of 153 | $94,982 | $227,967 | $443,123 | 93% |
| $3,000: leg from day one, at the published amounts | 10 of 153 | $94,982 | $225,483 | $443,224 | 93% |
| **$3,000: leg from $25,000 (v2.7.2)** | 3 of 153 | $91,285 | $226,339 | $455,740 | 98% |

No start went below $0 after buying the car in any of the four (lowest spare cash after it: $12,444, $22,269, $25,940
and $31,176). The step months with the leg from $25,000 (`variants_final_steps.csv`): Lucid 5.1 / 10.3 / 13.6 months
(typical / 9 in 10 by / latest) and 150K 9.3 / 13.5 / 15.6, as published, and the car 12.3 / 17.1 / 18.8 (published
12.9 / 17.5 / 20.3).

**Why the leg from day one hurts a slow start:**
- With the leg from day one, every run-out came between Feb 12 and Mar 4 2024 (`slow_variants` in `results_site_r8/`):
  the 21 starts of Oct 1 2021 - May 10 2022 with $1,000 and the 10 of Aug 9 - Nov 22 2022 with $3,000. Each had reached
  the Lucid step but not the 150K one. Without the leg the same stretch ended 2 of the $1,000 starts.
- The leg's XFAs swing more. In round 7's pools Topstep 50K made more with it in Dec 2019 - Nov 2021 ($112,280 a year
  against $65,030), 2025 ($126,000 against $69,285) and 2026 ($135,000 against $85,561), and less in 2022 ($43,264
  against $47,523), 2023 ($56,101 against $59,263) and 2024 ($84,450 against $97,619) (`results_r7/accounts_years.csv`).
  In the Dec 20 2019 start, Topstep 50K alone paid nothing from Sep 15 2023 to Oct 1 2024 with the leg (269 sessions),
  against Sep 29 2023 to Apr 3 2024 without it (130 sessions). A business with a few thousand dollars cannot ride that
  out; one with $25,000 can.

**The $500 / $1,000 starts** (24 months, 205 starts every 5 sessions; `budget_view.csv`, `switch25k/budget_view.csv`):
- With the leg from day one, more starts ran out in 12 of the 16 ways in and fewer in 4, but the starts that kept going
  made much more: one Lucid 25K eval at a time with $1,000 (40% rule) ran out in 26.3% of starts (25.4% without the
  leg), and those that kept going had a typical $170,420 after 2 years ($108,631).
- With the leg from $25,000, every way in ran out in exactly the same starts as without it, start by start, and those
  that kept going made more: that way in, $144,733 after 2 years.
- The website's $500 text quoted two stale figures, now corrected from these files: 145 of 205 starts is 70.7% (not
  70%), and 84 of the 105 25K starts that ran out did so after the first payout (not 78 of 99).

**Decision (indicator v2.7.2):** Auto starts the leg in Topstep 50K / 150K XFAs once "PLAN: my spare cash has reached
$25,000" is ticked, the plan's existing 150K step; "On" and "Off" are unchanged. It is the best of the four ways on the
full plan's typical and worst start and on the slow start, with the same run-outs as without the leg. It was chosen
after the rerun showed the problem, and only that one switch point was tested, so it is a practical rule rather than a
pre-registered result: before $25,000 every account trades as v2.6.6 did, and the step was not tuned. Round 7's verdict
on the leg is unchanged. The indicator's plan text, its PLAN and ORB inputs and its panel say so, and every figure they
quote was checked against these files (both editions parse with no undeclared or twice-declared names).

## Research round 9 (Nov 28 2026): the funded overnight trade on a blind rebuild (pre-registered in `PREREG_R9.md`)

**The question.** Another assistant (the user's friend's) argues that ONR's settings were chosen with all of history
visible, 2024-26 included. If so, every as-built comparison flatters the parts that were tuned, the funded overnight
trade most of all. It rebuilt the book blind ("ONR-B", every setting re-chosen by a fixed plateau rule on sessions
before 2024). On its own engine, skipping the funded overnight trade wins under ONR-B. It asked for our 5 + 5 pools
with its blind settings, next to the as-built ones ("if the honest version still says to keep the overnight trade,
that would change our view").

**How it was run** (`r9_honest.py` → `results_r9/`, the rules committed before any run):
- **Versions:** as built; ONR-B (a 0.05 ADR drive; pyramid stop 0.50, add +0.10, trail 0.50; a 90-minute IB with orders
  to 14:00; overnight at the 0.80 quantile of the stretch score before 2024, which is 0.8985 on our S&P input, stop
  1.0 ADR capped to the day's budget); and ONR-B with ONR's 60-minute IB, the note's "honest" standard, which decides.
  Each was run with and without the funded overnight trade; evaluations trade as built in every version.
- **Checks:** with the book's legs the new account class makes round 7's events exactly (all three accounts), and as
  built, with and without the trade, it reproduces `results_r7/skip_accounts.csv`. Every ONR-B pyramid trade equals
  `engine.pyramid` to the cent.
- **Noise bands:** 8 placebo runs of the honest version (overnight cutoff 0.8920-0.9050, size reference 340-360).

**Result: skipping fails in all three decision accounts, so nothing changes** (`r9_table.csv`, `r9_decision.json`).
Net to you a year, 5 funded + 5 evaluations, 12 start dates, with → without the funded overnight trade:

| Account | Version | Last 5 years | Worst full year | Dec 2019 - Nov 2021 | 2024 - Nov 2026 | Rule 5Y for skipping |
|---|---|---|---|---|---|---|
| Topstep 50K | honest (ONR-B, ONR's IB) | $79,283 → $79,097 | $38,473 → $45,000 | $91,921 → $67,730 | $87,263 → $91,459 | **fail** (early −$24,191, band $15,069) |
| | ONR-B, 90-minute IB | $70,991 → $72,450 | $32,438 → $45,000 | $88,170 → $66,735 | $79,888 → $80,555 | |
| | as built | $73,075 → $69,742 | $47,523 → $40,239 | $65,030 → $46,203 | $91,752 → $84,926 | |
| Lucid 50K add-on | honest | $59,500 → $43,593 | $34,414 → $16,813 | $63,809 → $55,307 | $69,232 → $51,005 | **fail** (−$15,907, band $3,313) |
| | ONR-B, 90-minute IB | $54,100 → $46,939 | $17,232 → $23,859 | $74,036 → $51,504 | $60,873 → $53,013 | |
| | as built | $58,262 → $53,831 | $40,987 → $33,126 | $50,837 → $42,277 | $69,455 → $65,297 | |
| Lucid 25K, 40% rule | honest | $26,793 → $24,081 | $10,583 → $12,825 | $30,450 → $25,230 | $33,820 → $28,417 | **fail** (−$2,712, band $2,010) |
| | ONR-B, 90-minute IB | $24,452 → $25,183 | $16,483 → $9,330 | $24,252 → $21,584 | $28,318 → $30,215 | |
| | as built | $29,868 → $26,490 | $13,512 → $15,191 | $20,351 → $19,594 | $40,190 → $34,177 | |
| Lucid 50K, 40% rule (reported) | honest | $52,921 → $46,288 | $20,791 → $18,104 | $64,096 → $65,533 | $66,128 → $52,766 | |
| | as built | $55,669 → $57,013 | $29,081 → $32,634 | $57,594 → $37,583 | $73,712 → $67,353 | |

**The note's own design** (25 monthly starts Nov 2021 - Nov 2023, 3 years each, mean total net, with → without; the note's
figures in brackets):

| Account | Honest (ONR-B, ONR's IB) | ONR-B, 90-minute IB | As built |
|---|---|---|---|
| Topstep 50K | $184,421 → $187,515 (note: $135k → $142k) | $157,653 → $180,296 | $207,174 → $208,526 (note: $223k → $202k) |
| Lucid 50K add-on | $151,029 → $121,598 | $132,082 → $130,337 | $169,536 → $157,104 |
| Lucid 50K, 40% rule | $133,329 → $129,780 (note's Lucid 50K: $133k → $147k) | $127,896 → $127,852 | $158,253 → $160,327 (note: $152k → $160k) |
| Lucid 25K, 40% rule | $66,551 → $60,809 (note: $30.2k → $47.2k) | $58,167 → $66,689 | $87,112 → $80,972 (note: $77k → $73k) |

With the honest IB, keeping the trade won in three of the four accounts and lost a little at Topstep 50K. Skipping won
clearly only with ONR-B's 90-minute IB, at Topstep 50K and Lucid 25K.

**The note's headline, 1 MNQ a leg with no account rules** (`unit.json`; daily P&L over all sessions):
- 2024 - Nov 20 2026, with → without the overnight trade:
  - honest: $56.05 → $42.41 a day, daily Sharpe 0.126 → 0.101 (t 3.45 → 2.77);
  - ONR-B with its 90-minute IB: $46.30 → $32.66 (0.108 → 0.082);
  - as built: $48.18 → $38.87 (0.136 → 0.121, t 3.73 → 3.31).
- Dec 2019 - Dec 2023 (in-sample for the blind choice): honest $32.36 → $26.38, as built $19.58 → $17.35.
- So on our data the blind rebuild made 79-93% of as built's daily Sharpe in 2024-26, not about half as the note found
  (0.066 against 0.122). The overnight trade added money in every version and window.

**The note's facts, checked on the Nasdaq-100 CFD 2011-2019/2018** (`facts_cfd.json`; 1 MNQ, $1.00 a round turn, t on trades in R):
- **Overnight as built** (score 0.7187, stop 0.5 ADR): 2011-2019 $0.79 a trade, t 0.29. The note's "about $0 before
  2024" holds for it.
- **Overnight with ONR-B's settings** (score 0.8985, stop 1.0 ADR): $7.67 a trade, t 2.17, 8 of 9 years up. On our
  data the blind overnight leg was positive before 2020.
- **IB, 2011-2018:**
  - both sides every day (the IB as first received): t 1.11, $0.57 a trade. This is the source of this README's
    "2011-18 t = 1.0" (*Edges by leg*).
  - v2.1 onward (the drive's side on drive days, both sides otherwise): t 1.49, $1.53 a trade.
  - the drive's side on drive days only: t 2.08, $4.68 a trade, 7 of 8 years, but t 0.10 in 2019-20.

**Answers to the note's three questions:**
1. **The overnight trade in 2011-19.** It was simulated on HistData's Nasdaq-100 CFD quotes, not the cash index. They
   run around the clock: the median session has 874 of the 920 minutes between 18:10 and 09:30. The trade enters at
   18:10's close, its stop is checked on every 1-minute bar and it exits at 09:30; where both exist, this CFD matched
   real NQ futures trade by trade. The 1.71 → 1.47 payouts per account were MNQ 2021-26 at Topstep 50K. On the CFD
   2011-2020 ours were 1.13 → 1.22, the same direction as the note's 1.35 → 1.49.
2. **The pools with the blind settings:** above. The honest version still says keep.
3. **The IB with t ≈ 1.0:** both sides every day, the IB as first received (v1).

**Where our numbers and the note's differ:**
- **The ORB's dollars:** our 2011-2020 ORB made $4.76 a trade at 1 MNQ ($47.60 per NQ). The note's "$31 a trade per
  MNQ" cannot be per MNQ: a 0.10 ADR stop risked only about $6-60 a micro then.
- **The blind version's level:** the note's blind rebuild is much weaker than ours (its Lucid 25K $30.2k against our
  $66.6k). Its intraday $600 loss limit and its reading of "add every 0.10" may differ from our capped stop and single
  add; we followed the settings as written.

## Data (history: the research's earlier series)

*Everything from here to the end describes the research on its earlier series (the Nasdaq-100 CFD from 2011, the user's earlier NQ export, Yahoo's MNQ bars). Since Nov 23 2026 no published figure comes from them: see* Your MNQ file only *above.*

| Use | Source | Period |
|---|---|---|
| Real MNQ futures check | Yahoo `MNQ=F` 5-min bars (the only free real MNQ minute data; Databento not used) | 2026-09-09 → 2026-11-17 |
| Long history | HistData `NSXUSD` (Nasdaq-100 CFD) 1-min bars, MNQ sizing ($2/pt) | 2010-11 → 2026-11-13 |
| S&P stretch score | HistData `SPXUSD` (S&P 500 CFD) 1-min bars, the research's own source | same |

**HistData timestamp bug (affects the original research too):** from 2019 on, every session inside the US/EU
daylight-saving mismatch weeks (2nd Sunday of March → last Sunday of March, last Sunday of October → 1st Sunday of
November) is labelled one hour early: its "09:30" is really 10:30 New York time. That is 137 S&P and 122 Nasdaq
sessions, about 7% of 2019+ sessions. `prep_data.py` detects each session's open label and shifts those sessions.
After the fix the CFD matches real MNQ futures: correlation of the 18:10→09:30 move 0.98, of the 09:30→09:35 drive
0.9997, of 09:35→16:00 0.9998; replaying the same trades on CFD vs MNQ differs by ~$25 per trade on average.
(The bug did not inflate the research much: overnight-signal t-stat 4.3 on raw vs 4.1 on fixed data.)

**Bad prints (Nov 22 2026):** Yahoo's MNQ=F bar at 15:00 ET on Oct 30 2026 had a false high 1,229 points above the
market, and the user's NQ export one false high on Jan 26 2021. Both are repaired at the source (`clean_prints.py`), and
every ONR Book result was rerun on the repaired data. See *Two bad prints repaired*.

## Results

All runs: Pine fill rules, $1 commission per MNQ round turn, no extra slippage unless stated. "Lifecycle" = one Lucid
Flex 25K at a time: eval → funded → $500 payouts until blown / abandoned (cushion < $200) / 5 payouts → buy the next
eval next session; statistics averaged over start dates every ~2 months. Net $/yr = payouts × $450 (90% split) −
evals × $60.

### Eval pass rate (new eval started on every session)

| | 2011–18 | 2019–26 |
|---|---|---|
| v1 | 43.7% (median 10 sessions) | 47.7% (9) |
| v2.1 | 44.4% (10) | 47.5% (9) |

Coin-flip sides on the same brackets (10 seeds, 2011–20 / 2021–26 split): 30.9% / 36.8% mean, best 33.5% / 41.4%,
vs the strategy's 42.9% / 50.4%. The tight bracket passes 34.1% / 36.1%; the paid 50% consistency add-on 42.0% / 49.0%
(no gain); dropping the news skip 39.8% / 49.3%.

### Lifecycle: payouts and dry spells

| | Payouts / yr | Months with a payout | Net $/yr | Longest dry spell: median / worst |
|---|---|---|---|---|
| v1, 2011–18 | 1.4 | 11.5% | $489 | 26.7 / 36.2 months |
| v1, 2019–26 | 7.4 | 43.4% | $2,742 | 13.1 / 14.5 months |
| **v2.1, 2011–18** | **5.2** | **33.3%** | **$1,552** | **11.9 / 12.4 months** |
| **v2.1, 2019–26** | **9.0** | **53.3%** | **$3,527** | **6.5 / 8.7 months** |

- More accounts that each buy one eval when empty multiply payouts but leave the longest dry spell unchanged, because
  every account trades the same signals; see "Several accounts" for what does help.
- The dry-spell statistic is noisy: changing the sizing reference ADR from 350 to 250 or 450 moves the worst 2019–26
  spell between 8.6 and 14.5 months. Treat any single "longest dry spell" number, including these, as ±5 months.
- Not adopted (tested, no consistent gain in both halves): wider overnight stop (0.75 / 1.0 ADR; it eats the day
  budget and crowds out the pyramid and IB), dropping the funded overnight leg, dropping the IB leg (much worse),
  pyramid-only.

### Robustness of v2.1 (one account: payouts / yr, worst dry spell)

| | 2011–18 | 2019–26 |
|---|---|---|
| base | 5.2, 12.4 months | 9.0, 8.7 months |
| 2× commission + 1 tick slippage per side | 4.0, 25.5 months | 8.1, 7.8 months |
| every entry 1 minute late | 4.8, 12.5 months | 7.0, 7.4 months |

In the calm, small-range 2011–18 market the book is fragile to costs and timing; in 2019–26 it holds.

### Funded book by year ($, full day budget every session, no account resets)

v1 (1 MNQ): positive in 16 of 16 full years, but only +$432 to +$1,613 a year until 2019.
v2.1 (ADR-sized): positive in 16 of 16 full years, from +$1,384 (2017) and +$1,435 (2023) to +$15,834 (2026 to Nov 13).
Daily Sharpe of the v2.1 funded book: 1.17 (2011–18), 1.82 (2019–26).

### Real MNQ futures, 5-min bars, 2026-09-09 → 2026-11-17 (50 sessions; v2.1 at 25K — the final 50K run is below)

- Eval: 40 of 48 rolling starts passed (all 8 failures started Oct 28 – Nov 6).
- Funded legs at 1 MNQ each, no budget: overnight 15 trades +$2,425, pyramid 24 trades +$5,781, IB 43 trades +$1,784.
- Funded book with the day risk budget: v1 69 trades +$8,289; v2.1 66 trades +$8,358 (49% and 50% winners; 1 MNQ
  either way).
- These are on the repaired data (*Two bad prints repaired*, below). Before the repair: legs +$2,325 / +$5,608 (23
  trades) / +$1,623; book v1 68 trades +$7,499, v2.1 65 trades +$7,568.
- 50 sessions in a strongly trending market say little about the future; the 15-year results matter more.

### Several accounts (`portfolio.py`)

Lucid (Nov 2026): at most 5 funded accounts and 10 accounts in total per household; copy trading between your own
accounts is allowed, opposing positions across accounts are not. Net = payouts × 90% − evals × $60; averages over 6
start dates per period.

| v2.1 | Net $ / yr (2011–18 / 2019–26) | Payouts / yr | Months with a payout | Longest dry spell |
|---|---|---|---|---|
| 1 account | $1,755 / $2,980 | 5.6 / 7.9 | 35% / 48% | 12.4 / 8.0 months |
| 5 accounts, each buys an eval when empty | $8,823 / $14,860 | 28 / 39 | 35% / 50% | 12.4 / 8.0 months |
| 5 accounts + 1 reserve eval each | $9,987 / $17,675 | 34 / 49 | 41% / 58% | 11.2 / 6.5 months |
| **5 funded kept full from an eval pool (10 max, ≤ 1 new eval a day)** | **$11,620 / $16,919** | **37 / 48** | **59% / 67%** | **7.6 / 6.5 months** |

- Pool, net by calendar year (started Feb 2011): 2011 $4.6k · 2012 $14.4k · 2013 $7.5k · 2014 $19.2k · 2015 $9.9k ·
  **2016 $0.4k** · 2017 $11.9k · 2018 $18.9k · 2019 $14.5k · 2020 $13.0k · 2021 $17.7k · 2022 $12.4k · **2023 $0.2k** ·
  2024 $30.8k · 2025 $22.0k · 2026 $24.2k (to Nov 13). Worst 12 months: −$6.0k (2011–18) / −$3.5k (2019–26).
- Plain 5 accounts, net by calendar year (same start): 2011 $9.3k · 2012 $12.5k · 2013 $9.9k · 2014 $16.4k ·
  **2015 −$0.9k** · 2016 $5.4k · 2017 $9.9k · 2018 $7.7k · 2019 $9.6k · 2020 $14.4k · 2021 $12.8k · 2022 $8.0k ·
  2023 $4.1k · 2024 $24.9k · 2025 $24.9k · 2026 $18.2k.
- With 2× commission + 1 tick slippage: pool $5.1k / $16.3k a year (longest gap 15.9 / 6.4 months); plain 5 accounts
  $2.9k / $13.8k.
- The pool buys ~80 evals a year (~$4,800 at $60, included above); it assumes a passed eval can wait until a funded
  slot frees up. Five accounts bought on the same day are exact copies of one account (same days, same blow-ups).

### Dry spells: what causes them and what was tried

Gaps of 5 months or more with no payout from any of 5 accounts (staggered a week apart, 2011–2026), with what the
strategy itself made meanwhile (continuous funded book, full budget, no resets; its average is +$654 a month):

| Gap | Strategy P&L during it | Eval pass rate in it | Kind |
|---|---|---|---|
| Jul 2014 → Jul 2015 (12.4 mo) | +$9,106 | 27% | eval bottleneck |
| Aug 2015 → Jun 2016 (10.8 mo) | +$259 | 43% | flat |
| Jul 2012 → Jun 2013 (10.7 mo) | +$3,390 | 39% | eval bottleneck |
| Nov 2017 → Jul 2018 (8.5 mo) | +$2,346 | 64% | slow funded climb |
| Sep 2020 → May 2021 (8.0 mo) | +$3,596 | 18% | eval bottleneck |
| Nov 2016 → Jul 2017 (7.6 mo) | −$4,621 | 37% | strategy drought |
| Mar → Sep 2023 (6.5 mo) | +$5,531 | 28% | eval bottleneck |
| Sep 2023 → Apr 2024 (6.4 mo) | −$7,655 | 30% | strategy drought |
| Dec 2025 → May 2026 (5.0 mo) | +$3,305 | 51% | eval bottleneck |

Tried, pre-registered, chosen on 2011–18 and checked on 2019–26:

- **Eval trades the funded book** (overnight + pyramid + IB at 1× or 2× size) to close the eval bottleneck:
  **rejected**, pass rate 26% / 40% (1×) and 20% / 32% (2×) vs 44% / 48%, twice as slow, far worse with 5 accounts.
  The v1 one-bracket eval is the better eval.
- **More parallel evals (reserve evals, eval pool):** better in both halves → recommended for multi-account use.
- Earlier (one account): wider overnight stop, dropping legs, 50% add-on, more accounts with one eval each: no gain.

What is left are strategy droughts (2016–17, late 2023): no account structure turns a losing stretch into payouts;
only a second, unrelated edge would, and adding one untested would be curve-fitting.

### Final setup: Lucid Flex 50K (indicator default), last 4 years

`report50k.py DATA OUT` produces every figure below; its tables are committed in `results_50k/`. Window Nov 14 2022 →
Nov 13 2026, $1.34 per MNQ round turn, maximum-allowed payouts, eval at $115 list price, Lucid's 10% share removed.

| Figure | Value |
|---|---|
| Eval pass rate (evals started on every session) | 42.9% of 1,034 |
| Sessions to pass: 25th / median / 75th / 90th percentile | 6 / 9 / 14 / 21 |
| Evals per funded account; fees per funded account | 2.33; $268 |
| Funded accounts that reach a payout | 56.9% of 371 (all 5 payouts: 13.5%) |
| Payouts per funded account before it ends: 0 / 1 / 2 / 3 / 4 / 5 | 43.1% / 27.5% / 1.9% / 5.7% / 8.4% / 13.5% |
| Net withdrawn per funded account, average | $2,184 |
| Days from funding to first payout (when one comes): median / 90th pct | 14 / 22 |
| One account slot, first eval to first payout: median | 69 days |
| First payout within 30 / 60 / 90 / 180 / 365 days | 17.1% / 45.0% / 60.9% / 86.4% / 100% |
| 5 funded 50K + eval pool: net a year (10 start dates) | $49,078 median ($48,114 – $54,104) |
| Payouts a year; evals bought a year | 44.2; 90.8 |
| Months with a payout; months net positive after eval fees | 65.9%; 51.3% |
| Monthly net: 10th / 25th / median / 75th / 90th percentile | −$1,725 / −$1,146 / $416 / $7,707 / $13,825 |
| Longest stretch with no payout; worst 12 months | 6.8 months; −$2,726 |
| Full calendar years positive (2023–2025, all 10 start dates) | 100% |
| One account trading every session (no resets): net a year; daily Sharpe | $19,871; 1.84 |
| Traded days positive; days of $150+ (qualifying) | 44.6%; 38.4% |
| 2× commission + 1 tick slippage: 5×50K net a year; worst 12 months | $53,796; −$3,339 (noise exceeds the cost effect) |
| Real MNQ futures Sep 9 – Nov 17 2026: evals passed; one account's trades | 32 of 48; +$19,211 on 73 trades |

The real-MNQ row uses this run's own S&P file, which ends with the Nov 13 session, so its Nov 17 reuses Nov 13's score
and has no overnight signal. `mnq_real50k.py` below uses the extended S&P series: +$18,649 on 73 trades.

By calendar year (5 funded 50K + eval pool from Nov 14 2022; one account's trades split by leg):

| Year | Net, 5 × 50K | Payouts | One account | Overnight | Pyramid | IB | Eval pass |
|---|---|---|---|---|---|---|---|
| 2022 (Nov 14 – Dec 31) | $4,521 | 5 | $4,044 | −$182 | $4,764 | −$538 | 32.4% |
| 2023 | $6,116 | 14 | −$3,204 | −$2,589 | −$2,607 | $1,992 | 24.9% |
| 2024 | $84,081 | 71 | $27,634 | $1,737 | $15,494 | $10,402 | 57.0% |
| 2025 | $24,814 | 32 | $15,355 | $2,252 | $9,951 | $3,152 | 42.3% |
| 2026 (to Nov 13) | $81,838 | 59 | $35,600 | $9,606 | $15,733 | $10,261 | 49.5% |

The 10 start dates converge by 2024 (the pool buys evals every day), so the yearly rows are one historical path, not
a spread of possible futures. Per trade (one 50K account): pyramid 98.6 trades a year, 32.5% winners, profit factor
1.72, +$10,841 a year (t 3.21); IB with the drive 168.9 a year, 43.7%, 1.21, +$6,322 (t 2.17); overnight 72.8 a year,
49.5%, 1.17, +$2,708 (t 1.01). Live alarm bands for one 50K funded account (median / yellow / red): day 20 $1,309 /
−$3,538 / −$5,359; day 60 $4,340 / −$4,383 / −$7,776; day 250 $18,683 / $100 / −$7,284.

#### The final 50K setup on real MNQ futures (`mnq_real50k.py` → `results_50k/real_mnq_50k.txt`)

Yahoo `MNQ=F` 5-minute bars, Sep 9 → 12:45 ET on Nov 17 2026, 50 sessions, same rules and costs. HistData's S&P data
ends with the Nov 13 session; the score of the Nov 16 session comes from Dukascopy's S&P 500 CFD (`prep_spx_ext.py`:
on the four days both sources have, the two scores agree to within 0.002), so every session has its own overnight
signal. These weeks lie inside the research window (through the CFD), so this checks the strategy on real futures
prices; it is not an out-of-sample test.

**Correction (Nov 18 2026).** The first version of this run reused Nov 13's score for Nov 17, which gave no overnight
signal. With Monday Nov 16's own score (+0.885, a buy, as the live indicator showed), Nov 17 has the overnight buy and
the pyramid, and **no** IB breakout, because the day's $1,200 risk budget was already used. The first version showed the
IB instead of the overnight trade and overstated Nov 17 by $612.84. On the repaired data (*Two bad prints repaired*,
below) Nov 17 is the overnight buy +$32.66 at 1 MNQ and the pyramid +$1,560.59; the overnight trade took $597 of the
budget and the pyramid $418, and the IB needed $298 more.

| One funded 50K account, every session | Trades | Winners | Net |
|---|---|---|---|
| Overnight | 16 | 69% | +$4,304 |
| Opening-drive pyramid | 23 | 43% | +$11,496 |
| IB breakout | 34 | 44% | +$2,848 |
| All | 73 | 49% | +$18,649 |

- 47 traded days: 53% positive, 47% qualifying ($150+), best +$7,078 (Sep 21), worst −$914. Without Sep 21 the
  account made about +$11,600. Weeks (Monday start): 9 of 11 positive, worst −$1,495 (week of Sep 28).
- Size: 3 MNQ while the ADR was under 280, 2 MNQ at 286–455, 1 MNQ at 481–597 (Nov 3, then from Nov 6).
- Evals started on every session: 32 of 48 finished passed (67%, median 10 sessions); all 15 started Oct 19 – Nov 6
  failed, then passes resumed. 2 were still open when the data ended.
- One account bought Sep 9: eval passed Sep 30; payouts $1,136 (Oct 16) and $1,280 (Oct 30). Before Nov 5 its
  cushion above the drawdown floor fell below $400 and it was given up; a second eval died Nov 9, a third passed
  Nov 16. Net +$1,829 after 3 evals ($345); the new funded account was open with +$1,593.
- 5 funded 50K + eval pool: 10 payouts ($11,677 gross), 16 evals ($1,840), net +$8,670 in the 50 sessions.
- These figures are on the repaired data (*Two bad prints repaired*, below). Yahoo's bar at 15:00 ET on Oct 30 had a
  false high 1,229 points above the market. It inflated that day's range by 702 points and the ADR by 50 points from
  Nov 2, so the run traded 1 MNQ where it should have traded 2 on Nov 2, 4 and 5. Before the repair this run showed
  +$16,955 on 71 trades for the funded account and +$18,360 for the pool: at the smaller size the account bought Sep 9
  had stayed above the $400 cushion and taken a third payout on Nov 17.

**Eval plan vs funded plan.** The table above is the funded plan, which the indicator draws with Phase = FUNDED: up to
three trades a day, 1 MNQ each at today's range. With Phase = EVAL, the default, the indicator draws the eval plan:
one trade a session, the 18:10 ET overnight trade if there is a signal and otherwise the 09:35 drive. At these days'
range it trades 2 MNQ with a fixed stop (299 points) and target (300 points). `export_charts.py` writes that plan session by session to
`results_charts/real_eval_trades.csv`, and it matches the live chart:

| Session | Eval | Funded |
|---|---|---|
| Nov 16 | 09:35 drive sell, target +$1,197.32 | pyramid sell, trailing stop −$216.84 |
| Nov 17 | overnight buy from Nov 16 18:10 ET, out at 09:30 +$65.32 (the chart showed +$66: TradingView's feed differs by one tick) | overnight +$32.66, pyramid +$1,560.59, IB not placed |
| Nov 18 (entered Nov 17 18:10 ET) | overnight buy, stopped −$1,200.00 | overnight buy at 1 MNQ, stopped about −$630 |

The Nov 18 entry is after the MNQ data ends. Yahoo refused downloads that day, so it was checked on Dukascopy's
Nasdaq-100 CFD ticks instead. The price fell 495 points below the entry, past both stops: 299 points for the eval,
315 points (0.5 ADR, with Nov 17's range from the CFD) for the funded account (340 points before the repair).

### Last 4 years only (Nov 14 2022 → Nov 13 2026): the numbers to rely on

The window treated as reliable: today's NQ (about 28,000, daily range 380–650 points) and the same-day-options era.
About 1,000 sessions, essentially one regime, so per-trade t-stats are smaller; each result is also shown for the two
2-year halves. `research.py DATA recent` reproduces this section. MNQ, $1.34 per round turn for accounts.

| Leg | 4 years | Nov 2022 – Nov 2024 | Nov 2024 – Nov 2026 |
|---|---|---|---|
| Opening-drive pyramid | +0.224R (t 3.4, n 462) | +0.175R (t 1.7) | +0.261R (t 3.0) |
| IB breakout with the 09:35 drive | +0.225R (t 2.6, n 246) | +0.269R (t 2.1) | +0.190R (t 1.7) |
| IB breakout against the drive (removed in v2.1) | −0.291R (t −3.2, n 158) | −0.075R | −0.477R (t −4.3) |
| IB breakout, no drive that day | +0.085R (t 1.6, n 505) | +0.031R | +0.151R |
| Overnight buy signals, no stop | +0.133 ADR (t 3.0, n 140) | +0.039 (t 0.6) | +0.211 (t 3.3) |
| Overnight sell signals, no stop | +0.024 ADR (t 0.8, n 151) | +0.003 | +0.051 |
| Overnight leg with its 0.5 ADR stop | buys +0.122R (t 1.4), sells +0.006R | | |
| Long every night (overnight drift) | +0.031 ADR (t 2.1) | | |
| Last-half-hour momentum / noise area / 5-min ORB | t −0.3 / 1.6 / 1.3 | | |

Eval pass rate (evals started on every session): 25K 53.5%, 50K 42.9%, 150K 38.5% (median 9–10 sessions); 25K with
coin-flip sides 37.2% (best of 10 seeds 44.8%).

| Setup (net of 90% split and list-price evals) | 4 years | First 2 yrs | Last 2 yrs | Longest gap | Worst 12 months |
|---|---|---|---|---|---|
| one 25K, $500 payouts (v2.1) | $3.4k | $2.5k | $3.7k | 7.0 mo | −$0.3k |
| one 25K, max-allowed payouts (v2.2) | $5.2k | $4.1k | $6.4k | 7.3 mo | ~$0 |
| one 50K, max-allowed | $9.4k | $8.7k | $7.6k | 9.3 mo | −$0.8k |
| 5 funded 25K + eval pool, $500 payouts | $19.0k | $12.4k | $23.8k | 6.9 mo | −$4.6k |
| **5 funded 25K + eval pool, max-allowed** | **$32.4k** | $20.6k | $40.3k | 7.2 mo | −$2.6k |
| **5 funded 50K + eval pool, max-allowed** | **$51.1k** | $32.6k | $57.8k | 6.7 mo | −$2.7k |
| 5 funded 100K + eval pool, max-allowed | $61.2k | $36.1k | $73.4k | 6.6 mo | −$20.9k |
| 5 funded 150K + eval pool, max-allowed | $83.5k | $68.6k | $73.6k | 6.5 mo | −$22.3k |

Year by year, 5 funded + eval pool from Nov 14 2022 (2022 = 7 weeks, 2026 = to Nov 13):
- 25K max-allowed: 2022 +$3.7k · **2023 −$1.3k** · 2024 +$49.5k · 2025 +$30.8k · 2026 +$42.9k
- 50K max-allowed: 2022 +$4.5k · 2023 +$6.1k · 2024 +$84.1k · 2025 +$24.8k · 2026 +$81.8k
- 150K max-allowed: 2022 +$9.0k · 2023 +$35.1k · 2024 +$168.5k · 2025 +$54.3k · 2026 +$95.2k

What the 4-year view changes: nothing in the rules. It confirms the v2.1 IB fix (against-drive trades lost heavily),
max-allowed payouts (+70% for 5×25K) and 50K over 25K (+58% with the same worst 12 months). Long-only overnight
stays out (5×50K better, single 25K worse). Run-to-run noise between setups is around ±10% (e.g. 50K with doubled costs
came out slightly ahead of base costs), so don't read small differences. 2023 is the drought year in this window.

### Research round (v2.2): what could make it better

Method: hypotheses fixed in advance from the literature or from Lucid's rules, never from the backtest; a trading change
counts only if it is positive with t >= 2 in BOTH 2011–18 and 2019–26 (and survives 1 tick of slippage); an account
change only if it improves the account results in both halves. `research.py legs|accounts|followup|final` reruns all.

**Literature checked against NQ 2011–2026** (published parameters, nothing tuned):

| Test | 2011–18 | 2019–26 | Verdict |
|---|---|---|---|
| L1 last-half-hour momentum (Gao, Han, Li, Zhou, JFE 2018: prior close → 10:00 predicts 15:30 → 16:00) | −0.008 ADR (t −1.9) | −0.009 ADR (t −2.0) | rejected: slightly reversed on NQ |
| L2 noise-area intraday momentum (Zarattini, Aziz, Barbon 2024; TWAP for VWAP) | +0.016 ADR/day (t 1.8) | +0.020 (t 2.5) | not validated |
| L3 5-minute ORB (Zarattini, Aziz 2023) | +0.03R (t 0.5) | +0.15R (t 2.6) | not validated; the book's 09:35 pyramid: +0.16R (t 3.2) / +0.20R (t 4.4) |
| M2 momentum legs by volatility regime (ADR14 / ADR100 terciles) | pattern flips between halves | | rejected |
| M1 overnight leg, buy signals (overnight-drift literature) | +0.118 ADR (t 4.4) | +0.097 ADR (t 3.2) | real |
| M1 overnight leg, sell signals | −0.029 ADR (t −1.8) | +0.008 ADR (t 0.4) | no edge |

The buy signal beats simply holding long every night (the market's overnight drift, +0.036 / +0.030 ADR) by +0.083 ADR
(t 2.9) / +0.067 ADR (t 2.1). But skipping sell signals did not improve account results in both halves (better 5-account
pool, slightly worse single account; with max payouts a wash), so it is not adopted.

**Lucid products and sizes** (third-party summaries of Lucid's help centre, Nov 2026 — verify before buying):

- Flex is the right product for this book: end-of-day drawdown, news trading allowed, no funded consistency rule.
- LucidDaily (payouts any day above a buffer) does not fit: its funded drawdown is always intraday and high-impact USD
  news is a hard breach (flat 1 minute before to 1 minute after) — the overnight leg holds through 08:30 releases.
  Pro and Direct apply funded consistency rules (40% / 20% per cycle) that big trend days would keep tripping.
- Flex sizes: 50K / 100K / 150K have $2,000 / $3,000 / $4,500 max loss, $3,000 / $6,000 / $9,000 targets, $150 / $200 /
  $250 qualifying days, $2,000 / $2,500 / $3,000 payout caps, list price $115 / $215 / $323 (30% codes are common).

**Account results** at a realistic $1.34 per MNQ round turn (prop schedules quote $1.24–$1.42), net of the 90% split and
evals at list price, averaged over 6 start dates (2011–18 | 2019–26):

| Setup | Net / yr | Longest gap | Worst 12 months |
|---|---|---|---|
| one 25K, $500 payouts (v2.1) | $1.0k \| $2.6k | 16.0 \| 8.0 mo | −$1.0k \| −$0.3k |
| one 25K, max-allowed payouts (v2.2) | $2.0k \| $4.3k | 13.5 \| 8.0 mo | −$1.0k \| +$0.1k |
| one 50K, max-allowed | $4.3k \| $7.2k | 12.0 \| 9.4 mo | −$1.5k \| −$0.8k |
| 5 funded 25K + eval pool, $500 payouts (v2.1) | $8.1k \| $15.1k | 7.6 \| 6.5 mo | −$7.1k \| −$4.0k |
| **5 funded 25K + eval pool, max-allowed (v2.2)** | **$12.3k \| $26.4k** | 7.6 \| 6.4 mo | −$6.9k \| −$2.0k |
| **5 funded 50K + eval pool, max-allowed** | **$21.6k \| $46.7k** | 7.3 \| 6.4 mo | −$12.3k \| −$2.3k |
| 5 funded 150K + eval pool, max-allowed | $23.2k \| $78.4k | 8.0 \| 6.4 mo | −$34.7k \| −$20.1k |

- **Max-allowed payouts** win in both halves for every size: each Flex account pays out at most 5 times and eventually
  ends, so profit left inside it is eventually lost. With $500 payouts a 100K pool loses money in 2011–18 and a 150K
  pool in both halves.
- **50K** roughly doubles 25K's income per slot with moderately deeper drought years; **150K** only pulls ahead in
  strong regimes and can cost ~$35k of evals in a bad year. With 2× commission + 1 tick slippage the 5×50K pool still
  makes $8.0k / $47.6k (25K: $5.5k / $25.5k).
- No setup removes the 6–8 month gaps: they are the strategy's own losing stretches.

**Operations:** Lucid allows automated strategies and trade copiers on eval and funded accounts (no HFT); TradersPost,
CrossTrade and PickMyTrade connect to it. Automating the alerts removes late manual entries, which the backtest shows
matter in calm markets — test any automation on an eval first.

### Research round 3 (pre-registered in `PREREG_R3.md` before testing): nothing beat the current rules

Six changes with a published or structural rationale, tested on Lucid Flex 50K (max-allowed payouts, $1.34) with 12
start dates per period; `research3.py DATA accounts|legs|diag` reruns everything (`results_r3/`). Decision rule: beat
the shipped rules by more than the placebo noise band in BOTH 2011–18 and 2019–26, longest gap at most 1 month worse.

**Noise band.** Four placebo runs (score threshold 0.715 / 0.722, Auto-size reference 345 / 355) moved the 5 × 50K
pool by up to $4.5k (2011–18), $3.8k (2019–26) and $11.3k a year (last 4 years) around the base's $21.5k / $47.1k /
$54.3k. Account-level differences smaller than that are path noise: trivial changes shift which days cross a payout
or drawdown threshold, and the effect compounds.

| ID | Change (source) | 5 × 50K pool vs base: 2011–18 / 2019–26 / last 4y | Other evidence | Verdict |
|---|---|---|---|---|
| A | Funded risk proportional to the cushion (Grossman & Zhou 1993); f = 0.6 chosen | −$2.4k / −$12.0k / −$9.8k | more funded accounts get a payout (51–61% vs 41–56%) but smaller ones; f = 0.4: worst 12 months −$1.7k / −$1.0k / −$0.8k vs −$12.3k / −$2.3k / −$2.7k, for about half the income | rejected |
| B | Day budget 800 × M (all three legs fit) | +$6.0k (gap +1.1 mo) / −$3.2k / −$10.2k | | rejected |
| C | Eval risk per trade × 0.75 (Dubins & Savage timid play) | −$5.9k / −$2.3k / +$1.0k | × 0.5 raises the pass rate (37.2 / 43.3 / 47.7% vs 34.9 / 39.2 / 42.9%) but triples the time to pass (median 33–37 sessions) | rejected |
| D | Eval skips overnight sells (chosen over 09:35-drive only) | −$1.7k / +$1.9k / +$7.0k | pass rate +0.3 / +1.1 / +2.8 points | rejected (inside the noise) |
| E | Second pyramid add at +0.30 ADR | −$4.6k (gap +8.3 mo) / +$13.3k / +$3.3k | per trade +0.017R (t 0.8) / +0.036R (t 1.9) | rejected (works only in the recent regime) |
| F | Overnight exit at 04:00 ET, no eval news skip (Boyarchenko, Larsen & Whelan 2023) | +$0.2k / +$0.9k / −$3.3k | per trade, buys −0.031R / −0.004R | rejected |

As pre-registered, A cut the day budget faster than contract rounding cut the size, so it often crowded out the
pyramid. A version that scales every leg in proportion was not tested; it would be a post-hoc change.

**Diagnostics.**
- **European-open drift.** The 2–3 a.m. ET move, every night, was +0.010 ADR (t 3.3) in 2011–14 and +0.012 (t 3.5) in
  2015–18, then +0.003 (t 0.7) in 2019–22 and +0.001 (t 0.3) in 2023–26. This replicates the NY Fed's *Disappearing
  Overnight Drift* (July 2026) on this data.
- **Overnight buy signal.** It does not depend on that window: +0.140 ADR by 09:30 in 2023–26, 40% of it earned after
  04:00. Sell signals show no edge in any 4-year block.
- **S&P 500 (MES).** The momentum legs are weaker there: pyramid +0.050R (t 1.0) / +0.087R (t 2.0), IB +0.002R /
  +0.073R. Monthly correlation with NQ is 0.50. They were positive in both NQ droughts (+4.5R and +11.5R) but fail
  2011–18, so MES is not added.

### Research round 4 (pre-registered in `PREREG_R4.md` before testing): 1 to 5 accounts, and can the weak years be fixed?

`research4.py DATA results_r4` runs everything (528 simulations, about a minute); `report4.py results_r4 results_r4` writes the tables. Lucid Flex 50K, $1.34 per MNQ round turn, $115 per eval, 90% split, mean of 12 start dates (Feb–May 2011, and from Nov 14 2022 for the last 4 years). The start dates converge within the first year, so each calendar year is effectively one historical path.

**Why some years made little** (one funded account trading every session):

- 2011–2017: NQ at 2,000–6,000 with a 30–55 point range meant 14–20 MNQ per leg, and commission took 32–94% of the gross (2017: $9,275 gross, −$8,721 commission). At today's 1–3 MNQ per leg it is 3–8% (2026: −$919 on $36,519).
- 2023: the strategy lost before any commission (−$1,673 gross).
- 2015 and 2016: eval pass rates of 17.0% and 36.4%, so eval fees ate the payouts (5 funded + evals: $3,497 and −$5,122).

**1 to 5 accounts.** *N accounts in all*: each an eval until it passes, then funded, a new eval when one fails or ends, at most one new eval a day. *N funded + N evals in reserve*: up to 2N accounts, so a passed eval is waiting when a funded account ends. Accounts bought the same day and copy-traded move in lockstep and make exactly N times one account ($5,438 a year each, $9,330 over the last 4 years).

| Setup | Net a year, 2011–26 | Net a year, last 4 years | Worst year | Losing years 2012–25 | Worst 12 months | Longest gap | Eval pass rate | Funded with a payout | Most cash out of pocket |
|---|---|---|---|---|---|---|---|---|---|
| 1 account | $5,202 | $6,676 | −$1,819 | 3 | −$2,070 | 14.7 mo | 36.5% | 47.4% | −$987 |
| 2 accounts | $9,822 | $13,449 | −$2,790 | 3 | −$3,275 | 12.0 mo | 37.4% | 45.5% | −$1,974 |
| 3 accounts | $14,624 | $20,108 | −$2,208 | 2 | −$4,770 | 12.0 mo | 38.4% | 45.8% | −$3,023 |
| 4 accounts | $19,638 | $26,334 | −$2,403 | 2 | −$6,265 | 12.0 mo | 39.4% | 47.1% | −$3,895 |
| 5 accounts | $24,599 | $34,681 | −$2,597 | 3 | −$7,990 | 12.0 mo | 39.7% | 47.6% | −$4,624 |
| 1 funded + 1 eval | $7,129 | $11,037 | −$174 | 3 | −$2,623 | 7.4 mo | 37.0% | 44.3% | −$1,277 |
| 2 funded + 2 evals | $13,659 | $20,118 | −$117 | 1 | −$5,245 | 7.3 mo | 38.6% | 43.5% | −$2,276 |
| 3 funded + 3 evals | $20,724 | $30,221 | −$1,136 | 1 | −$7,408 | 7.3 mo | 40.2% | 42.6% | −$3,707 |
| 4 funded + 4 evals | $27,867 | $41,309 | −$2,499 | 1 | −$9,686 | 7.3 mo | 40.3% | 43.0% | −$4,542 |
| **5 funded + 5 evals (current)** | $34,221 | $50,199 | −$5,122 | 1 | −$12,309 | 7.3 mo | 40.4% | 43.9% | −$6,190 |

Every year for each setup is in `results_r4/accounts_years_wide.csv` (median, lowest and highest of the 12 start dates, eval pass rate, payouts, evals) and on the dashboard.

**Can the weak years be fixed?** Three families aimed at steadier years, with the rule written down first: adopt only if the worst year (or the yearly net) improves by more than the placebo noise band in both 2011–18 and 2019–26 without the other falling by more than its band. 5 funded + evals:

| Setup | 2011–18 net a year | 2011–18 worst year | 2019–26 net a year | 2019–26 worst year | Last 4 years net a year | Last 4 years worst year |
|---|---|---|---|---|---|---|
| **Current rules** | $21,006 | −$5,122 | $47,303 | $11,081 | $50,199 | $4,182 |
| Placebo: size reference 345 | $25,541 | $483 | $47,080 | $11,656 | $54,339 | $4,757 |
| Placebo: size reference 355 | $19,842 | −$750 | $50,947 | $5,647 | $60,480 | $4,182 |
| Placebo: score threshold 0.715 | $21,597 | −$5,122 | $49,499 | $11,081 | $54,641 | $4,182 |
| Placebo: score threshold 0.722 | $21,404 | −$5,122 | $48,918 | $11,081 | $50,199 | $4,182 |
| 0.5× size | $12,835 | −$236 | $24,010 | $3,442 | $26,552 | $1,896 |
| 0.75× size | $20,832 | $4,698 | $37,523 | $8,295 | $46,675 | $405 |
| 1.25× size | $20,888 | $929 | $53,538 | $3,411 | $63,928 | $9,038 |
| 1.5× size | $11,415 | −$1,522 | $9,016 | $0 | $22,925 | $3,044 |
| No new evals after a losing 6 months | $13,490 | −$8,062 | $42,849 | $2,617 | $41,535 | −$4,282 |
| No new evals after a losing 3 months | $14,318 | −$7,006 | $41,201 | $6,671 | $42,875 | $2 |
| 7 accounts in all | $20,373 | −$2,944 | $38,293 | $7,127 | $39,269 | $5,587 |
| 8 accounts in all | $21,775 | −$3,497 | $41,636 | $7,897 | $42,774 | $5,185 |

Noise bands (largest placebo move): 2011–18 net $4,535, worst year $5,605; 2019–26 net $3,644, worst year $5,434. Verdict (`results_r4/decisions.txt`): **none adopted**. The throttle lowered both the income and the worst year in every period. 0.75× size passed 2011–18 on steadiness but failed 2019–26 (less income, no better worst year). 1.25× made more since 2019 but its 2019–26 worst year fell. 7 or 8 accounts made less. The current rules stay.

### The last 5 years first, and research round 5 (pre-registered in `PREREG_R5.md` and its addendum before any result)

`research5.py DATA R5DATA results_r5 accounts` (about 5 minutes) and `report5.py results_r5`. These use Lucid Flex 50K,
$1.34 per MNQ round turn, $115 per eval, a 90% split and the mean of 12 start dates (Nov 15 2021 and every 5 sessions
after it, to Nov 13 2026). The full years are 2022–2025. The start dates converge within months, so each year is
essentially one historical path.

**The current rules over the last 5 years.** Accounts bought the same day and copy-traded make exactly N times one
account: $8,028 a year each.

| Setup | Net a year | Worst full year | Total, 5 years | Deepest drop | Worst 12 months | Longest gap | Months with a payout | Eval pass rate | Payouts | Most cash out |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 account in all | $7,314 | $716 | $35,733 | −$1,840 | −$618 | 9.3 mo | 40.2% | 41.2% | 31.1 | −$527 |
| 2 accounts in all | $13,458 | $1,285 | $65,748 | −$3,105 | −$1,121 | 7.2 mo | 45.2% | 40.5% | 59.1 | −$1,054 |
| 3 accounts in all | $19,521 | $2,165 | $95,370 | −$4,140 | −$701 | 6.8 mo | 48.5% | 40.7% | 87.1 | −$1,572 |
| 4 accounts in all | $25,573 | $3,045 | $124,945 | −$5,060 | −$166 | 6.8 mo | 50.2% | 41.5% | 114.9 | −$2,070 |
| 5 accounts in all | $32,830 | $3,925 | $160,402 | −$5,865 | $1,059 | 6.8 mo | 55.2% | 42.6% | 146.9 | −$2,492 |
| 1 funded + 1 eval | $10,488 | −$67 | $51,237 | −$2,990 | −$2,343 | 7.1 mo | 53.7% | 38.9% | 50.1 | −$1,054 |
| 2 funded + 2 evals | $19,675 | $2,862 | $96,125 | −$3,910 | −$1,690 | 7.0 mo | 53.7% | 41.8% | 95.1 | −$2,070 |
| 3 funded + 3 evals | $29,829 | $6,163 | $145,735 | −$5,520 | −$1,381 | 6.4 mo | 62.1% | 45.0% | 141.1 | −$2,904 |
| 4 funded + 4 evals | $40,407 | $7,594 | $197,417 | −$7,245 | −$1,996 | 6.4 mo | 66.5% | 45.3% | 186.8 | −$3,699 |
| **5 funded + 5 evals (current)** | **$49,103** | **$11,081** | $239,902 | −$8,855 | −$2,266 | 6.4 mo | 67.0% | 46.2% | 230.0 | −$4,284 |

Year by year, 5 funded + 5 evals (median of the 12 start dates): 2021 (from Nov 15) −$1,610 · 2022 $38,691 ·
**2023 $11,081** · 2024 $84,081 · 2025 $24,814 · 2026 (to Nov 13) $81,838. The eval pass rate ran 49.2%, **23.4%**,
50.5%, 52.3% and 49.2% in 2022 to 2026, so 2023 was weak because evals failed. Every year of every setup is in
`results_r5/accounts_5y_years_wide.csv` and on the dashboard.

**Every account-level change of rounds 3 to 5, re-scored on the last 5 years (rule 5Y).**
- **The rule:** a change must beat the current rules over the last 5 years by more than the noise band, either on the
  worst full year or on the net a year without hurting the other by more than its band. In 2011–21 it must not be
  worse than that period's band on either.
- **The noise band:** 8 placebo runs (score threshold 0.712/0.715/0.722/0.725 instead of 0.7187; size reference
  340/345/355/360 instead of 350) give ±$11,596 a year in net and ±$9,884 in the worst year over the last 5 years, and
  ±$2,005 and ±$6,103 in 2011–21.

The size reference 360 alone, a trivial change, moved the last-5-year income by $11,596 a year. One 5-year path cannot
tell smaller differences from luck.

| Setup (5 funded + 5 evals) | Last 5 years: net a year | Last 5 years: worst year | 2011–21: net a year | 2011–21: worst year | Verdict |
|---|---|---|---|---|---|
| Current rules | $49,103 | $11,081 | $27,984 | −$5,122 | in use |
| Pyramid adds again at +0.30 ADR (round 3, E) | $56,201 | $25,108 | $31,499 | −$11,577 | steadier in the last 5 years, worse than the band in 2011–21: rejected |
| 1.25× the size (round 4, R) | $63,006 | $13,958 | $25,918 | $929 | more money in the last 5 years, net a year $61 past the band in 2011–21: rejected |
| Eval skips overnight sells (round 3, D2) | $54,626 | $12,682 | $26,789 | −$5,467 | inside the noise |
| Funded skips overnight sells (round 5, S) | $48,535 | $2,798 | $33,705 | −$1,975 | inside the noise |
| Overnight exit 04:00 ET (round 3, F) | $47,472 | $14,484 | $29,049 | −$1,011 | inside the noise |
| Placebo: size reference 360 | $60,699 | $20,964 | $29,580 | $981 | sets the band |

**A second market (H5-M), the book's pyramid and IB legs unchanged on gold and crude oil.**

| Leg | 2011–18 (R per trade) | t | 2011–21 (R per trade) | t |
|---|---|---|---|---|
| Gold pyramid | −0.012R | −0.3 | −0.015R | −0.4 |
| Gold IB breakout | −0.007R | −0.2 | −0.011R | −0.4 |
| Crude pyramid | +0.017R | 0.4 | +0.004R | 0.1 |
| Crude IB breakout | +0.028R | 0.9 | +0.015R | 0.5 |

`research5.py … legs-early` writes `results_r5/legs_early.txt`. These periods need no data after Nov 2023.
- **Gold** fails both rules, the original (positive with t ≥ 2 in 2011–18) and 5Y (positive in 2011–21), so it gets no
  account test whatever 2023–26 shows.
- **Crude** fails the original rule. Rule 5Y needs crude's last 5 years, and its 2024–26 minute data (Dukascopy) was
  still downloading when this was written.

Data notes:
- HistData's gold and crude files label the sessions of the US/European daylight-saving mismatch weeks an hour
  early, as its index CFDs do. With that fixed, the correlation of 5-minute moves with real gold futures in
  daylight-saving weeks rose from 0.877 to 0.987.
- Both files miss large parts of the day session from February to July 2023. Crude's 113 such days were filled from
  Dukascopy, whose prices match HistData's to the cent on the complete days.

All 18 changes, 9 from round 3, 8 from round 4 and 1 from round 5, are in `results_r5/r5_configs.csv` and
`results_r5/decisions.txt`. **None passed.** Under the original round-4 rule (2011–18 and 2019–26), the funded "skip
overnight sells" change (H5-S) passed 2011–18 on money and failed 2019–26, so it is rejected there too. The rules stay.

### Research round 6 (pre-registered in `PREREG_R6.md`): the strategy without its overnight trade

`research6.py DATA results_r6`. Three ways to drop the 18:10 ET overnight trade, and one replacement: with no overnight trade, an eval that sees no 09:35 drive takes the 10:30 IB breakout instead, with its usual bracket. 5 funded + 5 evals, mean of 12 start dates, rule 5Y with round 5's noise bands. The engine change (`engine.ib_entry`, `EvalAccount(ib_fallback=True)`) is off by default; the current rules reproduce exactly (901 fingerprints, 7,459 50K checks).

| Setup | Last 5 years: net a year | Last 5 years: worst year | Last 5 years: deepest drop | Longest wait | 2011–21: net a year | 2011–21: worst year | 2011–21: deepest drop |
|---|---|---|---|---|---|---|---|
| Current rules | $49,103 | $11,081 | −$8,855 | 6.4 mo | $27,984 | −$5,122 | −$20,490 |
| No overnight trade at all | $46,188 | $9,898 | −$6,210 | 6.4 mo | $27,611 | −$7,819 | −$25,759 |
| Funded accounts skip it | $50,674 | $6,207 | −$7,130 | 6.8 mo | $26,846 | −$2,419 | −$18,059 |
| Evals skip it (round 3's D1) | $48,724 | $12,451 | −$7,820 | 6.4 mo | $26,437 | −$13,334 | −$33,159 |
| No overnight trade; eval takes the 10:30 IB instead | $51,522 | $18,903 | −$4,831 | 2.9 mo | $25,318 | −$8,080 | −$38,208 |

**None passed** (`results_r6/decisions.txt`); under the original rule (2011–18 and 2019–26) neither family passes either.
- Dropping the overnight trade made less ($46,188 against $49,103 a year) with a slightly lower worst year.
- The IB replacement looked steadier over the last 5 years: worst year $18,903, longest wait 2.9 months.
  Those gains are inside the noise band, and in 2011–21 it was worse, with a deepest drop of −$38,208 against −$20,490.

**The overnight trade's own share** (`results_r6/overnight_share.csv`, after commission). Over the last 5 years one funded account trading every session made:
- $9,593 from 402 overnight trades;
- $47,965 from the 09:35 pyramid;
- $41,187 from the IB breakout.

The eval plan's 302 overnight trades made $19,765 (+65 a trade). Its 434 trades at 09:35 made $64,347 (+148 a trade).

### At your eval price: $88.20 instead of $115

A Lucid Flex 50K eval costs $88.20 with the user's discount code. The eval price only changes the bookkeeping (net = 90% of payouts − price × evals bought), never a trade, so every study was run again with `ONR_EVAL_FEE_50K=88.20` into the `*_fee8820` folders.
- Trades, payouts and eval counts are identical at both prices.
- The decisions are unchanged: rounds 4, 5 and 6 adopt nothing at $88.20 either, with their noise bands recomputed at that price.
- The dashboard shows the $88.20 figures. The last 5 years:

| Setup | Net a year | Worst full year | Total, 5 years | Worst 12 months | Most cash out |
|---|---|---|---|---|---|
| 1 account in all | $7,679 | $1,091 | $37,517 | −$162 | −$404 |
| 2 accounts in all | $14,171 | $1,982 | $69,236 | −$237 | −$809 |
| 3 accounts in all | $20,571 | $3,077 | $100,506 | $505 | −$1,205 |
| 4 accounts in all | $26,922 | $4,171 | $131,538 | $1,335 | −$1,588 |
| 5 accounts in all | $34,473 | $5,265 | $168,433 | $2,694 | −$1,911 |
| 1 funded + 1 eval | $11,092 | $603 | $54,192 | −$1,485 | −$809 |
| 2 funded + 2 evals | $20,767 | $3,720 | $101,462 | −$457 | −$1,588 |
| 3 funded + 3 evals | $31,399 | $7,342 | $153,408 | $334 | −$2,227 |
| 4 funded + 4 evals | $42,418 | $9,202 | $207,251 | $282 | −$2,837 |
| **5 funded + 5 evals (current)** | $51,566 | $13,010 | $251,942 | $494 | −$3,285 |

Year by year, 5 funded + 5 evals at $88.20: 2021 (from Nov 15) −$1,235 · 2022 $41,612 · 2023 $13,010 · 2024 $86,466 · 2025 $27,655 · 2026 (to Nov 13) $83,661.

### Final review (Nov 18 2026): the indicator against the backtest, line by line

Every line of `indicators/onr_book.pine` was checked against `engine.py` and `account.py`:
- the S&P score's 14 features and their z constants (equal to 6 decimals);
- the session clock (an event fires on the first bar whose close reaches its minute), the ADR, the IB range and the half days;
- every entry, stop, target and fill: a gap through a stop fills at the open, a target needs a tick through, and the stop wins a tie;
- the pyramid's add (at the open after a gap) and its trail;
- the IB orders: only on the drive's side, and a stop inside the fill bar counts;
- the eval bracket, the funded day budget, the cushion levels, the sizes and the payout rules.

No logic difference was found. The regression checks are unchanged (901 fingerprints, 7,459 50K checks), and the script still parses with no undeclared names. What changed in the indicator (no trade changes):
- **Tooltips at 50K.** Three tooltips quoted 25K pass rates from the first study (the 50% add-on, the bracket width, the news skip). They now give the 50K numbers below (`options50k.py`). The size tooltip now says its figures use list eval prices.
- **Header.** It now says what "5 funded + 5 evals" means (up to 10 accounts in all, one new eval a day) and includes the start-up weeks, Nov 15 – Dec 31 2021 (−$1.2k).
- **Live alarm bands.** These now come from the last 5 years, like every other figure, instead of the last 4. They are slightly tighter, so the alarm turns yellow or red a little sooner.

| Trading days | Typical | Yellow below | Red below | Before (last 4 years): typical / yellow / red |
|---|---|---|---|---|
| 20 | $1,354 | −$3,300 | −$5,202 | $1,309 / −$3,538 / −$5,359 |
| 40 | $2,831 | −$4,055 | −$6,555 | $2,785 / −$4,112 / −$6,883 |
| 60 | $4,190 | −$4,160 | −$7,376 | $4,340 / −$4,383 / −$7,776 |
| 120 | $8,623 | −$3,261 | −$7,956 | $8,760 / −$3,566 / −$8,929 |
| 250 | $18,314 | $923 | −$5,903 | $18,683 / $100 / −$7,284 |

Eval options at 50K, evals started on every session (`results_options_fee8820/options_pass_rates.csv`):

| Option | Last 5 years | 2011–20 | 2021–26 |
|---|---|---|---|
| Default: 40% rule, wide bracket, news skip | 41.3% | 34.8% | 40.9% |
| 50% consistency add-on | 44.2% | 34.4% | 42.8% |
| Medium bracket ×0.75 | 41.5% | 31.0% | 38.0% |
| Tight bracket ×0.5 | 39.5% | 22.1% | 37.0% |
| No news skip | 39.9% | 31.1% | 39.5% |

**New: the paid 50% consistency add-on helps at 50K.** The first study (25K, one account, $500 payouts) found no gain, and that conclusion was carried forward without a retest. At 50K with 5 funded + 5 evals and max-allowed payouts, it is worth having.
- **What it changes:** the eval passes when the best day is at most 50% of the total profit, instead of 40%. The bracket's target cap rises from $1,200 to $1,500, so the same $1,200 stop is spread over slightly more contracts. The indicator already does both when "EVAL: consistency rule you bought" is set to "50% (paid add-on)".
- **How it was scored:** research round 5/6's machinery and rule 5Y, unchanged (12 start dates, 8-placebo noise bands). Its price per eval is not known here, so each price was scored.

| Add-on price per eval | Last 5 years: net a year | Worst full year | 2011–21: net a year | Worst full year | Rule 5Y |
|---|---|---|---|---|---|
| (none: current rules) | $51,566 | $13,010 | $30,816 | −$1,906 | |
| $0 | $63,486 (+$11,920) | $24,179 (+$11,169) | $35,078 (+$4,262) | $2,283 (+$4,189) | passes |
| $10 | $62,545 (+$10,979) | $23,419 (+$10,409) | $33,978 (+$3,163) | $1,023 (+$2,929) | passes |
| $15 | $62,075 (+$10,509) | $23,039 (+$10,029) | $33,429 (+$2,613) | $393 (+$2,299) | passes |
| $20 | $61,604 (+$10,038) | $22,659 (+$9,649) | $32,879 (+$2,063) | −$237 (+$1,669) | inside the noise band |
| $30 | $60,663 (+$9,098) | $21,899 (+$8,889) | $31,779 (+$964) | −$1,497 (+$409) | inside the noise band |
| $40 | $59,723 (+$8,157) | $21,139 (+$8,129) | $30,680 (−$136) | −$2,757 (−$851) | inside the noise band |

Evals at $88.20.
- **Rule 5Y:** it passes up to an add-on price of $16.21 an eval ($15.50 with $115 evals; `results_options/`).
  - Up to about $33 it is still ahead on net and on the worst year in both periods, but by less than the noise band.
  - Above about $39 it makes less than the current rules in 2011–21.
  - Each $10 of add-on price costs about $940 a year (94 evals a year).
- **The price:** Lucid's help centre confirms the rule (50% instead of 40%, evaluation only, chosen at checkout) but does not give a price. Check it at checkout.
- **Caveat:** this check was run after the add-on's first numbers had been seen, so it is a descriptive result, not a pre-registered one.

`options50k.py DATA results_options_fee8820` (with `ONR_EVAL_FEE_50K=88.20`) reproduces both tables.

#### The full backtest with the add-on (`addon50k.py`, `results_addon_fee8820/`; the dashboard's "50% add-on" page)

The same 5-year report with every eval bought with the add-on (`ONR_EVAL_CONS=0.5 report50k.py` → `results_50k_5y_addon_fee8820/`), side by side with the current rules. Evals at $88.20, before the add-on's own price:

| Last 5 years | Current rules (40%) | With the 50% add-on |
|---|---|---|
| Eval pass rate (an eval started on every session) | 41.3% | 44.2% |
| Sessions to pass: median / 90th percentile | 9 / 20 | 8 / 17 |
| Funded accounts that reach a payout | 61.8% | 63.1% |
| Paid to you per funded account, average | $1,946 | $2,112 |
| One account slot: first payout, median / within 90 days | 58 days / 67.5% | 54 days / 71.9% |
| 5 funded + 5 evals: net a year | $51,566 | $63,486 |
| Worst full year / worst 12 months | $13,010 / $494 | $24,179 / $7,229 |
| Longest wait for a payout | 6.4 months | 6.1 months |
| Total, 5 years / most cash out of pocket | $251,942 / −$3,285 | $310,193 / −$2,852 |

By year, 5 funded + 5 evals (median of 12 start dates):

| Year | Current | With the add-on | Difference |
|---|---|---|---|
| 2022 | $41,612 | $48,159 | +$6,547 |
| 2023 | $13,010 | $24,179 | +$11,169 |
| 2024 | $86,466 | $105,224 | +$18,757 |
| 2025 | $27,655 | $41,626 | +$13,971 |
| 2026 (to Nov 13) | $83,661 | $91,796 | +$8,135 |

Since 2011 (start Feb 15 2011), the add-on made more in 12 of 16 years and less in 4: 2012 −$723, 2013 −$3,547, 2018 −$2,803 and 2021 −$2,622.

**Real MNQ futures, Sep 9 – Nov 17 2026: the add-on did worse.** It passed a slightly larger share of evals (32 of 47 against 32 of 48). But one account bought on Sep 9 netted $66 against $1,910, and 5 funded + 5 evals netted $152 against $9,098 (27 evals bought against 16). The reason is timing:
- With the add-on, the Sep 9 eval passed on Sep 28 instead of Sep 30, so its funded account met a different run of days.
- Its first payout on Oct 16 was $563 instead of $1,136. After the payout the cushion was thin, and the Oct 19 loss took it below the $400 abandon level.
- Its next three evals each ran out of cushion before a fifth one passed on Nov 16.
- Under the current rules, the same account was funded two sessions later and survived Oct 19. It took a second payout on Oct 30 ($1,280), fell below the $400 level on Nov 4, and its third eval passed on Nov 16.
- These are the repaired data's figures (*Two bad prints repaired*, below). Before the repair the current rules had kept the Sep 9 account through Nov 17 (3 payouts, net $3,894; pool $18,705 with 10 evals) and the add-on's pool netted $5,479 with 25 evals.

This is one 50-session path; the 5-year figures come from about 1,300 sessions and many start dates. The step-by-step table is `addon_journey.csv`. The current-rules figures equal `export_charts.py`'s checked ones.

`indicators/onr_book_addon50.pine` is the same indicator for an eval bought with the add-on: identical trading logic, with "EVAL: consistency rule you bought" (from v2.4 "LUCID EVAL: ...") defaulting to 50% and the add-on's backtest in its header and panel. Its tooltips for the bracket width and the news skip still quote the 40%-rule pass rates; those options were not re-run with the add-on.

### Real NQ futures: a 5-year 5-minute file (Nov 19 2026)

The user supplied `NQ_5Years_8_11_2024.csv`: NQ futures, 5-minute bars, Aug 11 2019 -> Aug 9 2024, additively back-adjusted (a constant added per contract period, so every move and range in points is intact). `prep_nqfut.py` repairs it and fills the gap to Nov 2026. `NQFUT.npz.json` records every step.

**What was wrong with the file, and the repair**
- **Labels are bar end times.** The busiest bars are labelled 09:35 and 08:35, and sessions run 18:05 -> 17:00. Every label moves back 5 minutes.
- **Mixed clocks.** For most of Aug 2019 - Nov 2022 the file is on Central European time, New York + 6 hours (+5 when the US and Europe change clocks on different dates). Unshifted, its 5-minute moves correlate about 0.0 with the market (0.99 shifted). Each contiguous block of bars gets the whole-hour offset that best matches the CFD; 1,869 of 1,909 blocks align at 0.80 or better. The rest (1,750 bars, 0.5%) are dropped.
- **A missing hour each day.** On those days the export also dropped one New York day-session hour (11:00 or 12:00), apparently while removing what it took for CME's 17:00-18:00 halt. Bars missing inside 09:30-16:00 are filled from the CFD at the futures' price level: 22% of 2019's day-session bars, 21% of 2020's, 27% of 2021's, 24% of 2022's, and none in 2023-24.
- **The result.** After the repair, every month correlates 0.985-0.999 with the CFD, and the futures' day ranges match the CFD's within 0.7% every year.
- **The fill after Aug 9 2024.** The HistData CFD, made into 5-minute bars, through the Sep 9 2026 session; then real MNQ (Yahoo) to 12:40 ET on Nov 17 2026. Every join is at an 18:00 session start.

**A defect in the CFD.** HistData's NSXUSD misses large parts of the day session on 117 days in Feb-Jul 2023 (half its sessions in those months). The futures file is complete there. Every earlier backtest used that CFD, so its 2023, the "drought year", was partly a data artifact.

**Trade by trade, real futures vs the CFD** (`nqfut_check.py` -> `results_nqfut_check/`; Aug 30 2019 -> Aug 9 2024, 1,260 sessions; one funded account trading the whole book every day, and an eval started every session):

| Period | One funded account a year: futures / CFD 5-min / CFD 1-min | Daily P&L correlation (futures vs CFD) | Same trade side | Eval pass, 40%: futures / CFD | Eval pass, add-on: futures / CFD |
|---|---|---|---|---|---|
| All but Feb-Jul 2023 | $17,676 / $18,118 / $18,639 | 0.97 | 97.9% | 37.1% / 36.8% | 39.5% / 39.0% |
| 2023 | $6,308 / -$2,095 / -$3,154 | 0.78 | 90.5% | 32.4% / 25.0% | 41.4% / 32.8% |

So the CFD is a faithful proxy where its data is complete. The 1-minute and 5-minute CFD agree too (daily correlation 0.99).

**The backtest on real futures** (`ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 report50k.py`; evals at $88.20, $1.34 commission, after Lucid's 10%, before the add-on's own price). Median of 10 start dates in the first 6 weeks; by-year figures are the first path.

| | Futures, Sep 2019 - Nov 2026: add-on | 40% | Futures, last 5 years: add-on | 40% | CFD, last 5 years: add-on | 40% |
|---|---|---|---|---|---|---|
| Eval pass rate | 43.5% | 41.1% | 46.1% | 42.5% | 44.2% | 41.3% |
| Sessions to pass, median | 8 | 10 | 8 | 9 | 8 | 9 |
| Funded accounts that reach a payout | 58.9% | 56.1% | 58.8% | 55.7% | 63.1% | 61.8% |
| One account slot: first payout median / within 90 days | 55 d / 71.6% | 64 d / 63.6% | 54 d / 74.8% | 64 d / 64.2% | 54 d / 71.9% | 58 d / 67.5% |
| 5 funded + 5 evals: net a year | $60,338 | $58,479 | $60,959 | $60,610 | $62,635 | $50,785 |
| Worst 12 months | +$31,910 | +$22,242 | +$32,294 | +$22,242 | +$7,229 | +$494 |
| Longest wait for a payout | 7.6 mo | 6.1 mo | 5.9 mo | 5.9 mo | 6.1 mo | 6.4 mo |
| 2x costs + 1 tick: net a year | $54,801 | $52,500 | $56,762 | $52,002 | $58,830 | $52,406 |
| One funded account trading every day, a year | $20,932 | $20,932 | $21,419 | $21,419 | $19,773 | $19,773 |

By year, 5 funded + 5 evals on real futures (add-on / 40%):

| Year | Add-on | 40% |
|---|---|---|
| 2019 (from Sep 3) | $7,763 | $3,840 |
| 2020 | $54,682 | $44,727 |
| 2021 | $68,124 | $68,316 |
| 2022 | $40,612 | $40,832 |
| 2023 | $40,468 | $33,494 |
| 2024 | $94,040 | $100,018 |
| 2025 | $49,650 | $39,022 |
| 2026 (to Nov 17) | $78,596 | $88,273 |

Every full year is positive. On the CFD, 2023 was $24,179 / $13,010.

**What changes**
- **The strategy holds up on real futures.** The last 5 years make about $61k a year with either rule.
- **The add-on.** On real futures its income gain is about +$0.3k a year over the last 5 years (+$1.9k over the full window), inside the noise; on the CFD it was +$11.9k, inflated partly by the CFD's 2023 defect and partly by path noise. Year by year the gap swings from -$9.7k to +$10.6k with small data changes. It still passes more evals (46.1% vs 42.5%), pays the first payout about 10 days sooner (median 54 vs 64 days), and improves the worst 12 months (+$32.3k vs +$22.2k). It is worth buying for those, but not for a promised income gain.
- **Data sources by period:** Sep 2019 - Aug 9 2024 real NQ futures (2019-22 with the CFD-filled hour); Aug 12 2024 - Sep 9 2026 the CFD; Sep 10 - Nov 17 2026 real MNQ.

Reproduce (the CSV is not committed: it is the user's file):

```bash
python3 -I prep_nqfut.py NQ_5Years_8_11_2024.csv ../../data/NSXUSD.npz ../../data/MNQ_5m_60d.npz ../../data_fut/NQFUT.npz
ln -s ../data_live/SPXUSD.npz ../../data_fut/SPXUSD.npz
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 ONR_EVAL_CONS=0.5 python3 report50k.py ../../data_fut results_nqfut_addon_fee8820 2019-09-03
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py ../../data_fut results_nqfut_fee8820 2019-09-03
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 ONR_EVAL_CONS=0.5 python3 report50k.py ../../data_fut results_nqfut_5y_addon_fee8820 2021-11-15
ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py ../../data_fut results_nqfut_5y_fee8820 2021-11-15
ONR_EVAL_FEE_50K=88.20 ONR_EVAL_CONS=0.5 python3 report50k.py ../../data results_cfd19_addon_fee8820 2019-09-03
ONR_EVAL_FEE_50K=88.20 python3 report50k.py ../../data results_cfd19_fee8820 2019-09-03
python3 nqfut_check.py ../../data_fut ../../data results_nqfut_check
```

#### The website and the indicator now use real futures (`futures_site.py` -> `results_futsite_fee8820/`)

The dashboard's 5-year pages now run on the futures series instead of the CFD. Research round 5's machinery runs unchanged; only its NQ sessions are swapped for `NQFUT.npz` at 5-minute bars. The pages cover:
- 1-5 funded accounts: 12 start dates, round 4's structures A, B and C;
- the add-on against the 40% rule, with the 8 placebo runs;
- every year;
- the trade-by-trade check;
- a data page.

Mean of the 12 start dates, last 5 years, 5 funded + 5 evals at $88.20:

| | 40% rule | 50% add-on (before its price) |
|---|---|---|
| Net a year | $61,504 | $61,757 |
| Worst full year | $33,494 (2023) | $40,104 |
| Worst 12 months | +$22,242 | +$32,294 |
| Eval pass rate | 42.5% | 46.1% |
| First payout after the first eval, median | 64 days | 54 days |

The add-on's +$253 a year is far inside the noise band of the 8 placebo runs ($4,977), and its worst-year gain (+$6,610) is inside that band too ($8,985). So round 5's rule does not adopt it for income at any price. On the earlier futures years, Aug 30 2019 - Nov 14 2021, the gain was +$5,226 a year. The case for buying it is the pass rate, the sooner first payout and the better worst 12 months.

**The indicator follows.** Its live alarm bands now come from `results_nqfut_5y_fee8820/alarm_bands.csv`: one 50K funded account on real futures, last 5 years, 20,000 block-bootstrap paths.

| Day | Median | Yellow below | Red below |
|---|---|---|---|
| 20 | $1,514 | -$3,171 | -$4,924 |
| 250 | $20,316 | +$2,803 | -$4,018 |

Its panel quotes the futures backtest.

**Chart drawing (Nov 19 2026, both indicator files; no trading logic changed).**
- Each trade is drawn like TradingView's position tool, from its entry bar to its exit bar: a red box from the entry to the stop, a green box from the entry to the target, and a gray entry line.
- A compact BUY / SELL label with the contract count marks each entry. A label with the result in $, commission included, marks each exit. Hovering a label shows the prices.
- The funded overnight trade and the pyramid have no fixed target, so they get only the red box. The pyramid's moving stop stays an orange line, and its add is labelled ADD.
- The old triangles and stop / target lines are gone. Purple lines still show the IB stop orders while they wait to fill.
- A "Show stop / target boxes" input turns the boxes off.

```bash
ONR_EVAL_FEE_50K=88.20 python3 futures_site.py ../../data_fut results_futsite_fee8820
```

### Lucid's move-to-live rule: what the maximum really makes (`live50k.py` → `results_live_fee8820/`)

**The most accounts Lucid allows.** Lucid's help centre ("Maximum Number of Accounts", Aug 26 2026) allows 10 accounts per household across evaluations and funded accounts, at most 5 of them funded, plus up to 5 LucidLive accounts. So 5 funded + 5 evals, the plan's default, is already the maximum.

**What every earlier pool figure assumed.** The accounts cycled for ever: an account that took its 5th payout simply ended, and a passed eval took its slot.

**What Lucid's rules say instead:**
- After its 5th payout a LucidFlex account's trader "will be moved live" ("LucidFlex Payouts", Jul 28 2026).
- When a trader is moved live, every simulated account closes, funded and evals alike (live structure, Oct 4 2026).
- Each funded account with at least one payout becomes a live account. It starts at $0 with a $2,000 end-of-day drawdown, which locks at $100 once live profits reach $2,000.
- Live accounts have no consistency rule and allow daily payouts.
- A one-time Live Bonus ($2,000 at 50K, 90/10) is paid once live profits reach $2,100, the first time a trader goes live.
- After losing a live account, a trader may buy evals again after 2 weeks.

**The model** (`live50k.py`'s docstring; fixed before the runs):
- The pool runs as before (`research4.sim_pool`) until the first 5th payout.
- Then the move: funded accounts with a payout go live; the others close, refunded when at least half their drawdown remains; evals in reserve are lost; unpaid sim profit is lost.
- Live accounts trade the funded plan with `FundedAccount`'s own code. Once locked, they keep a $2,000 cushion and withdraw the rest daily at an 80% split, and close at the plan's $400 abandon level.
- 2 weeks after the last live account is gone, the pool starts again from nothing.

The run checks itself:
- With the rule switched off it gives `sim_pool`'s events exactly.
- It reproduces the website's $61,504.

Last 5 years on real futures, mean of 12 start dates, evals at $88.20:

| 5 funded + 5 evals | 40% rule: net a year | worst full year | worst 12 months | 50% add-on: net a year | worst full year | worst 12 months |
|---|---|---|---|---|---|---|
| Accounts cycle for ever (earlier model; not Lucid's rules) | $61,504 | $33,494 | +$22,242 | $61,757 | $40,104 | +$32,294 |
| **Lucid's rules: moved live at the first 5th payout** (live split 80%) | **$48,292** | $32,287 | +$22,242 | **$47,356** | $37,956 | +$19,059 |
| Same, live split 90% (reported since March 2026) | $48,500 | $32,444 | +$22,242 | $47,630 | $38,100 | +$19,059 |
| Each account closed right after its 4th payout (never moved live) | $58,800 | $33,494 | +$22,242 | $59,494 | $38,612 | +$31,809 |

**What happens under the rule:**
- **When:** the first 5th payout comes after a median 265 days (add-on: 122). Over 5 years you are moved live 5 times.
- **Live accounts:** each move opens up to 5 live accounts, 21 over the 5 years. They are identical copies trading the same plan, so they rise and fall together. They close at the $400 cushion after a median 10 sessions (add-on: 19).
- **Withdrawals:** only 60 of 252 live accounts withdrew anything (add-on: 115 of 259), on average $484 gross ($621).
- **Live Bonus:** never earned with the 40% rule. With the add-on, the first set earned it in 2022: 5 × $1,800.
- **Cost of each move:** the evals in reserve, the unpaid sim profit and the weeks it takes to rebuild: 2 weeks' wait, then new evals, one a day.
- **Restart rule:** letting evals start again beside the remaining live accounts changes nothing, because the live accounts end together.

By year (median of the 12 start dates):

| Year | Lucid's rules | Closed after the 4th payout | Cycling for ever | Times moved live |
|---|---|---|---|---|
| 2022 | $42,243 | $40,576 | $40,832 | 1 |
| 2023 | $33,494 | $33,494 | $33,494 | 0 |
| 2024 | $75,351 | $94,469 | $100,018 | 2 |
| 2025 | $32,287 | $47,852 | $39,022 | 1 |
| 2026 (to Nov 17) | $53,563 | $72,005 | $88,273 | 1 |

Under Lucid's rules, 1 to 5 funded accounts with as many evals make $12,436, $23,010, $30,590, $39,208 and $48,292 a year (`lucid_5y.csv`). Since Aug 2019 (`live_summary.csv`, window "all"), the rule takes 5 funded + 5 evals from $58,364 to $46,820, and closing at the 4th payout gives $54,398.

**What it means:**
- The maximum setup makes about $48k a year under Lucid's stated rules, not $62k.
- Closing each funded account right after its 4th payout keeps the 10 accounts cycling and recovers most of the difference ($58.8k).
  - Lucid's risk team decides who goes live, and can move a trader for other reasons, such as lifetime payouts or sim performance. So this is not guaranteed.
  - It gives up the live accounts and the one-time bonus.
- The add-on still changes income by less than the noise. Under the rule it brings the first move live forward (122 vs 265 days) and makes $0.9k a year less.
- The indicator's trades are unchanged; only how the accounts are run differs.

**The indicator follows this from v2.3 (both editions).** The trades, sizes, stops and targets are unchanged.
- **Payout plan.** A new input, "FUNDED: payout plan", defaults to "Close after the 4th payout".
  - The 4th payout request says it is the last one.
  - Once 4 payouts are entered, the panel says to close the account and refill the slot from an eval.
  - "Take the 5th payout" restores the old behaviour, and the panel then says Lucid moves you live.
- **LIVE phase.** A new Phase, LIVE, trades a LucidLive account with exactly the funded plan.
  - Its drawdown trails the end-of-day P&L from $0 by the size's max loss. It locks at +$100 once live profit reaches it, or at the first live payout.
  - The panel says to withdraw nothing before the lock, then everything above the max loss + $100.
  - It says to stop trading the account below the $400 cushion; once no live account is left, Lucid lets you buy evals again after 2 weeks.
- **Header and panel.** Both now quote these figures (real futures, Lucid's rules).
- **Older tooltips.** The ones that still quote CFD results now say so.

**With the add-on's own price (Nov 19).** The user buys the 50% add-on for $10 extra per eval, so each eval costs $98.20. `ONR_ADDON_FEE_50K=10` charges that $10 on the add-on runs' evals only (`results_live_fee8820_addon10/`). The trades are identical; only the accounting changes.

| 5 funded + 5 evals, each account closed after its 4th payout | 50% add-on ($98.20 an eval) | 40% rule ($88.20) |
|---|---|---|
| Net a year | $58,528 | $58,800 |
| Worst full year | $37,451 | $33,494 |
| Worst 12 months | +$30,614 | +$22,242 |

The website's main view is now this setup: the 50% add-on at $98.20, each account closed after its 4th payout. The table of 1 to 5 accounts and the yearly chart show the same setup.

```bash
ONR_EVAL_FEE_50K=88.20 python3 live50k.py ../../data_fut results_live_fee8820
ONR_EVAL_FEE_50K=88.20 ONR_ADDON_FEE_50K=10 python3 live50k.py ../../data_fut results_live_fee8820_addon10
```

### The whole website on the user's plan (Nov 19 2026; `site_v23.py`, `results_v23_*`)

Every page of the website now uses one plan:
- the 50% consistency add-on on every eval at $98.20 ($88.20 with a discount code plus the add-on's $10);
- each funded account closed right after its 4th payout;
- up to 5 funded accounts and 10 in all, one new eval a day.

The only exception is the Tests page. Its research rounds ran earlier, with the 40% rule, $88.20 evals and accounts that kept cycling, and the page says so. The Details page's study moved from the last 4 years on the CFD to the last 5 years on real futures.

**What changed in the code** (each switch defaults to the old behaviour, so earlier results reproduce):
- `report50k.py`, `export_charts.py` and `mnq_real50k.py` read `ONR_EVAL_CONS` (the eval's consistency rule) and `ONR_MAX_PAY` (payouts before an account is closed).
- `export_charts.py` takes an optional futures data folder and the matching `report50k.py` folder. With them, the study window is the last 5 years on real futures. It is then checked against that report: book by year, first pool path, plan and price.
- `export_charts.py` checks the 60 real-MNQ sessions against `mnq_real50k.py`'s counts for each plan (`REAL_BY_PLAN`).
- `research5.metrics` and `research4.run_metrics` take the eval price per run, so one run can price the add-on at $98.20 and the 40% rule at $88.20.
- `make_kpis.py` also writes the distributions table and labels each year from the report's own window.
- `site_v23.py` makes the account tables and the add-on comparison (structures A, C and B, 1 to 5 accounts, 12 start dates):
  - on real futures over the last 5 years;
  - on the CFD for every year since 2011;
  - the 60 real-MNQ sessions for both plans.

**Checks that passed before anything was published:**
- 5 funded + 5 evals here equals `live50k.py`'s B5-addon-stop4: $58,528 a year, worst full year $37,451. The 40% comparison equals its B5-stop4: $58,800.
- `export_charts.py`'s 5-year study equals `report50k.py`'s run of the same plan, in book by year and in the first pool path ($284,780).
- Both plans' 60 real-MNQ sessions equal `mnq_real50k.py`'s counts. In those 50 sessions no account reached a 4th payout, so the payout plan changes nothing there.
- On the page, every one of the 79 drawings runs and every single figure equals its data cell. No link is broken, and nothing overflows at phone width.

**What the plan makes (last 5 years on real futures, mean of 12 start dates):**

| Accounts | Net a year | Worst full year | Months with a payout |
|---|---|---|---|
| 5 funded + 5 evals | $58,528 | $37,451 | 66.8% |
| 5 accounts in all, one new eval a day | $38,755 | $25,585 | 60.1% |
| 5 accounts bought the same day, copy-traded in lockstep | $37,516 | $26,564 | 49.7% |

- **Accounts bought the same day.** They make about the same a year as accounts bought one a day, but they pay out together. They paid in fewer months, and over every year since 2011 on the CFD their longest wait for a payout was 17.5 months against 8.6.
- **The add-on at $10.** It costs $272 a year against the 40% rule and pays for itself up to $7.19 an eval. Both are inside the $4,970 noise band. It raises the worst full year by $3,957 and the worst 12 months from $22,242 to $30,614.
- **Every year since 2011 on the CFD.** 5 funded + 5 evals made $38,539 a year with no losing full year; the worst was 2016's $1,023.
- **The last 60 days on real MNQ.** The add-on did worse in this one path: −$118 for 5 funded + 5 evals against +$9,098 with the 40% rule. Its evals passed a little more often (68.1% vs 66.7%), and its funded accounts met a worse run of days.
- **Double commission plus a tick of slippage** (the 5-year study, median of 10 start dates): $50,130 a year against $57,711.

```bash
ONR_MAX_PAY=4 ONR_EVAL_FEE_50K=98.20 ONR_EVAL_CONS=0.5 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py ../../data_fut results_v23_nqfut_5y_addon 2021-11-15
ONR_MAX_PAY=4 ONR_EVAL_FEE_50K=88.20 ONR_NQ_FILE=NQFUT.npz ONR_NQ_TF=5 python3 report50k.py ../../data_fut results_v23_nqfut_5y 2021-11-15
# the same two from 2019-09-03 (results_v23_nqfut_addon, results_v23_nqfut) and on the CFD (../../data: results_v23_cfd19_addon, results_v23_cfd19)
ONR_EVAL_FEE_50K=98.20 ONR_EVAL_CONS=0.5 ONR_MAX_PAY=4 ONR_ADDON_FEE_50K=10 python3 export_charts.py ../../data_live results_v23_charts ../../data_fut results_v23_nqfut_5y_addon
python3 make_kpis.py results_v23_nqfut_5y_addon results_v23_charts/kpis.csv "Nov 15 2021 - Nov 17 2026" "2022-2025" results_v23_charts
ONR_MAX_PAY=4 python3 site_v23.py ../../data_fut ../../data ../../data_live results_v23_site
ONR_MAX_PAY=4 python3 site_v23.py --fut-tables ../../data_fut results_v23_site
```

### Scaling up: bigger accounts (Nov 20 2026; `scale_sizes.py` → `results_scale_sizes/`)

**The constraint.** Lucid allows at most 5 funded accounts per household ("Different types of funded accounts combined may not exceed 5 accounts total"). So the user's 5 funded + 5 evals is already the most accounts. Within Lucid, the remaining lever is the account size.

**Rules at each size.** Lucid's help centre (read Nov 20 2026) confirms the rules `account.RULES` and the indicator use at every LucidFlex size:

| | 25K | 50K | 100K | 150K |
|---|---|---|---|---|
| Profit target | $1,250 | $3,000 | $6,000 | $9,000 |
| End-of-day max loss | $1,000 | $2,000 | $3,000 | $4,500 |
| Qualifying day | $100 | $150 | $200 | $250 |
| Payout cap | $1,000 | $2,000 | $2,500 | $3,000 |
| Max position | 20 MNQ | 40 MNQ | 60 MNQ | 100 MNQ |

At every size: a $500 minimum payout, a 90% split, and a 5-payout limit.

**The model.** The plan runs unchanged at each size: one new eval a day, each funded account closed after its 4th payout, and every dollar limit scaled by max loss / $1,000.

**Prices and their assumptions** (updated Nov 23 2026). Lucid's list prices were $65 / $115 / $215 / $323 when this study first ran. The help centre gives no prices, and the pricing page refused the fetch.
- The user's own prices, with Lucid's 30% discount code: $50.30 at 25K and $88.20 at 50K, and the 50% add-on $10 more at either size.
- 100K and 150K are not confirmed: 30% off the earlier list prices is assumed ($150.50 / $226.10), with the same $10 add-on. If those sizes went up like 50K ($80.50 to $88.20), they cost more than this.
- Prices change no trade.

5 funded + 5 evals, mean of 12 start dates:

| Size, rule | Eval | Last 5 years (futures): net a year | worst full year | worst 12 months | deepest drop | most cash out | 2011-2026 (CFD): net a year | worst full year |
|---|---|---|---|---|---|---|---|---|
| 25K, add-on | $60.30 | $29,052 | $16,415 | +$11,157 | -$4,583 | -$1,935 | $19,870 | $1,122 |
| **50K, add-on (the plan)** | $98.20 | **$58,528** | $37,451 | +$30,614 | -$7,463 | -$3,212 | **$38,539** | **$1,023** |
| 100K, 40% rule | $150.50 | $65,639 | $31,168 | +$22,234 | -$12,190 | -$6,572 | $37,046 | -$3,815 |
| 100K, add-on | $160.50 | $73,675 | $21,023 | +$8,867 | -$12,038 | -$6,586 | $39,926 | -$10,347 |
| **150K, 40% rule** | $226.10 | **$92,775** | $36,770 | +$20,359 | -$17,636 | -$9,986 | **$49,902** | **-$16,858** |
| 150K, add-on | $236.10 | $93,200 | $28,180 | +$9,462 | -$16,527 | -$8,281 | $56,647 | -$21,786 |

From Aug 30 2019 on futures, 150K with the 40% rule made $79,881 a year, against $55,575 for the plan.

**What it means:**
- **150K is the only size that clearly makes more**, about +$34.2k a year over the last 5 years. It is not better every year: in 2023 it made $36,770 against $39,448.
- **Its swings are about 2.4 times deeper.** It needs about $10k of eval fees before payouts catch up. Over 2011-2026 it had a losing year (2013: -$16,858); the plan's worst year was +$1,023 (2016).
- **At 150K the 40% rule is steadier than the add-on**, and cheaper per eval; the add-on's net is about the same ($93,200 against $92,775).
- **100K adds little** to 50K over the long history, with twice the drop. **25K makes half.**
- 50K with the add-on reproduces the website's $58,528 exactly (checked in the script).

The tables carry the Topstep tables' window ids, configs and year labels, so the website can set the two side by side.

```bash
python3 scale_sizes.py ../../data_fut ../../data results_scale_sizes
```

### Topstep: every configuration (Nov 20 2026; `topstep_sim.py` → `results_topstep/`)

**Topstep's rules** (help.topstep.com, read Nov 20 2026):

| | 50K | 100K | 150K |
|---|---|---|---|
| Combine per month, Standard / No Activation Fee path (a reset costs the same) | $49 / $95 | $99 / $149 | $199 / $229 |
| Target / end-of-day drawdown (locks at the start balance) | $3,000 / $2,000 | $6,000 / $3,000 | $9,000 / $4,500 |
| Combine best-day limit | 55% | 55% | 55% |
| XFA payout cap, Standard path (5 winning days of $150+) | $2,000 | $3,000 | $5,000 |
| XFA payout cap, Consistency path (3 days, best day ≤ 40% of the profit since the last payout) | $3,000 | $4,000 | $6,000 |

At every size:
- **XFA:** starts at $0; its drawdown locks at $0 and is set to $0 after any payout.
- **Fees and payouts:** a $149 activation fee per XFA on the Standard fee path; a $125 minimum payout; a 90% split.
- **Limits:** up to 5 XFAs, and no payout-count limit.

**Code changes.** `account.py` gained optional firm rules: `rules`, `lock`, `pass_cons`, `pay_min`, `pay_path`. The defaults are Lucid's. The pools, evals and funded accounts recorded beforehand are identical after the change.

**The model.** The plan runs as at Lucid: 5 funded + 5 Combines, one new Combine a session, and the indicator's 50% eval setting under Topstep's 55%.
- **Payouts:** requests follow the indicator: once an account is $1,000 up, half the profit up to Topstep's cap. Requesting at Topstep's $125 minimum (from $250 of profit) did worse with Standard payouts everywhere except 150K on futures, where it did slightly better: $75,855 a year at 50K over the last 5 years against $77,107, with a worst full year of $31,415 against $37,288 (`results_topstep_paymin125/`). After any payout an XFA's drawdown is $0, so an early small payout leaves little cushion.
- **No payout limit:** accounts are not closed after a set number of payouts.
- **Costs:** each Combine pays its monthly price at the start and every 30 days it is open; each XFA pays its activation fee.

**Not modelled:**
- **Topstep's call-up to a live account.** It is discretionary, closes every XFA and cannot be declined.
- **Smaller items:** the optional Daily Loss Limit, the monthly reset credit, and the Scaling Plan tiers. The tier table could not be read, so funded legs are capped at 6 / 10 / 10 micros (three legs inside the 20 / 30 / 30 micros we believe the tiers start at).

**How often that cap binds** (`topstep_cap.csv`). The indicator trades round(350 × max loss ÷ $1,000 ÷ ADR) MNQ a leg, so the cap binds when NQ's average daily range is below about 108 / 100 / 150 points. Over the last 5 years that happened on 0 / 0 / 6 sessions. It happened on most sessions of 2019 on futures (76 / 71 / 87 of 87) and of every CFD year before 2020 (nearly every session of 2011-2017). Lucid's plan, capped at 20 / 30 / 40, traded more on those sessions, so the windows reaching back there compare unlike sizes.

Last 5 years on real futures, mean of 12 start dates:

| Configuration | Net a year | Worst full year | Worst 12 months | Deepest drop | Most cash out |
|---|---|---|---|---|---|
| 50K, Standard payouts, Standard fees | $77,107 | $37,288 | +$28,898 | -$6,555 | -$1,783 |
| 50K, Standard payouts, No Activation Fee | $78,409 | $38,028 | +$30,466 | -$7,220 | -$3,091 |
| 100K, Standard payouts, Standard fees | $103,326 | $28,749 | +$12,024 | -$10,949 | -$3,573 |
| 150K, Standard payouts, Standard fees | $169,466 | $36,570 | +$25,475 | -$18,552 | -$7,039 |
| 150K, Standard payouts, No Activation Fee | $171,183 | $37,109 | +$26,072 | -$18,091 | -$8,006 |
| 50K / 100K / 150K, Consistency payouts | $54,534 / $55,314 / $95,334 | | +$22,796 / $0 / $0 | | |
| Lucid 50K add-on, closed after the 4th payout (the plan) | $58,528 | $37,451 | +$30,614 | -$7,463 | -$3,212 |
| Lucid 150K, 40% rule | $92,775 | $36,770 | +$20,359 | -$17,636 | -$9,986 |

Every year since 2011 (CFD), Standard payouts, Standard fees:
- 50K made $42,160 a year with a worst year of +$5,372; the Lucid plan made $38,539 with +$1,023.
- 150K made $77,859 a year, with a worst year of -$17,535 and a -$34,832 drop.

**What it means:**
- **Standard payouts made more at every size, in every window.** On the Consistency path the 40% rule traps money in the accounts. Of XFAs started every 10 sessions over the last 5 years and traded alone (`topstep_accounts.csv`), the longest wait for a payout reached 311 sessions at 50K, and 8.7% were still open at the end holding $42,398 each that had not been paid out. At 100K and 150K the pool's worst 12 months netted $0.
- **Topstep beats Lucid on paper.** The rules differ in its favour for this plan. XFAs keep paying until they fail, while Lucid's plan closes each account after its 4th payout to avoid going live. Winning days need only $150 at every size, the caps are higher at 100K and 150K, and Combines cost less.
- **The figures are a best case.** Topstep's discretionary call-up to Live would close all 5 XFAs, and the backtest cannot model it.
- **Size:** **50K** gives the most per dollar of drop. **150K** makes the most, with Lucid-150K-sized swings. **100K** has the weakest worst 12 months.
- **Fee path:** the two net within $1,717 a year of each other in every configuration and window. Over the last 5 years the Standard fee path needed less cash up front at every size.

**On the website** (v16, the Topstep tab), with Lucid at the same sizes beside it from `results_scale_sizes/`:
- all 36 summary rows and every year of each window;
- one XFA at a time, the $125 test in full, the rules and the cap table;
- how to set the indicator at Topstep.

The page was checked cell by cell, and each claim in its text, against these CSVs.

```bash
python3 topstep_sim.py ../../data_fut ../../data results_topstep
ONR_TS_PAYMIN=125 python3 topstep_sim.py ../../data_fut ../../data results_topstep_paymin125
# the tables again from runs.json (summary, years, one XFA at a time, rules, cap):
python3 topstep_sim.py --tables ../../data_fut ../../data results_topstep
```

**Month by month** (`topstep_months.py` → `results_topstep/topstep_months.csv`, `topstep_month_stats.csv`; website v17, Topstep tab).
- **What it re-runs:** the same 216 pools, keeping every calendar month of every configuration and window.
- **Each month shows:** net to you as the median, lowest and highest of the 12 start dates, then the first start date's month in full: Combines bought, passed and failed; XFAs started and lost; payouts (count, gross, Topstep's 10%); Combine and activation fees; net; running total; and the accounts open at the month's end.
- **Checks:** each run's daily cash equals `topstep_sim.cash_flows`, and its months add up to `runs.json`'s years exactly.

The first start date over the last 5 years:

| Setup | Months up | With a payout | Typical month | Worst month | Best month | Longest losing run |
|---|---|---|---|---|---|---|
| 50K, Standard payouts | 42 of 61 | 43 | $5,399 | -$2,323 (Jan 2024) | $19,800 (Dec 2024) | 5 months |
| 150K, Standard payouts | 38 of 61 | 39 | $11,362 | -$4,873 (Jan 2024) | $67,500 (Aug 2024) | 5 months |
| 50K, Consistency payouts | 23 of 61 (31 flat) | 23 | $0 | -$1,129 | $27,000 | 3 months |

Both rows use Standard fees.

```bash
python3 topstep_months.py ../../data_fut ../../data results_topstep
```

**Why Topstep made more** (`topstep_why.py` → `results_topstep_why/why.csv`). The 50K Lucid plan is turned into the Topstep plan one rule at a time, over the last 5 years (mean of 12 start dates, same trades):

| Step | Net a year | Payouts a year (average) | Fees a year | Evals bought a year |
|---|---|---|---|---|
| A. Lucid plan: add-on, closed after the 4th payout, $98.20 evals | $58,528 | 52.0 ($1,452) | $9,478 | 96.5 |
| B. A without the payout limit | $71,909 | 57.0 ($1,559) | $8,007 | 81.5 |
| C. B with Topstep's fees ($49 a month per Combine, $149 per XFA) | $70,502 | 57.0 ($1,559) | $9,415 | 81.5 |
| D. C with Topstep's account rules = the Topstep plan | $77,107 | 60.0 ($1,589) | $8,746 | 75.5 |

Each change alone from A: Topstep's fees $56,504 (−$2,024); Topstep's account rules $63,433 (+$4,905).

**What it means:**
- **The payout limit** is most of the gap (+$13.4k). Lucid's plan closes a working account after its 4th payout, because a 5th moves you live. That account's later payouts are lost, and an eval must be bought to replace it. That edge is exactly what Topstep's discretionary call-up to live could take away.
- **Topstep's account rules** add $5-7k a year. The max loss locks at $0 instead of +$100, and the Combine passes with a 55% best day instead of 50%.
- **Topstep's fees** cost $1.4-2k a year more than your $98.20 Lucid evals, mostly the $149 activation of each XFA.

**Starting cash** (`startcash.py` → `results_startcash/`). The plan is started on many dates: every 5 sessions on futures prices (271 starts, Aug 30 2019 to Dec 6 2024) and every 10 sessions on the CFD (357 starts, Feb 2011 to Nov 2024). Each start runs 2 years. "Cash out of pocket" is the lowest the running total of payouts minus every fee went.

Topstep 50K, Standard payouts, No Activation Fee path ($95 a month), futures starts:
- **Typical start:** median $2,090; back above $0 after a median 38 sessions.
- **How much was enough:** $5,000 for 80% of starts, $7,500 for 91%, $10,000 for 97%, $12,000 for all of them.
- **Worst start:** Aug 5 2020 needed $11,115. Its first payout came Apr 23 2021, and the running total was back above $0 by May 14 2021.
- **Bad timing since 2011:** starting Sep 2023, just before the Oct 2023 - Feb 2024 slump, needed about $10.3k.
- **After 2 years:** every futures start was ahead (median $132k, worst $74k).

The other setups:
- **$49 path:** median $1,823, worst $10,203.
- **Lucid plan:** median $2,062, worst $11,293.
- **CFD starts since 2011:** $12,000 was enough for every Topstep start. 1 of 357 Topstep starts was behind after 2 years (8 of 357 for the Lucid plan).

**Website v18 (Topstep tab):** what changed on the page:
- **Fee-path finding:** at 50K the No Activation Fee path made more in every window.
- **Two new sections:** "Why Topstep made more" (`topstep_why.py`) and "25K at both firms" (`topstep25k.py`, with each year).
- **Instructions:** "Running the indicator at Topstep" now describes v2.5's Topstep setting.
- **A correction:** Topstep's fees cost more, not less, on the Standard fee path. The $149 activation per XFA outweighs the cheaper Combines.
- **Headers:** the summary tables' headers are now written by the page's drawings.
- **Page size:** the page is stored without indentation or comment-only lines to stay under the 256 KB document limit.

**Checks:**
- Every cell of the 24 Topstep tables and every figure and claim in the text checked against these CSVs: 6,255 checks, 0 failures.
- All 36 month-by-month views are unchanged.
- The page harness found no problems, including at phone width.

**25K at both firms** (`topstep25k.py` → `results_topstep25k/`; Lucid from `results_scale_sizes/`).

Topstep's 25K is the Topstep Labs "$25K Static Trading Combine" (help centre, read Nov 20 2026):
- **Combine:**
  - $75 one time, no resets; expires after 90 days;
  - $2,000 target and a STATIC $1,000 max loss;
  - a mandatory $500 daily loss limit;
  - best day <= 55%;
  - 20 micros;
  - at most 5 bought a month;
  - free activation.
- **XFA:**
  - static $1,000 max loss, $0 after the first payout;
  - a $500 daily loss limit;
  - 20 micros, no scaling;
  - a $4,000 payout cap.
- **Assumed:** the 25K page states no other payout rule, so Topstep's general XFA rules are used: 5 winning days of $150 (Standard) or 3 days at 40% (Consistency), 50% of the balance, 90% split.

`account.py` gained `dll` and `max_days` for evals and `lock_after_pay` for funded accounts. A static max loss is `lock = -mll`. The defaults leave every earlier pool, eval and funded account identical (checked against the reference events saved before the first Topstep change).

The daily loss limit is met by capping each day's planned risk at $500. No Combine or XFA day lost more than $500 in 38,525 account-days.

Last 5 years, 5 funded + 5 evals, mean of 12 start dates:

| 25K | Net a year | Worst full year | Worst 12 months | Deepest drop | Most cash out |
|---|---|---|---|---|---|
| Topstep, Standard payouts ($75 Combines, 5 a month) | $31,661 | $4,747 (2023) | $1,018 | -$2,288 | -$1,981 |
| Topstep, Consistency payouts | $35,527 | $14,309 | $10,589 | -$2,194 | -$2,131 |
| Topstep, Standard, without the 5-a-month limit | $40,362 | $20,654 | $16,117 | -$4,362 | -$3,131 |
| Lucid, add-on ($60.30 evals, your price) | $29,052 | $16,415 | $11,157 | -$4,583 | -$1,935 |
| Lucid, 40% rule ($50.30, your price) | $30,897 | $16,221 | $12,899 | -$3,873 | -$1,811 |

Since 2011 (CFD):
- Topstep: Standard $20,477 (worst year +$243); Consistency $21,495 (worst year -$2,113, 2018).
- Lucid: add-on $19,870 (+$1,122); 40% rule $19,364 (-$547, 2016).

**What it means:**
- **At 25K the firms are about even.** At 50K Topstep led by about $19k a year.
- **The 5-Combines-a-month limit** binds in 68% of months on the Standard path, and it is what made 2023 weak.
- **Topstep 50K** (about $78k a year) makes more than twice as much as either 25K.

**Indicator v2.4 / v2.5: a Topstep mode** (both editions, `indicators/onr_book.pine` and `onr_book_addon50.pine`).

A new first input, "Prop firm" (Topstep or Lucid Flex), defaults to Topstep. A Trading Combine is Phase EVAL, and an XFA is Phase FUNDED. The trades, stops, targets and every $ limit are unchanged: Topstep's profit target and max loss equal Lucid's at 50K / 100K / 150K.

At Topstep the indicator uses exactly the rules of the Topstep backtest (`ek`, `fk` and `TS` in `topstep_sim.py`):
- **Max loss:** stops trailing at the start balance ($0); in an XFA it is $0 after any payout.
- **Combine:**
  - each day's target is capped at 50% of the profit target;
  - the "need" shown is Topstep's pass rule: the target, with the best day at most 55%;
  - at most 50 / 100 / 150 MNQ.
- **XFA payouts:** a new input, "TOPSTEP FUNDED: XFA payout path".
  - Standard: 5 winning days of $150 or more at every size, cap $2,000 / $3,000 / $5,000.
  - Consistency: 3 traded days, the best day since the last payout at most 40% of the profit since then, cap $3,000 / $4,000 / $6,000.
  - Both: the request comes once the XFA is $1,000 up and up since the last payout, for 50% of the balance up to the cap.
- **No payout limit:** "Payouts taken" now goes to 99, and the close-after-the-4th guidance is Lucid only.
- **Funded legs:** at most 6 / 10 / 10 MNQ, the panel showing the cap.
- **Lucid-only items** are labelled: the add-on input, the payout plan, and the LIVE phase. A Topstep live account is flagged as not modelled.

With "Prop firm" on Lucid Flex every formula reduces to v2.3's.

**v2.5 adds Topstep's 25K** (the Labs $25K Static account), exactly as `topstep25k.py`:
- $2,000 profit target;
- a static $1,000 max loss: -$1,000 from the start, and $0 after the first XFA payout;
- each day's risk capped at the $500 daily loss limit: the eval stop with commission included, and the funded day budget;
- at most 20 MNQ, with funded legs at most 6;
- a $4,000 payout cap on either path.

v2.4's "Topstep sells 50K / 100K / 150K" warning is gone.

**Checks:**
- Both editions parse.
- The constants for every firm, size and payout path equal `topstep_sim.py`, `topstep25k.py` and `account.RULES`.
- The 25K bracket, floors and day budget equal the 25K backtest on 120,000 random states.

**Checks:**
- Both editions parse with `pynescript`, with no undeclared identifiers.
- The constants, read from the Pine source for every firm, size and payout path, equal `topstep_sim.TS` / `CAP` and `account.RULES`.
- The Pine Combine bracket equals `account.eval_bracket` with Topstep's rules on 20,000 random states.
- The drawdown floor and the payout readiness and amount equal `EvalAccount` / `FundedAccount` on 200,000 random states.


### The website on your Topstep plan (Nov 20 2026; `topstep_report.py` → `results_topstep_report/`, `topstep_charts.py` → `results_topstep_site/`)

The website (v19) now leads with the user's Topstep plan, with Lucid beside it:
- **The plan:** Topstep 50K, the No Activation Fee path ($95 a Combine for every 30 days it is open), Standard payouts, 5 XFAs with 5 Combines behind them.
- **Overview:** every figure has Lucid's next to it, plus a side-by-side table and 1 to 5 XFAs.
- **Every year, Real futures and Details:** these pages now run on Topstep data.
- **Lucid:** the old Lucid overview and the accounts study are now one page, Lucid. The add-on page is now "Lucid add-on".

Two new scripts make the Topstep data, using the same definitions as the Lucid scripts they mirror.

**`topstep_report.py`** follows `report50k.py`'s definitions, using Topstep's rules (`topstep_sim.ek(50)`, `fk(50, "standard")`) and fees:
- a Combine bought on every session of the last 5 years;
- the XFA of every Combine that passed by May 13 2026;
- one account slot from every session to its first payout;
- 5 XFAs + 5 Combines from 10 start dates;
- the double-cost stress test.

`make_kpis.py`'s code then writes `kpis.csv`, `years.csv`, `monthly.csv` and `distributions.csv` in Topstep's words.

Checks:
- The book equals the Lucid plan's year by year. No contract limit binds at 50K in these 5 years: Combines peaked at 9 MNQ.
- The first pool path equals `topstep_sim.py`'s run to the cent ($382,201).
- The alarm bands are the Lucid plan's.

**`topstep_charts.py`** makes `export_charts.py`'s datasets with Topstep's accounts and fees:
- the 60 sessions of real MNQ;
- the last 5 years' slot;
- every year since Feb 15 2011 with the 6-micro cap per XFA leg;
- the cost table;
- 1 to 5 XFAs (`ts_sizes.csv`).

Each Combine's $95 renewal falls on the first session 30, 60, … days after purchase while it is open, the same rule as `topstep_sim.cash_flows`.

Checks:
- The 60-day and 5-year books equal the Lucid plan's trade by trade, and so does the every-year book from 2021.
- The 5-year pool equals `topstep_report.py`'s first path.
- The CFD pool equals `topstep_sim.py`'s CFD run from the same date ($680,733).
- Every slot's cash equals `topstep_sim.cash_flows` on its own events.
- The 5 + 5 row equals `topstep.csv`'s `5y-50-standard-noact`.

Last 5 years (`topstep_report.py`'s definitions; Lucid from `results_v23_nqfut_5y_addon`):

| | Topstep, your plan | Lucid, add-on |
|---|---|---|
| Combine / eval pass rate (one bought every session) | 46.6% | 46.1% |
| Sessions to pass, median | 8 | 8 |
| First payout after the first Combine / eval, median | 54 days | 54 days |
| Funded accounts that reach a payout | 59.0% | 58.8% |
| Payouts per funded account, average | 1.59 | 1.18 |
| Paid to you per funded account | $2,304 | $1,625 |
| Fees per funded account | $212 | $213 |
| 5 + 5, net a year (median of 10 start dates) | $77,368 | $57,711 |
| The same with 2x commission and 1 tick of slippage | $70,948 | $50,130 |

1 to 5 XFAs, each with a Combine behind it (mean of 12 start dates), against Lucid's N funded + N evals:

| | 1 + 1 | 2 + 2 | 3 + 3 | 4 + 4 | 5 + 5 |
|---|---|---|---|---|---|
| Topstep, net a year | $15,305 | $30,529 | $47,814 | $61,990 | $78,409 |
| Topstep, most cash out of pocket | -$1,077 | -$1,773 | -$2,272 | -$2,747 | -$3,091 |
| Lucid, net a year | $11,878 | $23,990 | $37,643 | $47,569 | $58,528 |

Every year since Feb 15 2011 (CFD), with the 6-micro cap:
- **One XFA trading every session** made $186,388, against $232,257 for a Lucid funded account, whose cap is 20.
  - Before 2020 NQ's range was small, so Topstep's cap held every leg at 6 MNQ. That cut both profit and commission: in 2017 one XFA kept $3,494 of $6,935, while the larger Lucid trades kept $555 of $9,275.
- **5 XFAs + 5 Combines** netted $680,733 ($43,241 a year, every year positive), against $601,804 for Lucid's 5 + 5.
- **One account slot** netted $124,226, against $100,398 at Lucid.

The 60 sessions of real MNQ: the funded accounts took the same trades and requested the same payouts (5, $2,814 gross), and 33 Combines passed against 32 evals. Net for 5 + 5: −$32 at Topstep against −$118 at Lucid; the difference is the fees.

The page's main script is now its own document (`files/app.js`, 90 KB), loaded with `<script src>`. The page document is 207 KB of its 256 KB limit, and the v18 page was 256 KB with the script inside it.

The harness passed on the published version:
- all 102 drawings ran;
- every figure equals its data cell, including figures that name a row by several columns;
- no broken links or duplicate ids;
- the tabs work;
- no sideways scroll at 390 px.

Changes to the datasets:
- **Added:** 17 Topstep datasets (`ts_*`).
- **Retired:** 12 Lucid datasets the page no longer draws: `all_days`, `all_trades`, `slot_all`, `history`, `months_all`, `real_account`, `real_evals`, `real_pool`, `slot_5y`, `years`, `monthly` and `distributions`. Their files stay in `results_v23_charts/` and `results_v23_nqfut_5y_addon/`.

```bash
python3 topstep_report.py ../../data_fut results_v23_nqfut_5y_addon results_topstep_report
python3 topstep_charts.py ../../data_live ../../data_fut results_v23_charts results_topstep_report results_topstep_site
```

### Your plan: how to run and grow the accounts (Nov 21 2026; `plan_search.py` → `results_plan_search/`)

`plan_search.py` asks which way of running and growing the accounts makes the most money for its risk.

**The setup:**
- Every payout stays in the business, and 30% of each payout to you is set aside for tax (an assumption).
- "Spare cash" is business cash minus that set-aside.
- A plan is a starting setup plus steps. Each step is taken the first session the spare cash reaches its amount.
- Those amounts are reserves: each setup's deepest fall since Aug 30 2019 on real futures (5 funded + 5 evaluations, the worst of 12 start dates), rounded up:
  - Topstep 50K $11,000, 150K $24,000;
  - Lucid 50K $12,000 ($11,000 before the Nov 23 prices), 150K $22,000.
  - The plan's steps are these reserves: Lucid at Lucid 50K's, Topstep 150K at Topstep 150K's, and the car once both are covered (`final_at` in the code).
- **The range rule:** a new Topstep Combine is 150K only while NQ's 14-day range is at least 151 points, otherwise 50K. 151 is where a 150K XFA's 10-micro leg cap stops binding. Below it, a 150K account trades no more than a 100K.
- **Start dates:** the first session of every month.
  - Sep 2019 to Nov 2023 on real futures: 51 starts, a market like today's.
  - Mar 2011 to Nov 2023 on the Nasdaq-100 CFD: 153 starts, including the quiet years.

**Checks:**
- The pool code equals `research4.sim_pool` with `topstep_sim.cash_flows` (both fee paths) or Lucid's flat price, session by session, for all 11 account types and two reserve sizes.
- The reserves equal the deepest falls in `topstep_sim.py`'s and `scale_sizes.py`'s runs.
- The earlier scratch runs of rounds 1 and 2, the car variants and the first ladder were reproduced exactly before 36 months was made an exact cut-off. Earlier chat figures had measured some plans at the end of month 36, about 37 months.

**Round 1 (17 plans) and round 2 (14 plans).** Today's market; the money made is after every cost and the tax set-aside, at exactly 36 months:

| Plan | Own money in, worst | Deepest fall | 3 years, typical | 3 years, worst | Quiet years: typical | Quiet years: deepest fall |
|---|---|---|---|---|---|---|
| Topstep 50K 5+5 only | $11,020 | -$11,020 | $133,280 | $93,572 | $71,299 | -$10,165 |
| + Lucid 50K at $23k | $11,020 | -$21,933 | $199,128 | $143,000 | $113,152 | -$23,012 |
| + Lucid, then Topstep 150K always | $11,020 | -$35,010 | $278,046 | $150,067 | $131,245 | -$57,677 |
| + Lucid, then Topstep 150K by the range rule | $11,020 | -$34,167 | $271,414 | $150,201 | $136,540 | -$24,242 |
| + Lucid, then both firms 150K | $11,020 | -$45,011 | $302,645 | $122,624 | $137,508 | -$42,150 |
| Topstep 150K from day one | $31,153 | -$31,153 | $234,796 | $168,553 | $85,814 | -$71,148 |
| **Lucid at $12k, Topstep 150K by range at $24k (the plan)** | **$11,020** | **-$35,181** | **$295,179** | **$167,290** | **$143,246** | **-$24,242** |

What changed little: the Standard fee path, Lucid's 40% rule, and the range rule at 125, 175 or 200 points. What did not help, or helped only with more risk:
- 3 or 7 Combines in reserve. 3 made less ($117,347 in 3 years against $133,280 for Topstep 50K alone). 7 needed more of your own money ($12,635) and fell deeper (-$37,697 against plan B's -$34,167), for about the same in today's market, though it made more in the quiet years ($162,528 against $136,540);
- Lucid 150K by range: more in a typical start ($290,744 against plan B's $271,414), but deeper falls (-$43,273; -$39,500 in the quiet years) and a lower worst start ($146,909 against $150,201);
- every step at once (up to $29,172 of your own money);
- half the reserves without the range rule (quiet years: a deepest fall of -$57,971).

**The car ($15,000).** The plan buys it at $51,000 of spare cash: the $36,000 that covers what is running, plus the car ($50,000 and $35,000 before the Nov 23 prices).
- **When:** a typical 13.8 months after the first Combine; 9 in 10 by 18.9 months, the latest 23.4.
- **Cushion afterwards:** spare cash never fell below $25,643, or $18,229 in the quiet years.

Other timings:
- **At $26,000 before Lucid (the previous answer):** never ran out of money, but once left only $936.
- **At $40,000–45,000 after the steps:** at $45,000 no start went below zero (the lowest was $7,854); at $40,000 one start went to -$8,177.
- **Before 150K (at $37,000):** 3 starts went below zero, the worst to -$9,619.
- **Before Lucid (car first, at $37,000 or $30,000):** 1 or 5 starts went below zero (2 or 8 in the quiet years), the worst to -$2,302 or -$7,093.

**Steps of the plan** (`final_steps.csv`, today's market, typical / 9 in 10 by):
- Lucid at $12k: 5.9 / 10.0 months.
- Topstep 150K by range at $24k: 8.8 / 12.7 months.
- The car at $51k: 13.8 / 18.9 months.

**The first ladder** (1 XFA + 1 Combine, 2 + 2 at the first payout, 5 + 5 at $11k, Lucid at $22k, both firms 150K at $46k, the car at $61k):
- needed at most $3,870;
- made a typical $193,104 in 3 years (worst start $63,498; quiet years $57,906);
- the car came at a typical 23.8 months.

**Starting with only $500 or $1,000** (`budget.csv`; `budget_table.py` → `budget_view.csv`). The plan's steps are unchanged; a start "runs out" when nothing is trading and the spare cash pays for neither a new evaluation nor a waiting activation. The rule: buy only while the spare cash covers the price, one more month of every open Combine and, on Topstep's Standard fee path, the $149 activation. A Lucid way in buys one eval at a time (a one-off price) until the first payout, then starts Topstep 5+5 and follows the plan.

The table uses every 5th session as a start, followed for 24 months (216 starts today's market / 659 quiet years); each cell is the share of starts that ran out:

| Way in | $500 | $1,000 |
|---|---|---|
| Topstep 5+5 at once, No Activation Fee | 71% / 74% | 59% / 60% |
| Topstep 5+5 at once, Standard fee path | 74% / 75% | 59% / 61% |
| One Topstep Combine at a time, No Activation Fee | 69% / 65% | 55% / 48% |
| One Topstep Combine at a time, Standard fee path | 76% / 70% | 51% / 50% |
| One Lucid 50K eval at a time, 40% rule ($88.20) | 64% / 66% | 43% / 42% |
| One Lucid 50K eval at a time, add-on ($98.20) | 73% / 70% | 52% / 55% |
| **One Lucid 25K eval at a time, 40% rule ($50.30)** | **62% / 53%** | **42% / 40%** |
| One Lucid 25K eval at a time, add-on ($60.30) | 67% / 64% | 43% / 47% |

Combines bought on back-to-back days pass and fail together, so a small budget does better spread over time. A one-off eval price with no monthly renewal makes the money last longest.

**Lucid 25K or 50K with $500 (at the Nov 23 prices).** 25K ran out less often than 50K with either rule and ended ahead after 2 years more often (today's market / quiet years):
- 40% rule: 62% / 53% ran out against 64% / 66%; ahead after 2 years 38% / 43% against 36% / 31%.
- With the add-on: 67% / 64% against 73% / 70%; ahead 33% / 32% against 27% / 28%.
- The add-on made both sizes worse with $500. Each eval costs $10 more, so $500 buys 8 tries at 25K instead of 9 (5 at 50K either way).
- 25K got far more starts to a first payout: 25 of 216 had none within 2 years, against 67 at 50K. Most 25K starts that ran out did so after the first payout, once the plan had moved the money into Topstep Combines (109 of 134).
- With $1,000 the two sizes are close with the 40% rule (42% / 40% ran out against 43% / 42%).

With $1,000 and Lucid 25K one eval at a time (40% rule; 50K in brackets):
- the first payout came a median 2.5 months in when it came (2.1);
- 5 Topstep XFAs were open by a median 4.3 months (3.8);
- the car came a median 17.4 months in, for the starts that did not run out (15.9).

**Indicator v2.6** adds the input "PLAN: my spare cash has reached $24,000 (150K step)" and the panel line "Next Topstep Combine".
- Before the step it says 50K.
- After it, 150K while NQ ADR is at least 151 points, otherwise 50K: the same rule as `Pool.pick`.
- No trade, size or rule changes.
- Both editions parse with `pynescript` with no undeclared or twice-declared names.

**Indicator v2.6.1** (review fix): once an eval's profit reaches its target, with the best day inside the firm's rule (Topstep 55%, Lucid the rule bought), it signals no new eval trades. The backtest's evals already stop at the pass; v2.6 kept signalling and showed a negative "need $-X more". The panel now says "profit target reached" and to set Phase to FUNDED once the firm confirms the pass. Topstep's 2-day Combine minimum is always met under its best-day rule (`topstep_sim.py`). Nothing else changes.

```bash
python3 plan_search.py ../../data_fut ../../data results_plan_search     # about 19 minutes on 4 cores
python3 plan_search.py ../../data_fut ../../data results_plan_search --budget-only
python3 budget_table.py results_plan_search                               # the $500 / $1,000 table (budget_view.csv)
```

### A second indicator checked: "W+Z Funded" (Nov 22 2026; `wz_check.py` → `results_wz/`)

The user pasted an indicator for funded accounts: a Williams breakout (OCO at the 09:30 open ± 0.3 × yesterday's RTH range, stop the other level or −$490 per MNQ, out at 15:59) and the Zarattini 5-minute candle (at 09:35 with the first 5 minutes; stop 0.10 ADR, target 1.0 ADR), 2 MNQ each at 50K, a −$1,200 day limit, and the plan "funded 50Ks: 3 run ONR, 2 run this". `wz_check.py` replicates its rules in the indicator's own bar order:
- exactly on the 1-minute CFD (2011–2026);
- on 5-minute bars for the futures file. On the CFD the 5-minute version came within about 4% of the exact one: Zarattini was identical and Williams slightly higher.

Costs are $1.34 per MNQ round turn and 1 tick on stop and market fills, as written. Half days, early closes and days the CME is shut are skipped.

**The two trades, 50K ($ after costs):**

| Period | Williams | Zarattini | Both, per year |
|---|---|---|---|
| 2011–18, CFD | +$7,059 in 8 years (t 1.23) | −$140 (t −0.05) | +$885 |
| 2019–23, CFD / futures | t 1.06 / 0.83 | t 2.42 / 2.23 | +$8,108 / +$7,818 |
| 2024–26, CFD / futures | t 2.15 / 2.25 | t 1.73 / 1.27 | +$20,723 / +$19,575 |

The indicator's "sealed 2024-26 t 2.40" for Zarattini does not reproduce: t 1.73 on the CFD, 1.27 on the futures file and 0.39 on its real-futures sessions alone (202). The 2.42 is 2019–23.

Robustness:
- Zarattini entered 2 or 3 minutes late: t 0.33 / 0.67 in 2019–23.
- 4 ticks of slippage: 2011–18 becomes −$1,984 a year.
- The day limit fired on 2 of 3,903 CFD days, and on 1 of 1,781 futures days.

Overlap with ONR:
- Zarattini trades the same first-5-minute direction as ONR's 09:35 pyramid.
- Daily P&L correlation with ONR's funded book is +0.38 to +0.47, and about +0.5 by month.
- In 2019–26, W+Z also lost in 21 of ONR's 30 losing months.

**Pools of 5 funded + 5 evals** (evals trade ONR), futures file Nov 15 2021 → Nov 17 2026, mean of 12 start dates (`pools.json`):
- Topstep: No Activation Fee Combines, Standard payouts.
- Lucid: $80.50 evals, each account closed after its 4th payout.
- W+Z accounts trade as written, with no cushion check, and the max loss is checked at each day's worst point (both firms enforce it intraday).

| Funded | Topstep $/yr | Lucid $/yr | 3 years, Topstep / Lucid | Worst 12 months | Months with a payout |
|---|---|---|---|---|---|
| 5 ONR | $78,409 | $59,550 | $200,173 / $167,733 | $30,466 / $23,173 | 72% / 65% |
| 3 ONR + 2 W+Z | $75,535 | $57,330 | $187,965 / $151,808 | $22,796 / $15,114 | 79% / 74% |
| 5 W+Z | $58,344 | $39,693 | $131,159 / $100,658 | −$2,592 / −$325 | 52% / 57% |

What each funded account did:
- **Topstep:** a W+Z account paid $2,243 against ONR's $2,615, and 97% of W+Z accounts ended at the max loss.
- **Lucid:** $1,202 against $1,679, and 92% ended at the max loss.

Checked at the close only, the mix would still make less than 5 ONR: $77,946 against $78,409 at Topstep, $58,604 against $59,550 at Lucid.

From Feb 2011 on the CFD, the mix made $38,537 against $43,241 (Topstep) and $33,146 against $36,784 (Lucid). The mixed pool code with no W+Z slot equals `research4.sim_pool` (checked).

**A bad print in the futures file.** `NQFUT.npz` (from Yahoo's MNQ, and its NQ file too) has a 2026-10-30 15:00 ET bar with open = high = 29,562.00 after a 28,234.50 close (low 28,284.00, close 28,307.25). `wz_check.repair` sets its open to the previous close; no other bar matches. It inflated that day's range and the ADR of the next 14 sessions. Effect on published figures:
- Lucid 5 + 5 over the last 5 years: $60,318 → $59,550 a year. Topstep unchanged at $78,409.
- Real MNQ, Sep 9 – Nov 17 2026:
  - one funded account +$16,977 (71 trades) → +$18,671 (73);
  - Lucid evals passed 30 of 46 → 32 of 48, add-on 33 of 47 → 32 of 47, Topstep 33 of 47 unchanged.
- Every other published ONR Book result has since been rerun on data repaired at the source (*Two bad prints repaired*, below).

**Version 2** (pasted later the same day; `results_wz_v2/`) changes one rule: no Williams trade on the session after a weekday holiday, an early close or any other gap. That is about 12 sessions a year: on the CFD, 94 after gaps and 95 after half days since 2011. Its early closes come from a hand-typed list (Nov 2026 – 2027 only); here `holidays.half_day` stands in for every year. Zarattini is unchanged.
- **Williams:** a little better: 2019–23 t 1.10 (futures 0.97), 2024–26 t 2.33 (2.31).
- **W+Z a year:** +$882 in 2011–18 (3 of 8 years lost money), +$8,172 in 2019–23, +$21,769 in 2024–26.

| Funded, version 2 (futures file, 12 starts) | Topstep $/yr | Lucid $/yr | 3 years, Topstep / Lucid | Worst full year | Worst 12 months | Months paid |
|---|---|---|---|---|---|---|
| 5 ONR | $78,409 | $59,550 | $200,173 / $167,733 | $38,028 / $34,341 | $30,466 / $23,173 | 72% / 65% |
| 4 ONR + 1 W+Z | −$575 | +$368 | −$3,123 / −$4,933 | | | +6.7 / +8.4 pts |
| 3 ONR + 2 W+Z | $76,206 | $56,759 | $199,002 / $148,240 | $42,001 / $24,726 | $30,078 / $15,146 | 80% / 75% |
| 5 W+Z | $62,123 | $40,702 | $138,141 / $104,632 | $20,912 / $10,157 | −$805 / −$254 | 57% / 54% |

The 4 + 1 row shows differences from 5 ONR, averaged over the 12 start dates.
- **Topstep 3 + 2:** less a year than 5 ONR in all 12 starts.
- **Lucid 4 + 1:** more a year in all 12 starts, less over 3 years in all 12.
- **From Feb 2011 on the CFD, 3 + 2:** $37,770 against $43,241 (Topstep) and $33,008 against $36,784 (Lucid).
- **Noise:** version 1 → 2 changes about 12 Williams trades a year, yet moved Topstep's 3-year mix by +$11,037. Pool differences of a few thousand dollars are within the noise of which accounts happen to end when.

```bash
python3 -I wz_check.py CFD_DIR FUT_DIR results_wz      # version 1: trades, years, sensitivity, pools
python3 -I wz_check.py CFD_DIR FUT_DIR results_wz_v2 v2
```

### Two bad prints repaired (Nov 22 2026; `clean_prints.py`)

Every price file was searched for single bad prints: one price that jumps out and straight back, more than 0.5% from
the bars around it. Each candidate was checked against the Nasdaq-100 CFD. It counts as a bad print only when the CFD
moved less than 40% as far in the same direction over that bar and the next (`clean_prints.py`'s docstring has the exact
rule). Two bars qualified, and only their outlying prices were replaced, by the CFD's at the futures' price level:

| Bar | File | Bad price | Repaired | Around it |
|---|---|---|---|---|
| 2021-01-26 00:00 ET | the user's NQ export | high 14,959.50 | 14,807.57 | bars of 14,794 – 14,827; the CFD moved 7% as far |
| 2026-10-30 15:00 ET | Yahoo's MNQ=F and NQ=F | open = high = 29,562.00 | open 28,319.99, high 28,333.12 | previous close 28,234.50; the CFD moved 4% as far |

Every other candidate was kept. The CFD or the S&P made the same move (March 2020, the April 2025 tariff days, CPI and
jobs releases), or the CFD had no bars then and the move fell on news (the COVID Sunday open, Amazon and Nvidia
earnings, the March 2023 jobs report). The Nov 5 2026 10:50 drop is real: the CFD made 85% of it.

**What the Oct 30 bar did.** It raised that day's day-session range from 627.25 to 1,329.00 points, so the 14-session
ADR was 50 points too high from Nov 2 to the end of the data (Nov 17). The ADR sets sizes and stops, so on Nov 2, 4
and 5 a 50K funded account traded 1 MNQ instead of 2 and the eval 2 instead of 3. The 2021 bar was overnight, outside
the day session, and changed no trade.

**Where the repair runs.** `prep_nqfut.py` now calls `clean_prints.repair` on the series it builds and records the
repairs in `NQFUT.npz.json` (`bad_prints_repaired`). The 60-day Yahoo file is repaired right after its download
(*Reproduce*): `clean_prints.py` writes the repaired file and a `.json` record of each repair next to it. The CFD files
needed no repair.

**Every published ONR Book result was rerun** on the repaired files. The runs are deterministic: the results that read
only the CFD came out byte-identical. (The W+Z study above was dropped and not rerun; it had already used its own repair
of the Oct 30 bar, which gives the same day range.) What changed:

| Figure (last 5 years on real futures unless noted) | Before | After |
|---|---|---|
| Topstep 50K plan, 5 XFAs + 5 Combines | $78,409 | $78,409 (unchanged) |
| Topstep 150K, Standard payouts: Standard fees / No Activation Fee | $168,547 / $170,264 | $169,466 / $171,183 |
| Lucid 50K plan: add-on at $90.50, each account closed after its 4th payout | $59,716 | $59,272 |
| Lucid 50K, 40% rule, closed after the 4th payout | $60,318 | $59,550 |
| Lucid's move-to-live rule: 40% rule / add-on | $50,096 / $48,924 | $48,975 / $48,068 |
| Eval pass rate: add-on / 40% rule | 46.2% / 42.5% | 46.1% / 42.5% |
| One funded account trading every day, a year | $21,081 | $21,419 |
| Live alarm bands, median at day 20 / day 250 | $1,504 / $20,110 | $1,514 / $20,316 |
| Real MNQ Sep 9 – Nov 17 2026: one funded account | +$16,955 (71 trades) | +$18,649 (73 trades) |
| Real MNQ: evals passed (40% rule) | 30 of 46 | 32 of 48 |
| Real MNQ: 5 funded + 5 evals ($115 evals) | +$18,360 | +$8,670 |

Unchanged: the plan (`plan_search.py`: about $296k in 3 years for a typical start, $169k for the worst), every worst
full year, worst 12 months and longest wait for a payout, and the first-payout medians (54 and 64 days).

**The other errors the audit found, all fixed:**
- `scale_sizes.py` reused its `runs.json` even when the price files had changed, so a rerun would have kept the old
  figures. It now keeps each data folder's sha256 in `runs_data.json` and makes a run again when the files differ. Its
  fresh run on the repaired data, and a second run reusing it, give identical tables.
- `topstep_why.py`, `scale_sizes.py` and `export_charts.py` (`REAL_BY_PLAN`) check themselves against published figures.
  They now pin the repaired values, and every check passes.
- `results_50k/real_mnq_50k.txt` is `mnq_real50k.py`'s output and is regenerated; `results_50k_fee8820/distributions.csv`
  is written by the `make_kpis.py` command in *Reproduce* and is now committed.
- `results_car_timeline/` was left behind when its script was removed (a9e3309) and is deleted.

**The website** (page version 22): 45 of its 71 datasets were replaced by the rerun files. The page text was corrected
where it wrote a figure or a version itself: both trade counts (73 and 1,718), the Topstep-versus-Lucid sentence on the
real-MNQ page (33 Combines passed against 32 Lucid evals now), and three mentions of the indicator version. A Nov 22 note
was added under "Latest". The page harness passed with the new data: all 560 drawings ran, every figure equals its data
cell, no link is broken and nothing overflows at phone width. Every sentence whose numbers changed was reread against
the new values.

**Indicator v2.6.2** (both editions): only texts and the live alarm bands change. The header and tooltips quote the
repaired figures, and the bands are `results_nqfut_5y_fee8820/alarm_bands.csv`. No trade, size or rule changes. Both
editions parse with `pynescript`, with no undeclared or twice-declared names.

### New Lucid prices (Nov 23 2026; `account.USER_EVAL`, `USER_ADDON`)

The user's Lucid prices with the discount code changed: a Flex 50K eval is now $88.20 (it was $80.50) and a 25K eval $50.30, and the 50% consistency add-on is $10 more at either size ($98.20 / $60.30). 100K and 150K are not confirmed: 30% off the earlier list prices is assumed ($150.50 / $226.10, $10 more with the add-on). Prices change no trade: net = 90% of payouts − the price × the evals bought.

**Code.**
- The prices live in one place, `account.py` (`USER_EVAL`, `USER_ADDON`, `USER_TAG`). Every script that prices the user's plan reads them: `site_v23.py`, `scale_sizes.py`, `plan_search.py`, `startcash.py`, `topstep_why.py`, `topstep_sim.py`'s check and `export_v23_xlsx.py`.
- The checks that compared against pinned figures now read them from the result files they cite. `scale_sizes.py` reuses saved runs only at the same prices.
- `plan_search.py` now derives the plan's steps from the reserves (`final_at`), and round 2's labels too. It also tests one Lucid 25K eval at a time as a way in. `budget_table.py` (new) turns its 24-month runs into one row per way in.

**What was rerun.**
- The `*_fee8050` folders are now `*_fee8820` (`ONR_EVAL_FEE_50K=88.20`).
- These folders were rewritten in place: `results_v23_*`, `results_scale_sizes`, `results_plan_search`, `results_topstep_why`, `results_startcash`, `results_v23_charts`, `results_v23_site`, `results_topstep_report` and `results_topstep_site`.
- Topstep's results do not depend on Lucid's prices: `topstep_sim.py` run again gives `results_topstep/` byte for byte.
- The futures folders' `kpis.csv` had not been regenerated after the Nov 22 repair. They are now made from their own `summary.json`.
- The spreadsheet `results_v23_trades_fee8820/ONR_v2.3_backtest.xlsx` was recalculated: 17,155 formulas, no errors.

Last 5 years on real futures, 5 funded + 5 evals, each account closed after its 4th payout (mean of 12 start dates):

| | Before (Nov 22) | Now |
|---|---|---|
| Lucid 50K, add-on (the plan) | $59,272 ($90.50 evals) | $58,528 ($98.20) |
| Lucid 50K, 40% rule | $59,550 ($80.50) | $58,800 ($88.20) |
| Lucid 50K, add-on, moved live at the first 5th payout | $47,143 | $46,431 |
| Lucid 25K, add-on | $29,833 ($51.15, assumed) | $29,052 ($60.30) |
| Lucid 25K, 40% rule | $31,269 ($45.50, assumed) | $30,897 ($50.30) |
| Topstep 50K (the plan) | $77,107 | $77,107 |

- **The add-on at 50K** costs $272 a year against the 40% rule after its own price; it pays for itself up to $7.19 an eval. What it buys is steadiness: more evals pass and the worst 12 months are +$30,614 against +$22,242.
- **The plan.** Lucid 50K's deepest fall since Aug 2019 is now $11,293, so its reserve rounds up to $12,000. The plan's steps are the reserves, so it now adds Lucid at $12,000 of spare cash (was $11,000) and buys the car at $51,000 (was $50,000). A typical start made $295,179 in 3 years (was $296,299), the worst start $167,290 (was $169,028).
- **Starting with $500:** Lucid 25K beat 50K with either rule (see *Starting with only $500 or $1,000* above). The best of the 8 ways in was one 25K eval at a time with the 40% rule.
- **Indicator v2.6.3** (both editions): only texts change. The header, the panel and the tooltips quote the new prices and figures, the add-on's figures now include its own $10, and the plan's Lucid step reads $12,000. No trade, size, rule or alarm band changes.

```bash
# ONR_EVAL_FEE_50K=88.20 for the *_fee8820 folders (commands in each section above); the plan's folders:
python3 scale_sizes.py ../../data_fut ../../data results_scale_sizes
python3 plan_search.py ../../data_fut ../../data results_plan_search && python3 budget_table.py results_plan_search
python3 topstep_why.py ../../data_fut results_topstep_why
python3 startcash.py ../../data_fut ../../data results_startcash
python3 topstep_sim.py ../../data_fut ../../data /tmp/topstep_check   # equals results_topstep/
```

### Edges by leg (1 MNQ, R = initial risk; `overfit.py`)

| Leg | Trades | Mean R | t | Years positive | Real vs random sides |
|---|---|---|---|---|---|
| Overnight (0.5 ADR stop) | 1,303 | +0.029 | 1.2 | 10/16 | random mean −0.033 (best +0.008), opposite −0.101 |
| Opening-drive pyramid | 1,805 | +0.177 | 5.4 | 13/16 | random mean +0.067 (best +0.103), opposite −0.042 |
| IB breakout | 3,591 | +0.065 | 3.1 | 13/16 | 2011–18 t = 1.0, 2019–26 t = 3.3 |

IB breakout by direction vs the 09:35 drive (2011–18 / 2019–26): with the drive +0.090R / +0.180R, against it
+0.024R / −0.087R, no drive that day +0.013R / +0.123R.

Overnight signal with no stop: +0.051 ADR per trade, t = 4.1 (2011–18 t = 2.9, 2019–26 t = 2.8); edge rises smoothly
with the threshold (0.5 → 1.0), barely changes with entry 18:05–20:00 or exit 08:25–10:00. Overnight leg in R by stop
width (2011–18 / 2019–26): 0.35 ADR +0.024 / −0.001, 0.5 ADR +0.028 / +0.030, 0.75 ADR +0.034 / +0.057, 1.0 ADR
+0.030 / +0.047. Pyramid positive in both halves for every threshold (0.05–0.20), stop, add and trail tested; best at
09:35, weaker at 09:33 / 09:40 / 09:45. IB breakout: 2011–18 t ≤ 1.6 for every variant, 10:00 IB negative.

### v1 header claims vs this replication

| v1 claim | Replication |
|---|---|
| Eval pass 48% / 49% (2011–20 / 2021–26) | 42.9% / 50.4% |
| Coin-flip sides pass 35–36% | 30.9% / 36.8% |
| 50% add-on 47% / 52% | 42.0% / 49.0% (no gain over 40%) |
| 8–9 sessions to pass | median 9–10 |
| Longest dry spell 14.0 / 14.2 months | v1: up to 36 months (2011–18), 14.5 (2019–26); depends on the start date |
| $500 payout in ~45–50% of months | v1: 11.5% (2011–18), 43.4% (2019–26); v2.1: 33.3% / 53.3% |
| 16/16 years positive | true for the combined funded book; single legs 10–13 of 16 |
| Holds with 2–3× costs and 1-minute-late entries | true for 2019–26 only; 2011–18 payouts roughly halve |

## Code review findings fixed in v2.1

1. **Funded size fixed at 1 MNQ** regardless of volatility → ADR-normalised `round(350 / ADR)`, 1–10 MNQ (input,
   default Auto; identical to v1 while the range is above ~233 points).
2. **Half days traded:** the panel said "no new trades" on early-close days but the code still fired the 09:35 and
   10:30 entries, and only Thanksgiving Friday / Dec 24 were known. v2 computes all US holiday half-sessions and early
   closes (MLK, Presidents, Memorial, Juneteenth, July 4 observed, Labor Day, Thanksgiving + Friday, Dec 24, July 3)
   and blocks RTH entries on them (backtest effect: neutral within noise; done for the 13:00 halt).
3. **Eval stop ignored commission:** a full stop-out cost `$sl + n x $1`; with 5+ contracts that breached the account
   limit the bracket was sized to respect. Now the stop distance leaves room for commission.
4. **Pyramid add filled at its level even when the bar gapped past it** → fills at the open (stop-order behaviour).
5. **Payout check missed Lucid's "positive net profit since the last payout"** → new input "P&L right after your
   last payout"; the panel also shows the maximum allowed request.
6. Silent skips: funded legs blocked by the day budget or cushion now say why in the panel.
7. 09:30 / 16:00 alerts fired every day even when flat → only when a position is open.
8. No check that the chart shows overnight bars (an RTH-only chart never fires the 18:10 trade) → panel warning.
9. Chart-built ADR fallback counted partial sessions → full sessions only. `peakEod` / `bestDay` can no longer be
   negative. Unused `isON` removed.
10. **Opposite positions:** the IB breakout could go short while the pyramid (or another account's eval) was long →
    on 09:35-drive days only the drive's side is placed. Every position in every account now always points the same
    way, so copy-trading several accounts can't create prohibited hedges.

Static checks (no TradingView compiler here): v1 and v2.1 both parse with `pynescript` (a full Pine grammar), and a
scope-aware check of the syntax tree finds no undeclared or out-of-block identifiers; both checks catch deliberately
injected errors. The holiday calendar's Pine logic matches an independent Python version on every day 2010–2035.

Kept as is (checked): no look-ahead in the ADR and score requests; the score after a half session reuses the last full
session's value (62 of 1,303 overnight trades, average +0.07 ADR, not harmful); news filter heuristic (first Friday
≤ 7th; small effect either way).

## Reproduce

*The earlier series. Your MNQ file's results: the commands at the end of* Your MNQ file only *above.*

```bash
python3 backtest/onr/fetch_histdata.py data/raw SPXUSD NSXUSD
python3 backtest/onr/prep_data.py histdata data/raw data SPXUSD NSXUSD
curl -s -A "Mozilla/5.0 (X11; Linux x86_64)" -o data/MNQ_5m.json "https://query2.finance.yahoo.com/v8/finance/chart/MNQ=F?interval=5m&range=60d"
python3 backtest/onr/prep_data.py yahoo data/MNQ_5m.json data/MNQ_5m_60d_raw.npz
python3 -I backtest/onr/clean_prints.py data/MNQ_5m_60d_raw.npz data/NSXUSD.npz data/MNQ_5m_60d.npz   # bad prints (Nov 22)
cd backtest/onr && python3 report.py ../../data && python3 overfit.py ../../data && python3 portfolio.py ../../data
python3 research.py ../../data legs && python3 research.py ../../data accounts && python3 research.py ../../data final
python3 research.py ../../data recent
python3 research3.py ../../data all
python3 research4.py ../../data results_r4 && python3 report4.py results_r4 results_r4
python3 research5.py ../../data ../../data results_r5 accounts && python3 report5.py results_r5
python3 fetch_dukascopy.py ../../data/duk_idx USA500IDXUSD 2026-11-09 2026-11-16   # S&P CFD past HistData's end
python3 prep_spx_ext.py ../../data ../../data/duk_idx ../../data_live/SPXUSD.npz   # + NSXUSD.npz, MNQ_5m_60d.npz
python3 mnq_real50k.py ../../data_live && python3 export_charts.py ../../data_live results_charts
python3 research6.py ../../data results_r6
python3 report50k.py ../../data results_50k_5y 2021-11-15 && python3 make_kpis.py results_50k_5y results_50k_5y/kpis.csv "Nov 15 2021 - Nov 13 2026" "2022-2025"
# the same at the $88.20 eval price (the dashboard's figures); the trades are identical
export ONR_EVAL_FEE_50K=88.20
python3 research4.py ../../data results_r4_fee8820 && python3 report4.py results_r4_fee8820 results_r4_fee8820
python3 research5.py ../../data ../../data results_r5_fee8820 accounts && python3 report5.py results_r5_fee8820
python3 research6.py ../../data results_r6_fee8820
python3 report50k.py ../../data results_50k_fee8820 && python3 make_kpis.py results_50k_fee8820 results_50k_fee8820/kpis.csv "Nov 14 2022 - Nov 13 2026" "2023-2025" results_50k_fee8820
python3 report50k.py ../../data results_50k_5y_fee8820 2021-11-15 && python3 make_kpis.py results_50k_5y_fee8820 results_50k_5y_fee8820/kpis.csv "Nov 15 2021 - Nov 13 2026" "2022-2025"
python3 export_charts.py ../../data_live results_charts_fee8820
python3 options50k.py ../../data results_options_fee8820   # the indicator's eval options and the 50% add-on (final review)
ONR_EVAL_CONS=0.5 python3 report50k.py ../../data results_50k_5y_addon_fee8820 2021-11-15   # every eval with the 50% add-on
python3 addon50k.py ../../data_live results_addon_fee8820   # add-on vs current rules, side by side (dashboard page)
unset ONR_EVAL_FEE_50K && python3 options50k.py ../../data results_options
```

Limits: the CFD is a proxy for MNQ before Sep 2026 (validated on the overlap only); TradingView's own fills on 1–5
minute bars can differ slightly from the 1-minute replica; Lucid's rules can change; nothing here is live-tested.
