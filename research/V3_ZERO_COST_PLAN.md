# V3 — ZERO-COST RESEARCH PLAN (PRE-OUTCOME)

**DATA BUDGET = $0.** No purchase, no payment information, no paid API, no
vendor subscription. Every source below was probed live from this environment.

**No V3 performance was computed.** No return relationship, correlation,
p-value, MFE/MAE, win rate or strategy result. Validation and the V2 stress set
remain untouched. V1 and V2_PROXY remain CLOSED.

---

## 1. What $0 actually buys (measured, not recalled)

Yahoo `NQ=F` is **genuine CME E-mini Nasdaq-100 front-month**, free, anonymous,
no registration, no payment details. Its caps are hard limits, measured:

| interval | max range accepted | result | beyond that |
|---|---|---|---|
| 1m | `7d` | 6,243 bars ≈ **10 calendar days** | `30d` → HTTP 422 |
| 5m | `60d` | 13,412 bars ≈ **70 calendar days** | `1y` → HTTP 422 |
| 15m | `60d` | 4,493 bars ≈ 70 days | `1y` → HTTP 422 |
| **1h** | `730d` | 13,734 bars ≈ **618 CME trade days** | `5y` → HTTP 422 |
| **1d** | `10y` | **2,515 bars ≈ 10 years** | `max` coerces to monthly |

Same endpoint, same caps, for **ES=F, YM=F, RTY=F** and **^VIX**.

**Other free routes are closed.** Stooq now serves a proof-of-work JS bot
challenge to programmatic requests. Nasdaq Data Link `CHRIS/CME_NQ1` returns
HTTP 403 (Incapsula) and is daily-only and long frozen. Barchart, FirstRateData,
Portara and EODData all put multi-year intraday NQ behind a paid subscription.

**Provenance resolved as a by-product:** `data_po3/NQ_1d.csv` had no provenance
file and was marked UNKNOWN. It is **confirmed Yahoo `NQ=F`** — 2,510 shared
timestamps against a live 10-year pull, closes identical on 2,510/2,510
(max difference 0.0000), volumes identical on 2,510/2,510.

### The three answers that decide this generation

- **Genuine order-flow data for $0: NO.**
- **Multi-year 1-minute or 5-minute genuine NQ for $0: NO.**
- **Multi-year 1-hour and daily genuine NQ, plus a synchronized ES/YM/RTY/VIX
  panel, for $0: YES.**

**Candidate A (order flow) is therefore BLOCKED and rejected for this
generation — for DATA UNAVAILABILITY, not statistical falsification.** It
remains a valid untested hypothesis. Order flow, delta, bid/ask imbalance,
absorption, depth and aggressive buyer/seller volume will **never** be
manufactured from OHLCV.

### Structural limits that must stay visible

- No free source carries contract identity, expiry or a roll log, so roll gaps
  are **not separable** from news gaps.
- 1h and finer windows are **rolling**: history cannot be recovered backward,
  only accumulated forward from today.
- The honest effective sample at 1h is **618 trade-date clusters**, not 13,734
  bars.

### One genuine advantage the $0 path has over V2_PROXY

Because the intraday window rolls forward, periodic re-fetching accumulates a
**true prospective holdout** — data that did not exist when the hypothesis was
frozen. V2_PROXY could never have this: its "stress set" *preceded* development,
which is why it could only ever show historical generalisation. This is a real
methodological gain, not a consolation.

---

## 2. Discovery timeframe is not execution timeframe

The final goal is unchanged: **a directional 5-minute NQ indicator.** No 1-hour
model is that indicator. The defensible structure is:

    1h / daily DISCOVERY  ->  a causal market STATE
    that state  ->  a FILTER permitting or forbidding 5m directional setups
    the 5m entry logic itself  ->  a SEPARATE, later research generation

A 1-hour state applied to a 5-minute chart is causally sound provided the state
uses only bars closed at or before the 5-minute decision time. What is not
permitted is presenting a 1h finding as though it were a 5m signal.

---

## 3. Three zero-cost candidate model classes

### Z1 — Cross-market relative state (NQ vs the index-futures complex)

- **Mechanism.** NQ, ES, YM and RTY share macro factors but differ in
  composition. When an NQ move is *not* confirmed by the broad complex, it
  reflects concentrated single-sector flow or a transient liquidity imbalance
  rather than a broad repricing, and has a different persistence profile from a
  move the whole complex participates in.
- **Genuinely new?** **Yes — new information, not a new transformation.** V1
  used NQ alone; V2 used a single NDX proxy series. A cross-sectional panel
  introduces data neither generation could see.
- **Falsifiable prediction.** The cross-market confirmation state carries no
  incremental information about NQ's subsequent return or its sign beyond NQ's
  own recent return and volatility state.
- **Data ($0).** NQ/ES/YM/RTY 1h (618 trade days) + daily (≈2,300–2,515 days).
- **Roll advantage.** Computed from *returns* rather than price levels, and with
  roll-week days excluded, a relative state largely cancels the roll gaps that
  contaminate absolute prices — all four contracts roll on the same quarterly
  schedule within days of each other. This is the one design that partly
  neutralises the missing contract identity.
- **Indicator relevance.** **High** — a directional-in-nature hourly state maps
  naturally onto a permit/forbid filter for 5m setups.
- **Overfitting risk.** Moderate: instrument subset, lookback, and divergence
  definition are all degrees of freedom. Must be frozen before outcomes and kept
  to a handful.

### Z2 — Volatility regime / expansion state (NQ OHLCV only)

