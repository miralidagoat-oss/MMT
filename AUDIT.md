# Adversarial Audit — MNQ 1H Sweep-Rejection Strategy

**Date:** 2026-08-11
**Verdict:** The previously published performance figures were wrong. The
corrected edge is not statistically distinguishable from zero.

This document supersedes the performance claims in `BACKTEST_RESULTS.md` and
the earlier sections of `README.md`.

---

## Headline correction

| | Previously published | Corrected |
|---|---|---|
| Trades (2.4y) | 80 | **47** |
| Win rate | 28.0% | **24.1%** |
| Profit factor | 1.51 (IS 1.64 / OOS 1.43) | **1.24** |
| Net R | +18.8R | **+5.3R** |

The old numbers came from a study that hard-coded Eastern Time as a fixed
`UTC-4` offset. That is EDT, correct only from March to November. For roughly
five months a year the "09:30–16:00 RTH" filter was actually selecting
08:30–15:00 ET. Fixing the timezone removes **33 of 80 trades** and
**72% of the reported profit**.

The timezone bug was load-bearing. It was not a rounding detail.

---

## Test 1 — DST correctness

```
MNQ old fixed UTC-4 approx    n=80  WR=28.0%  PF=1.51  netR=+18.8
MNQ TRUE America/New_York     n=47  WR=24.1%  PF=1.24  netR= +5.3
```

Everything below uses the corrected timezone.

---

## Test 2 — Bootstrap confidence interval (20,000 resamples)

```
point estimate      PF = 1.24    netR = +5.3    n = 47

PF    95% CI   [ 0.41 ,  2.65 ]
netR  95% CI   [ -15.7 , +29.3 ]
WR%   95% CI   [  9.5  ,  40.6 ]

P(true edge is flat or negative) = 32.5%
```

**This is the single most important number in the audit.** With 47 trades,
the confidence interval on profit factor spans from *badly losing* to
*excellent*. There is roughly a **one-in-three chance the strategy has no edge
at all** and the +5.3R is luck.

47 trades is simply not enough evidence. To distinguish a PF of 1.24 from a PF
of 1.0 with any confidence you need several hundred trades. At ~20 signals a
year, that is a decade of trading.

---

## Test 3 — Null hypothesis: does the signal beat random entry?

Kept the trade count identical, kept the same stop/target geometry, but
selected entry bars **at random** inside RTH. 400 runs.

```
real signal      netR +5.3    PF 1.24
random entries   netR mean -0.9   p95 +16.3   max +31.2
                 random PF mean 1.01

empirical p-value = 0.287
```

**Cannot reject the null hypothesis.** Random entries with the same risk
geometry land in the same distribution as the "liquidity sweep rejection"
signal. 29% of random configurations did as well or better.

All the sophistication — EWMA volatility, wick dominance, close position,
sweep depth, volume participation — did not measurably outperform picking bars
with a dartboard.

---

## Test 4 — Profit concentration (jackknife)

```
total netR +5.3 from 47 trades

remove the 1 best trade:   netR  +1.3   PF 1.06
remove the 2 best trades:  netR  -2.6   PF 0.88
remove the 3 best trades:  netR  -6.6   PF 0.71
remove the 5 best trades:  netR -14.6   PF 0.35

top winner alone = 75% of total profit
```

Drop-one-quarter:

```
without 2024-Q4:  netR -0.5   PF 0.97
```

**Two trades separate this strategy from losing money.** One quarter out of
ten contributes more than 100% of the profit. Remove Q4 2024 and the strategy
is net negative across the entire remaining sample.

That is not an edge. That is a handful of lucky outcomes inside noise.

---

## Test 5 — Data-mining correction

Random search over 1,500 arbitrary parameter combinations from the same grid:

```
36% of RANDOM configurations beat PF 1.40
10% of RANDOM configurations beat PF 2.00
median PF across the whole space = 1.21

the shipped configuration scores PF 1.24
```

**The shipped configuration performs at roughly the median of randomly-chosen
configurations.** If a third of arbitrary parameter sets "beat" your tuned one,
the tuning captured noise, not structure.

Across this project the search space examined is ≥93,750 sweep configurations,
plus 720 ORB configurations, plus the level-sweep family, across 6 timeframes
and 3 tickers. With that many looks at 2.4 years of data, finding a PF of 1.5
somewhere is *expected under pure randomness*. It requires no edge to exist.

---

## Test 6 — The "NQ cross-validation" was not independent

