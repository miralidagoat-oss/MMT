# V1 — FROZEN NEGATIVE RESULT

**Commit:** `96d878120c304ef6d960c0f21cc4feb2f3d850ad`  
**Basis:** `data_ndx_q/NDX_5m.csv` (Dukascopy USATECHIDXUSD CFD, NQ-tick-quantized)  
**Partition:** development only — the holdout was never opened  
**Frozen:** 2026-09-13

## Conclusion

> The tested V1 PO3 + VWAP + liquidity-sweep architecture did not demonstrate
> a statistically or economically defensible 5-minute NQ edge under the frozen
> methodology.

This statement is deliberately narrow. The following do **not** follow from
this work and are not claimed:

- *PO3 never works.* Three anchors were tested on one basis in one partition.
- *Liquidity sweeps carry no predictive information.* One sweep definition,
  one reclaim rule and one entry construction were tested — not the concept.
- *Multi-timeframe information never works.* Directional **agreement** as a
  permission filter was rejected. HTF state as context was never tested.
- *Displacement is universally harmful.* A negative gradient was measured for
  one displacement proxy on this basis. Whether displacement carries negative
  information, or whether waiting for it simply enters late, is unresolved.

## Cost assumption

- Headline **$14.00 round trip per NQ contract** = 0.7 index points at the $20/point multiplier
- Stressed **$24.00 round trip** (sensitivity only)
- Applied as: friction_points / initial risk in points, per trade - identical to $14 / (risk_points x $20)
- `cost_ticks` forced to 0.0 on every run, so the deprecated pre-v1.1
  approximation could not engage.

## Known defect in the frequency figures

reported trades/day used the loaded span (706 trade days, warm-up included) rather than countable days (685); every frequency figure is understated by ~3%.

Denominator used: **706** trade days (loaded span, warm-up included). Correct: **685**. Both columns
appear below. The error **understates** frequency, so no figure was flattered.

## Results

| Hyp | Configuration | n | trades/day (rep → corr) | Expectancy | PF | Win | Max DD | Headline CI | Scale |
|---|---|---|---|---|---|---|---|---|---|
| baseline | CANDIDATE as shipped | 1,978 | 2.80 → 2.89 | +0.0136R | 1.020 | 23.5% | 83.8R | [-0.0565, +0.0837] | cr1_day_cluster |
| H1 | cooldown argmax 8 (40min) | 1,926 | 2.73 → 2.81 | +0.0167R | 1.025 | 23.5% | 80.8R | [-0.0550, +0.0884] | cr1_day_cluster |
| H1 | validity 48 (240min) | 1,978 | 2.80 → 2.89 | +0.0136R | 1.020 | 23.5% | 83.8R | [-0.0565, +0.0837] | cr1_day_cluster |
| H2 | max_event_bars argmax 11 (55min) | 2,929 | 4.15 → 4.28 | +0.0086R | 1.013 | 23.3% | 107.2R | [-0.0521, +0.0693] | cr1_day_cluster |
| H3 | anchor day (Globex 18:00 ET) | 2,451 | 3.47 → 3.58 | -0.0040R | 0.994 | 23.0% | 109.2R | [-0.0648, +0.0591] | day_block |
| H3 | anchor midnight (00:00 ET) | 2,570 | 3.64 → 3.75 | -0.0348R | 0.950 | 22.3% | 172.9R | [-0.0969, +0.0246] | moving_block_10d |
| H3 | anchor cash (09:30 ET) | 2,216 | 3.14 → 3.24 | -0.0152R | 0.978 | 22.6% | 149.3R | [-0.0831, +0.0564] | stationary_5d |
| H4 | min_range_atr argmax 0.75 | 1,624 | 2.30 → 2.37 | +0.0284R | 1.042 | 23.8% | 51.6R | [-0.0500, +0.1059] | stationary_5d |
| H5 | drop T1 prior+session | 1,943 | 2.75 → 2.84 | +0.0103R | 1.015 | 23.4% | 83.7R | [-0.0601, +0.0807] | cr1_day_cluster |
| H5 | drop T3/T4 swing pivots | 553 | 0.78 → 0.81 | -0.0767R | 0.888 | 20.4% | 60.2R | [-0.2033, +0.0500] | day_block |
| H6 | 5m+15m | 327 | 0.46 → 0.48 | -0.1204R | 0.830 | 19.9% | 55.5R | [-0.3020, +0.0655] | moving_block_10d |
| H6 | 5m+1H | 553 | 0.78 → 0.81 | -0.0345R | 0.950 | 22.1% | 68.7R | [-0.1828, +0.1135] | stationary_5d |
| H6 | 5m+15m+1H | 105 | 0.15 → 0.15 | -0.0420R | 0.936 | 21.0% | 18.3R | [-0.3420, +0.2752] | moving_block_10d |

