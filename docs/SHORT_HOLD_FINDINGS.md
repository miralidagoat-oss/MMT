# Can anything work in a ≤2 hour holding window?

Short answer: nothing I could find, and the sample size needed to prove
otherwise is out of reach. This documents the screen so the question doesn't get
re-opened from scratch.

Run it yourself: `cd backtest && python3 intraday_screen.py ../ictdata`

## Method

Same discipline as `edge_screen.py`: hypotheses fixed in advance, each with at
most two parameters. Entry always at the **next bar's open** (never the signal
bar's close), exit a fixed number of bars later, never crossing the session end,
1bp round-turn cost charged. Tested on 875 days of 1h data across MNQ, NQ, ES,
MES, QQQ and SPY — 5,000–9,000 trades per hypothesis — and re-checked on 5m.

## Results, 1h and 2h holds, RTH only

Every hypothesis, pooled across six instruments:

| model | hold 1h (t) | hold 2h (t) |
|---|---|---|
| reversion: buy weak close (IBS<0.3) | −0.35 | −1.03 |
| reversion: short strong close (IBS>0.7) | **−3.72** | **−4.34** |
| momentum: buy strong close (IBS>0.7) | −1.67 | +0.53 |
| momentum: short weak close (IBS<0.3) | **−4.05** | −1.85 |
| reversion: buy any down bar | −2.99 | −2.13 |
| reversion: buy after 2 lower closes | −1.61 | −1.46 |
| reversion: short after 2 higher closes | **−4.32** | **−5.18** |

Nothing positive and significant. Hour-of-day drift was also checked across all
23 hours: 2 crossed |t| = 2, which is exactly what 23 tests produce by chance,
and both were worth ~2bp.

## The one candidate, and how it died

"Buy after 2 higher closes, 09:30–11:30 entries, hold 2h" came out at
**t = +2.47** (n = 2,211) — the best cell in the whole screen. Split by time:

| | n | mean | t |
|---|---|---|---|
| first half | 1,102 | +3.04 bp | **+2.91** |
| second half | 1,107 | +0.56 bp | **+0.57** |
| same idea on 5m data | 1,910 | −1.49 bp | **−1.38** |

It did not replicate. After ~25 tests, a single t of 2.47 is what the maximum of
a noise distribution looks like.

## The daily edge does not reach into the window

The validated daily model (`NQ_REVERSION_MODEL.md`) buys after a weak close. It
is natural to ask whether that bounce shows up in the first two hours of the next
session, which would make it a day-filter for short-hold trading. It does not:

| 09:30 → 11:30 after a weak prior close | n | mean | t |
|---|---|---|---|
| MNQ | 149 | −1.21 bp | −0.22 |
| NQ | 144 | −1.87 bp | −0.34 |
| ES | 159 | −2.69 bp | −0.73 |
| QQQ | 179 | −1.92 bp | −0.36 |

The bounce takes longer than two hours to develop. The morning is when the
residual selling is still working through.

## Why the horizon is the problem

| MNQ, 2-hour hold | |
|---|---|
| noise (sd of a 2h RTH move) | 68.3 bp = **201 points = $403/contract** |
| best edge found in ~25 tests | 1.8 bp = **5.3 points = $11/contract** |
| signal-to-noise per trade | **1 : 38** |
| trades needed to detect it at t = 2 | **~5,750** |

At two trades a day that is eleven years of trading before you could distinguish
that edge from zero. This is not a statement about effort — at a two-hour horizon
on a $59,000-notional instrument, an edge of that size is unverifiable in any
sample a retail trader will ever accumulate. Treat any backtested ≤2h MNQ system
presented with a few hundred trades accordingly.

## What did survive

One thing, and it is robust: **the short side loses systematically at this
horizon.** Every short hypothesis was negative, t = −3.7 to −5.2, on all six
instruments across 875 days, regardless of trigger. Short-horizon shorts on the
Nasdaq fight the drift. Long-only, or a materially higher bar for shorts.

## Implication

If the holding period is genuinely capped at two hours, the edge — if any — is in
order flow, level 2, news reaction and correlated-instrument lead/lag, none of
which OHLC bars can test. That is a discretionary skill claim, not a mechanical
one, and it should be sized and measured as such. Extending the holding period is
the single change that moves the problem back into testable territory: holding to
the session close reaches t = 2.69 over ten years, and one to two days reaches
Sharpe 1.13.
