# NQ 5-minute research protocol — v1.3b, FROZEN 2026-09-12

Supersedes v1.0. Declared **before** the multi-year NQ dataset exists and before
any paid data request. No strategy result was produced while writing this
revision. Changes require a new version, a dated changelog entry, and a
statement of what had already been seen.

## 0. Research history — carried forward, never reset

| Category | Already examined |
|---|---|
| 5m configurations | ~38 (18 repair attempts, 14 ablations, 6 frontier variants) |
| Model architectures | 1 |
| Session variants | 4 |
| Exit variants | ~12 (breakeven grid) |
| Timeframes surveyed | 7 |

**This count does not reset when new data arrives.** Every future result is
reported against this prior search history.

---

## 1. THE FINAL HOLDOUT GETS EXACTLY ONE USE

H1–H6 are developed, falsified, compared, selected, combined and rejected using
**only** development data, validation data, and the walk-forward procedure.

The holdout may **not** decide: whether any hypothesis works; which liquidity
hierarchy is best; whether displacement is included; which HTF combination wins;
any parameter value; any session rule.

**Sequence:**

1. **Development** → build and falsify hypotheses.
2. **Validation** → select architecture and parameters.
3. **Walk-forward on development + validation** → robustness confirmation.
4. **FREEZE** — all logic, parameters, session definitions, cost assumptions,
   entry rules, exit rules, HTF logic, roll handling. Recorded as a git commit
   SHA plus a SHA-256 of the frozen config. Nothing may change after this.
5. **Holdout run ONCE.**

**If the holdout fails, that is the reported result.** The system is not
repaired against it. Any further work is a **new research generation** requiring
genuinely new future data, or it is explicitly labelled contaminated. The
holdout may never again be described as untouched once opened.

---

## 2. Instrument, timeframe, objective

- **Primary statistical basis:** Dukascopy `USATECHIDXUSD`, a CFD on the
  Nasdaq-100 cash index, 2018-01-01 .. 2026-09-01, 1-minute aggregated to
  5-minute. ~8.7 years. See §12 for what this basis may and may not be used to
  claim. Adopted in v1.3 only after every NQ route was exhausted (§9b).
- **Corroboration set:** CME NQ, real exchange volume, via Yahoo `NQ=F` —
  5-minute (~72 days) and 1-hour (~2.4 years). The actual traded instrument.
  **Never used for parameter selection.** Roll per `ROLL_POLICY.md` v1.3, which
  continues to govern any NQ contract data; the CFD basis has no roll and the
  policy does not apply to it.
- **Execution:** 5-minute, aggregated deterministically from 1-minute
- **Primary metric:** expectancy in R per trade with **multi-scale block-bootstrap** CI (§7)
- **Secondary:** PF, win rate, trades/session, max drawdown in R, day-level stats, long/short, session split

---

## 3. TRANSACTION COSTS — unambiguous, in dollars

**NQ contract facts:** tick = 0.25 index points · tick value = **$5.00** ·
point value = **$20.00** per contract.

### HEADLINE ("realistic") — every headline number uses this

| Component | Per side | Round trip |
|---|---|---|
| Broker commission | $1.00 | $2.00 |
| Exchange + clearing + regulatory fees | $1.00 | $2.00 |
| **TOTAL FEES** | **$2.00** | **$4.00 ROUND TRIP** |
| Entry slippage (1 tick) | — | $5.00 |
| Exit slippage (1 tick) | — | $5.00 |
| **TOTAL HEADLINE ROUND-TRIP FRICTION** | | **$14.00 per NQ contract** |

The $4.00 fee figure is **round trip, not per side.**

| Scenario | Fees (RT) | Slippage | **Total RT friction** |
|---|---|---|---|
| Optimistic | $4.00 | 0 ticks | **$4.00** |
| **Realistic (headline)** | **$4.00** | **1 tick each side** | **$14.00** |
| Stressed | $4.00 | 2 ticks each side | **$24.00** |

### Application order — dollars first, then R

```
friction_$      = fees_$ + entry_slip_ticks*5 + exit_slip_ticks*5   (per contract)
initial_risk_$  = initial_stop_distance_points * 20                 (per contract)
net_R           = gross_R - friction_$ / initial_risk_$
```

**A single universal R-cost must NOT be subtracted from every trade.** Stop
distances differ, so identical dollar friction is a different R cost on each
trade. At $14 friction: a 30-point stop ($600) pays 0.023R; a 10-point stop
($200) pays 0.070R — a 3× difference.

