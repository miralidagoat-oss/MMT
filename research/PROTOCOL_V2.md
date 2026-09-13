# V2 research protocol — event study before strategy

**Status: FROZEN before any V2 result is examined.**
Supersedes nothing. `PROTOCOL.md` v1.3c remains in force for data, partitions,
costs, uncertainty and failure criteria. This document governs only what V2 does
differently.

---

## 0. Research history — carried forward, NEVER reset

V1's failure is evidence and is part of the multiple-comparison burden. The
count does not restart because the model class changed.

| Generation | Configurations / hypotheses examined |
|---|---|
| Pre-V1 (1H selection, cross-market scan) | ~38 configurations |
| V1 5-minute repair attempts (pre-basis) | 18 configurations |
| V1 improvement ideas rejected | 9 |
| V1 H1–H6 on the accepted basis | 1 baseline + 24 (H1) + 5 (H2) + 4 (H3) + 6 (H4) + 5 (H5) + 4 (H6) = **49** |
| **Running total entering V2** | **~114** |

Every V2 result is interpreted against that total. A nominal p = 0.01 found
after 114 prior examinations is not a discovery.

**V1 conclusion, quoted exactly and not to be widened:**

> The tested V1 PO3 + VWAP + liquidity-sweep architecture did not demonstrate a
> statistically or economically defensible 5-minute NQ edge under the frozen
> methodology.

Explicitly NOT concluded: that PO3 never works, that liquidity sweeps carry no
predictive information, that multi-timeframe information never works, or that
displacement is universally harmful. Those exceed the experiment.

---

## 1. The workflow is reversed

V1 asked *what entry rule should we trade?* and measured whether it profited.
V2 asks first:

> **What information exists after a liquidity event?**

and only then, if the answer is non-empty:

> What entry rule should we trade?

**The first V2 question is not profit factor.** It is whether a stable
conditional difference exists in the forward path of price after a liquidity
event. If no such difference exists, V2 stops. A strategy is not constructed
from noise to have something to show.

---

## 2. Phase 1 — causal event study

For every qualifying liquidity event, record market state **at the exact moment
the event becomes known**, never earlier. No PO3 requirement, no displacement
requirement, no HTF agreement, no trade entry.

An event is a penetration of a candidate liquidity level. Reclaim is **recorded
as an outcome, not required as a filter** — requiring it presupposes V1's answer.

### Features (continuous wherever possible)

Liquidity: type · age · prior touch count · penetration distance · penetration /
ATR · wick characteristics · close-back distance · reclaim latency.

Location: distance from VWAP · distance from VWAP in σ · VWAP slope · distance
from session open · distance from weekly open · distance from overnight high/low
· local structural location · session location · time of day.

Volatility: realized volatility · ATR percentile · local range compression ·
HTF volatility/regime variables.

Direction is recorded and long/short are analysed **separately** (§6).

**Feature discipline.** No dozens of arbitrary technical indicators. Every
feature must have a stated plausible relationship to auction or liquidity
behaviour, written down before it is computed. Adding a feature after seeing
results is a new hypothesis and increments the history count in §0.

---

## 3. Outcome paths, not win/loss labels

Do not assign win/loss. Measure what price actually did.

**Predeclared horizons — fixed now, never chosen after seeing which looks best:**
**5, 10, 15, 30, 60 minutes.**

At each horizon record: maximum favourable excursion · maximum adverse excursion
· net forward return · MFE/ATR · MAE/ATR · time to MFE · time to MAE · whether
opposing liquidity was reached · whether VWAP was reached · whether the swept
level was revisited.

Reporting a horizon not on this list, or adding one later, is a protocol
amendment and is logged as such.

---

## 4. Carried-forward questions from V1

These are hypotheses, not conclusions. V1's results motivate them; they do not
answer them.

### V2-A — confirmation latency (from H4)

V1 found displacement confirmation carried a **negative** gradient, consistent
across all three sweep-depth terciles. Two incompatible explanations remain
open, and V1 cannot distinguish them:

- **A.** Displacement itself carries negative information.
- **B.** Waiting for displacement simply enters too late, and the information
  decays with confirmation latency.

> **V2-A:** Some of the predictive information in a liquidity event decays as
> confirmation latency increases.

Test expectancy as a function of: time since sweep · time since reclaim · bars
since event · distance travelled before entry. This must **not** be shortcut
into "trade without confirmation" — that is assuming B.

### V2-B — HTF state, not HTF agreement (from H6)

