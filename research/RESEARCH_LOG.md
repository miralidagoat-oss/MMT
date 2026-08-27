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

---

## P2-001 — Baseline B1, session-VWAP mean reversion (5m)

- **Hypothesis:** price stretched from session VWAP reverts toward it.
- **Params:** k∈{1.5,2.0,2.5,3.0} σ, stop 1.25 ATR, rr 0.643, cooldown 12, max_hold 48.
- **Result:** PF 0.72 / 0.79 / 0.75 (moderate cost). **Zero-cost PF 1.01, WR 61.5%
  vs random-walk expectation 60.9% → no signal content whatsoever.**
- **Path band:** 0.00–0.02 PF — confirms the Phase 1 viable region works.
- **Status:** `REJECTED` — no gross edge; not a cost problem.

## P2-002 — Engine validation + null calibration

- Random entries reproduce the theoretical WR 60.9% / PF 1.00 → engine unbiased.
- **Null PF p95: 1.31 at ~170 trades; 1.52 at ~70 trades. Null WR p95 at ~70
  trades = 69.7%.** The brief's 70% WR / 1.5 PF targets are inside the chance
  band at these sample sizes.
- **Status:** `RETAINED` — this null is the yardstick for every later result.

## P3-001 — Family premise battery (A1, B2, C1, C2, VWAP) on 1h and 5m

- 18 a-priori configurations per timeframe, all reported, judged against a null
  calibrated on the same series at the same trade count, Bonferroni K=18.
- **1h (612 trading days, up to 1,655 trades): 0 of 18 survive.**
- **5m (45 usable days): 0 of 18 survive.**
- Caught trap: VWAP fade k=2.5 confirm=True on 1h shows PF ∞ / 100% WR at n=10;
  null p95 at n≈15 is 2.28. Pure noise.
- **Bug found and fixed:** the opening-range window [570,600) does not exist on
  this feed's 1h bars (they align to :00), so B2-OR silently produced 0 trades
  and read as a loss. `add_levels` is now parametrised per timeframe and the
  battery was re-run. Untested is not the same as disproven.
- **Status:** `REJECTED` for all tested families.

## P3-002 — Kill-test of the best candidate (B2 overnight-range continuation, 5m)

- Headline: n=150, WR 67.3%, PF 1.40, 3.3 trades/day — meets most brief targets.
- Survives costs (PF 1.24 harsh). Fails everything else:
  - same rule on 1h, 794 trades: **PF 0.84** (sign inverts on the larger sample);
  - screen→holdout: **PF 1.50 → 1.03**;
  - **49% of total profit from a single hour (13 ET), 19 trades at 89.5% WR**,
    while 09/11/15 ET are negative.
- **Status:** `REJECTED` — profit concentration + holdout collapse.
- **Fair caveat logged:** 5m and 1h breakouts are not identical trades, so the
  sign inversion alone would not be conclusive; the holdout and concentration
  results are what settle it.
