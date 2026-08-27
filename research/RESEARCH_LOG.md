# Research Log — MNQ 5m ETH

Append-only. One entry per experiment. One logical change per entry (brief §32).
Rejections record *why*. Any re-test of a previously rejected configuration must
cite the original entry ID, so circular re-optimization is visible.

Status key: `RETAINED` / `REJECTED` / `PROMOTED` / `PARKED`

---

## P1-000 — Data reconnaissance and architecture

- **Hypothesis:** n/a (scoping)
- **Change:** established obtainable data, session model, cost floor, path-ambiguity
  ceiling, feature normalization rule, validation architecture, scoring rubric.
- **Findings:**
  - MNQ 5m ETH: 13,485 bars / **51 trading days** (Yahoo 60d cap; 422 beyond).
  - MNQ 1h ETH: 13,737 bars / 617 trading days — usable for regime work.
  - ρ(MNQ, NQ 5m returns) = **0.9985** → NQ is *not* independent validation.
  - Cost floor: stops < 15 pts unviable; < 20 pts fail the harsh cost scenario.
  - Path ambiguity: at 15-pt stop, 55% of all bars / 95% of cash-open bars could
    contain both stop and target.
  - Viable design region: **stop 30–60 pts (1–2× ATR), target 20–40 pts**.
  - Data defects: 20% null padding; +228 pt jump across a 10-min gap (2026-07-28);
    265-min data hole (2026-07-17).
- **Result:** no strategy tested.
- **Status:** `RETAINED` — architecture fixed before any results exist.
- **Note:** scoring weights and promotion gates were fixed in Phase 1,
  *before* any candidate was run, so they cannot be tuned to favour an outcome.

---

## P1-001 — Prior-art carry-forward (from repo README, earlier work)

- **Family:** A1, liquidity-sweep rejection with 1:4 RR, crypto-derived params.
- **Prior result on MNQ:** 1H PF 1.35 (n=87); **5m PF 1.00 (n=75)**; 15m 0.80; 30m 0.57.
- **Assessment:** 5m result is breakeven *pre-cost*, i.e. negative after costs.
  The "NQ cross-validation" supporting the 1H claim is invalidated by ρ=0.9985.
- **Status:** `PARKED` — Family A1 deprioritized to 4th in the Phase 3 order.
  Re-testing it on the same 60 days with new parameters would be overfitting.

---

## P1-002 — Scope decisions (user)

- **9.1 Data:** proceed on the 51 available trading days. **Verdict for this
  project is capped at `PROMISING` or `INSUFFICIENT EVIDENCE`.** A
  `ROBUST CANDIDATE` verdict is not reachable from Track A alone and will not
  be claimed.
- **9.2 TradingView:** Premium+ with **Deep Backtesting**. Track B can therefore
  carry genuine multi-year 5m out-of-sample validation, executed by the user.
  The Phase 7 Pine script must expose in-sample/OOS date-window inputs so the
  final untouched block is never seen by me.
- **9.3/9.4:** default cost model ($0.85/side + 1 tick base) and the §3.4 risk
  envelope ($60–120/trade) accepted.
- **Consequence:** Track A output is *screening*. Any edge that survives it is
  handed to the user for Track B validation, and only Track B can promote it.
