# MNQ 5-Minute — Research Report

**Target:** Micro E-mini Nasdaq-100 futures (MNQ), 5-minute bars
**Date:** 2026-08-23
**Mandate:** find the strongest legally and publicly observable information that
improves a systematic 5m model; be adversarial toward every conclusion.

---

## 1. Executive summary

**The headline finding is negative, and it is the most useful thing in this
report.** At 5-minute resolution on MNQ, after realistic transaction costs, no
signal I tested — price-structural, positioning-derived, volatility-derived,
macro, or cross-asset — reaches conventional statistical significance out of
sample. Fifteen pre-registered hypotheses were run on 669 independent trading
sessions; **zero survived a false-discovery-rate correction in the untouched
test panel.**

The best surviving configuration is the existing repository system (liquidity
sweep + rejection, RTH only, breakeven at +1R, 1:4 target) with **one** added
filter — a realized-volatility regime gate. On three years of independent
Nasdaq-100 5m data it produced:

| metric | value |
|---|---|
| trades | 202 (≈67/year) |
| expectancy, net of 1.5 pts round-turn cost | **+0.219 R** |
| profit factor (net) | **1.45** |
| t-statistic | **1.73** |
| bootstrap 95% CI on expectancy | **[−0.069, +0.388] R — includes zero** |

That is a *promising, unproven* system. It is not a validated edge, and the
report says so everywhere it appears. Roughly **271 trades (~4 years)** would be
needed to reach t = 2 if the current point estimate is the true expectancy.

Three specific claims in the prior README did not survive re-audit — details in
§12.

---

## 2. Markets and data sources investigated

| dataset | source | span | size | role |
|---|---|---|---|---|
| MNQ 5m | Yahoo Finance chart API | 2026-06-11 → 08-21 (50 RTH sessions) | 13,759 bars | real futures, real CME volume; **holdout** |
| NQ 5m, ES 5m | Yahoo Finance | same 60 days | 13,759 / 13,761 bars | cross-instrument check |
| Nasdaq-100 cash 1m→5m | **Dukascopy** `USATECHIDXUSD` | 2023-08-23 → 2026-08-21 | **1,163,520 1m bars → 669 RTH sessions** | primary research sample |
| S&P 500 cash 1m→5m | Dukascopy `USA500IDXUSD` | same 3 years | 1,182,240 1m bars | cross-asset |
| CFTC TFF positioning | **CFTC Public Reporting (Socrata)**, primary | 2010-06 → 2026-08 | 845 weekly reports | positioning |
| VIX, VXN, DXY, 10y | Yahoo Finance | 5 years daily | ~1,256 rows each | volatility / macro |
| MNQ contract specs | **CME Group**, primary | — | — | cost model |

**Why Dukascopy.** Yahoo caps 5-minute history at 60 days — about 3,300 RTH
bars, which is far too little to conclude anything about a 5m system. Dukascopy
publishes free per-day 1-minute candle files with years of history and no API
key, which is what made a 669-session sample possible.

**The caveat that matters:** `USATECHIDXUSD` is Dukascopy's Nasdaq-100 **cash
index CFD**, not CME futures. It tracks the same underlying but has no CME
contract volume (its volume field is a broker liquidity proxy), no futures
basis or roll, and slightly different session coverage. It is used for
structural research on a large sample; real MNQ futures are used to validate.
Where the two feeds overlap they agree closely (§5), which is the main evidence
that the proxy is fit for purpose.

---

## 3. The cost hurdle — the number that governs everything at 5m

From CME primary source: **MNQ is $2.00 per index point; minimum tick 0.25
points = $0.50.**

Realistic round-turn friction: 1-tick spread crossed both ways (0.5 pts) +
commission (≈$1.50 RT = 0.75 pts) + typical stop slippage (0.25–0.5 pts) ≈
**1.0–1.75 index points.** I use **1.5 points** as base case and test 0.5–2.5.

The right way to express this is *relative to signal scale*, not in points:

- mean 5m RTH bar range (2026 sample): **50.6 points = 17.2 bp** of index
- 1.5 points of cost = **0.51 bp = about 3% of one bar's range**

A structural note worth flagging: because the tick is fixed in *points* while
the index level has risen, the relative hurdle has fallen materially — a 20 bp
5m range cost 5.8% of its range at NDX 13,000 in 2021 but only 2.5% at 29,500
today. Studies run on 2021–2025 samples (including the arXiv falsification
study below) faced a stiffer hurdle than a trader faces now. This is a genuine
tailwind and one of the few structural changes that favors the retail side.

