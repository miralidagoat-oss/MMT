# 2023–2025 out-of-sample result — the pre-registered test

**Verdict: REJECT. The strategy loses money.**
Tested against thresholds fixed in `PREREGISTRATION_2023-2025.md` *before* the
data was obtained.

## Data — found, and validated

The Phase 1 conclusion that no multi-year 5m data was obtainable was **wrong**.
Source: **`mdelcristo/NQ-F_1min_OHLCV_Parquet`** on Hugging Face (MIT licence) —
NQ 1-minute OHLCV, 2015–2025. Converted to 5m ETH by `backtest/hf_convert.py`
(naive-UTC → America/New_York with DST, CME trading-day mapping).

Validation before any result was trusted:

| Check | Result |
|---|---|
| Session structure | 17:00 ET break has 4 bars of 180,837; median 276 bars/day ✓ |
| Volume profile | 10 ET median 7,487 vs 180 overnight — 25–40× ✓ |
| Price sanity | NQ 17,019 (Jan 24) → 21,234 (Dec 24), matches history ✓ |
| **Independent cross-check vs Yahoo NQ=F 1h** | **median close difference 0.00 pts**, 82.8% within one tick, return correlation **0.990** over 7,497 overlapping bars ✓ |

Usable: **179,453 bars over 658 trading days** (2023-01-10 → 2025-07-25).

## The result

Config under test: ATR 19, stop 1.25 ATR, target 0.393 × stop, cooldown 8,
max hold 47 — tuned on Aug 2026 (PF 1.756, WR 79.73%, n=74).

| Cost | n | WR% | PF | Expectancy | Net |
|---|---|---|---|---|---|
| zero | 3,444 | 69.6 | **0.99** | −0.002R | −6.4R |
| base | 3,438 | 68.3 | 0.84 | −0.047R | −160.6R |
| **moderate** | **3,433** | **67.6** | **0.804** | **−0.058R** | **−198.9R** |
| harsh | 3,423 | 66.5 | 0.72 | −0.087R | −297.0R |

**Pre-registered threshold at n=3,433: PF > 1.082 (p95). Actual: 0.804.**

Two facts settle it independently of any threshold:

1. **Win rate 67.6% is below the 71.8% mechanical breakeven** for a 0.393
   payoff. The strategy loses money by arithmetic.
2. **At zero cost the PF is 0.99.** There is no gross edge to erode — the
   signal carries no directional information at all. Costs then make it clearly
   negative.

## Mandatory checks — all fail

| Check | Result |
|---|---|
| Per-year | 2023 PF 0.83 · 2024 PF 0.73 · 2025 PF 0.90 — **negative every year** |
| Win rate vs 71.8% breakeven | 67.6% — below |
| Trade count | 3,433 (expected 3,000–4,000) ✓ coverage confirmed |
| Long vs short | longs PF 0.78 · shorts PF 0.82 — **both negative** |
| Path band | 0.097 PF — narrow, so this is a real measurement |

## What the Aug 2026 result actually was

PF 1.756 on 74 trades sat at roughly the **98th percentile of pure chance** at
that sample size. A 2%-tail event, and it happened. Every warning sign was
already visible and correct:

- the same rule on 612 days of 1h data returned PF 0.85;
- random entries with identical brackets produce a 78.4% win rate at p95, so
  79.73% was barely outside chance;
- the null calibration put the required PF at 1.5+ for n=74.

## Apex 25K, using the real distribution

Real expectancy: **−$2.60 per trade per micro**, **−$14.53 per day per micro**.
At 2 micros: **−$29 per trading day ≈ −$610 per month.**

| Size | Pass rate | Median days to failure |
|---|---|---|
| 1 micro | 0.7% | 60 |
| 2 micros | **4.6%** | 22 |
| 4 micros | 9.7% | 7 |

## Is the family salvageable?

A 20-configuration sweep over stop ∈ {1.0…2.0} ATR and rr ∈ {0.393…2.0} on the
2023–25 data returns a best of **PF 1.011** — still below the 1.08 chance
threshold, and that sweep is now in-sample, so even that number is optimistic.

**Overnight-range breakout on MNQ/NQ 5m has no edge.** Not a parameter problem.

## Methodological note

This is what the apparatus was built for. The pre-registration made the verdict
unambiguous; the null calibration correctly flagged the Aug 2026 result as a
chance event; the 1h premise test predicted the failure months of compute
earlier. The Phase 1 data conclusion was the one real error, and it was an
error of insufficient searching — Hugging Face was never probed.
