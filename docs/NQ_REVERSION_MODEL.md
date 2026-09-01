# Nasdaq Short-Term Reversion

**`strategies/nq_reversion.pine` — run it on the DAILY chart of MNQ1! / NQ1!**

This is what came out of screening a short list of pre-registered hypotheses on
10 years of daily data instead of searching a big parameter space on 71 days.
It is the opposite failure mode to the ICT model in this repo: fewer moving
parts, far more evidence.

---

## The rule

**Entry** — at the close, when the session closes in the weak part of its range:

```
IBS = (close − low) / (high − low)          buy when IBS < 0.30
```

**Exit** — at the close of the first session that closes **higher** than the one
before it. Backstop: exit after 5 sessions regardless.

**Long only.** No stop by default (see §4 — this matters).

That's the whole model. Two numbers, one of which barely matters.

---

## 1. Results — exactly the configuration the script ships with

Daily mark-to-market, flat days included, ~2 bps round-turn costs charged
(roughly 5× the real cost of trading one MNQ, so this is conservative).

| | span | return | **Sharpe** | t | max DD | exposure | trades | win |
|---|---|---|---|---|---|---|---|---|
| **NQ** | 10.0 y | +17.5%/yr | **1.15** | 3.64 | 19.6% | 48% | 455 | 74% |
| NQ buy & hold | | +20.8%/yr | 0.92 | 2.89 | 35.3% | 100% | — | — |
| **MNQ** | 7.3 y | +18.3%/yr | **1.13** | 3.04 | 19.6% | 51% | 344 | 72% |
| **QQQ** | 10.0 y | +19.2%/yr | **1.27** | 4.01 | 14.9% | 51% | 480 | 74% |
| ES | 10.0 y | +10.2%/yr | 0.79 | 2.51 | 21.4% | 49% | 446 | 71% |
| SPY | 10.0 y | +7.9%/yr | 0.63 | 1.99 | 23.2% | 50% | 462 | 70% |

It does not beat buy & hold on raw return. It beats it on **risk**: better
Sharpe, roughly half the drawdown, while holding the market only half the time.
The other half of the time your capital is free and your risk is zero.

**Stability.** Split NQ's 10 years down the middle: first half Sharpe 1.18,
second half 1.12. That is about as stable as this kind of test gets.

**Every calendar year positive** — including the one that matters:

| NQ | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | **2022** | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| model | +1.3 | +14.2 | +7.8 | +22.7 | +31.6 | +11.6 | **+4.7** | +33.1 | +5.8 | +32.6 | +15.5 |
| buy & hold | +1.9 | +31.8 | −1.2 | +38.2 | +47.2 | +26.7 | **−32.5** | +54.4 | +24.7 | +19.9 | +15.8 |

2022 is the interesting column: the index lost a third of its value and the
model finished up. It is not a hedge — it just isn't in the market on the days
that do the damage.

---

## 2. Why the parameters are not knife-edges

The single most useful robustness check: vary each parameter across its whole
plausible range and see whether the result collapses. It doesn't.

**IBS threshold** (NQ, 10 y) — every value tested works:

| threshold | 0.15 | 0.20 | 0.25 | **0.30** | 0.35 | 0.40 | 0.50 |
|---|---|---|---|---|---|---|---|
| Sharpe | 1.15 | 1.19 | 1.18 | **1.15** | 1.20 | 1.12 | 1.01 |
| t | 3.62 | 3.74 | 3.72 | **3.64** | 3.80 | 3.53 | 3.19 |

**Max hold** — 3, 5, 10 and 20 sessions give essentially identical results,
because the "first higher close" exit almost always fires within three days.
The parameter is a backstop, not a tuning knob.

