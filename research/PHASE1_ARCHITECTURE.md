# MNQ 5-Minute ETH — Phase 1: Research Architecture

**Status:** Phase 1 complete. No strategy has been built or tested yet.
**Date:** 2026-08-23
**Scope:** Data assumptions, session model, structural constraints, feature spec,
candidate families, validation architecture, scoring system.

---

## 0. Headline findings before any strategy exists

Four things were measured from real MNQ data during Phase 1. Each one constrains
the design space *before* a single rule is written, and two of them are severe
enough that they should change what you expect from this project.

| # | Finding | Consequence |
|---|---|---|
| 1 | Only **51 trading days** of MNQ 5m ETH data is obtainable without paid credentials | The requested 60/20/20 + multi-year regime + walk-forward architecture **cannot be executed** on 5m locally. |
| 2 | **Costs kill tight stops.** A 5-pt stop loses 27–55% of R to commission+slippage | Stops below ~15 pts are dead on arrival regardless of signal quality. |
| 3 | **Intrabar ambiguity is severe at 5m.** With a 15-pt stop / 10-pt target, **55% of bars** are large enough to contain both | At tight stops the backtest reports an *assumption*, not a result. |
| 4 | **NQ is not independent validation.** ρ(MNQ, NQ 5m returns) = **0.9985** | Prior work in this repo used NQ as "cross-validation." It is the same series. That evidence must be discounted. |

Findings 2 and 3 intersect to define a **viable design region** that is much
narrower than the objectives assume. That is the single most important output of
Phase 1 and is developed in §3.

---

## 1. Data assumptions

### 1.1 What is actually obtainable

Measured, not assumed — every number below came from a live fetch this session.

| Series | Bars | Trading days | Span | Use |
|---|---|---|---|---|
| MNQ 5m ETH | 13,485 | **51** | ~2.4 months | Primary research series |
| MNQ 1h ETH | 13,737 | 617 | ~2.4 years | HTF context, regime priors |
| MNQ 15m / 30m | 4,518 / 2,261 | 51 | ~2.4 months | HTF context at 5m horizon |
| NQ 5m / 1h | 13,485 / 13,701 | 51 / 617 | same | **Not independent** (§1.4) |

Source: Yahoo Finance chart API (`MNQ=F`), the only intraday futures feed
reachable from this environment without credentials.

**Hard ceiling.** Yahoo caps 5m history at 60 calendar days and returns HTTP 422
for any older window — confirmed by direct request. Databento returns 401
(paid), Stooq is JS-gated, Dukascopy has no Nasdaq instrument at the probed
paths. There is no free path to multi-year 5m futures data.

### 1.2 The gap between what exists and what the programme needs

The research programme in the brief — 60/20/20 splits, rolling walk-forward,
year-by-year regime analysis, bull/bear/high-vol/low-vol partitions — needs
roughly **3–5 years of 5m data (200,000–350,000 bars)**.

We have 13,485 bars. That is **4–7% of the requirement.**

Statistical power, computed explicitly:

```
3 trades/day x 51 days            = 153 trades  -> t = 2.44 on expectancy (OK)
20% final OOS block = 10.2 days   =  ~30 trades -> cannot separate PF 1.5 from PF 0.9
95% CI on a 70% win rate, n=153   = [62.7%, 77.3%]
```

A ~30-trade untouched OOS block is **decoration, not validation**. Reporting a
profit factor from it would be exactly the kind of result-manufacturing the brief
forbids. This is resolved by the two-track architecture in §6, not by pretending
the sample is adequate.

### 1.3 Data quality — three defects that must be handled in code

1. **Null padding.** Yahoo emits a synthetic 24×12 grid per calendar day and
   fills non-traded slots with nulls — **3,423 of 16,908 rows (20%)**. These
   must be dropped, not forward-filled. (`backtest/eth_data.py` drops them.)
2. **Splice and hole artifacts.** Largest bar-to-bar gaps include **+228 pts
   across a 10-minute gap** (2026-07-28 01:15 ET) and a **265-minute data hole**
   on 2026-07-17 (that session has 151 bars vs. the normal 275). Median |gap| is
   0.50 pts, so these are outliers by 400×. MNQ=F is an **unadjusted continuous
   front-month proxy**; quarterly rolls (Mar/Jun/Sep/Dec) splice contracts.
   → **Required:** a gap filter that suppresses signals across any bar-to-bar
   discontinuity beyond a threshold, and session-level rejection of holed days.
