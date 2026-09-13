# V3 — MODEL CLASS JUSTIFICATION (PRE-OUTCOME)

**No V3 performance outcome has been computed. No validation or stress-set data
has been opened. V1 and V2_PROXY remain CLOSED.**

This document exists to decide whether a defensible V3 program should exist at
all. It does not authorize one.

---

## 0. Research history carried forward (units kept separate)

**V1** — verified-minimum performance-inspected configurations **50** ·
additional historical searches **~70, claimed, not independently auditable** ·
formal hypothesis families **6** (H1–H6) · baseline reference **1**

**V2_PROXY** — primary hypotheses inspected **22** · promoted **0** ·
secondary-horizon relationships inspected **66** · landmark relationships
inspected **19** · validation inspections **0** · pristine stress-set
inspections **0**

No grand total is computed; these are different units. Every future V3 test
appends to `RESEARCH_LEDGER.jsonl`.

---

## 1. The binding constraint is data, not ideas

The genuine-NQ audit (`V3_NQ_DATA_INVENTORY.json`, computed not inferred) found:

| resolution | genuine NQ coverage |
|---|---|
| 1-minute | **7 CME trade days** |
| 5-minute | **51 CME trade days** |
| 15-minute | 51 CME trade days |
| 1-hour | 618 CME trade days (~2.4 y) |
| daily | 2,514 trade days (~10 y) |

Every file is **front-month continuous with an undocumented Yahoo-internal
roll**: no contract column, no expiry, no roll log, unverifiable back-adjustment
status. The 1-hour series carries close-to-open jumps to 296 bps against a
0.2 bps median; the two largest sit on quarterly roll boundaries, others are
news gaps, and **the two cannot be separated without contract identity**.

**Therefore: no multi-year genuine-NQ intraday study is currently possible, for
any model class.** Data acquisition is the gate. A model class must be chosen
with its data requirement in view, not the reverse.

---

## 2. Candidate model classes (exactly three)

### A. Order-flow / auction imbalance

- **(A) Mechanism.** Aggressive market orders consume resting depth and move
  price. Part of that move is compensation to liquidity providers for inventory
  risk and reverts; part is information and persists. The decomposition is
  observable only in the transaction record.
- **(B) Why NQ.** NQ is one of the deepest electronic futures books with a
  centralized CME tape, so aggressor side and size are recorded exactly rather
  than inferred.
- **(C) Different from V1/V2.** V1 and V2 both read **price geometry** —
  where price sits relative to a level. This reads **who transacted, in what
  size, against which side**. It does not use liquidity levels at all.
- **(D) Falsifiable prediction.** Signed aggressive-volume imbalance over a
  short window carries no incremental information about the next interval's
  return once past returns and volatility are controlled.
- **(E) Data required.** CME GLBX MBP-1 or trades with aggressor side, multi-year,
  contract-level. **Not obtainable from any file in this project.** Billable.
- **(F) Failed assumptions it does NOT inherit.** No liquidity-level universe,
  no sweep definition, no pivot construction, no session-extremum levels, no
  VWAP anchoring.
- **(G) Stop condition.** Stop if tick data cannot be acquired at contract level
  for ≥3 years, or if the imbalance signal adds nothing beyond a
  past-return/volatility baseline.
- **Overfitting risk.** *Moderate.* Few natural degrees of freedom (window
  length, normalization), but this is heavily-studied territory — anything
  surviving at 1-minute-plus resolution is likely already arbitraged.

### B. Volatility / liquidity state transition — **distributional, not directional**

- **(A) Mechanism.** Volatility arrives in clusters. Periods of compressed
  range and thin participation resolve into expansion, and the *timing* of that
  transition is partly conditioned on observable state (time of day, prior
  compression duration, overnight range, session phase). The claim is about the
  **second moment**, not direction.
