# V2_PROXY — FROZEN NEGATIVE RESULT

**Status: CLOSED — NO PROMOTED DEVELOPMENT SIGNAL**

Commit `cb75fe962350f2acb66c7980e8e95dd5122f3ffe` · frozen 2026-09-13

> **PROXY EVIDENCE.** Dukascopy Nasdaq CFD with broker-side volume. Not CME NQ futures.

## Conclusion

The frozen V2_PROXY development event study found no statistically supported stable conditional relationship between any of the 22 predeclared event-time features and the primary 30-minute direction-normalized post-event return. Across 16,182 primary-eligible events spanning 431 CME trade dates, no primary feature rejected under the frozen Holm FWER procedure (m=22, alpha=0.05), and therefore no feature satisfied the complete Phase-1 promotion gate. These results apply to the tested V2_PROXY architecture and Dukascopy Nasdaq CFD proxy dataset. They do not establish that all liquidity-event models are ineffective, that every possible post-event variable is uninformative, or that genuine CME NQ must behave identically.

## 1. Population

| | |
|---|---|
| Total detected events | **16,666** |
| Unique episodes | **10,787** |
| Unique CME trade dates | **431** |
| Y30-eligible events | **16,182** |
| Y30-eligible episodes | **10,471** |
| Y30-eligible trade dates | **431** |
| Censored | **484** |
| Censor reasons | `missing_endpoint_bar` 484; all others 0 |

Development evaluable window 2023-09-01 → 2025-05-05; burn-in ends 2023-08-31.

## 2. Primary results — effect estimates and intervals

Reported so the reader can see which effect magnitudes remain compatible with the data. Ordered by raw p. Continuous: CR1 slope of rank(Y_30) on rank(X). Categorical: omnibus Wald only.

| feature | effect | 95% CR1 CI | rho | raw p | Holm adj p | miss% | N | G | reject |
|---|---|---|---|---|---|---|---|---|---|
| competing_liquidity_atr | -0.01849 | [-0.04250, +0.00553] | -0.0182 | 0.1310 | 1 | 0.00 | 16,182 | 431 | no |
| vwap_dist_sigma | -0.02678 | [-0.06355, +0.00999] | -0.0268 | 0.1531 | 1 | 1.98 | 15,862 | 431 | no |
| htf_1h_range_pctile | +0.01825 | [-0.01343, +0.04993] | +0.0183 | 0.2581 | 1 | 0.78 | 16,056 | 431 | no |
| htf_1h_vol_state | +0.01647 | [-0.01450, +0.04744] | +0.0165 | 0.2964 | 1 | 0.85 | 16,044 | 431 | no |
| minutes_since_session_open | -0.01474 | [-0.04430, +0.01483] | -0.0147 | 0.3278 | 1 | 0.00 | 16,182 | 431 | no |
| close_vs_level_atr | -0.01221 | [-0.03744, +0.01302] | -0.0122 | 0.3419 | 1 | 0.00 | 16,182 | 431 | no |
| penetration_atr | +0.01150 | [-0.01376, +0.03676] | +0.0115 | 0.3714 | 1 | 0.00 | 16,182 | 431 | no |
| atr_percentile | +0.01349 | [-0.02037, +0.04736] | +0.0135 | 0.4339 | 1 | 0.64 | 16,078 | 431 | no |
| dist_session_open_atr | -0.01131 | [-0.04425, +0.02163] | -0.0113 | 0.5002 | 1 | 0.00 | 16,182 | 431 | no |
| realized_vol_state | +0.01059 | [-0.02262, +0.04379] | +0.0106 | 0.5312 | 1 | 0.67 | 16,074 | 431 | no |
| level_prominence_atr | +0.00589 | [-0.01363, +0.02541] | +0.0059 | 0.5536 | 1 | 0.00 | 16,182 | 431 | no |
| liquidity_class | F(10,430)=0.874 | — (omnibus) | — | 0.5578 | 1 | 0.00 | 16,182 | 431 | no |
| range_compression | -0.00814 | [-0.03781, +0.02153] | -0.0081 | 0.5899 | 1 | 0.00 | 16,182 | 431 | no |
| vwap_slope_sigma_per_bar | -0.00812 | [-0.03971, +0.02348] | -0.0081 | 0.6139 | 1 | 3.33 | 15,643 | 431 | no |
| wick_body_ratio | -0.00610 | [-0.03215, +0.01996] | -0.0061 | 0.6459 | 1 | 0.00 | 16,182 | 431 | no |
| dist_overnight_high_atr | +0.01303 | [-0.04580, +0.07187] | +0.0130 | 0.6635 | 1 | 61.96 | 6,155 | 430 | no |
| htf_1h_dist_ref_atr | +0.00595 | [-0.02537, +0.03727] | +0.0060 | 0.7090 | 1 | 0.00 | 16,182 | 431 | no |
| htf_15m_compression | -0.00310 | [-0.03160, +0.02539] | -0.0031 | 0.8306 | 1 | 0.00 | 16,182 | 431 | no |
| level_age_min | -0.00264 | [-0.03104, +0.02575] | -0.0026 | 0.8548 | 1 | 0.00 | 16,182 | 431 | no |
| dist_overnight_low_atr | +0.00438 | [-0.05304, +0.06180] | +0.0044 | 0.8810 | 1 | 61.96 | 6,155 | 430 | no |
| session_location | F(7,430)=0.347 | — (omnibus) | — | 0.9318 | 1 | 0.00 | 16,182 | 431 | no |
| touch_count | -0.00148 | [-0.04214, +0.03917] | -0.0007 | 0.9428 | 1 | 0.00 | 16,182 | 431 | no |

