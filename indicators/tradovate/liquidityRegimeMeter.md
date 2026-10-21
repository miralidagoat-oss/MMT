# Liquidity Regime Meter — Tradovate indicator

`liquidityRegimeMeter.js` answers two questions in its own panel below the
chart:

1. **Is the market DEEP or THIN right now?** That is, how far is price moving
   for each contract of net aggressive buying or selling?
2. **Do your zones reverse more often in one state than the other?** Every
   number is counted from **your real Resting Order Levels zones** on this
   chart. Random prices appear only as a labelled comparison.

It is a companion to `restingOrderLevels.js`. The zones indicator tells you
**where** price has reversed. The meter tells you **when** those zones have
worked better or worse, and whether that difference is real.

## What you see

**Columns:** the impact percentile for each bar.

| Color | State | Meaning |
|---|---|---|
| 🔵 Blue | **DEEP** (bottom third) | Net aggression is moving price **less** than usual for this time of day. It's getting absorbed. |
| ⚪ Grey | **NORMAL** (middle third) | |
| 🟠 Orange | **THIN** (top third) | Net aggression is moving price **more** than usual. |

**Light line:** "flow explains X%". This is how much of the last 30 bars' price
change the net aggressive volume explains (the regression R²). It describes
the market; it doesn't predict anything.

**Text, top-left of the panel:**

```
NOW: THIN | impact 1.90 ticks per 100 net contracts, 81st pct vs RTH open in prior sessions | flow explains 41% of price change (last 30 bars) | volatility 74th pct
Your zones reversed (7.50 in favor before 7.50 against, within 60 bars): DEEP 63% ±6 (n=210; random 55%) | NORMAL 58% ±5 (n=190; random 54%) | THIN 51% ±7 (n=160; random 52%) | all 58% ±4
DEEP minus THIN: raw +12 ±8 | same volatility +9 ±8 | volume-only measure, same volatility +4 ±7 | bid/ask split adds +5 ±6 | odd/even sessions agree: yes
Verdict: ...
Sessions loaded 14 | zone tests: 560 state-tagged, excluded 140 (window 30, warm-up 100, unclear 10) | fails hitting both sides in one bar: ... | bid/ask volume coverage 99% | default settings
```

*(These numbers only illustrate the layout. Yours are counted on your chart.)*

**Read the Verdict line first.** It is one of these:

| Verdict | What to do |
|---|---|
| *collecting* | Not enough sessions yet. Ignore the colors for now. |
| *reverse more in DEEP (blue) … the bid/ask split predicts it better than a volume-only measure* | The state is a useful filter on this chart. Favor zone fades while the columns are blue, and be careful when they are orange (or the other way round if it says THIN). |
| *… a volume-only measure predicts it as well* | The colors still work as a filter. The edge comes from liquidity in general, not specifically the bid/ask split. |
| *odd and even sessions disagree* | The gap isn't consistent from session to session. Don't rely on it yet. |
| *explained by volatility* | DEEP only looked better because DEEP periods were calmer. At equal volatility the colors add nothing. Use the volatility percentile instead. |
| *no measurable difference* | Ignore the colors for zone fades on this chart. |

## How every number is made

**Impact (the DEEP/THIN state)**
- **Inputs:** for each closed bar, its price change in ticks and its net
  aggressive volume (volume at the ask minus volume at the bid).
- **Fit:** over the last 30 closed bars of **this session**, the meter fits a
  straight line through those pairs. The slope is ticks moved per contract
  (shown per 100 contracts); R² is how much of the price change it explains.
  Extreme bars are clipped to ±4 robust standard deviations so one news spike
  can't take over.
- **Ranking against the same time of day:** the slope is ranked against
  readings from the same part of the day in up to 20 earlier sessions. The
  parts of the day, in New York time with daylight saving handled, are:
  overnight 16:00–02:59, pre-market 03:00–09:29, RTH open 09:30–10:29, midday
  10:30–13:59, afternoon 14:00–15:59. The market is naturally thinner
  overnight than at the open, so ranking against all hours would mostly just
  say "it's night".
- **When there's no state:** if net flow explains less than 5% of the price
  change, the state is **unclear** and no color is shown.
- **No repainting:** the state shown on a bar uses only bars that had already
  closed before it. It never changes while the bar forms.

**Zone odds**
- **Same zones:** the meter re-detects your zones with the **exact same rules
  and defaults** as Resting Order Levels. The test harness checks that the two
  produce identical zone tests on the same data.
- **Same test:** every return to a zone is the same test as the zone labels
  use. Did price move `bounce` (1.5 × average bar range) in the zone's favor
  before moving `bounce` through it, within 60 bars? The touch bar can only
  fail, and a bar that hits both sides counts as a fail.
