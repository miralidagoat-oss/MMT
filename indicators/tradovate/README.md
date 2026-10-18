# Resting Order Levels — Tradovate indicator

`restingOrderLevels.js` draws labeled **support and resistance at prices where
real resting limit orders got filled and held price**.

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
S1 21000.00 | 1.5k bids filled | held 2x
R1 21020.00 | 862 offers filled | new  << TESTING
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
| `labelAlignment` | Right of last bar | If labels sit on top of the candles, switch to "Left of last bar" (Tradovate's docs don't say which way these values point) |
| `labelOffsetPx` | 8 | Gap between the last bar and the labels. Increase the chart's right margin if labels are cut off |

## Caveats

- **Past fills are not guaranteed future orders.** A level shows where size
  defended before. The same participants may not be there next time, which is
  why levels fade and break.
- **Not backtested yet**, unlike the Pine indicator in this repo. Treat the
  levels as context for your read of the tape, not as signals.
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
absorption events. It checks that levels are created, held, broken and
flipped correctly, that the graphics are valid, that results do not change
with how many live ticks arrive, and that the fallback modes behave.

## Wanting the actual DOM?

Live book data, meaning resting orders that have **not** traded yet, is only
available outside the chart. Tradovate's API (`md/subscribeDOM`) provides it
and needs API access on the account. A separate tool could track large
resting orders that persist (filtering out flashed and pulled size) and list
those levels. Tradovate's API cannot draw them on its charts, so they would
show in their own window.
