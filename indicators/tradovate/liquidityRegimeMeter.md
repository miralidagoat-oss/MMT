# Liquidity Regime Meter — Tradovate indicator

`liquidityRegimeMeter.js` answers two questions in its own panel below the
chart:

1. **Is the market DEEP or THIN right now?** That is, how far is price moving
   for each contract of net aggressive buying or selling, compared with the
   same time of day in earlier sessions?
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
| 🔵 Blue | **DEEP** (bottom third) | Net aggression is moving price **less** than it usually does at this time of day. It's getting absorbed. |
| ⚪ Grey | **NORMAL** (middle third) | |
| 🟠 Orange | **THIN** (top third) | Net aggression is moving price **more** than usual for this time of day. |

**Light line:** "flow explains X%". This is how much of the last 30 bars' price
change the net aggressive volume explains (the regression R²). It describes
the market; it doesn't predict anything.

**Text, top-left of the panel** (long lines wrap; continuation rows are
indented):

```
NOW: THIN - impact in the 81st percentile vs 09:20-09:45 ET in prior sessions
impact 1.90 ticks per 100 net contracts | flow explains 41.0% of price change (last 30 bars) | volatility 74th pct
Your zones' reversal rate by state | reversal = 1.5x avg bar range in favor before the same against, within 60 bars |
    distances used 5.25-9.75, now 7.50
DEEP 63% ±6 (n=210, 12 sessions; random 55%) | NORMAL 58% ±5 (n=190, 12 sessions; random 54%) |
    THIN 51% ±7 (n=160, 11 sessions; random 52%)
DEEP minus THIN: raw +12 ±8 | same volatility (calm, mid, volatile) +9 ±8 | odd/even sessions agree: yes
vs volume-only at equal volatility (calm, mid): impact gap +10 ±9, volume-only gap +4 ±7, bid/ask split adds +6 ±6
Verdict: at equal volatility your zones reverse more in DEEP than in THIN; the bid/ask split predicts it better
    than a volume-only measure. Favor zone fades in DEEP
Sessions loaded 14 | default settings | bid/ask volume coverage 99%
zone tests: 560 state-tagged, 140 excluded (window building 30, warm-up 100, unclear 10) |
    fails hitting both sides in one bar: DEEP 4% NORMAL 5% THIN 9%
```

*(These numbers only illustrate the layout. Yours are counted on your chart.)*

The panel needs about 200 pixels of height for all of it. Drag the panel
divider up, or set `showDetails` off to keep only the NOW, zone-rate and
Verdict lines.

**Read the Verdict line first.** It is one of these:

| Verdict says | What to do |
|---|---|
| *collecting - needs 30 tests from 6 sessions in both DEEP and THIN* | Not enough history yet. The line says how many you have. Ignore the colors for now. |
| *at equal volatility your zones reverse more in DEEP than in THIN … Favor zone fades in DEEP* | The state is a useful filter on this chart. Favor zone fades while the columns are blue, and be careful when they are orange (or the other way round if it says THIN). |
| *… But DEEP zones do not clearly beat random prices yet* | The state separates better and worse periods, but even in the better state your zones are not clearly better than random prices. Don't treat it as an edge yet. |
| *… the bid/ask split predicts it better than a volume-only measure* | The edge comes from who was aggressing, not just how much traded. |
| *… a volume-only measure shows a similar gap, so it may be liquidity in general* | The colors still work as a filter, but plain volume tells you about as much. |
| *… a volume-only measure predicts it better than the bid/ask split* | Plain volume is the better gauge here. |
| *… cannot tell yet whether the bid/ask split adds anything* / *… not available yet* | Not enough tests to compare the two measures. The rest of the verdict still holds. |
| *… (overall DEEP shows the lower rate - volatility masks it)* | Overall the numbers point the other way, because one state mostly happens in more volatile periods. The same-volatility comparison is the one to trust. |
| *odd and even sessions disagree* | The gap isn't consistent from session to session. Don't rely on it yet. |
| *too few tests to check odd vs even sessions yet* | The gap shows, but its consistency can't be checked yet. Wait. |
| *explained by volatility* | DEEP only looked better because DEEP periods were calmer. At equal volatility the colors add nothing. Watch the volatility percentile instead. |
| *too uncertain* / *too few tests at equal volatility* | There is a gap overall, but not enough tests to tell whether it is just volatility. Wait. |
| *no measurable DEEP/THIN difference* | Ignore the colors for zone fades on this chart. |

The verdict talks about what **predicts** zone reversals, never about why.

## How every number is made

**Impact (the DEEP/THIN state)**
- **Inputs:** for each closed bar, its price change in ticks and its net
  aggressive volume (volume at the ask minus volume at the bid).