---

## 4. Highest-value public information discovered

Ranked by what actually survived testing:

1. **Realized-volatility regime** (Grade B). The only conditioning variable
   that held its sign and magnitude across train and test. Free, instant, no
   external feed, computable in Pine in O(1).
2. **Overnight vs RTH return decomposition** (Grade B, but *not a 5m signal*).
   Prev-close → next-open averaged **+9.02 bp** across 669 sessions (t = 2.62),
   and was remarkably stable train→test (+9.33 → +8.68 bp). This is the
   well-documented overnight-drift anomaly. It is a **daily holding period**
   effect and says nothing about 5-minute trading.
3. **Session volatility profile** (Grade A as a *fact*, Grade D as a *signal*).
   The intraday U-shape is unambiguous — mean 5m range falls from 124.9 pts at
   09:30 to 36.6 pts at 13:30 and rises to 61.3 pts at 15:55. Excellent for
   sizing and stop placement; produced no directional edge.

Everything else failed. Details in §12.

---

## 5. The 5-minute reversal signal — a case study in adversarial testing

This is worth reading because it is the exact shape of a result that fools
people, and it took four separate tests to resolve.

**Step 1 — it looked extraordinary.** Fading the previous 5m bar on 60 days of
real MNQ futures gave +0.784 bp/bar, t = 4.03, and simulated to a Sharpe of
**8.3** with +140 points per session. That is not a real edge; it is a signal to
start attacking.

**Step 2 — tradeability.** The naive test enters at `close[i]`, which you cannot
trade. Decomposing into the non-capturable close→open jump and the capturable
open→open leg showed the jump is genuinely mean-zero (t = 0.05): the effect
survives realistic entry. Bid-ask bounce was ruled out on magnitude — the
half-spread is 0.042 bp, twenty times too small to explain 0.78 bp.

**Step 3 — decay profile.** Genuine transient price impact decays smoothly. This
**alternated sign** (+0.83, −0.61, −0.03, −0.59, +0.55…) and accumulated to only
+0.27 bp after 8 bars. That is an artifact signature, not liquidity provision.

**Step 4 — feed vs period.** The decisive test. Running the identical window on
two *independent* feeds and two *different instruments*:

| dataset / window | sessions | mean bp | t | net of cost |
|---|---|---|---|---|
| Yahoo **MNQ futures**, 2026-06-11..08-21 | 50 | +0.840 | 4.34 | +0.332 ✓ |
| Dukascopy **NDX cash**, same window | 52 | +0.821 | 4.31 | +0.310 ✓ |
| Dukascopy NDX cash, **full 3 years** | 669 | +0.129 | 2.59 | **−0.553 ✗** |

**Conclusion: not a data artifact — a regime.** Two unrelated feeds agree to
within 0.02 bp. But across 13 calendar quarters, **12 were below cost** and only
2026 Q3 — the current quarter — cleared it (+0.755 bp, t = 3.98). Trading this
is a bet that a live regime persists, not the exploitation of a stable effect.
It ships in the indicator as a **diagnostic display that generates no trades.**

---

## 6. Institutional positioning (13F / COT) analysis

**13F, 13D/G, Form 4 are not usable at 5-minute resolution and this is not a
close call.** 13F is filed 45 days after quarter-end; a position shown in a 13F
may have been closed months before you read it, gives no short exposure, no
derivatives detail, and cannot distinguish directional conviction from hedging,
index replication, or arbitrage. There is no honest path from a 13F to a 5m MNQ
entry, and I did not construct one.

**CFTC Commitments of Traders — tested properly and rejected.** Using the
Traders in Financial Futures report (primary source, dataset `gpe5-46if`),
Nasdaq-100 Consolidated:

- **Timing:** positions are as of **Tuesday close**, published **Friday 15:30
  ET** — a verified **3-day delay**, stretching to 9 days stale by the next
  Thursday. My fetcher stores an explicit `release_ts` and every backtest query
  is an as-of lookup against it, so no model can see a number before it existed.
- **Result:** no incremental value. Conditioning on leveraged-money net
  positioning not being extreme-long gave +0.199 R in train but only +0.095 R in
  test — and in the test panel **the trades it removed were better (+0.268 R)
  than the ones it kept.** The sign of the effect flipped. That is noise.
- **Additional hazard:** CFTC revises prior weeks. A backtest using
  currently-published history uses numbers that differ from what was visible in
  real time — an unavoidable look-ahead risk in this source.

