# V3-Z1 PREREGISTRATION — AMENDMENT 01

**Applied 2026-09-14. METHODOLOGY-ONLY, PRE-OUTCOME.**

| flag | value |
|---|---|
| `performance_inspected_before_amendment` | **False** |
| `outcomes_inspected_before_amendment` | **False** |
| `development_run` | **False** |
| `replication_run` | **False** |
| `m` before → after | **3 → 2** |
| removed slot refilled | **no** |

Version 1 is preserved in git history; this file is the audit trail. Nothing is silently rewritten.

## A1 — The redundant hypothesis, removed

The baseline contains `nq_z = z_NQ(t)`. Conditional on it:

```
span{ nq_z , nq_z - z_B }  =  span{ nq_z , z_B }

Y = a + b1*nq_z + c*(nq_z - z_B)
  = a + (b1 + c)*nq_z + (-c)*z_B
```

So the `divergence_1h` model and the `basket_z` model have **identical fitted values, residuals and standard errors** — only the parameterization differs. Measured on a synthetic design matrix (50 clusters):

| quantity | result |
|---|---|
| `beta(basket_z) + beta(divergence_1h)` | `+1.18e-16` — exactly opposite |
| p-values | identical to **14 decimal places** |
| \|t\| | identical |
| `nq_z` coefficient | absorbs exactly the difference |

**The worse consequence.** The preregistered signs were **NEGATIVE** for `divergence_1h` and **POSITIVE** for `basket_z`. Since `beta_basket = -beta_divergence`, those two expectations would have been confirmed or refuted **simultaneously and automatically** — a built-in guaranteed agreement that would have read as two independent hypotheses supporting each other. That is exactly the kind of artifact this protocol exists to prevent, and it was caught before any outcome existed.

`basket_z` status now: **diagnostic-only; a component of the divergence equation; never promotable**. The slot is **not refilled** — m drops to 2 rather than admitting a replacement feature to preserve a number.

## A2 — Multiplicity re-frozen

**Stage 1 (development):** Holm step-down FWER, **m = 2**, alpha = 0.05, family `divergence_1h` and `divergence_session`.

This change occurred **before any performance inspection**, because of algebraic equivalence — not because of an observed result.

## A3 — Tick arithmetic corrected

**Erroneous claim (v1):** *0.03 sigma is about 3 index points, comparable to one tick plus commission*

**Correction:** NQ outright tick size is 0.25 index points at $5 per tick ($20 per index point). 3 index points = 12 NQ ticks = $60 per contract. A realistic round trip of one tick of slippage plus commission is roughly $9-14, so 3 points is several times a round-trip cost, NOT comparable to one. The original statement was factually wrong and made the threshold look like a tight cost-based derivation when it was not.

## A4 — The effect floor is an information threshold, not expectancy

**Retained at 0.03**, in units of: standardized units: change in the sigma-normalized outcome per 1 development-SD of the predictor.

a PREDECLARED MINIMUM STANDARDIZED INFORMATION EFFECT. Below this the conditional association is too small to be worth carrying into a strategy phase at all, so the experiment would end there regardless of statistical significance. Frozen before outcomes and never tuned.

**It is explicitly NOT:** trade expectancy, a profitability claim, a completed transaction-cost calculation, evidence that any strategy would survive costs.

*Orientation only:* for orientation only: with NQ hourly sigma around 0.35% at an index level near 29,000, 0.03 sigma is roughly 3 index points = 12 NQ ticks = about $60 per contract at $20 per index point. This is an ORDER-OF-MAGNITUDE orientation, not a cost model: there is no entry rule, threshold, stop, target, holding period or frequency model, so no expectancy follows.

## A5 — Exact standardization

| aspect | rule |
|---|---|
| what is standardized | the PREDICTOR only |
| y scaling | Y is already sigma-normalized by its own definition and receives NO additional scaling, centering or rescaling |
| predictor scale | z = (X - mean_dev) / sd_dev, sample std |
| estimated from | DEVELOPMENT predictor values ONLY. No outcome is read. Replication and prospective values are never used to fit the scale. |
| centering | True |
| missing handling | missing predictor values are excluded from scale estimation and from the regression; a missing value or a missing scaler transforms to None, never to a substitute |
| degenerate scale | zero or non-finite sd -> scaler is None -> feature NOT TESTABLE |
| frozen for later stages | replication and prospective observations are transformed with the FROZEN development constants, unchanged |