- **Fit:** over the last 30 closed bars of **this session**, the meter fits a
  straight line through those pairs. The slope is ticks moved per contract
  (shown per 100 contracts); R² is how much of the price change it explains.
- **Outliers:** before the fit, extreme bars are clipped to ±4 robust standard
  deviations (median ± 4 × 1.4826 × median absolute deviation) **of that same
  30-bar window**, so one news spike can't take over the fit, and a quiet or
  wild period earlier in the day never rescales the current one.
- **Ranking against the same clock time:** the day is cut into 5-minute slots
  in New York time (daylight saving handled). Each session keeps the first
  reading of each slot. The current slope is ranked against the readings
  within ±10 minutes of the same clock time in up to 20 earlier sessions. The
  market is naturally thinner overnight than after the open, so ranking against
  all hours would mostly just say "it's night". The NOW line names the clock
  span it compares with, such as "09:20-09:45 ET".
- **Warm-up:** ranking starts once at least 3 earlier sessions have readings
  near this clock time, and at least 9 such readings exist. Until then the NOW
  line says exactly what it has and what it needs.
- **When there's no state:** the state is **unclear** (no color) when net
  aggressive volume didn't vary, when price moved against net aggression, or
  when net flow explains less than 5% of the price change. The NOW line says
  which.
- **Session breaks and halts:** the window starts over at each new trade date,
  and after a pause inside one trade date longer than 30 minutes (on 1-minute
  bars; 3 bars on bigger minute bars; 60 minutes on tick and volume bars). The
  price jump across a break isn't caused by order flow, so it is never used.
- **No repainting:** the state shown on a bar uses only bars that had already
  closed before it. It never changes while the bar forms.

**Zone odds**
- **Same zones:** the meter re-detects your zones with the **exact same rules
  and defaults** as Resting Order Levels. The test harness checks that the two
  produce identical zone tests on the same data.
- **Same test:** every return to a zone is the same test as the zone labels
  use. Did price move `bounce` (1.5 × average bar range by default) in the
  zone's favor before moving `bounce` through it, within 60 bars? The touch bar
  can only fail, and a bar that hits both sides counts as a fail. Because the
  average bar range moves, the line shows the smallest and largest distance
  among the counted tests, and the current one.
- **Filed by state:** each test is filed under the state in force when price
  came back to the zone.
- **Random comparison:** "random X%" is the same test at random prices near
  the market, in the same state. Each is chosen before the bar opens and
  counted only if price trades there.

**Margins (±)**
- They are 95% intervals that count **each session as one unit** (a
  delete-one-session jackknife with Student t). Many tests on the same day
  aren't treated as independent evidence.
- Each margin uses only the sessions that actually hold the tests it reads.
  If DEEP happened in only 3 of 20 sessions, the DEEP margin is built from
  those 3 sessions, and it is wide.
- A rate's margin is never narrower than the plain binomial (Wilson) interval
  of its tests. A gap whose sessions all agree exactly shows "margin
  unstable" instead of a false ±0.
- So they are wider than the ± on the zone labels, on purpose.
- A state's rate is only shown once it has 30 tests from 6 sessions.

**DEEP minus THIN gaps**
- **raw:** the plain difference in reversal rate.
- **same volatility:** the difference compared only within the same
  volatility level (thirds of the 30-bar average range, ranked the same way as
  impact), using a Mantel-Haenszel weighted average. This removes "DEEP was
  just calmer". The thirds that had enough DEEP and THIN tests to use are
  listed in brackets.
- **vs volume-only:** the same comparison using the Amihud measure (price
  movement per contract traded, ignoring which side aggressed). Both gaps are
  computed on the **same** volatility thirds, and "bid/ask split adds" is the
  difference between them. It shows how much the bid/ask information adds over
  plain volume.
- **odd/even sessions agree:** the same-volatility gap points the same way in
  odd-numbered and even-numbered sessions. "n/a" means a half doesn't have
  enough tests to check.

**What's left out:** tests while the 30-bar window rebuilds after a session
break or halt, during warm-up, or while the state is "unclear" are left out of
the state rates. They're counted on the last line so nothing disappears
silently.

## Setup

1. Paste `liquidityRegimeMeter.js` into Tradovate's Code Explorer as a new
   indicator and save.
2. Add **Liquidity Regime Meter** (tag **Order Flow**) to a **1-minute** chart.
   2- to 5-minute bars, volume bars and 100+ tick bars also work. Bars so big
   that 30 of them are longer than a session (hourly and up) never fill the
   window, and the NOW line says so. If you trade MNQ, use the **NQ** chart;
   MNQ's own order flow is mostly noise.