**0 of 22 rejected.** Holm m=22, α=0.05. Every feature fails gate 5 (`holm_adjusted_p ≤ alpha`). `dist_overnight_high_atr` and `dist_overnight_low_atr` additionally failed the missingness gate pre-outcome (61.96%) and were non-promotable regardless of any p-value.

### On statistical power

The event study has a substantially larger effective research sample than earlier work - 16,182 primary-eligible events across 431 trade-date clusters - making the null more informative for effects of practically relevant magnitude. Sample size alone, however, does not prove power against arbitrarily small or irregular clustered effects. No post-hoc power test was run; the CR1 effect estimates and 95% clustered confidence intervals below show the range of effects compatible with the data.

## 3. Subperiod stability (descriptive — the gate applies only to Holm survivors)

Direction reproduced in S1, S2 and S3: **6 of 20** continuous features.

- `liquidity_class`: stable = **False**, ρ(S1,S2) = +0.100, ρ(S2,S3) = -0.509
- `session_location`: stable = **False**, ρ(S1,S2) = +0.381, ρ(S2,S3) = -0.167

The categorical effects were unstable across adjacent development subperiods, which is consistent with a non-robust/noisy relationship.

## 4. Secondary horizons — DESCRIPTIVE ONLY

DESCRIPTIVE ONLY. No second Holm family was declared. Y_30 remains the frozen primary horizon. These cannot promote a feature.

| horizon | min raw p (descriptive) | # p<0.05 of 22 |
|---|---|---|
| Y_5 | 0.3395 (htf_1h_range_pctile) | 0/22 |
| Y_15 | 0.0776 (vwap_dist_sigma) | 0/22 |
| Y_30 *(primary)* | 0.1310 (competing_liquidity_atr) | 0/22 |
| Y_60 | 0.0495 (vwap_dist_sigma) | 1/22 |

### The Y_60 nominal result

vwap_dist_sigma at Y_60 produced one nominal unadjusted p < 0.05 (p = 0.04945). Y_60 was SECONDARY; Y_30 was the frozen PRIMARY horizon; 22 Y_60 relationships were examined descriptively; no second multiplicity-controlled family was declared. The result does NOT promote the feature. Re-running V2 with Y_60 as primary would be post-result horizon selection and is prohibited.

## 5. Landmark analysis — EXPLORATORY ONLY

The landmark analysis contained a small negative association between already-completed reclaim/displacement and remaining forward return, directionally consistent with hypothesis A. However, effect sizes were tiny (|rho| <= 0.047), the landmark comparisons were secondary, and the 24 comparisons were not multiplicity-controlled. Therefore this pattern is exploratory and does not distinguish A from B or C reliably.

| landmark | reclaim_magnitude_atr β | p (descriptive) | ρ |
|---|---|---|---|
| +5m | -0.04269 | 0.0114 | -0.0427 |
| +10m | -0.03309 | 0.0351 | -0.0331 |
| +15m | -0.04736 | 0.0011 | -0.0474 |
| +30m | -0.03334 | 0.0115 | -0.0333 |