Implementation `z1_panel.fit_scaler / z1_panel.apply_scaler`, proven by `backtest/test_z1_amendment.py section C`. A scaler fitted on development+replication measurably differs from the development-only scaler, so the constraint is real rather than cosmetic.

## A6 — Replication gate strengthened

**Entrants:** ONLY Stage-1 survivors. **Test:** one-sided in the PREREGISTERED direction, alpha = 0.1. **Multiplicity:** if more than one survivor enters Stage 2, Holm within the replication survivor family at alpha = 0.10.

a raw same-sign coefficient is NOT confirmation: an arbitrarily tiny same-sign estimate would pass. A one-sided inferential criterion in the preregistered direction demands the replication estimate be distinguishable from zero in that direction. alpha = 0.10 is chosen because Stage 2 is a confirmatory follow-up on an already-screened hypothesis, where the cost of a false negative is higher than at Stage 1; it is frozen before outcomes and never tuned.

## A7 — Hierarchical error control

```
Stage 1  development   Holm FWER across m = 2, alpha = 0.05
                       + all other development promotion conditions
   |
   v  survivors only
Stage 2  replication    one-sided in the preregistered direction,
                       alpha = 0.10, Holm within the survivor family
```

- a failed development hypothesis may NEVER be revived because it looks good in replication
- no replication result may modify the development model
- m is never reduced after seeing failures
- a secondary relationship is never moved into the primary family
- an untestable feature is reported NOT TESTABLE and never replaced

## A8 — `prev_day_nq_return`, exact

**Definition:** OPEN-TO-CLOSE return of the IMMEDIATELY preceding eligible CME trade date

```
ln(close of that date's LAST panel bar / open of its FIRST panel bar)
```

**Availability:** that session closes 17:00 ET, before the current session opens 18:00 ET, so it is fully available at every hour of the current trade date

**MISSING when:** the predecessor is roll-excluded; the predecessor is absent from the panel; there is no predecessor; either endpoint price is non-positive.

**Never:** uses the current incomplete trade date; bridges the roll-exclusion window; computes a multi-day return and calls it previous-day; walks backward until a convenient valid day appears; uses a Yahoo daily close unavailable at event time.

**Guarantee:** the function contains NO loop, so it cannot walk backward.

## A9 — Prospective accumulation

126 ELIGIBLE CME trade dates. Calendar time after the freeze is NOT the requirement. A date counts only if all its bars are after the freeze instant, it is not roll-excluded (the September window may overlap the start of collection), and it is not partial (>= 20 of the 23 modal rows). Roll-excluded, missing and partial dates count for NOTHING.

## Session reset, gap rule, outcome timing — confirmed

**Max admissible separation for an hourly return: 7200s.**

| case | treatment |
|---|---|
| adjacent 1h | ADMITTED |
| maintenance break 2h | ADMITTED |
| 3h hole | REJECTED |
| weekend 49h | REJECTED |
| holiday 73h | REJECTED |
| roll-excluded interval | the dates are removed from the sample entirely |
| missing-bar gap | REJECTED |

a multi-hour or multi-day price change is NEVER computed and labelled an hourly return; invalid gap returns are OMITTED from the volatility history, not fabricated.

**`divergence_session`** resets at the start of every CME trade date, carries no state across dates, bridges neither a roll-excluded period nor a missing session, and uses only eligible divergence observations available through t.

**Primary outcome timeline:**

1. bar t opens
2. bar t closes at ts(t)+3600
3. all feature inputs for t become available (they use only bars closed <= t)
4. the prediction is considered formed at the close of bar t
5. bar t+1 evolves
6. bar t+1 closes
7. Y(t) becomes observable

mutating C(t+1) moves Y and leaves every feature at t bit-identical; proven in backtest/test_z1_causality.py section D.

| boundary | outcome |
|---|---|
| maintenance break | CENSORED - t+1 is not the genuine next hour |
| weekend | CENSORED |
| holiday | CENSORED |
| roll exclusion | the observation is removed from the sample |
| missing t+1 bar | CENSORED |
| final row | CENSORED, never extrapolated |

## Strategy layer stays separate

A successful Z1 effect would **not** establish: 5-minute profitability, entry threshold, stop, target, position sizing, trade frequency, transaction-cost-adjusted expectancy.