**No row has an interval excluding zero.** Verified across all seven
predeclared scales including naive trade-level: 0 of 15 summarised results in
the H1–H6 artifacts excluded zero by any method.

## Failure reasons

- **baseline — CANDIDATE as shipped** (`e2adb81d4d4946f3`): CI spans zero; negative at stressed friction
- **H1 — cooldown argmax 8 (40min)** (`c6695d28b38dc76e`): surface flat - whole grid spans 0.51 SE; argmax is not distinguishable
- **H1 — validity 48 (240min)** (`a5f1768bcacedcb5`): INERT - market entry never consults limit lifetime; spread exactly 0.0000R
- **H2 — max_event_bars argmax 11 (55min)** (`8bec860de33f5278`): CI spans zero; no window beats the unconstrained model
- **H3 — anchor day (Globex 18:00 ET)** (`f20a7541f4d80dc4`): negative; best of the three sanctioned anchors
- **H3 — anchor midnight (00:00 ET)** (`5ba9d1471970a15f`): negative
- **H3 — anchor cash (09:30 ET)** (`73f89b943477373b`): negative
- **H4 — min_range_atr argmax 0.75** (`17fe4036c4c4576a`): §5 plateau FAILS - needle, longest run within 1 SE is 4 of 5 required
- **H5 — drop T1 prior+session** (`8a28835315a35f4d`): T1 adds value in only 1 of 3 sub-windows - fails the §5 tier test
- **H5 — drop T3/T4 swing pivots** (`a76d2e6b170b9eb4`): removing pivots collapses the model to -0.0767R - they carry it, but to zero
- **H6 — 5m+15m** (`9977acade54e104e`): negative; removes 83% of trades; fails the §11 frequency floor
- **H6 — 5m+1H** (`a35bbd65ac7d42d2`): negative; fails the §11 frequency floor
- **H6 — 5m+15m+1H** (`043770c3ae946a20`): negative; removes 95% of trades; fails the §11 frequency floor

## Economic reading

The baseline accumulates roughly 27R across 1,978 trades while enduring a **83.8R** peak-to-trough
drawdown. That is not a tradeable risk profile even before noting that the
interval spans zero. No configuration tested improves this materially.

## Configuration hashes

Each row is stamped with a sha256 prefix of its full parameter set, so any
figure can be regenerated exactly:

| Hyp | Configuration | hash |
|---|---|---|
| baseline | CANDIDATE as shipped | `e2adb81d4d4946f3` |
| H1 | cooldown argmax 8 (40min) | `c6695d28b38dc76e` |
| H1 | validity 48 (240min) | `a5f1768bcacedcb5` |
| H2 | max_event_bars argmax 11 (55min) | `8bec860de33f5278` |
| H3 | anchor day (Globex 18:00 ET) | `f20a7541f4d80dc4` |
| H3 | anchor midnight (00:00 ET) | `5ba9d1471970a15f` |
| H3 | anchor cash (09:30 ET) | `73f89b943477373b` |
| H4 | min_range_atr argmax 0.75 | `17fe4036c4c4576a` |
| H5 | drop T1 prior+session | `8a28835315a35f4d` |
| H5 | drop T3/T4 swing pivots | `a76d2e6b170b9eb4` |
| H6 | 5m+15m | `9977acade54e104e` |
| H6 | 5m+1H | `a35bbd65ac7d42d2` |
| H6 | 5m+15m+1H | `043770c3ae946a20` |

Full parameter sets and all seven interval scales per row: `V1_FROZEN.json`.
Sweep grids: `research/results/*.json`.

## Holdout status

**SEALED. One use remaining.** V1 produced no candidate deserving evaluation,
and a negative development result does not justify opening it.