**Disclosure:** every result reported in this project *before* v1.1 used the
engine's tick-based approximation (`cost_ticks × tick / risk_points`), which
conflates fees with slippage and does not scale fees by point value. Those
numbers are not directly comparable to anything produced under v1.1.

---

## 4. Partition boundaries — warm-up, purge, embargo

The model carries state: liquidity pools, session levels, VWAP accumulators,
HTF state, structural lookbacks, PO3 state, pool TTL, rolling volatility.
Cutting bars at a timestamp produces missing state or leakage.

- **Warm-up:** 30 calendar days of bars precede each partition, used **solely**
  to initialize causal state. No trade whose **entry bar** falls in warm-up is
  evaluated or counted anywhere.
- **Partition assignment:** a trade belongs to the partition containing its
  **entry bar**. Its exit may use bars beyond the boundary (causally fine).
  **Partitions never share a trade** and no trade is double-counted.
- **Embargo:** **1 full trade day** after each boundary in which no trade may
  enter, so no position straddles the seam.
- **No open position originating in training may generate validation or holdout
  P&L.**
- **No parameter selection may use any information from a later partition.**
- Any feature requiring a longer lookback than the warm-up extends the warm-up,
  not the embargo.

### §4a — the holdout is the UNTOUCHED block, not the latest one

§4 as frozen puts the holdout in the latest 25%. On this basis that window is
**already contaminated**: `data_long/NDX_5m.csv` spans 2022-09-09..2026-09-08
and prior research searched it heavily — eighteen 5m repair configurations, the
tier ablation, the frontier scan, the baseline study. A holdout carved from it
would be development data wearing a holdout label, and every number drawn from
it would overstate what it proves.

The block no run has ever touched is **2018-01-01 .. 2022-09-08**, first fetched
in v1.3. It is therefore the holdout.

| Partition | Range | Days | Use |
|---|---|---|---|
| Development | 2022-09-09 → ~2025-05 | ~2/3 of searched block | free exploration |
| Validation | ~2025-05 → 2026-09-01 | ~1/3 of searched block | predeclared variants only |
| **Holdout** | **2018-01-31 → 2022-09-08** | **~1,140** | **ONE run, after freeze** |

Consequences, all disclosed rather than managed away:

- **The test runs backwards in time.** Parameters are fitted on later data and
  tested on earlier data. This is unconventional. It is stated alongside every
  holdout number, never omitted because the number is favourable.
- The holdout's own first 30 calendar days are warm-up, not evidence: there is
  no earlier data to initialize from, since pre-2018 returns truncated ~14h
  sessions and is excluded by §12.
- The holdout spans COVID and the 2022 bear market — regimes absent from the
  fitting window. A rule that survives it survives something genuinely
  different. A rule that fails it may be failing regime, not logic, and that
  ambiguity is reported rather than resolved in the strategy's favour.