## 6. Descriptive outcome record

Event-study description, **not** strategy metrics.

| | median | mean | IQR |
|---|---|---|---|
| Y_5 (ATR) | +0.0147 | -0.0063 | [-0.466, +0.490] |
| Y_15 (ATR) | +0.0131 | -0.0291 | [-0.776, +0.818] |
| Y_30 (ATR) | +0.0145 | -0.0615 | [-1.131, +1.159] |
| Y_60 (ATR) | +0.0733 | -0.0889 | [-1.637, +1.619] |

MFE_30 median 1.131 ATR vs MAE_30 median 1.147 ATR, both peaking at a median of 15 minutes — symmetric excursion.

Level revisited within 30m: 77.0% · opposing liquidity reached: 65.0% · frozen VWAP reached: 24.7%

Direction split (descriptive context only — direction is not a replacement confirmatory feature, and no post-hoc long/short rules follow from it):

- sell side bullish orientation: 8,151 events, Y_30 median +0.1045, mean -0.0544
- buy side bearish orientation: 8,031 events, Y_30 median -0.0835, mean -0.0687

## 7. Limitations

- CFD proxy, not genuine CME NQ futures
- broker-side volume, so every VWAP-derived feature is proxy-specific
- missing late CME-session coverage: the 'post' session bucket is 100% censored (0/166 eligible) and 'power_hour' is 41% censored
- no genuine NQ replication was attempted
- no validation data inspected
- no pristine historical stress-set data inspected
- no trading strategy metric computed - this is an event study
- conclusions bind the tested architecture and this proxy dataset only

## 8. Reserved data

- `validation_inspected`: **False** — V2_PROXY validation inspections = **0**
- `pristine_stress_set_inspected`: **False** — outcome inspections = **0**

Validation is reserved for a frozen architecture that survives development. V2_PROXY produced none, so opening it now would only create another chance to search for a favourable answer after development failed. The sealed historical stress set likewise has no surviving candidate to test.

## 9. Model-class closure

**CLOSED - NO PROMOTED DEVELOPMENT SIGNAL**

Applies to:

- the frozen V2 liquidity-event definition
- the tested 22-feature family
- the tested primary Y_30 conditional-return target
- the Dukascopy Nasdaq CFD proxy dataset

Prohibited continuations:

- adding indicators to this family
- changing penetration from 0.25 to another value
- changing PIVOT_LEN
- switching the primary horizon to Y_60
- changing Holm family size or alpha
- splitting longs and shorts until something works
- mining validation

Each would continue a search family that has already failed. Any future generation requires a genuinely new economic hypothesis, a protocol preregistered before its outcomes are seen, and the full accumulated research-history count carried forward.

**No V3 is authorized by this closure.** Future target-market research should use genuine CME NQ data rather than continue increasingly elaborate discovery on the CFD proxy.

## 10. Reproduction hashes

| artifact | sha256 |
|---|---|
| protocol | `98acd539839eadd47c5a28c8e48cdbc1c1dd34fe9a3ed620f25c3035db683a1b` |
| feature_spec | `3a93b68832b23cf3cc21d5d1fe75dcb2638cbad295865937de988de765076b0a` |
| feature_engine | `044248030c08d9fb373f316e2b38a3ec299984e218418697121c70e5f32a5556` |
| outcome_engine | `08d94ed722b6a57fbb9dee57a58ce8ff9b8e339ad8aeb7e1d7a2020452bddf93` |
| inference | `ffb03ae14ebeb7d0ec0dae5ed924de7ec4a29a17df5d1d98e809c92e0d9df169` |
| population | `9f7e5e8352c527ce30efed4ab295d791c0f3f765c422bce7099e8178d2a9e57e` |
| events | `4f553ee39b3a96b12e8cca253069f02377b2c03afd9f775d370a70045c7f16a1` |
| winsorization | `087db96cb3f0689b16057fef01668d4540394383128118b7e86602784270f59f` |
| conformance_matrix | `9282983dad3d00b0d3f9064530421dce3b4485f0f6cc4484efcb9a4e47b5cdd7` |
| phase1_runner | `2b18cb49f30fc2a2e8db6a8cefad2382ef74795a377d48857fc191acb62d1680` |