3. **Volume is real but time-skewed.** Only 0.3% of real bars have zero volume,
   so volume features are usable — but see §3.3 for why raw thresholds are a trap.

### 1.4 Why NQ cannot serve as cross-validation

Prior work in this repo (`README.md`, v3.1/v3.2) reports "NQ cross-validation"
as independent confirmation of an MNQ edge. Measured this session:

```
corr(MNQ 5m returns, NQ 5m returns) = 0.998546
median |MNQ close - NQ close|       = 0.50 pts
```

MNQ and NQ are the same underlying index at 1/10 contract size. Testing on NQ
after MNQ is **re-testing on the same data**, not out-of-sample validation. It
controls only for tick-size and micro-liquidity differences. All prior
conclusions resting on it should be discounted accordingly.

Genuinely independent-ish cross-instruments would be **ES/MES** (S&P, ρ≈0.9 to
Nasdaq — correlated but a different index) or **YM/MYM**. Those are the correct
cross-validation targets, and they are a Phase 5 task.

### 1.5 Prior negative result — carried forward, not ignored

This repo already tested a liquidity-sweep-rejection family on MNQ across
timeframes. The recorded result:

| TF | trades | WR% | PF | verdict |
|---|---|---|---|---|
| 1H | 87 | 25.3 | **1.35** | tradeable |
| **5m** | **75** | **20.0** | **1.00** | **breakeven pre-costs** |
| 15m | 24 | 16.7 | 0.80 | negative |
| 30m | 16 | 12.5 | 0.57 | negative |

**Family A (liquidity sweep) has already failed once at 5m on this instrument**,
at PF 1.00 *before* costs — which is negative after them. That is a real prior.
It does not prove the family is dead (the test used crypto-derived parameters, a
1:4 RR unsuited to a high-WR objective, and 60 days), but it means Family A must
clear a **higher** bar than an untested family, and re-testing it with new
parameters on the same 60 days is close to guaranteed overfitting.

---

## 2. Session and trading-day model

### 2.1 The ETH session is faithfully represented

Verified against bar counts and ET-hour histograms:

- Globex opens **Sunday 18:00 ET**, closes **Friday 17:00 ET**
- Daily maintenance break **17:00–18:00 ET** (2 stray bars in 13,485 — effectively empty)
- Full session day = 23 h × 12 = **276 bars**; observed median **275**

### 2.2 Trading-day mapping (a correctness issue, not a preference)

The CME session that begins Sunday 18:00 ET belongs to **Monday's** trading day.
Keying features off calendar days silently corrupts:

- previous-day high/low (PDH/PDL)
- overnight high/low
- "trades per day" accounting
- daily loss limits and max-trades-per-day rules

Correct mapping (implemented in `backtest/eth_data.py::session_day`): bars at or
after 18:00 ET roll into the next trading day; Saturday bars fold back to Friday.
Applying it collapses 59 calendar days into **51 trading days** — a 14%
difference that would have inflated any per-day statistic.

### 2.3 Session blocks for time-of-day analysis

Fixed a priori, before seeing any strategy results, so that later block-level
reporting is not a post-hoc carve-up:

| Block | ET window | Median 5m range | Median 5m volume |
|---|---|---|---|
| Globex open | 18:00–20:00 | 21.8 pts | 3,072 |
| Asia | 20:00–02:00 | 24.6 pts | 4,096 |
| London | 02:00–08:00 | 22.8 pts | 3,237 |
| US pre-market | 08:00–09:30 | 28.2 pts | 6,375 |
| **US cash open** | **09:30–11:00** | **74.2 pts** | **45,256** |
| Midday | 11:00–14:00 | 37.0 pts | 16,532 |
| US afternoon | 14:00–16:00 | 30.8 pts | 12,644 |
| Post-close | 16:00–17:00 | 17.8 pts | 2,759 |

The cash open carries **4.2× the range and 16× the volume** of the post-close
block. Section 4.1 explains why this forces per-bucket normalization.

---

## 3. Structural constraints — the viable design region

This section is the core Phase 1 deliverable. It bounds the strategy space using
only measured properties of MNQ 5m, independent of any trading idea.

### 3.1 Contract and cost assumptions