- The forward-looking guarantee of §4 ("no parameter selection may use
  information from a later partition") is inverted here and cannot be claimed.
  What is claimed instead: no selection used information from the holdout,
  because the holdout had never been fetched when the fitting data was searched.

### Partitions (chronological, never shuffled)

| Partition | Share | Use |
|---|---|---|
| Development | earliest 50% | debugging, hypothesis formation, free exploration |
| Validation | next 25% | selecting among predeclared variants only |
| **Final holdout** | latest 25% | **one run, after freeze** |

Walk-forward: 12-month train → 3-month forward test, stepped 3 months, across
**development + validation only**.

**The existing 59-day NQ 5m sample is `recent-regime development evidence`, not
a holdout** — the shipped config has already been run on it with a 60/40 split,
long/short split and 9-bucket session breakdown.

---

## 5. Parameter plateau — applied by parameter type

The principle is a plateau, not a needle. The implementation differs by type.

| Type | Examples | Requirement |
|---|---|---|
| **Continuous** | sweep depth ATR, stop buffer ATR, displacement threshold | Predeclared neighbourhood; require **≥5 contiguous tested values** whose expectancy sits within 1 SE of the chosen one |
| **Small integer** | reclaim window in bars, consecutive closes | Test **n−2, n−1, n, n+1, n+2** where sensible; neighbours must not collapse |
| **Temporal (minutes)** | cooldown, pool TTL, raid duration | Predeclared grid; require a contiguous stable region spanning **at least a 2× ratio** |
| **Categorical** | session anchor, entry style, HTF combination | Rank stability across **≥3 development sub-windows**; the winner must not depend on one window |
| **Liquidity tiers** | T1–T4 inclusion | Ablate by tier; each retained tier must show incremental value in **≥2 of 3** development sub-windows |

**±25% is not applied blindly** and is withdrawn as a universal rule.

---

## 6. Session definitions — frozen before frequency is measured

**PRIMARY FREQUENCY DENOMINATOR — the CME trade day.** 18:00 ET → 17:00 ET, one
per weekday. The frequency target *"2–3+ legitimate opportunities per session"*
means **2–3+ per CME trade day**. Failure floor: **1.0 per trade day**.

**SECONDARY, reported separately: RTH sub-session** 09:30–16:00 ET.

**TIME-OF-DAY ANALYSIS BUCKETS — diagnostic only, never a frequency denominator:**
Overnight 18:00–02:00 · London 02:00–07:00 · NY premarket 07:00–09:30 · NY open
09:30–10:30 · NY morning 10:30–12:00 · Midday 12:00–14:00 · NY afternoon
14:00–15:00 · Power hour 15:00–16:00 · Post 16:00–18:00.

**These definitions are frozen and may not be changed to flatter a trade count.**
Treating each of the 9 buckets as a "session" would imply 20–27 trades/day and is
explicitly forbidden.

---

## 7. Uncertainty at three dependence scales

Day blocks preserve intraday structure but destroy multi-day regime dependence.
All three are computed and reported for every headline result:

1. **Naive trade-level SE** — reported, never the headline.
2. **Day-cluster** — CR1 cluster-robust SE + 1-day block bootstrap.
3. **Multi-day blocks** — moving-block bootstrap at predeclared lengths
   **{5, 10, 20 trading days}**, plus a stationary bootstrap with mean block
   length 5 days.

**Block lengths are predeclared and fixed. The one producing significance is
never selected.** Headline conclusions respect the **most conservative**
dependence-aware interval among them.

---

## 8. MDE is recomputed from the ingested data

The figures below are **planning estimates from 59 days of NQ 5m only** and are
**not binding**:

> planning estimate: MDE ≈ 0.34R ± 0.02R at n=155 / 48 independent days;
> ~557 trading days (~2 years) to detect +0.10R.

Once genuine NQ data is ingested, MDE is recalculated from that dataset's actual
trade variance, independent-day count, observed clustering, serial dependence,
and the planned α/power — and **reported with its assumptions**. If it differs
materially from the planning estimate, **the estimate is updated, not defended**.

---

## 9. More data is not expected to create an edge

The four-year 5m proxy result — **+0.013R, PF 1.02, 95% band [−0.057, +0.083]**
— stays in the research record. The purpose of genuine multi-year NQ data is
**not** to make that significant. It is to determine whether H1–H6 produce a
reproducible improvement surviving genuine NQ data, transaction costs, parameter
perturbation, regime change, walk-forward, and one untouched holdout.

**If the conclusion is that the 5-minute system has no economically meaningful
edge, that is the reported conclusion.** No optimization until one appears.

---

## 9b. Data acquisition is staged, and buys only outrights

> **DORMANT as of v1.3.** The operator has declined to open a paid Databento
> account, so no stage below has been executed and none will be without an
> explicit new decision. The machinery is retained, tested (46 offline
> assertions) and correct; it is unfunded, not withdrawn. The primary basis is
> now the free Dukascopy feed (§12). Nothing in this section has ever been run
> against a live key, and no money has been spent at any point in this research.

A parent request (`NQ.FUT`, `stype_in=parent`) resolves to **every child
instrument**, which for a CME futures root includes **calendar spreads** and
other non-outright instruments. Purchasing seven years of minute bars for that
universe would buy a large volume of spread data this research never reads, and
invalidates any size estimate derived from outright volume.

Acquisition therefore proceeds in stages, and **no paid minute request is priced
until the universe has been filtered**:

| Stage | Action | Cost class |
|---|---|---|
| **A** | Discover outrights: `symbology.resolve` parent→raw_symbol, filter `^NQ[HMUZ]\d{2}$`, verify against `instrument_class == FUTURE` with a one-day definition probe | metadata / negligible |
| **B** | `ohlcv-1d` for those outrights only — daily volume for the roll | negligible |
| **C** | Apply the **frozen** roll policy to build active-contract intervals | local |
| **D** | Plan per-contract minute windows: active interval + 30-day contract-specific warm-up | local |
| **E** | `metadata.get_cost` on exactly that plan, reported per stage, then **stop** | metadata |

`instrument_id` is **not** assumed stable over arbitrary periods. `raw_symbol`
plus point-in-time mappings are the key throughout; any `instrument_id` recorded
is stored with the date range it applied to.

Stage A halts the pipeline if the symbol regex and the exchange's own
`instrument_class` disagree, rather than spending on an unverified universe.

## 10. Predeclared hypotheses

- **H1** Parameter re-normalisation in three categories — temporal → elapsed
  minutes; structural → normalized by ATR / volatility / completed structural
  events, *not* by wall-clock inheritance from the 1H model; storage → split into
  `POOL_TTL_MINUTES` (economic relevance) and `MAX_ACTIVE_POOLS` (resource cap).
- **H2** Multi-bar manipulation event model — stage timestamps recorded (level
  identified → penetration begins → raid extreme → rejection → reclaim →
  optional displacement). The empirical duration distribution is examined
  **before** any candidate window is declared; only coarse economically
  reasonable ranges follow.
- **H3** Session-anchored PO3 + causal accumulation. Exactly **three** anchors:
  Globex trade-day open, NY midnight, 09:30 cash open. No other start times.
- **H4** Displacement — tested **both** as binary permission filter **and** as a
  continuous contribution to setup quality, with marginal value assessed after
  controlling for sweep quality.
- **H5** Liquidity hierarchy ablated **by tier**: T1 PDH/PDL + overnight
  extremes + major session H/L · T2 opening range + equal highs/lows + major
  confirmed structure · T3 significant dynamic swing liquidity · T4 minor local
  pivots. Pivot **occurrence time** and **confirmation time** are recorded
  separately; only confirmation time is usable.
- **H6** Confirmed HTF context: 5m alone / 5m+15m / 5m+1H / 5m+15m+1H. Only
  fully closed HTF bars. **The 1H result (+0.183R) is treated as a hypothesis,
  not established fact** — it emerged from the ~38-configuration search above and
  has not been validated on untouched data.

New ideas require v2.0 and are testable on development data only.

---

## 11. Failure criteria — declared in advance

REJECT if any of: development expectancy improvement < 0 at headline costs; the
improvement does not survive the **most conservative** bootstrap (CI includes 0);
frequency falls below 1.0/trade-day; the type-appropriate plateau test (§5)
fails; sign disagreement with NDX generalization *and* a development CI including
zero; negative at stressed friction ($24 RT).

**INCONCLUSIVE is permitted and expected.** A failed hypothesis is recorded, not
retried with adjusted thresholds.

---

## 12. NDX status — PRIMARY as of v1.3, with claim limits

v1.2 held NDX as a secondary falsification set while multi-year NQ data was
still thought reachable. It is not reachable without payment, which the operator
has declined (§9b). NDX is therefore promoted to the primary statistical basis.
The promotion changes where parameters are fitted. It does **not** change what
may be claimed.

### What the CFD basis is

`USATECHIDXUSD` is a broker CFD on the Nasdaq-100 **cash index**. It is not the
futures contract and is not a substitute for it:

| Property | NQ futures | This basis |
|---|---|---|
| Instrument | exchange-traded contract | broker CFD |
| Roll / basis | quarterly roll, term structure | none - continuous |
| Price side | bid and ask | **BID only** - spread unobservable |
| Volume | exchange contract volume | broker volume (proxy) |
| Session | 23h CME trade day | ~22h, 17:00 ET break present |

Verified before adoption: volume carries the correct intraday profile - peak at
the 10:00 ET cash open, secondary peak at the 03:00 ET London open, trough at
the 18:00 ET reopen, CV 1.20. It is a usable VWAP weight. It is not exchange
volume and is never reported as such.

Full-session coverage begins in 2018. 2015-2017 returns ~14h/day and **must not
be used**: a truncated day silently corrupts every Asia-session and overnight
liquidity-pool feature. 2012-2013 is RTH-only and is excluded for the same
reason. The window is pinned at 2018-01-01 in `fetch_dukascopy.py fetch_range`
and recorded in `data_ndx/PROVENANCE.json` with every empty weekday listed.

### Friction on this basis

The $14 round-trip headline (§3) is an NQ figure in NQ dollars. The E-mini NQ
multiplier is $20 per index point, so the headline translates to **0.70 index
points round trip**, applied in points and then divided by each trade's own
initial point risk - the same dollars-first-then-R order §3 requires. This keeps
R-multiples comparable across the two bases. It does not model CFD spread, which
is unobservable in a bid-only feed and is assumed to be inside the 0.70.

### Tick-grid quantization — binding

The feed quotes to three decimals; observed increments are around **0.002 index
points**. NQ trades on a **0.25** tick. Research is run on a quantized copy
(`quantize_basis.py`, raw files retained untouched) because native precision
manufactures edge three separate ways:

- `min_risk = 2 * tick` becomes 0.004 points instead of 0.50 and stops
  rejecting untradeable stops;
- a sweep is price *exceeding* a level; at 0.002 resolution levels are pierced
  by amounts no NQ order can express, inflating sweep counts against an
  instrument that could never register them;
- stop distances land between ticks, so every R-multiple is computed off risk
  that is unfillable in practice.

Method: round OHLC to the nearest 0.25, then re-derive high and low as the
extremes of the rounded four. Nearest-grid is unbiased; rounding highs down and
lows up would shrink every range and bias sweep detection the other way, which
is not more honest for being conservative. Measured effect at 5m: invariant
repair needed on 0.00% of bars, mean bar range 17.537 -> 17.539 points.

### Claim limits — binding

- Results on this basis may be stated as: *this rule survives across regimes in
  Nasdaq-100 price action.*
- They may **not** be stated as a futures P&L, a dollar return, or an expected
  NQ result. No equity curve from this basis is presented as tradeable.
- Every headline figure names the basis that produced it. A number without a
  named basis is a defect, not a rounding.
- **NQ and NDX trades are never pooled.** NDX power is never reported as NQ
  power.
- Directional disagreement between the two bases is a **failure**, reported as
  such (§11), never averaged away or explained post hoc.

## Changelog

- **1.3b — 2026-09-12** — §4a added after discovering that the window §4
  designates as holdout had already been searched over 18+ configurations by
  prior research. The holdout moves to the never-fetched 2018-01-01..2022-09-08
  block; the test consequently runs backwards in time, which is disclosed with
  every holdout number rather than buried. Operator approved the design. No
  strategy result produced during this revision.
- **1.3a — 2026-09-12** — tick-grid quantization made binding after measuring
  the feed's native precision (~0.002 pts vs NQ's 0.25 tick); engine gained the
  §3 dollar friction model it had never actually implemented, replacing the
  deprecated `cost_ticks x tick` approximation that overcharged the headline by
  43%; MDE script parameterized per §8. Both parity suites pass unchanged. No
  strategy result produced during this revision.
