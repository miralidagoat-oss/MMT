# V1 ERRATA — mechanical correction of a partition-boundary defect

**Original artifact:** `V1_FROZEN.json`, commit `96d878120c304ef6d960c0f21cc4feb2f3d850ad` — retained unchanged as part of the audit trail.  
**Corrected artifact:** `V1_CORRECTED.json`, commit `907af68504c72985b14aca16cec10ac3dc8fbf17`

## What was wrong

`partitions.load()` treated a calendar date as UTC midnight and applied fixed
−6h / +30h offsets to reach session boundaries. Those offsets encode neither
the 18:00 ET open nor US DST rules.

| | OLD | NEW |
|---|---|---|
| evaluation opens | 2022-09-08 14:00 EDT | 2022-09-08 18:00 EDT |
| evaluation closes | 2025-05-06 02:00 EDT | 2025-05-05 17:00 EDT |

**Impact, measured not assumed:**

- erroneously included bars: **122**
- erroneously excluded bars: **0**
- erroneously included trades: **3**
- erroneously excluded trades: **0**
- affected CME trade dates: **2022-09-08, 2025-05-06**

All three trades fall on trade date 2025-05-06, beyond the declared
development end of 2025-05-05:

```
2025-05-05 20:00 EDT  dir +1  r -1.0512
2025-05-05 23:10 EDT  dir +1  r -0.3399
2025-05-06 01:20 EDT  dir +1  r -1.0491
                             total -2.4402R
```

**All three are losing trades, so the correction improves every expectancy
figure.** Profitability was not consulted in deciding what to do — the frozen
partition determined it — but the direction is stated prominently because a
correction that flatters the strategy deserves more scrutiny, not less.

Separately, the frequency denominator counted every trade day among loaded
bars including warm-up (706) rather than
eligible trade days (683).

## Specification identity

All **13** configurations were rebuilt from the stored parameter
sets and their sha256 hashes re-derived. Every hash matched the frozen value;
the correction script aborts on any mismatch rather than reporting a silent
specification change. **No parameter, hypothesis, threshold, entry rule or exit
rule was altered, added or removed.**

## Original vs corrected

| Hyp | Configuration | n | elig. days | trades/day | Expectancy R | PF | Win % | DD R |
|---|---|---|---|---|---|---|---|---|
| baseline | CANDIDATE as shipped | 1978→**1975** | 706→**683** | 2.80→**2.89** | +0.0136→**+0.0149** | 1.020→**1.022** | 23.5→**23.5** | 83.8→**83.8** |
| H1 | cooldown argmax 8 (40min) | 1926→**1923** | 706→**683** | 2.73→**2.82** | +0.0167→**+0.0180** | 1.025→**1.026** | 23.5→**23.6** | 80.8→**80.8** |
| H1 | validity 48 (240min) | 1978→**1975** | 706→**683** | 2.80→**2.89** | +0.0136→**+0.0149** | 1.020→**1.022** | 23.5→**23.5** | 83.8→**83.8** |
| H2 | max_event_bars argmax 11 (55min) | 2929→**2926** | 706→**683** | 4.15→**4.28** | +0.0086→**+0.0094** | 1.013→**1.014** | 23.3→**23.3** | 107.2→**107.2** |
| H3 | anchor day (Globex 18:00 ET) | 2451→**2448** | 706→**683** | 3.47→**3.58** | -0.0040→**-0.0030** | 0.994→**0.996** | 23.0→**23.0** | 109.2→**109.2** |
| H3 | anchor midnight (00:00 ET) | 2570→**2567** | 706→**683** | 3.64→**3.76** | -0.0348→**-0.0339** | 0.950→**0.951** | 22.3→**22.3** | 172.9→**172.9** |
| H3 | anchor cash (09:30 ET) | 2216→**2213** | 706→**683** | 3.14→**3.24** | -0.0152→**-0.0142** | 0.978→**0.979** | 22.6→**22.6** | 149.3→**149.3** |
| H4 | min_range_atr argmax 0.75 | 1624→**1622** | 706→**683** | 2.30→**2.37** | +0.0284→**+0.0293** | 1.042→**1.043** | 23.8→**23.8** | 51.6→**51.6** |
| H5 | drop T1 prior+session | 1943→**1940** | 706→**683** | 2.75→**2.84** | +0.0103→**+0.0116** | 1.015→**1.017** | 23.4→**23.5** | 83.7→**83.7** |
| H5 | drop T3/T4 swing pivots | 553→**553** | 706→**683** | 0.78→**0.81** | -0.0767→**-0.0767** | 0.888→**0.888** | 20.4→**20.4** | 60.2→**60.2** |
| H6 | 5m+15m | 327→**326** | 706→**683** | 0.46→**0.48** | -0.1204→**-0.1197** | 0.830→**0.831** | 19.9→**19.9** | 55.5→**55.5** |
| H6 | 5m+1H | 553→**553** | 706→**683** | 0.78→**0.81** | -0.0345→**-0.0345** | 0.950→**0.950** | 22.1→**22.1** | 68.7→**68.7** |
| H6 | 5m+15m+1H | 105→**105** | 706→**683** | 0.15→**0.15** | -0.0420→**-0.0420** | 0.936→**0.936** | 21.0→**21.0** | 18.3→**18.3** |