```
MNQ point value   $2.00 / point
Tick              0.25 pt = $0.50
Cost scenarios (round turn, per contract):
  base      $0.85/side commission + 1 tick slippage each way  = $2.70
  moderate  $0.85/side commission + 2 ticks each way          = $3.70
  harsh     $1.25/side commission + 3 ticks each way          = $5.50
```

### 3.2 Constraint 1 — the cost floor

Assume for illustration the brief's own target shape: 70% WR at PF 1.50, which
forces payoff = 0.643 : 1 and gross expectancy **+0.150 R/trade**.

Net expectancy after costs, by stop distance:

| Stop (pts) | $ risk | base | moderate | harsh |
|---|---|---|---|---|
| 5 | 10 | −0.120 | −0.220 | −0.400 |
| 8 | 16 | −0.019 | −0.081 | −0.194 |
| 10 | 20 | +0.015 | −0.035 | −0.125 |
| 15 | 30 | +0.060 | +0.027 | −0.033 |
| 20 | 40 | +0.082 | +0.057 | +0.012 |
| 30 | 60 | +0.105 | +0.088 | +0.058 |
| 40 | 80 | +0.116 | +0.104 | +0.081 |

**Conclusion:** stops under ~10 pts are unviable at any signal quality. Stops
under ~20 pts do not survive the harsh scenario. Any candidate whose logic
implies a sub-15-pt stop is rejected in Phase 1 without being tested.

### 3.3 Constraint 2 — intrabar path ambiguity (the 5-minute trap)

OHLC bars do not reveal the order in which the high and low were made. When a
single bar is large enough to contain **both** the stop and the target, the
recorded outcome is decided by the backtester's tie-breaking rule, not by data.

MNQ 5m median bar range is **26.8 pts**. Fraction of bars that could contain both
levels (target = 0.643 × stop):

| Stop | Target | Span | % of all bars ≥ span | % of 09:30–12:00 ET bars |
|---|---|---|---|---|
| 10 | 6 | 16 | **82.2%** | — |
| 15 | 10 | 25 | **55.0%** | **95.4%** |
| 20 | 13 | 33 | 36.6% | — |
| 25 | 16 | 41 | 24.1% | 79.2% |
| 30 | 19 | 49 | 16.6% | — |
| 40 | 26 | 66 | 8.5% | 45.9% |
| 50 | 32 | 82 | 4.9% | — |
| 60 | 39 | 99 | 2.9% | 17.5% |

This is why 5-minute strategies so often show fake 70% win rates: at a 15-pt stop
during the cash open, **95% of bars are ambiguous**, and an optimistic
tie-breaker credits the target nearly every time.

**Methodological rule adopted for this project:** every candidate is scored twice
— once resolving all ambiguous bars **pessimistically** (stop first) and once
**optimistically** (target first). Only the pessimistic number is used for
go/no-go decisions. The width of the band is itself reported: a candidate whose
pessimistic and optimistic PF differ by more than ~0.3 is flagged as
path-assumption-dominated and treated as unproven.

### 3.4 The resulting viable design region

Intersecting the cost floor (stop ≥ ~20 pts) with the ambiguity ceiling
(span ≥ ~50 pts ⇒ stop ≥ ~30 pts at this payoff):

> **Viable region: stop ≈ 30–60 pts (≈ 1.0–2.0 × 5m ATR(14)), target ≈ 20–40 pts.**
> Median 5m ATR(14) = **28.4 pts**, so this is "one to two ATR," not "tight."

### 3.5 Honest tension with the stated objectives

The objectives ask for **3+ trades/day, ~70% WR, PF 1.50+**. Inside the viable
region these pull against each other:

- Wider stops (needed for cost + path validity) mean **longer holds**, which
  mechanically **reduces independent trades per day**.
- 3 trades/day at 30–60 pt stops means risking **$60–120 per trade, 3× per day**
  — a materially larger account requirement than a tight-stop system implies.
- The 70% WR target is achievable *arithmetically* (it only requires a 0.643
  payoff), but every historical 70%-WR 5m result that uses a sub-20-pt stop is
  more likely a path-assumption artifact than an edge.

**This is not a reason to abandon the project.** It is the honest starting
position: the target combination is not impossible, but it sits in a corner of
the space where measurement error is largest, and it will require wider stops
than most 5-minute systems use. I will report against the targets without
bending the methodology to reach them.

---

## 4. Feature specification