- **1.3 — 2026-09-12** — Databento route closed: the operator declined to open a
  paid account, so no multi-year NQ intraday data is obtainable and the staged
  acquisition of §9b is dormant, not deleted. Dukascopy `USATECHIDXUSD`
  2018-01-01..2026-09-01 promoted to primary statistical basis; real NQ (5m 72d,
  1h 2.4y) demoted to a corroboration set never used for selection. Claim limits
  on the CFD basis made binding, friction translated to 0.70 index points,
  pre-2018 data excluded for truncated sessions. Fetch pinned to explicit dates
  and made to emit provenance including every empty weekday. No strategy result
  produced during this revision.

- **1.2 — 2026-09-12** — acquisition staged A–E so only outright quarterly
  contracts are priced and purchased, spreads excluded; `raw_symbol` rather than
  `instrument_id` as the durable key; warm-up clarified as the incoming
  contract's own pre-roll history, explicitly distinct from cross-contract level
  carryover; dataset manifest required so every bar stays attributable to a real
  CME contract. Calendar roll fallback verified by the operator and no longer
  flagged. No strategy result produced during this revision.
- **1.1 — 2026-09-12** — holdout reduced to a single post-freeze use; calendar
  roll fallback corrected and its uncertainty disclosed; costs made
  dollar-explicit ($14 RT headline) and applied per-trade before R conversion;
  warm-up / purge / embargo defined; plateau rule made type-specific; primary
  frequency denominator frozen as the CME trade day; bootstrap extended to three
  dependence scales; MDE demoted to a non-binding planning estimate. No strategy
  result produced during this revision.
- **1.0 — 2026-09-12** — initial freeze.
