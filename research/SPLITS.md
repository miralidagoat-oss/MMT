# Data splits — fixed before any strategy work on the 11-year set

Dataset: NQ 5m ETH, 742,707 bars, 2,729 trading days (2015-01 → 2025-07),
from `mdelcristo/NQ-F_1min_OHLCV_Parquet`, validated in PHASE5.

| Split | Years | Trading days | Use |
|---|---|---|---|
| **Development** | 2015–2020 | 1,548 | Hypothesis generation. Everything is allowed here. |
| **Validation** | 2021–2022 | 518 | Confirm a dev survivor. Looked at only for candidates that clear dev. |
| **Final untouched OOS** | 2023–2025 | 663 | Examined **once**, for a candidate that has cleared both above. |

## Contamination note

The **ON-range breakout family is already burned on 2023–2025** — it was tested
and rejected there (PF 0.804, n=3,433). That result stands; the family is not
resurrected. For families not yet tested there, 2023–2025 remains clean.

## Rules

1. Parameters are chosen on **development only**.
2. A candidate reaching validation must be specified completely first — no
   tuning against validation results.
3. The final OOS is examined once. Anything changed after seeing it requires a
   new untouched period, per the brief's §19.
4. Every configuration tested is counted for multiple-testing correction.
5. All results judged against a null calibrated on the same series at the same
   trade count, not against PF 1.0.

## Power now available

At ~4-5 trades/day, development alone yields **6,000–8,000 trades**. The null
PF p95 at n=7,000 is ≈ **1 + 4.78/√7000 = 1.057**. A genuine edge of even a few
percent becomes visible — which was impossible on the 45-day sample.
