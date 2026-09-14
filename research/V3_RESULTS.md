# V3 — FROZEN NEGATIVE RESEARCH GENERATION

**Status: `CLOSED - NEGATIVE RESEARCH GENERATION`** · frozen 2026-09-14 · `data_cost_usd = 0`

> genuine CME-REFERENCING data, but VENDOR-LIMITED: Yahoo generic/continuous series. Historical contract identity, generic switch dates, roll algorithm and back-adjustment are UNKNOWN.

## Conclusion

The frozen V3-Z1 cross-market development experiment found no statistically supported incremental directional relationship between either predeclared cross-market state and the next-hour direction-normalized NQ return. Across 7,586 and 7,227 primary-eligible observations spanning 360 CME trade-date clusters, neither hypothesis rejected under the frozen Holm procedure (m=2, alpha=0.05), both point estimates carried the OPPOSITE sign to the preregistration, and both failed seven of nine Stage-1 gates. Replication was never opened and the prospective holdout was never touched. These results apply to the tested V3-Z1 operationalization, the one-hour horizon, the frozen NQ-only baseline, and a vendor-limited Yahoo generic/continuous futures dataset. They do not establish that cross-market information never works, that ES/YM/RTY contain no information, that NQ has no predictable behaviour, or that future cross-market research is invalid.

## 1. V3-Z1 — the research result

**`V3-Z1 NEGATIVE - DEVELOPMENT`** · Holm m=2, α=0.05 · **promoted 0**

| | H1 `divergence_1h` | H2 `divergence_session` |
|---|---|---|
| rows | 7,586 | 7,227 |
| clusters | 360 | 360 |
| **β** | **+0.015410** | **+0.008933** |
| CR1 se | 0.025191 | 0.017482 |
| t | +0.612 | +0.511 |
| raw p | 0.54111 | 0.60969 |
| Holm-adjusted p | **1.00000** | **1.00000** |
| 95% CI | [-0.03413, +0.06495] | [-0.02545, +0.04331] |
| expected sign | NEGATIVE | NEGATIVE |
| **observed sign** | **POSITIVE** | **POSITIVE** |
| gates passed | 2 of 9 | 2 of 9 |

both estimates were WRONG-SIGNED against a preregistered direction. Preregistering the sign is what makes that readable: without it, p=0.54 with a positive coefficient could have been retold as 'mild momentum'.

Replication: **not opened** — no Stage-1 survivor; remains outcome-uninspected.

## 2. V3-Z2-PC — the instrument check

*an INSTRUMENT CHECK, never a research hypothesis.*

| check | configuration | result | verdict |
|---|---|---|---|
| **A1 sensitivity** | HAR + `log(r²)` | β=**+0.448**, t=**+10.05**, Wald p=7.8e-98 | **PASS** |
| A2 size (original) | HAR + `log(r²)` | rate **0.1710** | FAIL |
| A2-R1 | HAR + Z1 return | rate **0.0680** | PASS |
| **A2-R2** | **actual Z1 + Z1 return** | rate **0.0540** | **PASS** |

**PIPELINE VALIDATED for the return-outcome configuration actually used.**

this is V3's one POSITIVE result and it is methodological, not economic. The V2_PROXY and V3-Z1 nulls rest on a pipeline with demonstrated sensitivity (detects a known-true effect at t=+10.05) and demonstrated correct size (5.40% at nominal 5%, within one Monte-Carlo SE). The 24 predeclared nulls are evidence about the market, not artifacts of the code.

> **This must not be read as a research finding.** a research finding. The volatility-persistence coefficient confirms a KNOWN-TRUE effect and exists only to calibrate the instrument. It is not promoted, not a signal, and no Z2 research hypothesis was ever preregistered.

*Unresolved:* why the log(r^2) configuration over-rejected at 17.1%. My heavy-tail explanation was REFUTED by measurement - log(r^2) kurtosis 3.59 vs return kurtosis 15.61. An untested conjecture is residual intraday seasonality surviving the block permutation. Nothing depends on it.

## 3. The structural finding — a data ceiling

this is V3's most consequential finding and it constrains all future work on free data.

| | |
|---|---|
| Z1 measured CR1 se | 0.02519 at 360 clusters |
| **MDE @ 80% power** | **0.0706** |
| declared economic floor | 0.03 |
| the gap | the design could only certify effects >= 0.071 while declaring it cared about 0.03 |
| clusters needed for 0.03 | **1,992** (~7.9 years) |
| free hourly ceiling | **618** (~2.5 years) |
| shortfall | **5.5 more years** of forward accumulation |

**no directional hourly experiment on free Yahoo data can reach the power its own economic threshold requires - now, or short of 5.5 years of forward accumulation. This is an arithmetic ceiling on the data source, not a hypothesis problem. Every future directional candidate on this basis inherits it.**

