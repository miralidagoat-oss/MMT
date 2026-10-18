# Resting Order Levels — Tradovate indicator

`restingOrderLevels.js` draws labeled **support and resistance at prices where
real resting limit orders got filled and held price**. Each zone shows the
**measured** chance that price reverses there, counted from what actually
happened at these zones on your own chart.

## Why it uses fills and not the DOM

Tradovate's custom-indicator API gives an indicator bar data only. It has no
access to the DOM / Level 2 book (see `BarInputEntity` in Tradovate's
[official typings](https://github.com/tradovate/custom-indicators/blob/master/typescript/TimeSeries.d.ts)).
It does give each bar's **volume profile**: for every price, the contracts
traded at the bid and the contracts traded at the ask.

- **Volume at the bid** = sell market orders filling **resting buy limits**.
- **Volume at the ask** = buy market orders filling **resting sell limits**.

So the footprint is a record of resting orders that actually traded. This has
one advantage over watching the DOM: displayed size can be pulled or spoofed,
but filled size cannot.

## How a level is made

| Event | Rule |
|---|---|
| **Support born** | Unusually large bid fills (≥ `absorptionMultiple` × normal volume per price) at the bar's low edge, and the bar closes back up at least `rejectionTicks`. The resting buyers absorbed the selling and held. |
| **Resistance born** | Same at the high edge, using ask fills, with the bar closing back down. |
| **Held** | A later bar trades into the level (within `touchTicks`) and closes back on the correct side. The hold count goes up, and the new fills there are added to the level's total. |
| **Re-absorbed** | A new absorption within `mergeTicks` merges into the existing level. |
| **Broken** | A bar **closes** more than `breakTicks` through the level. The level is removed, or flips side if `flipBrokenLevels` is on. Wicks through a level do not break it. |
| **Faded** | Strength halves every `halfLifeBars`. A level untested for `maxIdleBars` is dropped. |

## Install

1. In Tradovate, open **Code Explorer** and create a new indicator.
2. Paste the full contents of `restingOrderLevels.js` and save.
3. Add **Resting Order Levels (S/R)** to a chart. It is listed under the
   **Order Flow** tag.
4. Check the status line in the chart's top-left corner:
   - `footprint (per-price bid/ask fills)`: working as designed.
   - `bar-level estimate`: the chart is not delivering per-price data. Levels
     then fall back to whole-bar bid/ask volume plus a rejection wick. They are
     coarser and are marked with `~` in front of the fill count. Use a chart
     style that carries per-price bid/ask volume to get the real version.
   - `NO bid/ask volume`: this chart has no aggressor data, so nothing can be
     detected.

## Reading the chart

```
S1 21000.00 | 65% reversal ±13 vs 54% random (1st test, n=48) | 1.5k bid fills | held 2x
R1 21020.00 | 58% reversal ±7 vs 54% random (all tests, n=212) | 862 offer fills | new  << TESTING
```

- **S1/R1** are the nearest support/resistance to price, then S2, S3, and so
  on. By default the five strongest levels per side are shown.
- **Line thickness** shows strength. A level being tested right now is drawn
  at the thickest width and labeled `<< TESTING`. It is labeled `<< BREAKING`
  when the live bar is beyond the break distance (the break only counts once
  the bar closes).
- **Dashed lines** are flipped levels: broken support now acting as
  resistance, or the reverse.
- **Small dots** mark the bars and prices where an absorption happened.

## Reversal odds — what the percentage means

The percentage is **counted, not modeled or assumed**. Every time price comes
back to a zone on your chart, the indicator starts a **test**:

- **Reversal**: price moves `bounce` **away** from the zone, in the zone's
  favor, before it moves `bounce` **through** it, within `horizonBars` bars.
- Anything else counts as **no reversal**. That includes going `bounce`
  through first, both happening in one bar, or neither happening in time.
- `bounce` is shown on the status line. By default it is 1.5 × the average bar
  range, for example about 7.50 points on 1-minute NQ.

`65% reversal ±13 (1st test, n=48)` means: of the 48 times price came back to a
zone for the first time on this chart, 31 (65%) reversed by that definition.
The true rate is likely between 50% and 77% (a 95% Wilson interval).

- **Test buckets.** Zones are grouped by **1st, 2nd, and 3rd+ test**, because
  how often a zone has already been hit can matter. If a bucket has fewer than
  `minSamples` (20) tests, the label uses all tests together and says so. If
  there are fewer than 20 tests in total, it shows
  `reversal odds: collecting (n=7)` instead of a number.
- **"vs 54% random".** The indicator runs the exact same test at random prices
  near the market. Each one is chosen before the bar opens and tested only if
  the bar trades to it, exactly like a zone. **A zone only matters by how much
  it beats this number.** On data where zones mean nothing, both numbers come
  out the same, which is checked in the tests below. If your zones show 55% vs
  54% random, they have no real edge on this chart.
- **Status line.** It shows the totals: all zone tests against all random
  tests, each with its sample size.

### Rules that keep the number honest

- **Only closed bars are counted.** The live bar never feeds the statistics,
  so the number never uses future data.
- **Every return to a zone counts**, including returns where the zone broke on
  that same bar. Counting only zones that survived would inflate the rate.
- **Bar data can't show which came first inside one bar.** So the touch bar's
  own high or low is never counted as a reversal, and a bar that reaches both
  sides counts as **no reversal**. This makes the number conservative.
- **One open test per zone at a time.** A new test can't start on the bar that
  decided the previous one, so a single price move is never counted twice.
- **Deterministic.** The random prices are fixed by bar number, so reloading
  the chart gives the same statistics.

### Limits

- **It describes the past on the history loaded on your chart.** More loaded
  history means more tests and a smaller ±. A different market, timeframe or
  period can give a different rate, so check `n` and the ± before trusting a
  number.
- **The ± is a minimum.** Two nearby zones hit by the same move are partly the
  same event, so the real uncertainty is a bit wider than the ± shown.
- **This is not a prediction.** A zone at 65% still fails about a third of the
  time.

## Settings

The tick-distance settings default to **0 = auto**. Auto scales each distance
to the average bar range, so the same defaults work on ES (about 5-tick
1-minute bars) and NQ (about 20-tick bars). The status line shows the values
in use. Enter a number to fix a distance in ticks.

| Setting | Default | Meaning |
|---|---|---|
| `absorptionMultiple` | 3 | Fills at one price must be at least this many times the normal one-sided volume per price |
| `minContracts` | 0 | Absolute floor for that peak (for example, 100 on NQ to ignore small prints) |
| `edgeTicks` | auto (20% of range, min 2) | How close to the bar's high or low the absorption must be |
| `rejectionTicks` | auto (25%, min 2) | How far the close must end up from the absorption price |
| `touchTicks` | auto (10%, min 1) | How close a later bar must come to count as a retest |
| `mergeTicks` | auto (25%, min 2) | Absorptions this close together become one level |
| `breakTicks` | auto (30%, min 2) | How far a close must go through a level to break it |
| `flipBrokenLevels` | off | Broken support becomes resistance and vice versa |
| `halfLifeBars` | 300 | Strength decay (0 = none) |
| `maxIdleBars` | 1000 | Drop levels untested this long |
| `levelsPerSide` | 5 | How many levels to draw per side |
| `baselineBars` | 50 | Lookback for "normal" volume |
| `barModeMultiple` | 1.8 | Threshold used only in bar-level fallback mode |
| `showOdds` | on | Show the measured reversal odds on labels and the status line |
| `bounceTicks` | auto (1.5 × range, min 4) | The move that counts as a reversal, and the same move the other way counts as a failure |
| `horizonBars` | 60 | A test not decided within this many bars counts as no reversal |
| `minSamples` | 20 | Fewest tests before a percentage is shown (per test-number bucket, otherwise for all tests together) |
| `labelAlignment` | Right of last bar | If labels sit on top of the candles, switch to "Left of last bar" (Tradovate's docs don't say which way these values point) |
| `labelOffsetPx` | 8 | Gap between the last bar and the labels. Increase the chart's right margin if labels are cut off |

## Caveats

- **Past fills are not guaranteed future orders.** A level shows where size
  defended before. The same participants may not be there next time, which is
  why levels fade and break.
- **The odds come from your chart's own history.** No result from other data
  is built in. There is no fixed claim of an edge; the "vs random" number
  tells you whether there is one on your market and timeframe.
- **Not run inside Tradovate yet.** The code follows Tradovate's official
  indicator typings and community indicators that use the same calls
  (`d.profile()`, graphics `LineSegments`/`Text`). It was exercised with the
  offline harness below, which mimics how the app calls `map()`, including
  repeated calls on the live bar. If something renders oddly, open an issue
  with a screenshot.

## Offline test harness

```
node indicators/tradovate/test/harness.js
```

The harness runs the indicator on synthetic footprint bars with planted
absorption events. It checks that:

- levels are created, held, broken and flipped correctly;
- the graphics are valid;
- results do not change with how many live ticks arrive;
- the fallback modes behave.

For the reversal odds it checks:

- each outcome rule on hand-built bars (reversal, failure, both in one bar,
  touch-bar wick, timeout, zones broken on the touch bar, test numbering);
- the ± margin against an independent computation;
- that results up to any bar never change when later bars are added (no
  lookahead).

Two statistical checks guard the comparison itself:

- **On bars cut from a pure random walk**, with resting-order prints that have
  no effect on price, zones and random prices come out the same in three
  seeds: 53.8% vs 54.4%, 55.2% vs 54.6%, 53.4% vs 54.3%. The comparison does
  not invent an edge.
- **When zones really do make price bounce**, the edge shows up: 100% vs 63%.

## Wanting the actual DOM?

Live book data, meaning resting orders that have **not** traded yet, is only
available outside the chart, through Tradovate's API. The companion tool
[`tradovate-dom/`](../../tradovate-dom) uses it. It tracks large resting
orders that persist, ignores flashes, flags pulled (spoofed) size, and shows
the levels in a terminal and a local dashboard. It needs API access on the
account. You can try it without an account using `--simulate`.