H6 rejected directional agreement as a permission filter. That says nothing
about HTF **context**. V2 may test 1H volatility regime · 1H distance from major
reference · 1H range percentile · 1H extension from fair value · 15m
compression/expansion state.

**Prohibited:** any rule of the form `5m long == 15m bullish == 1H bullish`. The
directional-confirmation architecture is rejected and must not be quietly
reintroduced under a new name.

### V2-C — dynamic vs static liquidity (from H5)

Named T1 levels failed the tier test while the pivot component carried most of
V1's activity. This does **not** establish that the 5-bar fractal is good.

> **V2-C:** Local dynamically formed liquidity carries more information on
> 5-minute NQ than static textbook levels.

Characterise dynamic levels by continuous properties — age · touch count ·
prominence · distance from surrounding structure · ATR-normalised separation ·
volume/time formed · equal-high/low clustering — rather than hardcoding one
arbitrary fractal width as the answer.

### V2-D — weekly open is EXPLORATORY ONLY

V1 observed the pre-existing weekly-open variant stayed positive while the three
sanctioned anchors were negative. It was **already in the research history**, so
it cannot be treated as an independent discovery and must not be optimised
around. If multi-day anchoring is tested, predeclare the general form:

> Multi-day reference location carries incremental information beyond intraday
> session anchoring.

and compare a **small predetermined family** on development data only.

---

## 5. Continuous features before boolean filters

V1 leaned on yes/no sweep, yes/no reclaim, yes/no displacement, yes/no HTF
agreement, discarding magnitude at every step. V2 preserves information:

| Use | Not |
|---|---|
| `penetration = 0.36 ATR` | `deep_sweep = true` |
| `vwap_distance = -1.42σ` | `below_vwap = true` |
| `reclaim_latency = 17 min` | `reclaimed_within_n = true` |

Discretisation is permitted only **after** evidence of a stable threshold, and
the evidence is shown.

---

## 6. Long and short are analysed separately

No symmetric coefficients or thresholds are imposed. Asymmetry may **not** be
claimed without sufficient observations in both directions; the minimum is
declared before the split is examined, and MDE is computed per side.

---

## 7. Model complexity is earned, not assumed

Begin with interpretable statistics: conditional expectancy tables · monotonic
binning · univariate effect plots · regularised linear/logistic models.

Nonlinear models are permitted only when compared against these baselines and
shown to beat them out of sample. No large neural networks, no massive
gradient-boosted searches, no hundreds of engineered features — each multiplies
researcher degrees of freedom far faster than it adds insight.

---

## 8. Data access — unchanged and absolute

Development · validation · walk-forward **only**.

**The final holdout (2018-05-31 .. 2022-09-08, 1,106 trade days) remains
SEALED with one use remaining.** It is opened only after a single V2
architecture is frozen and has survived development, validation **and**
walk-forward. A negative result never justifies opening it, and neither does a
positive one that has not been frozen first.

Guards from v1.3c stay in force: `partitions.guard()` refuses the holdout unless
`MMT_SPEND_HOLDOUT=yes` is set deliberately, and whole-basis runs require
`MMT_WHOLE_BASIS=yes`. Both refuse before reading anything.

### Outstanding holdout exposure

The v1.3c §12 exposure log records one partial exposure (a pooled mean spanning
the holdout period, from a whole-basis MDE run). It stands as logged. V2 adds no
further exposure.

---

## 9. Defects inherited from V1, to fix before V2 Phase 1 produces numbers

Both were found in the V1 accounting audit and are recorded rather than silently
corrected:

1. **Frequency denominator.** `report_result.summarize()` divides by every trade
   day in the loaded span, warm-up included (706), rather than countable days
   (685). All V1 frequencies are understated by ~3%. Direction of error favours
   no result.
2. **Partition boundary offsets.** `partitions.load()` uses fixed ±6h/+30h
   offsets from UTC midnight instead of a timezone-aware 18:00 ET trade-day
   boundary, leaking one trade day at each edge (685 countable against 683
   declared).

V1's frozen numbers are **not** restated. The fixes apply to V2 onward, and the
V1 artifact carries both columns so the two are comparable.

---

## 10. Walk-forward — specified, never yet run

§4 of `PROTOCOL.md`: 12-month train → 3-month forward test, stepped 3 months,
across development + validation only. That yields **11 windows**, W1 train
2022-09-09→2023-09-09 test →2023-12-09, through W11 train 2025-03-09→2026-03-09
test →2026-06-09. The holdout appears in no window.

**No walk-forward has been run at any point in this project.** V1's H1–H6 were
pooled single-pass runs over development. Walk-forward is a precondition for
spending the holdout and remains outstanding work.