COT is genuinely informative about *weekly* positioning extremes in some
markets. It cannot inform a 5-minute entry, and on this test it added nothing at
any horizon I could measure.

---

## 7. Options / volatility analysis

**What is not available.** Dealer gamma exposure, strike-level open interest,
put/call ratios, volatility skew and unusual-options-activity feeds are **not
accessible to Pine Script.** Any indicator claiming to plot "dealer gamma" on
TradingView is either using a hardcoded number the author typed in, or
fabricating it. I did not include one.

**What is available:** VIX, VXN, VIX9D, VIX3M as daily series via
`request.security()`.

**What it was worth:** VIX above its median looked helpful (+0.214 R train,
+0.275 R test — consistent). But it is **the same information** as the realized
volatility gate, which is cheaper, needs no second data feed, and carries no
higher-timeframe repaint risk. Added on top of the realized-vol gate it changed
nothing. Per the incremental-value test, it was removed.

An honest note on interpretation: even with full options data, large trades
cannot be classified as directional. A large block may be a hedge, a spread leg,
market-making inventory, or portfolio protection. Feeds that report "unusual
options activity" generally cannot distinguish these, and treating them as
directional is unjustified.

---

## 8. Macro / government data analysis

Economic releases (BLS CPI/NFP at 08:30 ET, FOMC at 14:00 ET) have a
**deterministic, zero-delay calendar** — the timestamp is knowable in advance,
so the timing is clean. Their volatility effect is not in question.

I did **not** ship a macro component, for a specific reason: establishing a
*directional* edge requires the market's *expectation* (consensus forecast) to
compute a surprise, and consensus data is a licensed commercial product not
available from a primary public source or to Pine. Without it, "CPI day" is a
volatility flag, which the realized-volatility gate already captures. Claiming a
macro edge here would not be supportable.

The 10-year yield and DXY were tested as daily conditioning variables and added
nothing beyond the volatility regime.

---

## 9. Cross-asset analysis

At 5-minute resolution, ES and NQ are effectively contemporaneous. Genuine
index-futures lead-lag is a **sub-second** phenomenon contested by firms with
colocation; it is not observable on 5m bars and not capturable by a retail
TradingView system. The reversal effect appears in MNQ (+0.784 bp), NQ (+0.757)
and ES (+0.432) with magnitudes scaling to each instrument's volatility, which
is consistent with a common volatility factor rather than an exploitable
lead-lag relationship.

---

## 10. Market-structure analysis

- **Intraday U-shape: confirmed and strong.** Mean 5m range 124.9 pts (09:30) →
  36.6 pts (13:30) → 61.3 pts (15:55); volume follows the same shape.
- **Opening-range breakout: failed out of sample.** OR-30m was the single
  strongest hypothesis in training (+11.49 bp, t = 3.09, the only FDR survivor)
  and **collapsed to +3.54 bp, t = 0.72** in the untouched test panel. Note also
  that three OR windows were tried and only one worked — selection.
- **Session and weekday conditioning: noise.** The 09:30–11:00 block was −0.100
  R in train and +0.182 R in test. Complete sign flip. Removed.

---

## 11. Signal library

| signal | source | freq | delay | rationale | real-time? | failure mode | Pine? | grade |
|---|---|---|---|---|---|---|---|---|
| Liquidity sweep + rejection | chart | 5m | none | stop-run then failure to continue | yes | underpowered; t=1.34 alone | yes | **B−** |
| Realized-vol regime gate | chart | 5m | none | 1:4 target unreachable in low vol | yes | vol clustering ≠ direction | yes | **B** |
| Overnight drift | chart | daily | none | documented overnight anomaly | yes | *not a 5m signal*; gap risk | yes | **B** |
| Intraday U-shape (sizing) | chart | 5m | none | auction structure | yes | not directional | yes | **A (fact)** |
| 5m short-horizon reversal | chart | 5m | none | transient liquidity imbalance | yes | **1 of 13 quarters only** | yes | **C** |
| OR-30m breakout | chart | 5m | none | opening auction resolution | yes | **failed OOS (t 3.09→0.72)** | yes | **D** |
| Intraday momentum (Gao 2018) | chart | 30m | none | late-day rebalancing | yes | **dead: t = 0.06** | yes | **D** |
| COT leveraged-money net | CFTC | weekly | **3 days** | positioning extremes | no | **sign flipped OOS** | partial | **D** |
| VIX level / term structure | CBOE | daily | 1 day | volatility regime | yes | redundant vs realized vol | yes | **C (redundant)** |
| Dealer gamma / options OI | — | — | — | dealer hedging flow | **no** | **not accessible to Pine** | **no** | **N/A** |
| 13F institutional holdings | SEC | quarterly | **45 days** | institutional conviction | no | hopeless at 5m | no | **D** |

