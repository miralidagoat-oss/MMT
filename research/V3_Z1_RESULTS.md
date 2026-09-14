# V3-Z1 RESULTS — NEGATIVE, DEVELOPMENT

**Classification: `V3-Z1 NEGATIVE - DEVELOPMENT`**

First real outcome inspected: **2026-09-14T04:08:58+00:00** under commit `9fffc86e5db93760ca30af79948c44a4efe0d0ea`.

```
performance_inspected         = true
outcomes_inspected            = true
development_run               = true
replication_run               = false
prospective_holdout_inspected = false
data_cost_usd                 = 0
```

> Genuine CME-referencing data, but VENDOR-LIMITED: Yahoo generic/continuous series for NQ/ES/YM/RTY. Historical contract identity, switch dates, roll algorithm and back-adjustment remain UNKNOWN.

## 1–2. Development statistics

| | H1 `divergence_1h` | H2 `divergence_session` |
|---|---|---|
| eligible rows | 7,586 | 7,227 |
| eligible trade dates | 360 | 360 |
| **β** | **+0.015410** | **+0.008933** |
| CR1 standard error | 0.025191 | 0.017482 |
| t | +0.612 | +0.511 |
| degrees of freedom | 359 | 359 |
| **raw two-sided p** | **0.54111** | **0.60969** |
| 95% CR1 CI | [-0.034131, +0.064951] | [-0.025448, +0.043313] |
| expected sign | NEGATIVE | NEGATIVE |
| **observed sign** | **POSITIVE** | **POSITIVE** |
| \|standardized β\| | 0.0154 | 0.0089 |
| clusters G | 360 | 360 |
| design rank / k | 10/10 | 10/10 |
| condition number | 6.59 | 6.19 |
| numerical warnings | none | none |

## 3. Holm (m = 2, α = 0.05)

| rank | feature | raw p | multiplier | Holm threshold | adjusted p | result |
|---|---|---|---|---|---|---|
| 1 | `divergence_1h` | 0.54111 | 2 | 0.0250 | **1.00000** | **FAIL** |
| 2 | `divergence_session` | 0.60969 | 1 | 0.0500 | **1.00000** | **FAIL** |

## 4. Concentration (10 leave-one-decile-out refits)

**`divergence_1h`** — full β = +0.015410

| decile omitted | β |
|---|---|
| D1 | +0.018328 |
| D2 | +0.002058 |
| D3 | +0.014846 |
| D4 | +0.022590 |
| D5 | +0.004697 |
| D6 | +0.021559 |
| D7 | +0.013585 |
| D8 | +0.009385 |
| D9 | +0.023414 |
| D10 | +0.022705 |

- retaining preregistered (negative) sign: **0/10** → (a) False
- largest opposite-sign \|β\|: 0.023414 vs full \|β\| 0.015410 → (b) False
- median LOO \|β\| 0.016587, ratio 1.076 → (c) True
- **CONCENTRATION FAIL**

**`divergence_session`** — full β = +0.008933

| decile omitted | β |
|---|---|
| D1 | +0.011972 |
| D2 | -0.013600 |
| D3 | +0.015466 |
| D4 | +0.006083 |
| D5 | +0.015683 |
| D6 | +0.007765 |
| D7 | +0.010859 |
| D8 | +0.011338 |
| D9 | +0.012506 |
| D10 | +0.007472 |

- retaining preregistered (negative) sign: **1/10** → (a) False
- largest opposite-sign \|β\|: 0.015683 vs full \|β\| 0.008933 → (b) False
- median LOO \|β\| 0.011655, ratio 1.305 → (c) True
- **CONCENTRATION FAIL**

## 5–7. Moving-block bootstrap (seed 20260914, 5,000 resamples each)

| feature | L | median β | 2.5% | 97.5% | fraction negative | result |
|---|---|---|---|---|---|---|
| `divergence_1h` | 5 | +0.013882 | -0.032901 | **+0.062645** | 0.294 | **FAIL** |
| `divergence_1h` | 10 | +0.013374 | -0.033120 | **+0.060096** | 0.283 | **FAIL** |
| `divergence_1h` | 20 | +0.015253 | -0.029024 | **+0.056353** | 0.247 | **FAIL** |
| `divergence_session` | 5 | +0.008916 | -0.025056 | **+0.040283** | 0.300 | **FAIL** |
| `divergence_session` | 10 | +0.008573 | -0.027653 | **+0.041078** | 0.322 | **FAIL** |
| `divergence_session` | 20 | +0.009180 | -0.030823 | **+0.044403** | 0.329 | **FAIL** |

