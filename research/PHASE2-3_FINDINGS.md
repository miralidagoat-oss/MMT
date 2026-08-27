# Phase 2–3 — Baseline and Hypothesis Testing: Results

**Status:** Phases 2 and 3 complete. **No candidate has survived.**
**Bottom line:** across 36 a-priori configurations spanning five strategy
families and two timeframes, **zero** show a profit factor distinguishable from
chance. No Pine Script is warranted on this evidence.

---

## 1. The engine was validated before any conclusion was drawn

With a stop at −1R and a target at +0.643R, a driftless random walk hits the
target first with probability 1/(1+0.643) = **60.9%**, giving PF ≈ 1.00.
Random entries on the real MNQ series reproduce exactly that:

```
random seed 1..5, zero cost:  WR 56.3–64.0%,  PF 0.85–1.14,  median PF 1.00
```

The engine's fill accounting is therefore unbiased, and any strategy result can
be read against this null rather than against zero.

---

## 2. The single most important number in this project

**At the sample sizes this data supports, the targets in the brief are inside the
noise band.** Null distribution of random entries on the real series:

| Sample | PF p50 | PF p95 | PF p99 | WR p95 |
|---|---|---|---|---|
| ~170 trades, zero cost | 1.00 | **1.31** | 1.43 | 66.3% |
| ~170 trades, moderate cost | 0.87 | 1.12 | 1.29 | 64.8% |
| **~70 trades, zero cost** | 1.00 | **1.52** | 1.79 | **69.7%** |

Read the last row carefully: **with ~70 trades, a 70% win rate and a PF of 1.5
each occur by pure chance about 5% of the time.** A backtest hitting the brief's
headline targets on a sample this size is not evidence of an edge. This is why
every result below is judged against its own null at its own trade count, not
against PF 1.0.

---

## 3. Phase 2 — baseline B1 (session-VWAP mean reversion): REJECTED

Three rules: stretched from session VWAP in sigma terms, bar closes back toward
VWAP, fade the stretch. Stop 1.25 ATR (~35 pts, inside the Phase 1 viable
region), payoff 0.643.

| k (σ) | n | WR% | PF (pess) | exp R | trades/day | path band |
|---|---|---|---|---|---|---|
| 1.5 | 272 | 55.1 | 0.72 | −0.130 | 6.04 | 0.02 |
| 2.0 | 121 | 57.9 | 0.79 | −0.091 | 2.69 | 0.00 |
| 2.5 | 26 | 57.7 | 0.75 | −0.103 | 0.58 | 0.00 |

Cost ladder at k=2.0: **zero cost PF 1.01** → base 0.90 → moderate 0.79 → harsh 0.73.

**The gross edge is exactly zero.** PF 1.01 at zero cost, with WR 61.5% against a
random-walk expectation of 60.9%, means the signal carries no information at all;
costs then push it negative. This is not a cost problem to be engineered around.

*One architectural success:* the path-assumption band is **0.00–0.02 PF**. The
Phase 1 viable design region (stop 30–60 pts) did what it was supposed to do —
at these stop sizes the intrabar ambiguity that plagues 5m backtests is
essentially absent, so these numbers are real measurements, not tie-break artifacts.

---

## 4. Phase 3 — family premises on 612 trading days of 1h

The 5m series has 45 usable days; testing six families there would manufacture a
spurious winner with near-certainty. So each family's *premise* was tested first
on **612 trading days of MNQ 1h**, where trade counts reach 600–1,700.

18 a-priori configurations, all results reported, zero cost (isolating signal
content from cost drag):

| Family | best config | n | WR% | PF | verdict |
|---|---|---|---|---|---|
| A1 liquidity sweep | PDH/PDL continuation | 604 | 60.6 | 1.08 | inside noise |
| B2 range break | OR continuation | 553 | 57.1 | 1.10 | nominal only, dies under K |
| C1 compression→expansion | comp<0.9 fade | 493 | 54.6 | 0.81 | inside noise |
| C2 EMA pullback | fade | 487 | 60.0 | 1.00 | inside noise |
| VWAP stretch | k=2.5 fade | 327 | 63.3 | 1.21 | inside noise |