### 4.1 The ETH normalization rule (mandatory)

Measured: median 5m range is **24.0 pts at 03:00 ET** and **67.1 pts at 10:00 ET**
— a **2.8× spread**; volume spans 2,628 to 39,178 — a **15×** spread.

Any flat threshold ("range > 1.5× the 20-bar average", "volume > 2× average")
therefore **routes essentially every signal into the US cash open by
construction**, silently converting an ETH strategy into an RTH strategy. That is
precisely the failure mode the brief warns about in §6.

**Rule:** every volatility and volume feature is normalized against its **own
ET-time-of-day bucket**, using a trailing window of prior trading days only:

```
rvol(t)  = volume(t) / median(volume at same ET minute over previous N trading days)
rrange(t)= range(t)  / median(range  at same ET minute over previous N trading days)
```

Trailing-only, prior-days-only — no lookahead. N is a robustness parameter
(candidates: 10, 15, 20, 30 days).

### 4.2 Feature inventory

Each feature carries its rationale and its leakage-safety note. All are computed
on **confirmed bars only**.

**Volatility / range**
- `atr14`, `atr_pct` — ATR percentile within its ET bucket (trailing)
- `rrange` — ET-normalized bar range
- `body_frac` = |close−open| / range; `upper_wick_frac`, `lower_wick_frac`
- `compression` = ATR(14) / ATR(56), a regime scalar for squeeze→expansion

**Volume**
- `rvol` — ET-normalized relative volume
- `vol_expansion` = volume / volume[1]

**Location / liquidity**
- distance to **PDH/PDL** (session-day mapped, §2.2), in ATR units
- distance to **overnight high/low** (18:00 ET → 09:30 ET, frozen at 09:30)
- distance to **session VWAP**, in ATR units and in σ
- `swept_pdh`, `swept_onh`, etc. — wick pierced level and **closed back inside**
  (close-based confirmation is what makes it non-repainting)

**Structure**
- swing highs/lows via a **confirmed** fractal (n bars each side — note that an
  n-bar-right fractal is only known n bars later; the feature is timestamped at
  confirmation, never backdated)
- `bos` / `mss` — break of structure, displacement strength in ATR units
- FVG presence and size

**Context**
- HTF trend from 15m/30m/1h (§4.3)
- ET minute-of-day, session block, day-of-week
- bars since last signal (for §13 independence)

### 4.3 Higher-timeframe access without leakage

This is the most common source of silent lookahead in Pine. The rule:

> An HTF value may only be consumed by a 5m bar if the HTF bar that produced it
> has **already closed** at that 5m bar's timestamp.

Implementation, both tracks:
- **Pine v6:** `request.security(sym, tf, expr[1], lookahead=barmerge.lookahead_off)`
  — the `[1]` offset plus `lookahead_off` is the combination that guarantees the
  value is from a *closed* HTF bar. Using `lookahead_on`, or omitting `[1]`,
  leaks the forming bar's future.
- **Python:** HTF series are resampled from 5m and **shifted forward by one HTF
  bar** before joining, so a 5m bar at 10:07 sees the 15m bar that closed at
  10:00, never the 10:00–10:15 bar still forming.

Every HTF feature will be accompanied by an explicit statement of which closed
bar supplies it. A leakage unit test (§6.4) enforces this mechanically.

---

## 5. Candidate strategy families and priors

Ordered by prior plausibility for **high-WR, 3/day, 5m ETH MNQ**, with an honest
prior attached to each. Hypothesis-driven, per brief §4 — not a brute-force sweep.

| # | Family | Market hypothesis | Prior | Fits objectives? |
|---|---|---|---|---|
| **B1** | **VWAP mean reversion** | Intraday flow is mean-reverting around session VWAP outside trend regimes; stretched moves at low rvol revert | **Best fit.** High WR + modest payoff is the natural signature of mean reversion. Untested here. | ✅ 70% WR / 0.64 payoff is native to this family |
| **B2** | **Opening-range / overnight-range fade** | ON range extremes drawn from thin liquidity get rejected when RTH volume arrives | Good. Distinct trigger from B1, similar payoff shape | ✅ |
| **C1** | **Compression → expansion breakout** | Low ATR(14)/ATR(56) precedes directional expansion | Plausible but **low WR by nature** (30–45%) | ❌ conflicts with 70% WR; would need PF via payoff |
| **C2** | **Trend continuation on HTF-aligned pullback** | 15m/1h trend + 5m pullback to VWAP/EMA resumes | Moderate. Payoff shape is middling | ⚠️ ~55–60% WR realistic |
| **A1** | **Liquidity sweep + reclaim** | Stop runs beyond PDH/ONH reverse | **Already failed at 5m in this repo (PF 1.00).** Must clear a higher bar | ⚠️ discounted prior |
| **E1** | **MSS after sweep** | Structure shift confirms the reversal | Untested; but adds complexity — brief §21 penalizes this | ⚠️ only if A1/B1 show life |

