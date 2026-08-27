# MNQ 5-Minute ETH — Final Research Report

**Final verdict: INSUFFICIENT EVIDENCE. Do not trade this.**
Basis: 742,707 5-minute bars, 2,729 trading days, 2015–2025, validated against
an independent feed.

---

## 1. What was found

A real but weak effect exists, and it is not tradeable on MNQ.

**Overnight-range continuation at a 2:1 payoff** was the only structure to
survive a 66-configuration a-priori battery with Bonferroni correction on the
2015–2020 development split. Five of 66 survived; all five were *continuation*
(momentum), all at the highest payoff tested. That coherence is what
distinguishes a signal from scattered noise.

It then failed everywhere it mattered.

## 2. The candidate

- **Hypothesis:** price that breaks the overnight range during RTH continues,
  because the level is drawn from thin overnight liquidity.
- **Context:** overnight high/low, accumulated 18:00→09:30 ET and frozen at 09:30.
- **Trigger:** 5m close beyond the frozen level (confirmed bar).
- **Entry:** next bar open, market.
- **Stop:** k × ATR(14). **Target:** 2 × stop.
- **Management:** cooldown 8 bars, max hold 47 bars, flat 16:45 ET, gap guard 1.5 ATR.

## 3. Results across the pre-registered splits

Zero cost isolates signal content; moderate cost is MNQ reality
($0.85/side + 2 ticks). Thresholds are a null calibrated on the same series at
the same trade count.

| Split | Years | Days | n | PF (zero) | PF (MNQ cost) | Threshold | Verdict |
|---|---|---|---|---|---|---|---|
| Development | 2015–2020 | 1,543 | 3,093 | **1.113** | 0.916 | 1.077 | signal present, untradeable |
| Validation | 2021–2022 | 512 | 1,081 | **1.234** | **1.163** | 1.130 | **clears** |
| **Final OOS** | **2023–2025** | **658** | **1,385** | **1.083** | **1.009** | **1.114** | **fails** |

Stop-size grid on the final OOS — nothing clears at any size:

| Stop | MNQ $risk | cost as %R | n | PF (cost) | Threshold |
|---|---|---|---|---|---|
| 1.25 ATR | $30 | 12.5% | 2,334 | 0.972 | 1.088 |
| 2.00 ATR | $47 | 7.8% | 1,684 | 0.981 | 1.104 |
| 3.00 ATR | $71 | 5.2% | 1,385 | 1.009 | 1.114 |
| 4.00 ATR | $95 | 3.9% | 1,250 | 1.030 | 1.120 |
| 5.00 ATR | $119 | 3.1% | 1,181 | 0.999 | 1.124 |

**The pre-specified configuration (2.0 ATR) failed validation too** — PF 1.097
against a 1.117 threshold. The wider stops that cleared validation showed a clean
monotonic trend (1.124 → 1.314) that **did not reproduce in OOS** (1.083, 1.059,
1.083, 1.087, 1.042). That trend was noise, and selecting on it would have been
fitting to the validation set.

## 4. Regime analysis — why it looked real

Signal content year by year, zero cost, 3 ATR stop:

| Year | Split | PF (zero) | Individually significant? | PF (MNQ cost) |
|---|---|---|---|---|
| 2015 | dev | 1.188 | no | 0.894 |
| 2016 | dev | 1.179 | no | 0.872 |
| 2017 | dev | 1.033 | no | 0.789 |
| 2018 | dev | 1.040 | no | 0.929 |
| 2019 | dev | 1.136 | no | 0.996 |
| 2020 | dev | 1.091 | no | 1.031 |
| **2021** | val | **1.189** | **YES** | 1.105 |
| **2022** | val | **1.269** | **YES** | 1.212 |
| 2023 | OOS | 1.062 | no | 0.979 |
| 2024 | OOS | 1.112 | no | 1.057 |
| 2025 | OOS | 0.993 | no | 0.909 |