**Costs** — at 10 bps round turn (5× what you'd actually pay on MNQ) it still
returns +13.8%/yr at Sharpe 0.92.

Compare that with the ICT model in this repo, where neighbouring parameter cells
flipped sign. Flat surfaces are what a real effect looks like.

---

## 3. Why it works

Short-term mean reversion in equity indices is one of the oldest documented
anomalies, and the mechanism is not mysterious: a close on the lows is forced
selling — margin calls, stop runs, index funds and risk-parity books rebalancing
into the close. Whoever provides liquidity into that gets paid for it over the
following session. You are being paid to take the other side of someone else's
deadline.

That also tells you when it should stop working: in a genuine sustained
downtrend, "forced selling into the close" is not a temporary imbalance, it's
information. Which is exactly the risk in §4.

---

## 4. Honest limits — read before sizing up

1. **It is long-only, measured mostly across a bull market.** 2016–2026 was a
   historic run for the Nasdaq. 2022 is the only real bear market in the sample
   and the model handled it (+4.7%), but that is *one* observation. A 2000–2002
   style grind would hurt it, and I have no data here to tell you how much.
2. **It holds overnight.** One to five sessions, usually one or two. This is not
   day trading and it carries gap risk. If you cannot hold overnight, this model
   is not for you — and see §6.
3. **Tight stops destroy it.** This is the most important operational point.
   On NQ a 1% stop cut Sharpe from 1.15 to **0.45**. You are deliberately buying
   weakness; a tight stop guarantees you sell the low. Only a wide disaster stop
   is affordable (5%: Sharpe 1.08, and max DD improves from 19.6% to 13.3%).
   That trade — a little return for a lower tail — is a reasonable one on
   leveraged futures. It ships **off** because off is how it was tested.
4. **Nasdaq >> S&P.** NQ Sharpe 1.15, ES 0.79, SPY 0.63. The effect is real on
   the S&P too but much weaker. Trade this on the index it works on.
5. **Leverage is the real risk, not the signal.** One MNQ at 29,500 is ~$59,000
   of notional. On a $25,000 account that is 2.4× leverage on a model with a
   ~20% drawdown at 1×. Do that arithmetic before you size.
6. **~2 bps of assumed cost.** Real MNQ cost is nearer 0.4 bps, so the live
   result should be slightly *better* than the table, not worse — unusual, and
   deliberate.

---

## 5. What I also tested, and rejected

Recorded so you don't spend a weekend rediscovering them:

| tested | verdict |
|---|---|
| Shorting strong closes (IBS > 0.9) | **Loses.** −1.5%/yr QQQ. Don't short index strength. |
| 200-day MA regime filter | **Hurts.** Cuts exactly the dips worth buying (Sharpe 0.88 → 0.81 QQQ, and it wrecked SPY). |
| Gap fade at the open | **No edge.** −2.7%/yr QQQ. |
| Gap continuation at the open | **No edge.** −1.5%/yr QQQ. |
| Overnight-only exit (close → next open) | **Fails.** −0.5%/yr. The gain is in the *daytime* session, not the gap. |
| Holding a fixed 2, 3 or 5 days | Worse than "first higher close" in every case. |
| Buy & hold with the same capital | Higher return, but 0.92 Sharpe and 35% drawdown. |

---

## 6. If you will not hold overnight

There is a pure day-trade version: after a weak close, buy the **next open** and
exit at that session's **close**. On 10 years of QQQ (the only series whose daily
bar is a true 09:30–16:00 session) it returns +9.0%/yr at Sharpe 0.85, t = 2.69,
649 trades — genuinely significant, and about half the edge of the swing version.

The catch: rebuilt on true RTH futures sessions over the last 2.4 years it
weakened to Sharpe 0.42 on MNQ. Sign consistent, magnitude not. So the intraday
variant is real but noticeably weaker and possibly decaying — I would trade the
swing version, and if you can't, size the intraday one smaller.

---

## 7. Reproduce it

```
cd backtest
python3 ict_data.py ../ictdata        # fetches the data
python3 edge_screen.py ../ictdata     # the pre-registered hypothesis screen
python3 reversion_model.py ../ictdata # daily mark-to-market, all instruments
```

`edge_screen.py` is the honest part: it contains the models that failed as well
as the one that worked, in the form they were tested.