**Phase 3 order:** B1 → B2 → C2 → (A1 only if B-family motivates it) → C1.
Family B is tested first because its natural payoff shape is the only one that
matches the objectives without contortion.

**Complexity discipline (brief §21):** each family starts as a **2–3 rule
baseline**. A filter is added only if it improves the *pessimistic* score on
data the filter was not chosen on, and each addition is logged with its
incremental effect (brief §32 — one component at a time).

---

## 6. Validation architecture

### 6.1 The problem this must solve

51 trading days cannot support the requested validation. Rather than run a
statistically meaningless 60/20/20 on 5m and present it as rigor, the programme
splits into two tracks with **different epistemic status**.

### 6.2 Track A — local screening (Python, this repo)

- **Data:** MNQ 5m, 51 trading days, 13,485 bars.
- **Purpose:** kill bad ideas cheaply. Measure signal counts, MAE/MFE
  distributions, path-ambiguity exposure, cost sensitivity, time-of-day spread.
- **Status of its output:** **hypothesis screening only.** No claim of
  out-of-sample validity will be made from Track A. A family that fails here is
  dead; a family that passes is *promoted*, not *validated*.
- **Split used:** 34 days screen / 17 days holdout — used **only** as a sanity
  check for catastrophic overfit, never quoted as an OOS result.
- **1h track:** 617 trading days of MNQ 1h is available and *is* enough for
  genuine regime work. It will be used to test whether a family's **premise**
  (e.g. "VWAP deviations revert") holds across 2.4 years and across regimes,
  even though the 5m execution cannot be validated there.

### 6.3 Track B — TradingView validation (the real out-of-sample)

The final Pine script will be built as a **research instrument**, not just a
strategy: explicit `inSampleStart / inSampleEnd / oosStart / oosEnd` date inputs
and an on-chart stats panel, so **you** execute the 60/20/20 protocol on
TradingView's full MNQ 5m ETH history and the untouched block stays untouched by me.

**⚠️ Confirm before Phase 7 — TradingView bar limits.** The strategy tester is
bounded by chart history: roughly 5k bars on Basic, ~10k on Essential/Plus, ~20k
on Premium. At 276 bars/day, **20,000 bars ≈ 72 trading days** — barely more than
Track A. Multi-year 5m backtesting requires **Deep Backtesting** (Premium and
above), which extends the tester beyond the chart limit.

**If you do not have Deep Backtesting, no multi-year 5m validation is possible
on TradingView either**, and the honest ceiling for this project drops to
"promising hypothesis, unvalidated." I need to know your tier (§9).

### 6.4 Anti-cheating controls (brief §3), enforced mechanically

Not a checklist to assert at the end — tests that run on every candidate:

1. **Confirmed-bar gate.** Signals evaluate on `barstate.isconfirmed` only.
2. **HTF leakage test.** Every HTF feature recomputed with a deliberately
   shifted join; if results change materially, a leak exists.
3. **Shift-invariance test.** Re-run with all signals delayed one bar. A strategy
   whose edge evaporates under a 1-bar delay was reading the current bar's close
   as if it were tradeable.
4. **Path-band test** (§3.3). Pessimistic and optimistic fills both reported.
5. **Cost sweep.** base / moderate / harsh, plus the break-even cost level.
6. **Synthetic-null test.** Run the same rules on phase-randomized MNQ series
   preserving the volatility profile. A rule that "works" on surrogate data is
   fitting session structure, not an edge.
7. **Roll/gap guard.** Signals suppressed across splice discontinuities (§1.3).

### 6.5 What gets reported and when

The final untouched OOS block is examined **once**. Per brief §19, if anything
changes after that, a new untouched period is designated and the old one is
retired. This will be stated explicitly in the research log rather than quietly
observed.