## 4. Methodological assets carried forward

- **MDE-versus-floor rule** — no pass threshold may be declared BELOW the design's MDE at 80% power, computed before outcomes. V3-Z1 violated this; V3-Z2-PC applied it. *(BINDING on all future preregistrations)*
- **algebraic-redundancy check** — no confirmatory feature may be a linear combination of the baseline plus another confirmatory feature. Caught in Z1 Amendment 01 where divergence_1h and basket_z were one test written twice. *(BINDING)*
- **validated inference pipeline** — CR1 day-clustered inference with demonstrated sensitivity and size *(reusable)*
- **outcome firewall pattern** — dry-run poisons the outcome VALUE function; only a boolean presence predicate is reachable; protected hashes verified before outcome access *(reusable)*

## 5. Model-class closure

**CLOSED - NO PROMOTED DIRECTIONAL SIGNAL**

Applies to:

- the V3-Z1 cross-market divergence operationalization
- the NQ/ES/YM/RTY hourly panel as a DIRECTIONAL basis
- the one-hour direction-normalized return target
- the Yahoo generic/continuous futures dataset

Prohibited continuations:

- re-parameterizing the divergence features
- adding instruments to the basket
- changing the volatility lookback
- switching the horizon to find significance
- relaxing any Stage-1 gate
- splitting long and short
- mining the replication segment
- opening the prospective holdout early

**Explicitly NOT closed:**

- **volatility as a research target** — never preregistered as a hypothesis; only used as a control
- **order flow / transaction-level microstructure** — BLOCKED on data availability at $0, never statistically falsified

## 6. Reserved data

| | |
|---|---|
| V3 replication inspected | **False** |
| V3 prospective holdout inspected | **False** |
| prospective cutoff | `2026-09-14T02:44:06Z` |
| accumulation required | 126 eligible trade dates |

the prospective holdout is intact but is a SUNK ASSET: there is no promoted candidate to spend it on. It should not be opened.

## 7. Research history carried forward

*tracked BY UNIT; unlike units are never summed.*

**A. Configuration searches** — V1 verified minimum **50**, V1 unknown additional **~70**, V2 new **0**, V3 new **0**

**B. Primary hypotheses** — V1 families 6 (frozen report rows 13) · V2_PROXY **22** · V3-Z1 **2** · **total predeclared 24, promoted 0**

**C. Secondary exposure** — V2 secondary-horizon 66 · V2 landmark 19 · V3 instrument checks 3

**D/E/F. Reserved** — validation 0 · stress set 0 · prospective 0

No grand total is computed: these entries do not share a unit.

## 8. Limitations

- Yahoo generic/continuous series, not contract-level CME data
- roll algorithm, switch dates and back-adjustment UNKNOWN
- 618 trade dates is the hard free-data ceiling at hourly resolution
- effective sample is 360 trade-date CLUSTERS, not 7,586 hourly bars
- no 5-minute microstructure claim is supported
- no order-flow claim is supported
- no profitability or strategy claim is supported - none was constructed

**No V4 is authorized by this closure.**

## 9. Hashes

| artifact | sha256 |
|---|---|
| `research/V3_Z1_RESULTS.json` | `f74f7600a1cd95f207f195d84b2bd8d9f8473d06717239fa5f8b272f8505099d` |
| `research/V3_Z2_PC_RESULTS.json` | `c77689bba382cba1076483630a739c95b174edade031132d8bfacf1c9f64dd2e` |
| `research/V3_A2_RERUN_RESULTS.json` | `50480b57d254938d98f5699475b2b911d4a415329996fef3f44ed0f2b3dc6d3a` |
| `research/V3_Z1_PREREGISTRATION.json` | `a979a8ca4ddccc0f995b6b5cfe3ff5c02841a8daf6350879abc159a565fad98a` |
| `research/V3_Z2_PC_PREREGISTRATION.json` | `18ac40c84a7dd4d0bcd3aa5497cc1516bb45fb02b02d12878afa9700e79a69ae` |
| `research/V3_Z1_DATA_MANIFEST.json` | `a8f82dc864607241ba00eea97d00644a1632bb8e2be971327adf55fd926aa1a3` |
| `backtest/z1_panel.py` | `24259e15e3de9f704fe7859ab3e66b258c655c7a048238567827555ad03733a8` |
| `backtest/z1_design.py` | `0a884b8d834bf05e947df982eaecd6a4dd93e52377d7e8cccaa7359c8e8fd428` |
| `backtest/z2_control.py` | `c653a12d26f4a661cbc018deb1404e436bb14552102ee00cd081dc3a9c94b037` |
