# A2 SIZE DIAGNOSTIC — RE-RUN WITH THE Z1 RETURN OUTCOME

**Result: the CR1 implementation is SOUND. V2_PROXY and V3-Z1 p-values are validated.**

## The three size checks

| configuration | design | outcome | rows | clusters | rejection rate @ α=0.05 | verdict |
|---|---|---|---|---|---|---|
| **A2** (original) | HAR | `log(r²)` | 7,806 | 367 | **0.1710** | FAIL |
| **A2-R1** | HAR | Z1 return | 7,829 | 368 | **0.0680** | PASS |
| **A2-R2** | **actual Z1** | Z1 return | 7,586 | 360 | **0.0540** | PASS |

All three: 1,000 block permutations, seed 20260914, identical scheme. Pass band [0.025, 0.080].

## What this settles

**A2-R2 is the one that matters.** It is the exact configuration that produced the V3-Z1 null — same features, same baseline, same session coding, same frozen scalers, same clusters. It rejects a true null **5.40%** of the time at a nominal 5%. With 1,000 permutations the Monte-Carlo SE is 0.0069, so that sits **within one SE of nominal**.

**The V3-Z1 p-values were correctly calibrated.** By extension the CR1 machinery used throughout V2_PROXY is sound for the return-outcome setting it was actually used in. The 24 predeclared nulls rest on correctly sized tests.

A2-R1 at 6.8% is also inside the band, though 2.6 SE above nominal — mildly elevated, and worth noting rather than glossing.

## My stated hypothesis was wrong

I attributed the A2 failure to heavy tails in `log(r²)`. **The measurement refutes that:**

| outcome | n | skew | kurtosis | min | max |
|---|---|---|---|---|---|
| `log(r²)` | 7,807 | -0.571 | **3.59** | -23.12 | -5.21 |
| normalized return | 7,829 | -1.021 | **15.61** | -12.54 | +8.28 |

`log(r²)` has kurtosis **3.59**, close to the normal value of 3. The return has kurtosis **15.61** and larger skew. **The return is by far the heavier-tailed of the two — and it is the one that produces correct size.** Tails are not the mechanism.

## What remains unexplained

UNTESTED. log(r^2) carries strong intraday seasonality - variance at the cash open is systematically higher than overnight - and so do the HAR predictors. The block permutation preserves hour-of-session alignment, so permuted X and Y still share that seasonal component. Six coarse session buckets may not absorb all of it, leaving a real shared signal under a nominal null. If so the 17.1% is an artifact of MY A2 design, not of CR1 and not of log(r^2). This is a conjecture; it has not been tested and should not be reported as the cause.

| | |
|---|---|
| settled | the CR1 implementation is not defective |
| **not** settled | why the log(r^2) configuration over-rejects |

Since no Z2 research hypothesis was ever preregistered, nothing depends on resolving this. It matters only if a volatility-outcome experiment is attempted later, and it would have to be resolved first.