### Uncertainty intervals, original vs corrected

**baseline — CANDIDATE as shipped**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0591, +0.0864] | [-0.0580, +0.0877] |
| cr1_day_cluster _(orig headline)_ _(corr headline)_ | [-0.0565, +0.0837] | [-0.0553, +0.0850] |
| day_block | [-0.0542, +0.0839] | [-0.0517, +0.0835] |
| moving_block_5d | [-0.0564, +0.0816] | [-0.0565, +0.0830] |
| moving_block_10d | [-0.0574, +0.0797] | [-0.0520, +0.0817] |
| moving_block_20d | [-0.0573, +0.0759] | [-0.0558, +0.0751] |
| stationary_5d | [-0.0558, +0.0818] | [-0.0548, +0.0848] |

**H1 — cooldown argmax 8 (40min)**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0571, +0.0905] | [-0.0559, +0.0919] |
| cr1_day_cluster _(orig headline)_ | [-0.0550, +0.0884] | [-0.0538, +0.0898] |
| day_block | [-0.0539, +0.0889] | [-0.0519, +0.0888] |
| moving_block_5d | [-0.0519, +0.0861] | [-0.0529, +0.0875] |
| moving_block_10d | [-0.0512, +0.0857] | [-0.0506, +0.0847] |
| moving_block_20d | [-0.0503, +0.0843] | [-0.0527, +0.0791] |
| stationary_5d _(corr headline)_ | [-0.0527, +0.0881] | [-0.0539, +0.0910] |

**H1 — validity 48 (240min)**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0591, +0.0864] | [-0.0580, +0.0877] |
| cr1_day_cluster _(orig headline)_ _(corr headline)_ | [-0.0565, +0.0837] | [-0.0553, +0.0850] |
| day_block | [-0.0542, +0.0839] | [-0.0517, +0.0835] |
| moving_block_5d | [-0.0564, +0.0816] | [-0.0565, +0.0830] |
| moving_block_10d | [-0.0574, +0.0797] | [-0.0520, +0.0817] |
| moving_block_20d | [-0.0573, +0.0759] | [-0.0558, +0.0751] |
| stationary_5d | [-0.0558, +0.0818] | [-0.0548, +0.0848] |