**Only 2 of 11 years are individually significant, and they are exactly the two
validation years.** The validation "success" was the sample landing on the two
hottest years in the series. The pooled effect is real but too small and too
unstable to trade.

## 5. The cost wall

MNQ is $2/point. Round-turn cost is ~$3.70 at moderate assumptions. The stop
must therefore be large in *dollars*, and that depends entirely on the
volatility regime:

| Year | Median 5m ATR | 3 ATR stop | MNQ risk | Cost as % of R |
|---|---|---|---|---|
| 2017 | 2.06 pts | 6.2 pts | $12 | **30%** |
| 2019 | 4.65 pts | 14 pts | $28 | 13% |
| 2022 | 15.47 pts | 46 pts | $93 | 4.0% |
| 2025 | 17.45 pts | 52 pts | $105 | 3.5% |

A gross edge of +0.05 to +0.07R cannot pay a 5–30% cost. Even in the friendliest
regime the margin is a few percent of R, which is inside the estimation error.

**A methodological error worth recording:** the first battery run applied MNQ's
$2/point across all 11 years and returned PF 0.2–0.8 everywhere. A random-entry
control (PF 0.99 at zero cost) proved the engine was sound and the losses were
structural — I was measuring the cost floor, not the signals. MNQ also did not
exist before May 2019, so micro economics are anachronistic in the early years.

## 6. What was rejected along the way

| Family | Configurations | Outcome |
|---|---|---|
| A1 liquidity sweep (PDH/PDL, ONH/ONL) | 12 | all noise |
| B2 range breakout — **fade** | 12 | all noise |
| B2 range breakout — **continuation** | 12 | 4 survive dev, fail OOS |
| C1 compression → expansion | 12 | all noise |
| C2 EMA pullback | 6 | all noise |
| D1 VWAP deviation | 12 | 1 survives dev, fails OOS |

Plus, from earlier phases: VWAP mean reversion at 5m (zero-cost PF 1.01, i.e. no
signal at all) and the tuned ON-range configuration at a 0.393 payoff
(**PF 0.804 over 3,433 trades**, win rate 67.6% against a 71.8% mechanical
breakeven).

## 7. Scored against the objectives

| Target | Achieved |
|---|---|
| 3+ trades/day | ✅ 4–5/day |
| ~70% win rate | ❌ 44–48% at the payoff where signal exists |
| PF 1.50+ | ❌ 1.01 OOS |
| Positive expectancy | ❌ +0.004R OOS, negative after realistic costs |
| Robust across regimes | ❌ 2 of 11 years significant |
| Robust across years | ❌ decays 2022 → 2025 |
| No repainting / lookahead | ✅ verified |

**Overfitting risk of the surviving candidate: HIGH** — it cleared validation
only on the two hottest years and failed a clean OOS.

## 8. Weaknesses of this study

- Data is **NQ**, not MNQ, for the signal; MNQ economics are modelled at $2/point.
  The contracts track the same index (ρ = 0.9985) so signals transfer, but MNQ's
  own microstructure was never tested.
- 2023–2025 was partially contaminated for this family (examined earlier at a
  0.393 payoff), so the OOS is slightly weaker evidence than a virgin sample.
- Only six families were tested. Market structure (BOS/MSS/FVG/displacement) and
  hybrids were not, deliberately — each extra family raises the multiple-testing
  burden.
- Costs are modelled, not measured from fills.

## 9. Verdict

**INSUFFICIENT EVIDENCE — do not fund an account on this.**

The honest summary: overnight-range continuation carries a small, genuine
momentum signal on NQ 5m, worth roughly +0.05 to +0.07R per trade gross. MNQ's
transaction costs are 3–30% of R depending on regime. The edge does not clear
the cost wall reliably, is significant in only 2 of 11 years, and failed the
untouched out-of-sample test outright.

This is not a parameter problem and more searching will not fix it.