3. Load as much history as Tradovate allows. The meter needs:
   - **3 sessions** of warm-up before it can rank anything;
   - then **30 tests from 6 sessions** in both DEEP and THIN before it gives a
     verdict.
   That's usually 9+ full sessions. The last lines say how many are loaded and
   how many tests each state has.
4. If you changed any settings on Resting Order Levels, set the same values
   here (the zone settings have the same names and defaults).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `impactWindow` | 30 | Closed bars in each impact fit |
| `r2Gate` | 0.05 | Below this R² the state is "unclear" |
| `minPriorSessions` | 3 | Earlier sessions with readings near this clock time before ranking |
| `poolSessions` | 20 | Earlier sessions kept for ranking |
| `minSessions` | 6 | Sessions a state's tests must come from before its rate or a verdict is shown |
| `minTests` | 30 | Tests per state before its rate is shown |
| `minStratumN` | 10 | DEEP and THIN tests needed in a volatility third to use it |
| `tintCandles` | off | Also color the price candles by state |
| `showStatus` | on | Show the text |
| `showDetails` | on | Show the gap, volume-only and diagnostics lines |
| `textAlignment` | Right of the corner | If the text runs off the panel, switch it |
| `textColor` | grey | Text color |
| `deepColor` / `normalColor` / `thinColor` | blue / grey / orange | Column colors |
| zone settings | same as Resting Order Levels | Keep them equal to your zones indicator |

Changing any setting that affects what is measured prints *"SETTINGS CHANGED
from defaults: results are in-sample"*. Results you tuned on the same history
are no longer an honest test.

## Honest limits

- **It describes the history loaded on your chart.** A DEEP rate of 63%
  still fails 37% of the time, and a different month can differ.
- **Equal measured volatility doesn't prove cause.** The impact state can
  simply be a sharper gauge of a volatility regime than the 30-bar range is.
  That's why the verdict talks about what predicts zone reversals, never why.
- **It reacts with a delay.** The 30-bar window takes up to half an hour to
  catch a sudden change in conditions, such as the open, CPI or FOMC.
- **Coarse early rankings.** With only 3 earlier sessions, the percentile is
  ranked against about 15 readings that overlap in time. It sharpens as
  sessions accumulate (up to 20).
- **Undocumented inputs.** Tradovate doesn't document how it classifies trades
  as bid or ask. Opening prints may have no side. The diagnostics line shows
  what share of volume had a side.
- **History limits are uncertain.** How much history Tradovate loads, and
  whether older bars keep bid/ask volume, varies. The meter shows what it
  actually got.
- **Not run inside Tradovate by the author.** It is tested offline against a
  stand-in for Tradovate's indicator API (below).

## Tests

```
node indicators/tradovate/test/meterHarness.js          # about 25 s
node indicators/tradovate/test/meterHarness.js --full   # 40 random-walk seeds
```

The harness checks:
- **The math, against independent computations:** the regression with
  in-window clipping, percentile ranking, t-values, the Wilson interval, and
  the jackknife and Mantel-Haenszel results.
- **Margins per statistic:** a state seen in 3 of 20 sessions gets a margin
  from those 3 sessions only; identical sessions never show ±0; the impact and
  volume-only gaps use the same volatility thirds.
- **Time and sessions:** New York time across both daylight-saving changes,
  5-minute slots, session handling, halts, warm-up, and that states appear on
  5-minute bars too.
- **Clock-time ranking:** sessions that differ only by hour (thin overnight,
  deep after the open) don't read DEEP by hour; each part of the day gets
  about a third of each state.
- **Zone consistency:** that its zone tests are exactly those of Resting Order
  Levels.
- **No lookahead or repainting:** the live bar never changes, and adding later
  bars changes nothing earlier.
- **Every verdict branch,** worded as described above, with no color names.
- **Volatility control:** an exact case where DEEP only *looks* better because
  it is calmer must be explained away by the same-volatility comparison.
- **Text:** every row fits, the verdict is bold, the details toggle works.

Then it checks three statistical behaviours:
- **Random data shows no edge.** On bars cut from a pure random walk (40
  seeds with `--full`), the margins cover zero in 38 of 40 seeds (a 95% margin
  should miss about 2 in 40). The verdict claimed a DEEP/THIN difference twice
  and never said to favor zone fades.
- **A real effect is found.** When zones really are defended in DEEP
  conditions and give way in THIN ones (at equal volatility and volume), the
  verdict finds the gap in at least 2 of 3 seeds. When DEEP comes from bigger
  trade size, the verdict says to favor zone fades in DEEP (3 of 3 seeds) and
  does not credit the bid/ask split, because plain volume explains it.
- **Edge cases are honest.** Unsupported chart types and charts without
  bid/ask volume say so instead of guessing.