```
shared timestamps               13,704
mean |close difference|         7.07 pts (0.034%)
bars within half a point        76.4%
return correlation              0.937
```

MNQ and NQ are the **micro and mini contracts on the same Nasdaq-100 index**.
Testing on NQ after tuning on MNQ is not out-of-sample validation — it is
re-running the same price path with different cost assumptions.

The "cross-validation PF 1.26" confirmed nothing. Genuine validation requires
a different market or a different time period.

---

## Test 7 — Parameter sensitivity

Mostly a plateau, which is the one genuinely reassuring result:

```
rb_lookback     8:1.24  10:1.29  12:1.24  14:1.24  16:1.30  20:1.39
stop_sigma      1.0:0.77  1.25:1.01  1.5:1.24  1.75:1.19  2.0:1.14
be_trigger      0.0:1.20  0.5:1.07  1.0:1.24  1.5:0.98  2.0:0.86   <-- FRAGILE
```

`be_trigger` is fragile — neighbouring values break the edge, which is a
classic overfit signature.

**Three parameters are dead code.** `min_wick`, `cooldown` and `vol_mult`
change *nothing*: sweeping `min_wick` from 0.25 to 0.45 and `cooldown` from 0
to 20 leaves the trade list byte-identical (n=47, PF 1.24 throughout). They are
non-binding — other gates already dominate them. They add apparent
sophistication and zero function.

---

## Test 8 — Cost and fill sensitivity (the good news)

```
0.0x costs   PF 1.27      2.0x costs   PF 1.20
1.0x costs   PF 1.24      4.0x costs   PF 1.14
```

Cost-robust, because the 1H timeframe has large per-trade risk relative to the
$3 round trip. Requiring price to trade *through* the limit rather than merely
touch it changed nothing (0 trades lost).

These were the tests the strategy was *supposed* to fail, and it passed them.
The problem is not costs or fills. The problem is that there is not enough
signal to begin with.

---

## Test 9 — Corrected Monte Carlo, $25,000, 1 contract

The earlier Monte Carlo shuffled trade order, which cannot change a sum — the
ending-equity block was degenerate by construction. Re-run with bootstrap
resampling:

```
ending equity after 2.4 years:
   p05 $21,904   p25 $24,804   median $27,058   p75 $29,459   p95 $33,190

max drawdown:  median $2,279   p95 $4,610   p99 $5,869

P(you finish 2.4 years BELOW where you started) = 27.0%
P(you finish down more than 10%)                =  7.5%
```

Median outcome: **+$2,058 over 2.4 years ≈ $860/year ≈ 3.4% annually**, with a
27% chance of simply losing money over that period.

---

## What is NOT broken

The Pine implementation is genuinely sound, and this matters:

- `ta.highest(high, rbLookback)[1]` correctly excludes the current bar — no
  lookahead
- `barstate.isconfirmed` gates every signal — no intrabar repaint
- Breakeven never arms on the fill bar
- The target is withheld on the fill bar, matching the study
- Outside bars satisfying both directions are correctly skipped
- Limit expiry, cooldown and session gating all behave as documented

There is no coding bug in the strategy script. The engineering is correct. The
*edge* is what is missing.

---

## Honest conclusion

After correcting the timezone error, the strategy shows:

- **PF 1.24 on 47 trades** over 2.4 years
- **32.5% probability the true edge is zero or negative**
- **p = 0.287 against random entry** — no demonstrated skill
- **75% of profit from a single trade**, negative without one quarter
- Parameters that score at the **median of random configurations**

**This does not meet the standard for risking money.** Not because the code is
bad — it is well-built — but because 47 trades over one market regime cannot
support a claim of edge, and every test designed to separate skill from luck
came back inconclusive or negative.

The realistic expected value is roughly **$860/year on a $25,000 account, with
a 27% chance of losing money instead.** That is materially worse than a
savings account, at vastly higher variance and effort.

### What would actually be required

To establish whether this edge exists at all:

1. **Real data.** Yahoo continuous-contract data carries 91 splice gaps >0.5%
   and 517 zero-volume bars. Proper backtesting needs tick data with real
   contract rolls.
2. **More history.** 2.4 years covers one regime. Ten-plus years spanning 2018,
   2020 and 2022 would test whether the edge survives a bear market.
3. **A held-out period never examined.** Every year of this data has now been
   looked at repeatedly. It is contaminated for validation purposes.
4. **Several hundred trades** before any performance claim is meaningful.

That is months of work with no guarantee of a positive answer — and the honest
prior, given these results, is that the answer is negative.