---

## 7. Scoring system

Candidates are ranked on a 100-point rubric weighted toward robustness. Weights
are fixed **now**, before any results exist, so they cannot be tuned to favor a
preferred candidate.

| Criterion | Weight | Scoring basis |
|---|---|---|
| OOS profit factor (pessimistic fills) | 18 | 0 at PF ≤ 1.0; full at PF ≥ 1.8 |
| OOS expectancy per trade | 14 | 0 at ≤ 0; full at ≥ +0.15 R net of moderate costs |
| Path-assumption band width (§3.3) | 12 | full if pess/opt PF gap < 0.15; zero if > 0.50 |
| Parameter stability | 10 | fraction of ±2-step neighbours retaining PF > 1.2 |
| Cost robustness | 10 | survives harsh scenario = full |
| Regime robustness | 8 | positive in ≥ 3 of 4 vol/trend regimes |
| Walk-forward consistency | 8 | fraction of forward windows profitable |
| Profit concentration | 6 | PF with top 5 / 10 trades removed |
| Trade frequency | 5 | full at ≥ 3/day; partial credit from 1.5/day |
| Monte Carlo tail | 5 | 95th-pct drawdown within tolerance |
| Complexity penalty | −up to 10 | −2 per rule beyond 4; −3 per extra data source |
| **Win rate** | **4** | full at ≥ 65% — deliberately low weight per brief §28 |

Win rate carries **4 of 100 points**. The brief is explicit that it prefers
65%/1.8PF/robust over 73%/1.4PF/fragile, and the rubric encodes that rather than
merely promising it.

**Promotion gates.** A candidate must clear *all* of: pessimistic OOS PF > 1.15;
net expectancy > 0 under moderate costs; path band < 0.50; ≥ 60% of parameter
neighbours profitable. Failing any one is rejection, not a tuning prompt.

---

## 8. Research log protocol (brief §31)

`research/RESEARCH_LOG.md`, one append-only entry per experiment:

```
ID | date | family | hypothesis | change from parent | params
   | screen result | holdout result | path band | cost sweep
   | retained? | reason
```

Rules: one logical change per entry (§32); every rejection records *why*; any
re-test of a previously rejected configuration must cite the original entry, so
circular re-optimization is visible rather than accidental.

---

## 9. Decisions I need from you

Three of these change what Phase 2 onward can deliver. I can proceed without
answers by taking the stated defaults, but 9.1 and 9.2 materially bound the honest
ceiling of the whole project.

**9.1 — Data.** Free sources cap at 51 trading days of 5m. Options:
   - **(a)** Provide better data: a TradingView 5m ETH CSV export, a Databento /
     FirstRate / Polygon key, or an IBKR/Rithmic dump. **This is the single
     highest-leverage thing you can do** — it converts the project from
     "hypothesis screening" to genuine validation.
   - **(b)** Proceed on 51 days, with every conclusion labelled as provisional
     and the final verdict capped at *PROMISING* or *INSUFFICIENT EVIDENCE* —
     never *ROBUST CANDIDATE*. ← **default if you don't answer**
   - **(c)** Shift the primary research to **15m or 1h**, where 617 trading days
     exist and the prior evidence is stronger, and treat 5m as execution timing.

**9.2 — TradingView tier.** Do you have **Deep Backtesting** (Premium+)? Without
it, Track B is limited to ~72 trading days and no multi-year 5m OOS exists anywhere.

**9.3 — Cost assumptions.** Default: $0.85/side commission, 1-tick slippage base
case. Tell me your actual broker costs if they differ materially.

**9.4 — Risk sizing.** The viable region implies **$60–120 risk per trade**.
Confirm that is acceptable, or tell me your per-trade risk budget and I will
check whether it is compatible with §3.4 at all.

---

## 10. Phase 2 plan (on your go-ahead)

1. Port the ETH-aware feature layer (§4) with the normalization rule and the
   leakage tests of §6.4.
2. Build the **baseline**: a deliberately simple B1 (VWAP-deviation reversion),
   3 rules, stop/target inside the §3.4 viable region.
3. Establish baseline PF / WR / expectancy / DD / frequency **with the
   pessimistic–optimistic band**, not a single number.
4. Report it honestly — including if the baseline is negative, which is a
   genuinely likely outcome and useful information.

No Pine Script until Phase 7, per the brief.