Only A/B signals entered the shipped system: the sweep baseline and the
volatility gate. Nothing else.

---

## 12. Signals that failed falsification — and prior claims that did not survive

**Three claims in the previous README did not hold up:**

1. **"MNQ edge is 1H only."** Re-running the frozen preset on 3 years of
   independent 1H data gives 47 trades, PF 1.18 net of costs, +4.2 R — far
   weaker than the claimed PF 1.35 over 87 trades, and on this larger sample
   **5m was better than 1H**, not worse. The original 1H conclusion rested on a
   single 2-year Yahoo series that had also been used for tuning.

2. **"5m is breakeven/negative (PF 1.00)."** That verdict came from 60 days and
   75 trades. On 669 sessions the same rules give PF 1.32 net. The original
   sample was simply too small to conclude anything — in either direction.

3. **A real code defect in the study harness.** `study_mnq.py` used
   `et_hour(ts) = (ts // 3600 - 4) % 24` — a fixed UTC−4 offset. US Eastern is
   UTC−5 outside daylight saving, so **the "RTH" session gate was shifted by one
   hour for roughly 40% of the calendar**, and the session-attribution
   conclusions drawn from it are unreliable. The new `lib5m.py` does proper DST
   conversion.

**Also falsified:** market intraday momentum (t = 0.06 — consistent with the
published post-2013 decay of the Gao et al. effect); OR-breakout; session and
weekday filters; COT conditioning; gap-fade.

**Multiple-testing discipline.** 15 pre-registered hypotheses plus 32 subgroup
conditionings were run. At 32 tests, ~2 will clear |t| > 2 by chance. Every
subgroup result in this report is stated with both panels shown so the reader
can apply that discount. The reason the volatility gate is believed and the
weekday result is not: the volatility gate held its **sign and magnitude** in
both panels (+0.308 / +0.300) and has a mechanism — a 1:4 target is unreachable
inside the validity window when volatility is compressed.

---

## 13. Look-ahead / data-timing audit

| signal | event created | public at | delay | revised? | classification |
|---|---|---|---|---|---|
| Sweep + rejection | bar close | bar close | none | no | **NON-REPAINTING** (gated on `barstate.isconfirmed`) |
| Realized-vol gate | bar close | bar close | none | no | **NON-REPAINTING** |
| Limit fill | later bar | later bar | ≥1 bar | no | **CONFIRMATION DELAY REQUIRED** (fills only on a bar *after* the signal bar) |
| Breakeven arming | bar close | bar close | 1 bar | no | **CONFIRMATION DELAY REQUIRED** (armed after exit checks; effective next bar) |
| COT positioning | Tuesday close | **Friday 15:30 ET** | **3 days** | **YES** | **NOT SUITABLE FOR REAL-TIME 5m** |
| VIX daily close | 16:15 ET | same evening | ~1 session | no | usable next session only |
| 13F holdings | quarter-end | +45 days | 45 days | yes | **NOT SUITABLE** |

Deliberately avoided: no `request.security()` in the shipped code, no
higher-timeframe candles, no pivot/swing functions requiring future bars, no
`lookahead_on`. Intrabar path is treated as unknowable: if stop and target both
print inside one bar, the **stop wins**; the target is never credited on the fill
bar.

---

## 14–16. The three systems

**VERSION A — pure evidence.** Sweep + rejection, RTH 09:30–16:00 ET, breakeven
at +1R, 1:4 target. 222 trades / 3 years, **+0.159 R** net, PF 1.32, t = 1.34.

**VERSION B — enhanced (recommended).** A + realized-volatility regime gate
(take signals only when session realized vol exceeds its trailing baseline).
202 trades, **+0.219 R** net, PF 1.45, t = 1.73. The gate is *the only* addition
that earned its place.

**VERSION C — research, display only.** The short-horizon reversal regime,
rendered as a diagnostic marker. **It generates no trades and enters no
statistic.** It cleared cost in 1 of 13 quarters; presenting it as tradeable
would be dishonest.

---

## 17. Backtest results (Version B core, 3y NDX 5m)

