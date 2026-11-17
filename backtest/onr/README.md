# ONR Book: independent review and MNQ backtest (2026-11-17)

Review of `indicators/onr_book.pine` (v1 as received, commit `77b0f72`) and the v2 fixes, with a Python replica of the
script's exact logic (`engine.py`, `account.py`) run on 2011–2026 minute data and on real MNQ futures.

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
| v2 | 44.4% (10) | 47.5% (9) |

Coin-flip sides on the same brackets (10 seeds, 2011–20 / 2021–26 split): 30.9% / 36.8% mean, best 33.5% / 41.4%,
vs the strategy's 42.9% / 50.4%. The tight bracket passes 34.1% / 36.1%; the paid 50% consistency add-on 42.0% / 49.0%
(no gain); dropping the news skip 39.8% / 49.3%.

### Lifecycle: payouts and dry spells

| | Payouts / yr | Months with a payout | Net $/yr | Longest dry spell: median / worst |
|---|---|---|---|---|
| v1, 2011–18 | 1.4 | 11.5% | $489 | 26.7 / 36.2 months |
| v1, 2019–26 | 7.4 | 43.4% | $2,742 | 13.1 / 14.5 months |
| **v2, 2011–18** | **5.5** | **35.8%** | **$1,690** | **11.8 / 12.1 months** |
| **v2, 2019–26** | **8.8** | **51.0%** | **$3,348** | **7.2 / 9.3 months** |

- Dry spells are regime-driven (Jul 2014–Jul 2015, Dec 2016–Aug 2017, Feb–Sep 2023, Dec 2025–May 2026). Running 2 or
  3 staggered accounts multiplies payouts but leaves the longest dry spell unchanged, because every account trades
  the same signals.
- The dry-spell statistic is noisy: changing the sizing reference ADR from 350 to 250 or 450 moves the worst 2019–26
  spell between 8.6 and 14.5 months. Treat any single "longest dry spell" number, including these, as ±5 months.
- Not adopted (tested, no consistent gain in both halves): wider overnight stop (0.75 / 1.0 ADR; it eats the day
  budget and crowds out the pyramid and IB), dropping the funded overnight leg, dropping the IB leg (much worse),
  pyramid-only.

### Robustness of v2 (lifecycle payouts / yr, worst dry spell)

| | 2011–18 | 2019–26 |
|---|---|---|
| base | 5.5, 12.1 months | 8.8, 9.3 months |
| 2× commission + 1 tick slippage per side | 3.0, 25.5 months | 8.1, 8.8 months |
| every entry 1 minute late | 3.0, 14.4 months | 7.2, 7.2 months |

In the calm, small-range 2011–18 market the book is fragile to costs and timing; in 2019–26 it holds.

### Funded book by year ($, risk budget applied, no account resets)

v1 (1 MNQ): positive in 16 of 16 full years, but only +$432 to +$1,613 a year until 2019.
v2 (ADR-sized): positive in 16 of 16 full years, from +$267 (2017) and +$2,479 (2023) to +$13,056 (2021).
Daily Sharpe of the v2 funded book: 1.1 (2011–18), 1.75 (2019–26).

### Real MNQ futures, 5-min bars, 2026-09-09 → 2026-11-17 (50 sessions)

- Eval: 40 of 48 rolling starts passed (all 8 failures started Oct 28 – Nov 6).
- Funded legs at 1 MNQ each, no budget: overnight 15 trades +$2,325, pyramid 23 trades +$5,608, IB 43 trades +$1,623.
- Funded book with the day risk budget: 68 trades, +$7,499, 49% winners (v1 and v2 identical: ADR > 233 → 1 MNQ).
- 50 sessions in a strongly trending market say little about the future; the 15-year results matter more.

### Edges by leg (1 MNQ, R = initial risk; `overfit.py`)

| Leg | Trades | Mean R | t | Years positive | Real vs random sides |
|---|---|---|---|---|---|
| Overnight (0.5 ADR stop) | 1,303 | +0.029 | 1.2 | 10/16 | random mean −0.033 (best +0.008), opposite −0.101 |
| Opening-drive pyramid | 1,805 | +0.177 | 5.4 | 13/16 | random mean +0.067 (best +0.103), opposite −0.042 |
| IB breakout | 3,591 | +0.065 | 3.1 | 13/16 | 2011–18 t = 1.0, 2019–26 t = 3.3 |

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
| $500 payout in ~45–50% of months | v1: 11.5% (2011–18), 43.4% (2019–26); v2: 35.8% / 51.0% |
| 16/16 years positive | true for the combined funded book; single legs 10–13 of 16 |
| Holds with 2–3× costs and 1-minute-late entries | true for 2019–26 only; 2011–18 payouts roughly halve |

## Code review findings fixed in v2

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

Kept as is (checked): no look-ahead in the ADR and score requests; the score after a half session reuses the last full
session's value (62 of 1,303 overnight trades, average +0.07 ADR, not harmful); news filter heuristic (first Friday
≤ 7th; small effect either way).

## Reproduce

```bash
python3 backtest/onr/fetch_histdata.py data/raw SPXUSD NSXUSD
python3 backtest/onr/prep_data.py histdata data/raw data SPXUSD NSXUSD
curl -s -A "Mozilla/5.0 (X11; Linux x86_64)" -o data/MNQ_5m.json "https://query2.finance.yahoo.com/v8/finance/chart/MNQ=F?interval=5m&range=60d"
python3 backtest/onr/prep_data.py yahoo data/MNQ_5m.json data/MNQ_5m_60d.npz
cd backtest/onr && python3 report.py ../../data && python3 overfit.py ../../data
```

Limits: the CFD is a proxy for MNQ before Sep 2026 (validated on the overlap only); TradingView's own fills on 1–5
minute bars can differ slightly from the 1-minute replica; Lucid's rules can change; nothing here is live-tested.