**H2 — max_event_bars argmax 11 (55min)**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0510, +0.0682] | [-0.0503, +0.0691] |
| cr1_day_cluster _(orig headline)_ _(corr headline)_ | [-0.0521, +0.0693] | [-0.0513, +0.0701] |
| day_block | [-0.0503, +0.0680] | [-0.0497, +0.0702] |
| moving_block_5d | [-0.0494, +0.0650] | [-0.0478, +0.0647] |
| moving_block_10d | [-0.0457, +0.0634] | [-0.0468, +0.0624] |
| moving_block_20d | [-0.0442, +0.0686] | [-0.0452, +0.0663] |
| stationary_5d | [-0.0488, +0.0687] | [-0.0508, +0.0682] |

**H3 — anchor day (Globex 18:00 ET)**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0689, +0.0609] | [-0.0680, +0.0619] |
| cr1_day_cluster | [-0.0656, +0.0576] | [-0.0646, +0.0586] |
| day_block _(orig headline)_ | [-0.0648, +0.0591] | [-0.0627, +0.0598] |
| moving_block_5d | [-0.0668, +0.0537] | [-0.0647, +0.0541] |
| moving_block_10d | [-0.0647, +0.0527] | [-0.0659, +0.0529] |
| moving_block_20d | [-0.0634, +0.0512] | [-0.0644, +0.0488] |
| stationary_5d _(corr headline)_ | [-0.0637, +0.0601] | [-0.0645, +0.0603] |

**H3 — anchor midnight (00:00 ET)**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0976, +0.0279] | [-0.0967, +0.0289] |
| cr1_day_cluster | [-0.0924, +0.0227] | [-0.0916, +0.0237] |
| day_block | [-0.0953, +0.0201] | [-0.0945, +0.0234] |
| moving_block_5d | [-0.0945, +0.0234] | [-0.0993, +0.0208] |
| moving_block_10d _(orig headline)_ | [-0.0969, +0.0246] | [-0.0972, +0.0199] |
| moving_block_20d | [-0.0981, +0.0225] | [-0.0992, +0.0213] |
| stationary_5d _(corr headline)_ | [-0.0964, +0.0250] | [-0.0941, +0.0292] |

**H3 — anchor cash (09:30 ET)**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0831, +0.0527] | [-0.0821, +0.0538] |
| cr1_day_cluster | [-0.0801, +0.0496] | [-0.0791, +0.0507] |
| day_block | [-0.0775, +0.0533] | [-0.0778, +0.0549] |
| moving_block_5d | [-0.0795, +0.0528] | [-0.0768, +0.0532] |
| moving_block_10d | [-0.0805, +0.0529] | [-0.0824, +0.0512] |
| moving_block_20d _(corr headline)_ | [-0.0828, +0.0514] | [-0.0825, +0.0513] |
| stationary_5d _(orig headline)_ | [-0.0831, +0.0564] | [-0.0790, +0.0539] |

**H4 — min_range_atr argmax 0.75**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0523, +0.1090] | [-0.0515, +0.1100] |
| cr1_day_cluster _(corr headline)_ | [-0.0494, +0.1061] | [-0.0485, +0.1071] |
| day_block | [-0.0487, +0.1032] | [-0.0451, +0.1052] |
| moving_block_5d | [-0.0500, +0.1051] | [-0.0482, +0.1032] |
| moving_block_10d | [-0.0438, +0.1015] | [-0.0448, +0.1033] |
| moving_block_20d | [-0.0435, +0.0929] | [-0.0457, +0.0928] |
| stationary_5d _(orig headline)_ | [-0.0500, +0.1059] | [-0.0453, +0.1061] |

**H5 — drop T1 prior+session**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.0631, +0.0837] | [-0.0619, +0.0851] |
| cr1_day_cluster _(orig headline)_ _(corr headline)_ | [-0.0601, +0.0807] | [-0.0589, +0.0821] |
| day_block | [-0.0594, +0.0808] | [-0.0577, +0.0820] |
| moving_block_5d | [-0.0585, +0.0819] | [-0.0579, +0.0792] |
| moving_block_10d | [-0.0544, +0.0774] | [-0.0560, +0.0749] |
| moving_block_20d | [-0.0565, +0.0697] | [-0.0573, +0.0690] |
| stationary_5d | [-0.0571, +0.0796] | [-0.0576, +0.0783] |

