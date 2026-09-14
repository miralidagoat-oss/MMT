# V3-Z2-PC RESULTS — INSTRUMENT CHECK FAILED

**Verdict: `INSTRUMENT CHECK FAILED`** — A1 PASS, A2 FAIL.

First outcome inspected 2026-09-14T17:16:29+00:00 at commit `5f65d88b65ca70ed9ec37f79ae599ea62913c2bb`.

```
performance_inspected = true    outcomes_inspected = true
development_run       = true    data_cost_usd      = 0
prospective_holdout_inspected = false
```

## A1 — sensitivity: **PASS, decisively**

7,806 rows, 367 clusters, rank 9/9, condition number 8.53.

| | β | CR1 se | t |
|---|---|---|---|
| `rv_short` | **+0.44796** | 0.04456 | **+10.05** |
| `rv_day` | +0.29995 | — | +6.25 |
| `rv_week` | +0.29816 | — | +6.65 |

raw p = **3.698e-21** · 95% CI [+0.36033, +0.53558] · joint Wald F = **297.84**, p = **7.779e-98**

| gate | result |
|---|---|
| b_s > 0 | **PASS** |
| |t| ≥ 4.0 | **PASS** |
| Wald p < 1e-4 | **PASS** |
| |b_s| ≥ 0.0698 (MDE) | **PASS** |

**The pipeline detects volatility persistence unambiguously.** All three HAR components are positive with large t. Net of session fixed effects, so this is genuine persistence and not intraday seasonality.

*Second correction to my own estimate:* I predicted an attenuated β of 0.132–0.246. The realised β is **0.448** — my attenuation model was too pessimistic, not too optimistic.

## A2 — specificity / size: **FAIL**

1,000 block permutations, seed 20260914.

| | |
|---|---|
| nominal α | 0.05 |
| rejections | 171 / 1,000 |
| **empirical rejection rate** | **0.1710** |
| pass band | [0.025, 0.08] |
| mean \|t\| under the null | 1.185 |

**The test rejects a true null 17.1% of the time at a nominal 5%** — roughly 3.4× over-rejection. The CR1 p-values in this setting are **anti-conservative**: they are too small.

## What this does and does not license

**Direction of the error matters.** An anti-conservative test is too eager to reject. Every prior result from this machinery was a **null** — a failure to reject. Failing to reject with a test that over-rejects makes those nulls **harder to dismiss, not easier**. The V2_PROXY and V3-Z1 negative conclusions are not weakened by this finding.

**But any future positive would need a much higher bar.** A nominal p = 0.04 from this pipeline does not carry a 5% false-positive rate.

### A specification gap I have to own

The preregistration claimed A2 "directly tests the SIZE of the CR1 p-values used throughout V2_PROXY and V3-Z1." **As implemented it does not.** V2 and V3 used a roughly symmetric normalized-return outcome; A2 measured size under `log(r²)`, which is severely left-skewed (log χ², 1 df — as r → 0 the outcome → −∞). Heavy-tailed errors are a known cause of cluster-robust over-rejection.

So there are two live candidate causes, and this run does not separate them:

1. **A general defect in the CR1 implementation** → V2/V3 p-values are affected.
2. **Outcome-specific behaviour under `log(r²)`'s tails** → V2/V3 p-values are likely fine, and the finding is confined to the Z2 setting.

That gap is mine — the preregistered claim outran what the preregistered procedure could establish. It is recorded rather than quietly narrowed.

## Status of the model class

`Stage B` was deliberately never preregistered, and this result means it must not be. The instrument is not validated, so no research hypothesis should be built on it yet.

## Artifacts

| file | sha256 |
|---|---|
| `research/V3_Z2_PC_RESULTS.json` | `c77689bba382cba1076483630a739c95b174edade031132d8bfacf1c9f64dd2e` |
| `research/V3_Z2_PC_EXECUTION_SPEC.json` | `76dac9d9b182cdb116b1fdafc400a5a176c96185bcc92b85b1f173a818191313` |
| `research/V3_Z2_PC_PREREGISTRATION.json` | `18ac40c84a7dd4d0bcd3aa5497cc1516bb45fb02b02d12878afa9700e79a69ae` |
