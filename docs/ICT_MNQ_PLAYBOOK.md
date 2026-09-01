# ICT MNQ Playbook — Sweep → MSS → Displacement

5-minute execution, higher-timeframe filtered. This is the trading manual for
`strategies/ict_mnq_sweep_mss.pine`. Read the last section before you size up:
it says plainly which parts of this held up under testing and which did not.

---

## 1. The one sentence version

Wait for price to raid a known pool of liquidity, reject it, and close back
through the swing that stood before the raid — then take that shift **in the
direction the 30m and 1H structure already point**, risk one ATR, target two.

---

## 2. Chart setup

| | |
|---|---|
| Instrument | MNQ (front month) |
| Execution chart | **5 minute** |
| HTF filter | **30m + 1H** structure (the script reads these for you) |
| Context you eyeball | 4H / Daily for the day's draw — see §7 before you gate trades on it |
| Session | **09:30 – 13:30 ET** for entries; flat by 15:55 ET |
| Indicators needed | ATR(14). Nothing else is required. |

At MNQ ≈ 29,500 the 5m RTH ATR(14) runs about **43 points** (p25 32 / p75 58),
and the daily range is around 630 points. So the numbers below are big compared
with older ICT material written when NQ was at 12,000 — scale by ATR, never by
a fixed point count.

---

## 3. The five checks, in order

Run them in this order every time. If a check fails, there is no trade — do not
go looking for a different reason to take it.

**① Is there liquidity to raid?**
Mark, before the open: prior day high/low (PDH/PDL), the Asia range
(18:00–02:00 ET) high/low, the London range (02:00–08:00 ET) high/low, and any
untaken 5m swing highs/lows from the current leg. These are the pools. Equal
highs/lows are the highest-quality version of the same thing.

**② Did price raid one and get rejected?**
The candle must trade **through** the level and **close back inside it**. A
close beyond the level is not a sweep — that is a breakout, and you are on the
wrong side of it. Depth should be meaningful but not a collapse: the script
accepts 0–3 ATR beyond the level and ignores anything past that.

**③ Did structure actually shift?**
Within about 6 bars of the raid, a candle must **close** through the swing point
that stood before the sweep — the last 5m swing high for a long, swing low for
a short. Closing through, not wicking through. The shift candle needs a real
body: at least 0.25 ATR (~11 points). A doji through the level is not
displacement.

**④ Does the higher timeframe agree?**
30m **and** 1H structure must both point the same way as your trade. A
timeframe is bullish once it closes above the high of its last 3 candles and
stays bullish until it closes below the low of its last 3. If either disagrees,
**skip it.** This is the single most important filter in the whole model — see
§7.

**⑤ Is it inside the window?**
09:30–13:30 ET. No new entries after 13:30. Max 2 trades a day; when both are
done you are finished whether you are up or down.

---

## 4. Entry

**Enter on the close of the shift candle.** Market order, fills on the next bar.

That contradicts what most ICT material teaches — wait for the retracement into
the fair value gap and buy the discount — and I want to be straight about why I
am telling you to do it differently. When I tested both, the FVG limit entry got
filled on roughly **40% of setups, and they were the wrong 40%**: the setups
that ran straight to target never came back to fill the order, so the limit
collected the ones that stalled. Entering on the shift close produced about
**2.5× the trades and a better profit factor** on the same signals.

The script keeps all three options (`Entry Mode`):

- `On MSS close` — the default, and what the testing supported.
- `FVG limit` — the textbook version, if you want to see it for yourself.
- `FVG limit, else market` — rests the limit for 6 bars, then takes it at market.

If you do use a limit, put it at the **near edge** of the gap (`FVG Entry Depth`
= 0), not at 50%. Deeper limits fill even less often.

---

## 5. Stop and target

**Stop: 1.0 × ATR(14) from entry** — about 43 points, $87 on one MNQ contract.

If the swept extreme is *closer* than that, use the swept extreme plus a small
buffer instead. Never place it further out than 1 ATR, and never tighter than
0.5 ATR — measured adverse excursion on valid setups averaged about 1.5 ATR from
the shift close, so anything under half an ATR is sitting inside the noise the
sweep itself just made. Tight stops are what killed every early version of this.

**Target: 2R** — about 87 points.

That is the default because it is where the measured excursion profile actually
lives: after an aligned setup, price reached 1 ATR about 57% of the time and
2 ATR about 43%. Aiming at 4R or 5R sounds better and is not supported by the
distribution. `Target opposing liquidity` is available if you prefer to aim at
the next pool (floored at 1.5R, capped at 4R).

**Management**
- Stop to breakeven at **+1R**. On by default.
- Optional partial at +1R (off by default — it lowers variance and lowers
  expectancy; your call, not a free lunch).
- Flat at 15:55 ET, always. No overnight.

---

## 6. Position sizing

Fixed fractional. Risk a constant dollar amount, let the ATR decide contracts:

```
contracts = risk_$ / (stop_points × $2)
```