- **Mechanism.** Volatility clusters; compressed, thin regimes resolve into
  expansion on a partly dated intraday and daily schedule.
- **Genuinely new?** **Yes — it changes the outcome type** from directional
  return to a second moment.
- **Falsifiable prediction.** Conditional on a predeclared compression state,
  future realized variance does not differ from a frozen **HAR-RV** baseline.
- **Data ($0).** NQ 1h and daily.
- **Indicator relevance.** **Medium** — a regime filter governing *when*
  directional trading is permitted; it never supplies direction itself.
- **Overfitting risk.** **Lowest of the three** — HAR-RV is a hard,
  parameter-light baseline, and beating it is a real bar.
- **Disclosed overlap.** Compression inputs overlap V2's `range_compression`,
  `htf_15m_compression`, `atr_percentile` and `realized_vol_state`, which failed
  against a *directional* outcome. Against a variance outcome it is a different
  hypothesis, but the overlap is real.

### Z3 — Overnight information arrival and the cash-session open

- **Mechanism.** NQ trades nearly 24 hours, but capital reprices discretely: the
  overnight session accumulates global information in thin liquidity, and the
  09:30 ET cash open is when the deepest pool reprices against it.
- **Genuinely new?** **Weakest of the three.** V1 carried `midnight` and `cash`
  PO3 anchors; V2 carried `dist_overnight_high_atr`, `dist_overnight_low_atr`
  and `session_location`, all tested directionally and all failed. This is close
  to a continuation of an already-searched family and is **disclosed as such**.
- **Falsifiable prediction.** Overnight repricing magnitude carries no
  incremental information about cash-session continuation or reversal.
- **Data ($0).** NQ 1h — but 1h gives only ~6–7 overnight bars per day and one
  observation per trade day, so **618 observations total**.
- **Indicator relevance.** Medium. **Overfitting risk: high**, given the prior
  inspection of nearly identical variables.

---

## 4. Ranking for the eventual directional 5-minute indicator

| rank | class | new info | directional | history ($0) | complexity | overfit risk |
|---|---|---|---|---|---|---|
| **1** | **Z1 cross-market** | **highest** | **yes** | 618d @1h, ~2,300d @1d | medium | medium |
| 2 | Z2 volatility regime | medium | **no** | 618d @1h, 2,515d @1d | low | **lowest** |
| 3 | Z3 overnight | **lowest** | yes | 618 observations | low | **highest** |

Z2 would rank first on pure scientific cleanliness. It ranks second here because
the question asked is relevance to a *directional* indicator, and Z2 cannot
supply direction by construction.

---

## 5. Recommended $0 route: **Z1**, with Z2 as the frozen control

Discovery on the 1h panel (618 trade-date clusters), **corroborated** on the
10-year daily panel, with a Z2-style volatility state included as a *baseline
control* rather than a competing hypothesis — so that any Z1 effect must prove
it is not merely a volatility-regime effect wearing a cross-market costume.

### Exact data files required

Refresh and archive (all $0, all from `backtest/fetch_nq.py`):

```
NQ=F 1h 730d   ES=F 1h 730d   YM=F 1h 730d   RTY=F 1h 730d
NQ=F 1d 10y    ES=F 1d 10y    YM=F 1d 10y    RTY=F 1d 10y
^VIX 1d 10y                                   (context only)
```

Already held and reusable: `data_nq/NQ_5m.csv` (51 trade days) and
`data_nq/NQ_1m.csv` (7 trade days) — **for later qualitative parity checks
only**, never as a research basis.

---

## 6. Preregistration outline — NO RESULTS

1. **Primary question.** Conditional on a causally observable cross-market
   confirmation state among NQ/ES/YM/RTY, does the sign or magnitude of NQ's
   next-hour return differ stably from the prediction of frozen baselines?
2. **H0 / H1.** H0: no incremental information beyond baseline. H1: a stable,
   **two-sided** difference — the sign is not economically known in advance, so
   the primary test is two-sided.
3. **Observational unit.** One non-overlapping 1-hour interval; clustering on
   **CME trade date**; overlapping windows forbidden; roll-week days excluded
   under a rule frozen before outcomes.
4. **Primary outcome.** Frozen before results; direction-normalized next-hour
   NQ return, *not* inherited from V2's Y_30.
5. **Feature budget.** **≤ 8** variables, each with economic role, exact
   formula, availability timestamp, missingness rule, normalization and a
   predeclared or explicitly two-sided sign.
6. **Baselines.** Unconditional · time-of-day · NQ own-return AR · **volatility
   state (Z2 control)**. Continuation requires beating the strongest, not zero.
7. **Partitions.** Chronological, development first, validation after, built
   **only after** exact coverage is fixed. **No historical block preceding
   development** — the prospective forward-accumulating window is the holdout.
8. **Multiple testing.** Family size fixed before any p-value; correction
   procedure predeclared.
9. **Inference.** Day-clustered; multi-day block sensitivity predeclared. 618
   clusters is the effective sample, and this must be stated wherever a result
   is reported.
10. **Stop conditions.** No effect · unstable sign across chronological windows ·
    effect vanishes against the volatility baseline · effect confined to one
    narrow period · roll or data-integrity failure.

## 7. What this route can and cannot support

**Can:** a genuine-CME-NQ, multi-instrument, multi-year *hourly and daily*
market-state study with a true prospective holdout that accumulates forward.

**Cannot:** any 5-minute microstructure claim · any order-flow claim · any
liquidity-sweep claim at intraday resolution · any contract-level or
roll-exact claim · a finished directional 5-minute indicator.

**No candidate is selected. `candidate_selected = null`.**
