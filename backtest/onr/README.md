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
- **Last 4 years only** (Nov 2022 – Nov 2026, the window to rely on): same conclusions; 5 funded 50K accounts with
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

### Real MNQ futures, 5-min bars, 2026-09-09 → 2026-11-17 (50 sessions)

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
```

Limits: the CFD is a proxy for MNQ before Sep 2026 (validated on the overlap only); TradingView's own fills on 1–5
minute bars can differ slightly from the 1-minute replica; Lucid's rules can change; nothing here is live-tested.