| metric | value |
|---|---|
| signals / fills / expired | 277 / 222 / 55 |
| trades after vol gate | 202 |
| win rate (decisive) | 26.4% vs 20.0% breakeven at 1:4 |
| wins / losses / breakeven scratches | 37 / 103 / 82 |
| profit factor, gross → net | 1.44 → **1.32** (baseline), **1.45** (gated) |
| expectancy net | **+0.219 R** |
| net R | +44.2 R over 3 years (~+14.7 R/yr) |
| cost as fraction of average R | **3.4%** (mean stop distance 44.7 pts) |

**Costs are charged per trade at 1.5 index points**, converted to R using each
trade's own stop distance (R varies, so a flat R-cost would be wrong).

---

## 18. Out-of-sample results

Chronological split, no refitting, 5-session embargo.

| panel | n | expectancy | t | PF |
|---|---|---|---|---|
| train (first half) | 101 | +0.121 R | 0.70 | 1.24 |
| test (second half) | 101 | +0.317 R | 1.70 | 1.68 |

Positive in both halves, stronger in the second. But **the full-sample bootstrap
CI still includes zero**, and neither half is individually significant. The
15-hypothesis battery is the sterner test: **zero hypotheses survived FDR
correction in the untouched test panel.**

---

## 19. Robustness

One-at-a-time parameter sensitivity (net-of-cost PF; shipped value in bold):

| parameter | sweep of values → PF |
|---|---|
| sweep_sigma | 0.25→1.43, 0.5→1.39, **0.75→1.32**, 1.0→1.16, 1.25→1.26 |
| stop_sigma | 0.75→1.36, 1.0→1.48, **1.5→1.32**, 2.0→1.32, 2.5→1.20 |
| min_wick | 0.25→1.32 … **0.35→1.32** … 0.5→1.34 (insensitive) |
| range_exp | 0.6→1.06, 0.8→1.04, **1.0→1.32**, 1.2→1.28, 1.5→0.84 |
| vol_mult | 0.4→1.08, 0.6→1.07, **0.8→1.32**, 1.0→1.24, 1.2→1.16 |
| rb_lookback | 6→1.14, 9→1.29, **12→1.32**, 18→1.36, 24→1.37 |
| rr | 2→1.16, 3→1.23, **4→1.32**, 5→1.33, 6→1.49 |

Mostly robust — PF stays in 1.16–1.48 across the majority of the space, so this
is not a knife-edge fit. **But two parameters sit exactly on local maxima**
(`range_exp` = 1.0, with neighbours at 1.04–1.06; `vol_mult` = 0.8, neighbours
at 1.07–1.08). Those two were tuned on MNQ in the prior work and this is the
selection bias showing. Treat their contribution as overstated.

The volatility gate itself is robust to its window: expectancy +0.205 (W=500),
+0.213 (W=1000), +0.231 (W=2000). **W=1000 ships deliberately because it is not
the maximum.**

---

## 20–21. TradingView implementation