**H5 — drop T3/T4 swing pivots**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.2073, +0.0540] | [-0.2073, +0.0540] |
| cr1_day_cluster | [-0.2009, +0.0476] | [-0.2009, +0.0476] |
| day_block _(orig headline)_ _(corr headline)_ | [-0.2033, +0.0500] | [-0.2033, +0.0500] |
| moving_block_5d | [-0.1727, +0.0275] | [-0.1727, +0.0275] |
| moving_block_10d | [-0.1703, +0.0240] | [-0.1703, +0.0240] |
| moving_block_20d | [-0.1628, +0.0211] | [-0.1628, +0.0211] |
| stationary_5d | [-0.1774, +0.0310] | [-0.1774, +0.0310] |

**H6 — 5m+15m**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.2892, +0.0484] | [-0.2891, +0.0496] |
| cr1_day_cluster | [-0.2923, +0.0515] | [-0.2922, +0.0527] |
| day_block | [-0.2799, +0.0595] | [-0.2840, +0.0612] |
| moving_block_5d _(corr headline)_ | [-0.2987, +0.0640] | [-0.2951, +0.0648] |
| moving_block_10d _(orig headline)_ | [-0.3020, +0.0655] | [-0.2972, +0.0592] |
| moving_block_20d | [-0.2702, +0.0104] | [-0.2697, +0.0112] |
| stationary_5d | [-0.3015, +0.0541] | [-0.2943, +0.0588] |

**H6 — 5m+1H**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.1689, +0.1000] | [-0.1689, +0.1000] |
| cr1_day_cluster | [-0.1725, +0.1036] | [-0.1725, +0.1036] |
| day_block | [-0.1686, +0.1059] | [-0.1686, +0.1059] |
| moving_block_5d | [-0.1672, +0.1159] | [-0.1672, +0.1159] |
| moving_block_10d | [-0.1839, +0.1062] | [-0.1839, +0.1062] |
| moving_block_20d | [-0.1888, +0.0998] | [-0.1888, +0.0998] |
| stationary_5d _(orig headline)_ _(corr headline)_ | [-0.1828, +0.1135] | [-0.1828, +0.1135] |

**H6 — 5m+15m+1H**

| Estimator | ORIGINAL | CORRECTED |
|---|---|---|
| naive_trade | [-0.3432, +0.2592] | [-0.3432, +0.2592] |
| cr1_day_cluster | [-0.3458, +0.2619] | [-0.3458, +0.2619] |
| day_block | [-0.3337, +0.2787] | [-0.3337, +0.2787] |
| moving_block_5d | [-0.3358, +0.2608] | [-0.3358, +0.2608] |
| moving_block_10d _(orig headline)_ _(corr headline)_ | [-0.3420, +0.2752] | [-0.3420, +0.2752] |
| moving_block_20d | [-0.3800, +0.2262] | [-0.3800, +0.2262] |
| stationary_5d | [-0.3263, +0.2650] | [-0.3263, +0.2650] |

## Does the correction change any qualitative V1 conclusion?

**No.** `qualitative_change = False`.

Checked mechanically on two criteria per row: whether significance changed,
and whether the sign of expectancy changed. Neither did for any of the 13
configurations. Every interval still includes zero; every sanctioned H3 anchor
is still negative; every H6 confirmation is still negative; H4's argmax is
still a §5 plateau failure; H5's T1 still fails the tier test.

The V1 conclusion stands exactly as frozen:

> The tested V1 PO3 + VWAP + liquidity-sweep architecture did not demonstrate
> a statistically or economically defensible 5-minute NQ edge under the frozen
> methodology.

## Ledger classification

This is a **reproducibility correction**, not a new strategy hypothesis. It
adds 0 to the hypothesis count and 0 to the performance-inspected
configuration count: the same 13 specifications were re-evaluated under a
corrected data boundary, not searched over.