- **(B) Why NQ.** NQ has a pronounced, mechanically-driven intraday volatility
  seasonality — overnight thinness, the 09:30 ET cash open, macro releases at
  08:30/10:00 ET, the close — which makes compression→expansion a real, dated
  phenomenon rather than a pattern read into noise.
- **(C) Different from V1/V2.** The **outcome changes**. V1 and V2 both asked
  "which way will price go" (direction-normalized return). This asks **"how much
  will price move"** — future realized variance / range expansion. A model class
  can be right here while saying nothing about direction.
- **(D) Falsifiable prediction.** Conditional on a predeclared compression
  state, future realized variance over the predeclared horizon does **not**
  differ from a HAR-RV / EWMA baseline prediction for the same timestamp.
- **(E) Data required.** OHLCV at 1m or 5m, multi-year, contract-level
  preferred. **The cheapest of the three** — no aggressor side, no second
  instrument. Still requires genuine NQ we do not yet have.
- **(F) Failed assumptions it does NOT inherit.** No levels, no sweeps, no
  reclaim, no PO3, no directional claim whatsoever.
- **(G) Stop condition.** Stop if the state adds no information beyond HAR-RV,
  or if the incremental R² is too small to matter, or if the effect lives in one
  narrow period.
- **Overfitting risk.** *Low-to-moderate.* The baseline is the defence: beating
  zero is trivial, beating HAR-RV is not, and HAR-RV is frozen and
  parameter-light.
- **Honest limitation, stated before any work:** *variance prediction is not
  P&L.* Knowing NQ will move more does not say which way. Monetizing it needs
  options, or a directional overlay that would be a separate research
  generation. This candidate is the most scientifically defensible and the least
  directly tradeable.

### C. Cross-market lead/lag (NQ vs ES)

- **(A) Mechanism.** NQ and ES share macro factors but differ in sector
  composition. Index arbitrage enforces a relationship; transient divergences
  reflect either a differing information set or temporary liquidity imbalance,
  and the latter mean-reverts.
- **(B) Why NQ.** NQ is tech-concentrated and ES is broad, so the spread has
  genuine economic content rather than being a pure duplicate.
- **(C) Different from V1/V2.** Uses a **second instrument** and a relative-value
  state; V1/V2 were strictly single-instrument geometry.
- **(D) Falsifiable prediction.** The NQ–ES divergence state carries no
  incremental information about NQ's next-interval return beyond NQ's own past
  returns.
- **(E) Data required.** Synchronized contract-level NQ **and** ES — two
  datasets, two roll constructions, doubled cost and doubled roll risk. Existing
  ES/NQ 1h files are 99.9% timestamp-synchronized but both are continuous and
  unrolled.
- **(F) Failed assumptions it does NOT inherit.** No levels, no sweeps, no
  session extremes.
- **(G) Stop condition.** Stop if the relationship is not estimable out of
  sample, or if divergences do not survive realistic spread costs on two legs.
- **Overfitting risk.** **High.** Two instruments multiply researcher degrees of
  freedom (hedge ratio, estimation window, divergence threshold, which leg
  leads). The relationship is also the single most heavily arbitraged one in
  equity futures — at 1-minute-plus resolution most of it is gone by
  construction.

---

## 3. Side-by-side against the failed families

| | V1 | V2_PROXY | A order flow | B vol state | C cross-market |
|---|---|---|---|---|---|
| Trigger | liquidity sweep | liquidity sweep | aggressive flow | compression state | relative divergence |
| Reads | price geometry | price geometry | transaction record | dispersion of returns | two instruments |
| Outcome | directional P&L | directional return | directional return | **variance / range** | directional return |
| Needs levels | yes | yes | **no** | **no** | **no** |
| Data available now | — | — | **no** | **no** | **no** |

---

## 4. Ranked recommendation

**1st — B (volatility / liquidity state transition).** It is the only candidate
whose data requirement is plain OHLCV; it changes the *outcome type*, so it
cannot be a disguised continuation of a directional family that already failed
twice; and it has a real frozen baseline (HAR-RV) that makes self-deception
hard. Its weakness is stated openly above: it does not directly produce trades.