- `indicators/mnq_5m_sweep_v4.pine` — indicator, Versions A/B/C
- `strategies/mnq_5m_sweep_strategy.pine` — strategy with real order engine,
  `commission_value = 0.75`/side and `slippage = 2` ticks (≈1.75 pts round turn,
  slightly *more* conservative than the research's 1.5)

Not included, deliberately: COT, options/gamma, macro, cross-asset. Each either
failed the incremental-value test or is inaccessible to Pine. Adding them would
make the script look sophisticated and perform no better.

---

## 22. Adversarial code audit

Defects found in my own code and fixed:

1. **`ta.sma()` inside a ternary** in the Version C overlay — a `ta.*` call
   evaluated on only some bars silently corrupts its internal state. This is the
   same class of bug this project previously had with `ta.variance`. Fixed:
   compute unconditionally, gate only the *consumption*.
2. **`strategy.pending_orders` is not a Pine built-in.** I had invented it.
   Replaced with a `strategy.closedtrades` watcher, which also fixes a real
   deadlock: a limit that fills *and* exits within one bar would leave the
   `working` flag stuck true, blocking every later signal.
3. **EOD flatten could never fire.** It detected "first bar outside the session",
   which does not exist on a chart configured for regular hours only — positions
   would have run overnight. Replaced with an explicit ET clock test.
4. **Version C was advertised but unimplemented** — the input offered it and
   nothing happened. Now implemented as a display-only diagnostic.
5. **Expectancy denominator excluded evicted trades**, overstating expectancy on
   signal-dense charts. Added `cEvicted` to the closed count.
6. **`str.startswith` is not a documented Pine built-in**; and matching on an
   em dash is encoding-fragile. Replaced with comparison to named constants.
7. **`max_bars_back` too small** for the regime baseline window; raised to 5000
   and the input capped so `rvBaseLen + rvLen` stays inside the budget.

A defect in the *pre-existing* study harness is recorded in §12 item 3 (fixed
UTC−4 offset breaking DST).

**The Pine code has not been compiled.** There is no TradingView compiler in
this environment, so syntax is verified by inspection only. It must be pasted
into the Pine editor before use.

---

## 23. Known limitations

1. **The headline result is not statistically significant.** t = 1.73, CI
   includes zero. This is the single most important limitation.
2. **The research sample is a cash-index CFD, not CME futures.** No real
   contract volume — so the volume gate, which is part of the signal, could not
   be tested in its true form on the large sample.
3. **Only 50 sessions of real MNQ futures 5m data exist** at Yahoo's cap, and on
   that small sample RTH-gated results were *negative* (n = 30). Underpowered,
   but it is not confirmation either.
4. **Two parameters sit on local optima** from prior tuning (§19).
5. **Costs are modelled, not measured.** Real slippage varies with volatility and
   is worst exactly when these signals fire.
6. **Limit-order fills are assumed** at the posted price. Real limit orders
   suffer adverse selection: you are filled preferentially when the market keeps
   going against you.
7. **3 years spans one broad regime** — no 2022-style bear market, no 2020-style
   volatility shock.
8. **Pine code is uncompiled.**

---

## 24. Data that cannot be accessed

- Dealer gamma exposure, strike-level OI, options order flow — not in Pine, and
  not free from a primary source
- Level 2 depth, full order book, CME MBO — not in Pine
- Real-time consensus economic forecasts — licensed commercial data
- Tick-level futures history beyond 60 days without a paid vendor
- Intraday COT — does not exist; the report is weekly by law
- Real-time institutional positioning — does not exist publicly at any frequency

---

## 25. What would need to be done next

1. **Buy real MNQ 5m tick/bar history** (Databento, CME DataMine, FirstRate) for
   5+ years *with genuine contract volume*. This is the single highest-value
   next step: it removes the CFD proxy caveat and the volume-gate blind spot at
   once.
2. **Re-run the volume gate in its true form** on that data — it is a component
   of the shipped signal that the large-sample test could not exercise.
3. **Collect ~270 forward trades** (≈4 years live, or 4 years of new history) to
   reach t = 2. Until then this stays "promising, unproven".
4. **Paper-trade Version B** for one quarter and compare realized slippage
   against the 1.5-point assumption. If real friction is 2.5 pts, the edge is
   gone (§3 sensitivity).
5. **Re-fit nothing.** The temptation will be to nudge `range_exp` and
   `vol_mult` off their local optima. Freeze them and let new data judge.
6. **Test on ES and RTY** with the same frozen parameters — if the effect is
   real market structure it should appear, weaker, in sibling contracts.
7. **Compile the Pine** in the TradingView editor and reconcile its strategy
   output against `reaudit.py` before risking money.

---

## Reproduce

```bash
python3 backtest/fetch_dukascopy.py data5m 3 USATECHIDXUSD,USA500IDXUSD
python3 backtest/fetch_cot.py cot_ndx.csv "20974+"
python3 backtest/research5m.py data5m/USATECHIDXUSD_5m.csv "NDX 5m"
python3 backtest/reaudit.py    data5m/USATECHIDXUSD_5m.csv "NDX 5m"
python3 backtest/evaluate.py
python3 backtest/window_compare.py
python3 backtest/final_config.py
```

## Sources

- CME Group — [Micro E-mini Nasdaq-100 contract specifications](https://www.cmegroup.com/markets/equities/nasdaq/micro-e-mini-nasdaq-100.contractSpecs.html) (primary)
- CFTC — [Public Reporting Environment, Traders in Financial Futures](https://publicreporting.cftc.gov/resource/gpe5-46if.json) (primary)
- Gao, Han, Li, Zhou — [Market intraday momentum](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351), *Journal of Financial Economics* 129(2), 2018 — tested here and **not replicated**
- Zarattini, Aziz, Barbon — [Beat the Market: An Effective Intraday Momentum Strategy for SPY](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172)
- Mesfin — [Structural Limits of OHLCV-Based Intraday Signals in MNQ Futures: A Systematic Falsification Study](https://arxiv.org/abs/2605.04004), arXiv 2026 — independent negative-results study on the same instrument and timeframe; its ~2-point friction assumption is consistent with §3
