# ONR Book: independent review and MNQ backtest (2026-11-17)

Review of `indicators/onr_book.pine` (v1 as received, commit `77b0f72`), the v2.1 fixes and the v2.2 research round, with a Python replica of
the script's exact logic (`engine.py`, `account.py`, `portfolio.py`) run on 2011–2026 minute data and on real MNQ
futures, including several Lucid accounts side by side.

## Verdict

- The code is careful work: no look-ahead or repainting (`request.security(..., expr[1], lookahead_on)` is the correct
  pattern), conservative fills (stop wins ties, targets need a tick through) and the Lucid Flex 25K rules match the
  currently published ones.
- The edge is real but smaller and less evenly spread than v1's header says. Most of it comes from the
  **opening-drive pyramid** (t = 5.4) and the **IB breakout** (t = 3.1, only after 2019). The **overnight S&P
  "stretch" signal**, the book's namesake, does predict the overnight move (t = 4.1 with no stop, both halves of the
  sample), but its 0.5 ADR stop throws away about half of it; with the stop the leg is t = 1.2.
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
  5 evals in reserve netted $49,103 a year at the $115 list price, and $52,274 at the user's $80.50 discount price.
  Every full year was positive; the worst was 2023 ($11,081, or $13,565 at $80.50), when only 23% of evals passed.
  - Rounds 3–5 re-scored on these 5 years: none of 18 changes passed.
  - Round 6 (no overnight trade, or the eval's IB breakout in its place) did not pass either.
  - See "The last 5 years first", "Research round 6" and "At your eval price" below.
- **Final review (Nov 18):** the indicator and the backtest match line by line. The indicator's tooltips now give 50K
  numbers and its live alarm uses the last 5 years. One new finding: Lucid's paid 50% consistency add-on raised
  5 funded + 5 evals by about $11.9k a year over the last 5 years before its own price (+$4.3k a year in 2011–21).
  By rule 5Y it is worth buying below about $16 an eval. See "Final review" below.
- **Last 4 years only** (Nov 2022 – Nov 2026): same conclusions; 5 funded 50K accounts with
  max-allowed payouts netted ~$51k a year (25K: ~$32k), with 2023 the drought year. See "Last 4 years only" below.
- **Dry spells cannot be removed completely.** About half of them were times the strategy itself lost money; the
  other half were times it made money but the eval kept failing. More accounts run as an eval pool fix much of the
  second kind (longest gap 12 → 8 months in 2011–18, 8 → 6.5 in 2019–26) but nothing fixes the first kind.

## Data

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
- Funded legs at 1 MNQ each, no budget: overnight 15 trades +$2,325, pyramid 23 trades +$5,608, IB 43 trades +$1,623.
- Funded book with the day risk budget: v1 68 trades +$7,499; v2.1 65 trades +$7,568 (49% winners; 1 MNQ either way).
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
| Real MNQ futures Sep 9 – Nov 17 2026: evals passed; one account's trades | 32 of 48; +$17,568 on 71 trades |

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
signal. With Monday Nov 16's own score (+0.885, a buy, as the live indicator showed), Nov 17 has the overnight buy
(+$32.66 at 1 MNQ) and the pyramid (+$1,495.43), and **no** IB breakout. The day's $1,200 risk budget was already used:
the overnight trade took $647 and the pyramid $453, and the IB needed $323 more. The first version showed the IB
(+$645.50) instead of the overnight trade, so it overstated Nov 17 by $612.84.

| One funded 50K account, every session | Trades | Winners | Net |
|---|---|---|---|
| Overnight | 16 | 69% | +$4,510 |
| Opening-drive pyramid | 22 | 45% | +$9,845 |
| IB breakout | 33 | 45% | +$2,600 |
| All | 71 | 51% | +$16,955 |

- 47 traded days: 51% positive, 47% qualifying ($150+), best +$7,078 (Sep 21), worst −$810. Without Sep 21 the
  account made about +$9,900. Weeks (Monday start): 9 of 11 positive, worst −$1,495 (week of Sep 28).
- Size: 3 MNQ while the ADR was under 280, 2 MNQ at 286–421, 1 MNQ from Nov 2 (ADR 490–647).
- Evals started on every session: 30 of 46 finished passed (65%, median 10 sessions); all 15 started Oct 19 – Nov 6
  failed, then passes resumed. 4 were still open when the data ended.
- One account bought Sep 9: eval passed Sep 30; payouts $1,136 (Oct 16), $1,280 (Oct 30), $2,000 (Nov 17); net
  +$3,859 after the $115 eval, still open with +$3,624.
- 5 funded 50K + eval pool: 15 payouts ($21,677 gross), 10 evals ($1,150), net +$18,360 in the 50 sessions.

**Eval plan vs funded plan.** The table above is the funded plan, which the indicator draws with Phase = FUNDED: up to
three trades a day, 1 MNQ each at today's range. With Phase = EVAL, the default, the indicator draws the eval plan:
one trade a session, the 18:10 ET overnight trade if there is a signal and otherwise the 09:35 drive. It trades 2 MNQ
with a fixed stop (299 points) and target (300 points). `export_charts.py` writes that plan session by session to
`results_charts/real_eval_trades.csv`, and it matches the live chart:

| Session | Eval | Funded |
|---|---|---|
| Nov 16 | 09:35 drive sell, target +$1,197.32 | pyramid sell, trailing stop −$216.84 |
| Nov 17 | overnight buy from Nov 16 18:10 ET, out at 09:30 +$65.32 (the chart showed +$66: TradingView's feed differs by one tick) | overnight +$32.66, pyramid +$1,495.43, IB not placed |
| Nov 18 (entered Nov 17 18:10 ET) | overnight buy, stopped −$1,200.00 | overnight buy at 1 MNQ, stopped about −$680 |

The Nov 18 entry is after the MNQ data ends. Yahoo refused downloads that day, so it was checked on Dukascopy's
Nasdaq-100 CFD ticks instead. The price fell 495 points below the entry, past both stops: 299 points for the eval,
340 points (0.5 ADR) for the funded account.

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

### At your eval price: $80.50 instead of $115

A Lucid Flex 50K eval costs $80.50 with the user's discount code. The eval price only changes the bookkeeping (net = 90% of payouts − price × evals bought), never a trade, so every study was run again with `ONR_EVAL_FEE_50K=80.50` into the `*_fee8050` folders.
- Trades, payouts and eval counts are identical at both prices.
- The decisions are unchanged: rounds 4, 5 and 6 adopt nothing at $80.50 either, with their noise bands recomputed at that price.
- The dashboard shows the $80.50 figures. The last 5 years:

| Setup | Net a year | Worst full year | Total, 5 years | Worst 12 months | Most cash out |
|---|---|---|---|---|---|
| 1 account in all | $7,784 | $1,199 | $38,030 | −$31 | −$369 |
| 2 accounts in all | $14,376 | $2,182 | $70,239 | $18 | −$738 |
| 3 accounts in all | $20,873 | $3,338 | $101,982 | $852 | −$1,100 |
| 4 accounts in all | $27,309 | $4,494 | $133,432 | $1,766 | −$1,449 |
| 5 accounts in all | $34,945 | $5,650 | $170,740 | $3,164 | −$1,744 |
| 1 funded + 1 eval | $11,266 | $796 | $55,041 | −$1,239 | −$738 |
| 2 funded + 2 evals | $21,081 | $3,966 | $102,996 | −$103 | −$1,449 |
| 3 funded + 3 evals | $31,850 | $7,681 | $155,613 | $827 | −$2,033 |
| 4 funded + 4 evals | $42,996 | $9,664 | $210,076 | $936 | −$2,589 |
| **5 funded + 5 evals (current)** | $52,274 | $13,565 | $255,401 | $1,287 | −$2,999 |

Year by year, 5 funded + 5 evals at $80.50: 2021 (from Nov 15) −$1,127 · 2022 $42,452 · 2023 $13,565 · 2024 $87,152 · 2025 $28,471 · 2026 (to Nov 13) $84,184.

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
- **Header.** It now says what "5 funded + 5 evals" means (up to 10 accounts in all, one new eval a day) and includes the start-up weeks, Nov 15 – Dec 31 2021 (−$1.1k).
- **Live alarm bands.** These now come from the last 5 years, like every other figure, instead of the last 4. They are slightly tighter, so the alarm turns yellow or red a little sooner.

| Trading days | Typical | Yellow below | Red below | Before (last 4 years): typical / yellow / red |
|---|---|---|---|---|
| 20 | $1,354 | −$3,300 | −$5,202 | $1,309 / −$3,538 / −$5,359 |
| 40 | $2,831 | −$4,055 | −$6,555 | $2,785 / −$4,112 / −$6,883 |
| 60 | $4,190 | −$4,160 | −$7,376 | $4,340 / −$4,383 / −$7,776 |
| 120 | $8,623 | −$3,261 | −$7,956 | $8,760 / −$3,566 / −$8,929 |
| 250 | $18,314 | $923 | −$5,903 | $18,683 / $100 / −$7,284 |

Eval options at 50K, evals started on every session (`results_options_fee8050/options_pass_rates.csv`):

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
| (none: current rules) | $52,274 | $13,565 | $31,629 | −$982 | |
| $0 | $64,211 (+$11,937) | $24,765 (+$11,200) | $35,924 (+$4,295) | $3,253 (+$4,235) | passes |
| $10 | $63,270 (+$10,996) | $24,005 (+$10,440) | $34,825 (+$3,196) | $1,993 (+$2,975) | passes |
| $15 | $62,799 (+$10,526) | $23,625 (+$10,060) | $34,275 (+$2,646) | $1,363 (+$2,345) | passes |
| $20 | $62,329 (+$10,055) | $23,245 (+$9,680) | $33,725 (+$2,096) | $733 (+$1,715) | inside the noise band |
| $30 | $61,388 (+$9,114) | $22,485 (+$8,920) | $32,626 (+$997) | −$527 (+$455) | inside the noise band |
| $40 | $60,447 (+$8,173) | $21,725 (+$8,160) | $31,527 (−$103) | −$1,787 (−$805) | inside the noise band |

Evals at $80.50.
- **Rule 5Y:** it passes up to an add-on price of $16.41 an eval ($15.50 with $115 evals; `results_options/`).
  - Up to about $33 it is still ahead on net and on the worst year in both periods, but by less than the noise band.
  - Above about $39 it makes less than the current rules in 2011–21.
  - Each $10 of add-on price costs about $940 a year (94 evals a year).
- **The price:** Lucid's help centre confirms the rule (50% instead of 40%, evaluation only, chosen at checkout) but does not give a price. Check it at checkout.
- **Caveat:** this check was run after the add-on's first numbers had been seen, so it is a descriptive result, not a pre-registered one.

`options50k.py DATA results_options_fee8050` (with `ONR_EVAL_FEE_50K=80.50`) reproduces both tables.

#### The full backtest with the add-on (`addon50k.py`, `results_addon_fee8050/`; the dashboard's "50% add-on" page)

The same 5-year report with every eval bought with the add-on (`ONR_EVAL_CONS=0.5 report50k.py` → `results_50k_5y_addon_fee8050/`), side by side with the current rules. Evals at $80.50, before the add-on's own price:

| Last 5 years | Current rules (40%) | With the 50% add-on |
|---|---|---|
| Eval pass rate (an eval started on every session) | 41.3% | 44.2% |
| Sessions to pass: median / 90th percentile | 9 / 20 | 8 / 17 |
| Funded accounts that reach a payout | 61.8% | 63.1% |
| Paid to you per funded account, average | $1,946 | $2,112 |
| One account slot: first payout, median / within 90 days | 58 days / 67.5% | 54 days / 71.9% |
| 5 funded + 5 evals: net a year | $52,274 | $64,211 |
| Worst full year / worst 12 months | $13,565 / $1,287 | $24,765 / $8,006 |
| Longest wait for a payout | 6.4 months | 6.1 months |
| Total, 5 years / most cash out of pocket | $255,401 / −$2,999 | $313,734 / −$2,603 |

By year, 5 funded + 5 evals (median of 12 start dates):

| Year | Current | With the add-on | Difference |
|---|---|---|---|
| 2022 | $42,452 | $49,106 | +$6,655 |
| 2023 | $13,565 | $24,765 | +$11,200 |
| 2024 | $87,152 | $105,901 | +$18,750 |
| 2025 | $28,471 | $42,411 | +$13,940 |
| 2026 (to Nov 13) | $84,184 | $92,304 | +$8,120 |

Since 2011 (start Feb 15 2011), the add-on made more in 12 of 16 years and less in 4: 2012 −$677, 2013 −$3,431, 2018 −$2,765 and 2021 −$2,591.

**Real MNQ futures, Sep 9 – Nov 17 2026: the add-on did worse.** More evals passed (33 of 47 against 30 of 46). But one account bought on Sep 9 netted $104 against $3,894, and 5 funded + 5 evals netted $5,479 against $18,705 (25 evals bought against 10). The reason is timing:
- With the add-on, the Sep 9 eval passed on Sep 28 instead of Sep 30, so its funded account met a different run of days.
- Its first payout on Oct 16 was $563 instead of $1,136. After the payout the cushion was thin, and the Oct 19 loss took it below the $400 abandon level.
- Its next three evals each ran out of cushion before a fifth one passed on Nov 16.
- Under the current rules, the same account was funded two sessions later and survived Oct 19.

This is one 50-session path; the 5-year figures come from about 1,300 sessions and many start dates. The step-by-step table is `addon_journey.csv`. The current-rules figures equal `export_charts.py`'s checked ones.


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

```bash
python3 backtest/onr/fetch_histdata.py data/raw SPXUSD NSXUSD
python3 backtest/onr/prep_data.py histdata data/raw data SPXUSD NSXUSD
curl -s -A "Mozilla/5.0 (X11; Linux x86_64)" -o data/MNQ_5m.json "https://query2.finance.yahoo.com/v8/finance/chart/MNQ=F?interval=5m&range=60d"
python3 backtest/onr/prep_data.py yahoo data/MNQ_5m.json data/MNQ_5m_60d.npz
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
# the same at the $80.50 eval price (the dashboard's figures); the trades are identical
export ONR_EVAL_FEE_50K=80.50
python3 research4.py ../../data results_r4_fee8050 && python3 report4.py results_r4_fee8050 results_r4_fee8050
python3 research5.py ../../data ../../data results_r5_fee8050 accounts && python3 report5.py results_r5_fee8050
python3 research6.py ../../data results_r6_fee8050
python3 report50k.py ../../data results_50k_fee8050 && python3 make_kpis.py results_50k_fee8050 results_50k_fee8050/kpis.csv "Nov 14 2022 - Nov 13 2026" "2023-2025" results_50k_fee8050
python3 report50k.py ../../data results_50k_5y_fee8050 2021-11-15 && python3 make_kpis.py results_50k_5y_fee8050 results_50k_5y_fee8050/kpis.csv "Nov 15 2021 - Nov 13 2026" "2022-2025"
python3 export_charts.py ../../data_live results_charts_fee8050
python3 options50k.py ../../data results_options_fee8050   # the indicator's eval options and the 50% add-on (final review)
ONR_EVAL_CONS=0.5 python3 report50k.py ../../data results_50k_5y_addon_fee8050 2021-11-15   # every eval with the 50% add-on
python3 addon50k.py ../../data_live results_addon_fee8050   # add-on vs current rules, side by side (dashboard page)
unset ONR_EVAL_FEE_50K && python3 options50k.py ../../data results_options
```

Limits: the CFD is a proxy for MNQ before Sep 2026 (validated on the overlap only); TradingView's own fills on 1–5
minute bars can differ slightly from the 1-minute replica; Lucid's rules can change; nothing here is live-tested.