**2nd — A (order flow).** The strongest mechanism of the three and the cleanest
break from price geometry, but it needs multi-year contract-level tick data that
must be purchased, and it competes directly with the best-resourced participants
in the market.

**3rd — C (cross-market).** Most degrees of freedom, most arbitraged, double the
data cost and double the roll risk. Recommended only if A and B are both
unavailable, which would itself be a reason to stop.

**Overriding recommendation: do not select any of them yet.** All three are
blocked on the same gate — genuine contract-level NQ history. Choosing a model
class before knowing which data can be obtained would let data availability
retroactively justify a hypothesis, which is the failure mode this whole
protocol exists to prevent.

---

## 5. Draft V3 primary question (candidate B, if authorized)

> Conditional on a causally observable intraday compression state in genuine
> CME NQ futures, does realized variance over the next predeclared horizon
> differ in a stable way from the prediction of a frozen HAR-RV baseline for the
> same timestamp?

**Primary outcome (proposed, to be frozen before results):** realized variance
over the next 30 minutes, computed from closed 1-minute log returns,
log-transformed for regression. *Not* a direction-normalized return — V3 must
not inherit Y_30 merely because V2 used it.

**Observational unit (proposed):** one non-overlapping 30-minute interval per
evaluation timestamp, clustered on **CME trade date**. Overlapping windows are
forbidden; if a compression state spans several intervals, one observation per
episode with deduplication frozen before outcomes.

**Feature budget (proposed):** **≤ 10** explanatory variables, each with
economic role, exact formula, availability timestamp, missingness rule,
normalization and a predeclared (or explicitly two-sided) expected sign.

**Baselines (proposed, all frozen before results):**
1. unconditional realized variance;
2. time-of-day seasonal mean (NQ variance is strongly dated);
3. **HAR-RV** (daily/weekly/monthly realized-variance components);
4. EWMA / one-lag autoregressive variance.

A candidate earns continuation only by adding stable information **beyond
baseline 3**, not beyond zero.

---

## 6. Prior observations that must NOT be treated as fresh evidence

These are contaminated by prior inspection. They may be cited as research
history; they can never serve as independent confirmation. If a V3 hypothesis
overlaps any of them, the overlap must be disclosed explicitly at
preregistration.

1. The **Y_60 nominal result** — `vwap_dist_sigma`, unadjusted p = 0.04945.
2. The **exploratory landmark associations** — `reclaim_magnitude_atr_by_L` and
   `distance_travelled_atr_by_L`, 19 uncontrolled comparisons.
3. **Any single V2 subperiod effect** for any of the 22 features.
4. **Any V1 pivot/tier/anchor/HTF result** from H1–H6.
5. **Weekly-open distance**, which looked favourable at one point in V1.
6. Any feature previously described as "almost significant" or "close to
   threshold" in either generation.
7. The **V2 descriptive outcome rates** (level-revisit 77.0%, opposing-liquidity
   65.0%, VWAP 24.7%) — already outcome-exposed.

Note also that candidate B's compression concept **overlaps** V2's
`range_compression`, `htf_15m_compression`, `atr_percentile` and
`realized_vol_state` features as *inputs*. Those were inspected against a
**directional** outcome and all failed. Using compression against a **variance**
outcome is a different hypothesis, but the overlap is real and is disclosed here
rather than discovered later.

---

## 7. Verdict

A genuinely new V3 program is **defensible in principle** — candidate B is a
real change of model class, not a re-parameterization. It is **not currently
executable**: the genuine NQ intraday history required does not exist in this
project, and the existing continuous files cannot support contract-level
research.

**No V3 model class is selected. No V3 hypothesis is preregistered. No V3
outcome may be computed until genuine data is acquired and passes a formal
quality gate.**