At a 43-point stop, $250 of risk is 2 MNQ contracts ($86 risk each). Set
`Size position by risk` in the script and give it your risk-per-trade. On a
$25,000 account, 1% is $250 — that is the top of what I would use, not a floor.

---

## 7. What the research actually said — read this

I built the model in Python and tested it on MNQ, NQ, ES, MES, QQQ and SPY
(Yahoo data: ~71 days of 5m, ~875 days of 1H), with commission and slippage
charged. The scripts are in `backtest/` so you can re-run all of it.

**What held up:**

1. **HTF alignment is the filter that matters.** Taking the 5m shift *against*
   30m/1H structure lost money on 5 of the 6 markets tested (MNQ: −0.76 ATR per
   event, t = −2.18). Taking it *with* 30m and 1H, and skipping the PM session,
   was positive on 5 of 6 (MNQ: +1.26 ATR, t = +2.10). If you take one thing
   from this document, take this one.
2. **The NY PM session is the worst slice** of the day, consistently — negative
   on MNQ 5m, ES 5m and MNQ 1H. Hence the 13:30 cutoff.
3. **Entry timing beat every other execution parameter.** See §4.
4. **Stops under ~0.75 ATR destroy the edge** regardless of everything else.

**What did NOT hold up — and I would rather tell you than let you find out live:**

5. **The raw setup has no edge on its own.** Unfiltered, a sweep + MSS on MNQ 5m
   produced a forward move of −0.06 ATR with 43% of events going the right way,
   and MFE 0.93 vs MAE 1.05 — very slightly worse than a coin flip. Every bit of
   the edge in this model comes from the filters, not from the pattern.
6. **4H and Daily alignment did not help.** On all three 5m markets, requiring
   4H agreement made results *worse* than not requiring it. That is why
   `Also require a third HTF` ships OFF. Keep using 4H/Daily to decide what your
   day's draw is and where you are targeting — just don't use it as a hard gate
   until you've tested it on your own data.
7. **On the long sample it does not work.** Run over 875 days of 1H data
   (390–970 trades), the same logic produced a profit factor of **0.80–1.01**,
   and the HTF filter made it *worse* there rather than better. The good 5m
   numbers come from 71 days and ~190 trades pooled across six correlated
   symbols.
8. **The 5m sample is too small to prove anything.** MNQ and NQ are the same
   market on two feeds, and over the same 71 days they came out with *opposite
   signs* (+0.6R vs −4.3R). That is a direct measurement of how much noise there
   is at this sample size. A real edge of the size worth trading would need
   several hundred trades to separate from zero, and I do not have the data for
   that — Yahoo caps sub-hourly history at ~60 days.

**Honest bottom line:** this is a coherently built, correctly specified model
whose filters have a defensible rationale and consistent-direction evidence
behind them. It is **not** a validated edge, and I am not going to tell you it
is. Treat the defaults as a well-reasoned starting hypothesis, not a result.

---

## 8. On VWAP, since you asked

Test result: trading on the correct side of VWAP was better than the wrong side
on MNQ (−0.11 ATR vs −0.61) and on QQQ (+0.28 vs −0.34), and made no difference
at all on ES (+0.046 vs +0.055). So the effect points the right way but it is
weak, it is 2-of-3, and — this is the important part — it is **largely redundant
with the 30m/1H structure filter**, because being above VWAP and being in a
bullish intraday structure are mostly the same statement. On MNQ, 68 of 89
events were already on the "right" side of VWAP.

So: **do not add VWAP as a third direction filter.** You would mostly be
re-filtering what the HTF check already caught, at the cost of trades. The
script includes it (`Require price on the correct side of VWAP`, default off)
so you can verify that yourself.

Where VWAP genuinely earns its place on MNQ is as **context, not permission**:
as a magnet/target for a trade taken from an extreme, as the line that tells you
whether the session is trending or balancing, and as a place liquidity rests.
Use it to decide *where you are going*, not *whether you are allowed to go*.

---

## 9. How to backtest this properly

You said you'd run it yourself. To make that a fair test:

1. Load it on MNQ1! 5m. The script already charges $0.52/side commission and 1
   tick of slippage — leave those on. A backtest without them is fiction.
2. **Do not judge it on fewer than ~100 trades.** At 1–2 trades a day you need
   several months. Below that you are reading noise.
3. Change **one input at a time** and write down what happened before you change
   the next. The fastest way to fool yourself is to sweep everything at once and
   keep the best cell — that cell is almost always noise, which is exactly what
   happened to my first tuned configuration (it looked good on MNQ and came out
   at PF 0.70 on ES).
4. Test forward, not just back: tune on the first 60% of the range, then check
   the last 40% untouched. If it only works on the whole sample, it doesn't work.
5. Sanity-check it on ES/MES too. A rule that only works on one instrument is
   usually fitted to that instrument's noise.

If it comes out positive on a few hundred trades with costs on, out of sample —
then you have something, and I'd trust that far more than anything I could
produce from 71 days of free data.