Pass required the 97.5 percentile < 0. Every interval straddles zero, and the bootstrap mass sits predominantly on the **wrong side**: only 25–33% of resamples land in the preregistered negative direction.

## 8. Stage-1 gate table

| gate | H1 `divergence_1h` | H2 `divergence_session` |
|---|---|---|
| 1 holm p le alpha | **FAIL** | **FAIL** |
| 2 sign matches | **FAIL** | **FAIL** |
| 3 abs beta ge 0.03 | **FAIL** | **FAIL** |
| 4 concentration | **FAIL** | **FAIL** |
| 5 bootstrap L5 | **FAIL** | **FAIL** |
| 6 bootstrap L10 | **FAIL** | **FAIL** |
| 7 bootstrap L20 | **FAIL** | **FAIL** |
| 8 full baseline model | **PASS** | **PASS** |
| 9 rank conditioning | **PASS** | **PASS** |
| FINAL DEVELOPMENT PROMOTION | **FAIL** | **FAIL** |

## 9–10. Replication

**Stage-1 survivors: NONE.** no hypothesis passed Stage 1; replication remains OUTCOME-UNINSPECTED.

Replication coefficients, p-values, correlations and directional summaries were **not computed** for either hypothesis. `replication_run = false`.

## 11. Final classification

### `V3-Z1 NEGATIVE — DEVELOPMENT`

## 12. What this does and does not establish

**Establishes:** the frozen V3-Z1 cross-market hypothesis family did not demonstrate a sufficiently robust incremental directional relationship in the development sample. Neither preregistered feature passed the frozen Stage-1 gate, and both failed independently on seven of nine gates.

**Both point estimates came out POSITIVE** where the preregistration committed to NEGATIVE. The transient-impact reversion mechanism, as operationalized here, is not supported. The opposite lean is itself far too weak and unstable to claim: concentration refits reverse sign readily (0/10 and 1/10 retain the expected sign) and every bootstrap interval straddles zero.

**Does NOT establish:** that cross-market information never works; that ES/YM/RTY contain no information; that NQ has no predictable behaviour; or that future cross-market research is invalid. The result binds this frozen operationalization, this hourly horizon, this baseline, and this vendor-limited sample of 360 development trade dates.

**Silent about:** 5-minute behaviour, order flow, profitability, any strategy. None was constructed.

## 13–14. Artifacts

| artifact | sha256 |
|---|---|
| `research/V3_Z1_RESULTS.json` | `f74f7600a1cd95f207f195d84b2bd8d9f8473d06717239fa5f8b272f8505099d` |
| `research/V3_Z1_EXECUTION_SPEC.json` | `e196c8dbb9d14eb0cb6745cfa97c2ae66d679bd747a5d9c07c261a083331d29f` |
| `research/V3_Z1_PREREGISTRATION.json` | `a979a8ca4ddccc0f995b6b5cfe3ff5c02841a8daf6350879abc159a565fad98a` |
| `research/V3_Z1_DATA_MANIFEST.json` | `a8f82dc864607241ba00eea97d00644a1632bb8e2be971327adf55fd926aa1a3` |

## 15. Post-outcome defect record

One defect was found AFTER outcomes were inspected, recorded per the frozen post-outcome policy:

- **What:** the results-markdown generator used `L` as both the output-line list and the bootstrap block-length loop variable, so `"\n".join(L)` raised and wrote an empty file.
- **When discovered:** immediately after the first commit of results.
- **Outcomes already seen:** all development outcomes (they were already correctly written to `V3_Z1_RESULTS.json` before this script ran).
- **Could it affect those outcomes:** **NO.** The bug is in a presentation script that only reads the completed results JSON. It touches no data, no sample, no model, no statistic. `V3_Z1_RESULTS.json` is byte-identical before and after the fix.
- **Run status:** NOT contaminated. No rerun of the analysis was performed or needed.