- **Filed by state:** each test is filed under the state in force when price
  came back to the zone.
- **Random comparison:** "random X%" is the same test at random prices near
  the market. Each is chosen before the bar opens and counted only if price
  trades there.

**Margins (±)**
- They are 95% intervals that count **each session as one unit** (a
  delete-one-session jackknife). Many tests on the same day aren't treated as
  independent evidence.
- So they are wider than the ± on the zone labels, on purpose.

**DEEP minus THIN gaps**
- **raw:** the plain difference in reversal rate.
- **same volatility:** the difference compared only within the same
  volatility level (thirds of the 30-bar average range), using a
  Mantel-Haenszel weighted average. This removes "DEEP was just calmer".
- **volume-only measure:** the same comparison using the Amihud measure (price
  movement per contract traded, ignoring which side aggressed).
- **bid/ask split adds:** the difference between the two. It shows how much
  the bid/ask information adds over plain volume.
- **odd/even sessions agree:** the same-volatility gap points the same way in
  odd-numbered and even-numbered sessions.

**What's left out:** tests during warm-up, while the 30-bar window rebuilds
after a session break, or while the state is "unclear" are left out of the
state rates. They're counted on the last line so nothing disappears silently.

## Setup

1. Paste `liquidityRegimeMeter.js` into Tradovate's Code Explorer as a new
   indicator and save.
2. Add **Liquidity Regime Meter** (tag **Order Flow**) to a **1-minute** chart.
   If you trade MNQ, use the **NQ** chart; MNQ's own order flow is mostly
   noise.
3. Load as much history as Tradovate allows. The meter needs:
   - **3 sessions** of warm-up before it can rank anything;
   - **6 more sessions** with zone tests before it gives a verdict.
   That's about 9+ full sessions. The last line says how many are loaded.
4. If you changed any settings on Resting Order Levels, set the same values
   here (the zone settings have the same names and defaults).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `impactWindow` | 30 | Closed bars in each impact fit |
| `r2Gate` | 0.05 | Below this R² the state is "unclear" |
| `minPriorSessions` | 3 | Prior sessions needed for this time of day before ranking |
| `poolSessions` | 20 | Prior sessions kept for ranking |
| `minSessions` | 6 | Sessions with tagged zone tests before any rate or verdict |
| `minTests` | 30 | Tests per state before its rate is shown |
| `minStratumN` | 10 | DEEP and THIN tests needed in a volatility level to use it |
| `tintCandles` | off | Also color the price candles by state |
| `textAlignment` | Right of the corner | If the text runs off the panel, switch it |
| zone settings | same as Resting Order Levels | Keep them equal to your zones indicator |

Changing any setting that affects what is measured prints *"settings changed
from defaults: treat results as in-sample"*. Results you tuned on the same
history are no longer an honest test.

## Honest limits

- **It describes the history loaded on your chart.** A DEEP rate of 63%
  still fails 37% of the time, and a different month can differ.
- **Equal measured volatility doesn't prove cause.** The impact state can
  simply be a sharper gauge of a volatility regime than the 30-bar range is.
  The verdict talks about what predicts zone reversals, never about why.
- **It reacts with a delay.** The 30-bar window takes up to half an hour to
  catch a sudden change in conditions, such as the open, CPI or FOMC.
- **Undocumented inputs.** Tradovate doesn't document how it classifies trades
  as bid or ask. Opening prints may have no side. The last line shows what
  share of volume had a side.
- **History limits are uncertain.** How much history Tradovate loads, and
  whether older bars keep bid/ask volume, varies. The meter shows what it
  actually got.

## Tests

```
node indicators/tradovate/test/meterHarness.js          # about 10 s
node indicators/tradovate/test/meterHarness.js --full   # 40 random-walk seeds
```

The harness checks:
- **The math, against independent computations:** the regression, percentile
  ranking, t-values, outlier clipping, and the jackknife and Mantel-Haenszel
  results.
- **Time and sessions:** New York time across both daylight-saving changes,
  session handling, and warm-up.
- **Zone consistency:** that its zone tests are exactly those of Resting Order
  Levels.
- **No lookahead or repainting:** the live bar never changes, and adding later
  bars changes nothing earlier.
- **Volatility control:** an exact case where DEEP only *looks* better because
  it is calmer must be explained away by the same-volatility comparison.

Then it checks three statistical behaviours:
- **Random data shows no edge.** On bars cut from a pure random walk, the
  margins cover zero in 40 of 40 seeds and the verdict never claims an effect.
- **A real effect is found.** When zones really are defended in DEEP
  conditions and give way in THIN ones (at equal volatility and volume), the
  verdict finds it in 3 of 3 seeds.
- **Edge cases are honest.** Unsupported chart types and charts without
  bid/ask volume say so instead of guessing.