**0 of 18 survive.** With K=18 tests a genuine claim needs p < 0.05/18 = 0.0028;
nothing clears even the uncorrected p95 by a meaningful margin.

The same battery on 5m: **0 of 18 survive** there too.

### The trap the method caught

On 1h, VWAP fade at k=2.5 with the reversal filter returns **PF ∞ on 100% win
rate (n=10)**, and at k=2.0 **PF 2.37 at 77.3% WR (n=22)**. Those are the most
spectacular numbers produced anywhere in this project. The null at ~15 trades has
p95 = 2.28 — so both are ordinary noise. Reported without a null calibration they
would have looked like the strategy the brief asked for.

---

## 5. The best-looking candidate, killed

`B2 overnight-range continuation` on 5m was the most attractive result in the
battery: **n=150, WR 67.3%, PF 1.40, 3.3 trades/day** — on paper it meets nearly
every objective in the brief. It was then attacked directly.

| Test | Result | Verdict |
|---|---|---|
| Realistic costs | PF 1.33 base → 1.32 moderate → 1.24 harsh | **passes** |
| Same rule on 1h (794 trades, 612 days) | **PF 0.84, WR 53.3%** | fails — sign inverts on the larger sample |
| Screen (34d) → holdout (17d) | PF **1.50 → 1.03** | fails — edge collapses |
| Profit concentration | removing top 10 of 150 trades: PF 1.40 → 1.26 | tolerable |
| Time-of-day | **49% of all profit from one hour (13 ET)**; 13 ET shows 89.5% WR on 19 trades, while 09/11/15 ET are negative | fails badly |

Half the profit comes from a single hour on nineteen trades, the edge does not
survive a holdout, and the identical rule loses money on a sample five times
larger. **Rejected.**

The one caveat worth stating fairly: a 5m breakout and a 1h breakout are not
quite the same trade — the 1h version enters later with a wider stop — so the
sign inversion alone would not be conclusive. Combined with the holdout collapse
and the single-hour concentration, the parsimonious reading is noise.

---

## 6. What this does and does not establish

**Established:**
- The canonical forms of liquidity-sweep, VWAP-reversion, range-breakout,
  volatility-compression and trend-pullback logic show **no detectable edge** on
  MNQ at 5m or 1h, at the sample sizes available.
- The brief's headline targets (70% WR, PF 1.5) are **inside the chance band** at
  the trade counts this data produces — so hitting them would not, by itself,
  demonstrate anything.
- Phase 1's viable design region was correct and useful: at 30–60 pt stops the
  path-assumption band collapses to ~0.02 PF.

**Not established:**
- That no edge exists in MNQ 5m ETH. Absence of evidence here is genuinely weak
  evidence of absence, because the noise floor is wide.
- Families **E (market structure: BOS/MSS/FVG/displacement)** and **F (hybrids)**
  were not tested in depth. That is a deliberate stopping point, not an oversight:
  each additional family raises the multiple-testing burden, and on 45 usable 5m
  days more searching mostly buys a better-disguised false positive.

---

## 7. Recommendation

**Verdict: INSUFFICIENT EVIDENCE.** Not "reject MNQ 5m forever" — *this data
cannot answer the question*, and no amount of further searching on 45 trading
days will change that.

Per the brief's §27 and §34, the honest move is to stop searching and fix the
binding constraint. In priority order:

1. **Get real data.** 3–5 years of MNQ 5m ETH (Databento, FirstRate, IBKR, or a
   TradingView export). This is the only step that changes what is knowable. With
   ~250,000 bars the null band at 2,000+ trades narrows to roughly PF 1.05, and
   families that are currently unresolvable become decidable.
2. **Then re-run this exact battery.** The infrastructure is built and validated:
   feature layer, engine, null calibration, kill-tests. It is a rerun, not a
   rebuild.
3. **Only then** consider Pine Script.

Writing a strategy now would mean shipping one of the noise-band configurations
above and calling it an edge. On the evidence, that is not warranted.
