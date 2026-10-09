# Draw on Liquidity (DOL) Engine

`indicators/draw_on_liquidity.pine` — Pine Script v6, overlay.

A clean-room reimplementation of the behaviour described for the TradeAxis
DOL indicator, built from its public description and screenshot. It keeps a
constrained pool of liquidity levels, scores each one out of 100, and draws
the highest-scoring level as the **Draw on Liquidity**: a glowing target line
inside a dashed zone band, a `Target: BEFVG / PoT: 70.1%` label, and a dashed
connector from the current close.

## Install

Pine Editor → paste the file → **Add to chart**. Keep the chart timeframe at
or below the mode's execution timeframe (see below).

## Trading modes

| Mode | HTF (structure / bias) | STF (sub-structure, BSL/SSL) | Execution (FVG / OB) |
|---|---|---|---|
| Swing | D | 4H | 1H |
| Day Trading (default) | 4H | 1H | 15m |
| Scalping | 1H | 15m | 5m |
| Custom | any | any | any (keep Exec ≤ STF ≤ HTF) |

If the chart timeframe is *higher* than a mode timeframe, the engine
promotes that timeframe to the chart's and shows a warning in the
dashboard, so it never requests lower-timeframe data. Not supported on
tick, range, Renko or other non-time-based charts.

## The level pool

| Tag | What it is | Side |
|---|---|---|
| BSL / SSL | STF swing high / low (resting buy- / sell-side liquidity). Equal highs/lows within tolerance merge into one level and raise its density. | above / below |
| BEFVG / BUFVG | Execution-TF 3-candle fair value gap (min size × ATR) | above / below |
| BEOB / BUOB | Extreme candle of the leg that broke the last execution-TF swing | above / below |
| BEBRK / BUBRK | Breaker: an order block that price closed through, now acting from the other side | above / below |
| BEiFVG / BUiFVG | Inversion FVG: an FVG that price closed completely through | above / below |

Lifecycle:

- A level is a **candidate** until its draw point is reached. For zones the
  draw point is the consequent encroachment (50%) or the near edge
  (setting); zones count as reached on a touch. BSL/SSL use the swing price
  and must be traded *through* (a sweep). Swept BSL/SSL are deleted; reached
  zones stay on the chart, faded, as support/resistance.
- An FVG that closes completely through flips to an iFVG; an OB that does
  the same flips to a breaker. A flip makes it a new, unmitigated candidate.
- An iFVG is deleted once more than *N* execution-TF candles close inside it
  (default 2), or one closes beyond its far side. A breaker is deleted when
  price closes back through it.
- Levels beyond **Max ATR Distance** (default 8 execution-TF ATR) can't be
  targeted; beyond **Purge ×** that distance (default 2×), or older than
  **Max Level Age**, they are deleted. When the pool is over its cap
  (default 40), reached zones go first (oldest first), then the weakest
  candidates. The current DOL is never evicted.

All close-based rules use execution-TF closes, so a level behaves the same on
a 1m chart and a 15m chart.

## Score (0–100)

`score = 100 × (wP·P + wF·F + wC·C + wD·D) / (wP + wF + wC + wD)`,
default weights 30 / 20 / 30 / 20.

- **Proximity P** — `1 − (d / MaxATR)^1.5`, where *d* is the ATR-normalised
  distance from the close to the draw point; 0 beyond Max ATR Distance.
- **Freshness F** — `0.5^(age / half-life)`, age in execution-TF bars since
  the level was detected or last flipped / reinforced (default half-life 48).
  Ages, Max Level Age and the PoT horizon count real execution bars, so
  overnight, weekend and holiday gaps don't count as elapsed time.
- **Confluence C** — half anchor overlap, half structural bias.
  Anchors within ±0.25 ATR of the level: PDH/PDL (1.0 each), PWH/PWL (1.0),
  HTF swing high/low (0.8), PD and HTF equilibria (0.6), daily, weekly,
  NY midnight and NY 09:30 opens (0.6); combined as `1 − e^(−sum)`.
  Bias: HTF (60%) and STF (40%) structure (bias flips on a close through the
  last confirmed swing); 1 when the level is on the side the structure
  points to, 0 against it, 0.5 with no bias yet.
- **Density D** — measured in the bars *before* the level formed: equal
  highs/lows resting at the window extremes, coiling (window range vs a
  random walk's), an inducement sweep (a candle took the window's high/low
  and closed back inside), and relative volume (1H for zones, the pivot bar
  for BSL/SSL; neutral when the symbol has no volume).

The highest-scoring candidate within range and above **Min Score** (default
30) is the DOL. A challenger has to beat the current DOL by the
**hysteresis** (default 8 points) to replace it, which stops the target
flickering between near-equal levels.

**PoT** in the label is the composite score by default. Setting *PoT Display*
to *Self-Calibrated* shows instead the realised touch rate of past DOL
targets in the same score bucket, once that bucket has enough samples.

## Non-repainting

- Every higher-timeframe value comes from closed bars (`expr[1]` with
  `lookahead_on`). When the execution TF equals the chart TF the chart's own
  confirmed bar is used, so there is no added lag.
- Pool, score and DOL state change only on confirmed chart bars. On a live
  bar only the connector line follows price.
- Levels are drawn at the time of the candle that formed them
  (`xloc.bar_time`).
- A level built from a bar's own data is never touch-checked on that same
  bar.

## Dashboard and alerts

Dashboard: mode and timeframes, HTF/STF bias, target, PoT, each pillar's
points, distance in ATR, pool size, the PoT self-audit (every newly selected
DOL is graded hit/miss over the next *N* execution-TF bars, bucketed by
score), and a timeframe status line.

Alerts: **New DOL Target** and **DOL Delivered**, plus `alert()` messages
with the level type, price and score (once per bar close).

## Validation

`backtest/dol_validate.py` is a bar-for-bar Python port of the engine on the
local path (chart TF = execution TF), with STF/HTF resampled from the same
data and read with the indicator's closed-bar semantics. Market-data APIs
were unreachable from the build environment, so it was run on the two
intraday-capable samples bundled with `pip install backtesting`: EURUSD 1h
(5,000 bars, 2017–18; Swing mode equivalent) and GOOG daily (2,148 bars;
D / W / 4W). Horizon: 30 execution bars. Default settings throughout.

Each newly selected DOL, graded touched / not touched:

| score bucket | EURUSD n | EURUSD touched | GOOG n | GOOG touched |
|---|---|---|---|---|
| 50–60 | 44 | 59% | 24 | 54% |
| 60–70 | 190 | 71% | 135 | 65% |
| ≥ 70 | 523 | 74% | 454 | 75% |
| all | 766 | **72%** | 617 | **72%** |
| *random eligible level, same moments* | | *42%* | | *45%* |
| *nearest eligible level, same moments* | | *82%* | | *78%* |

Every eligible level, sampled every 5 bars (EURUSD n = 8,689; GOOG n = 4,159):

| score bucket | < 40 | 40–50 | 50–60 | 60–70 | ≥ 70 | AUC |
|---|---|---|---|---|---|---|
| EURUSD touched | 19% | 30% | 42% | 56% | 62% | 0.68 |
| GOOG touched | 23% | 34% | 48% | 57% | 73% | 0.69 |

What this shows:

- **The score is monotonic and roughly calibrated.** Higher score means a
  higher touch rate on both datasets, and a selected DOL labelled
  "PoT 70%+" was touched 74–75% of the time.
- **Proximity carries most of the touch signal** (AUC 0.77–0.78 on its own). The
  nearest level is touched more often than the DOL — expected, since the DOL
  deliberately trades some touch probability for structure, freshness and
  confluence. The DOL is touched far more often than a random eligible level.
- **The other pillars are market-dependent.** Holding distance fixed, none
  of them moved touch rate consistently: freshness −2 points (EURUSD) / −4
  (GOOG), confluence −2 / +6, density +1 / −3. They stay at the described
  weights; tune them per market rather than trusting these defaults
  universally.
- Raising hysteresis from 3 to 8 cut target changes by 23% (998 → 768 on
  EURUSD) with no loss of touch rate, so 8 is the default.

Reproduce:

```
pip install backtesting
python3 backtest/dol_validate.py --bundled                         # EURUSD 1h
python3 backtest/dol_validate.py <GOOG.csv> 1440 10080 40320       # path printed by: python3 -c "import backtesting,os;print(os.path.dirname(backtesting.__file__))"
python3 backtest/dol_validate.py <your.csv> 15 60 240              # Day Trading mode on your own data
```

## Caveats

- Two bundled samples are a small evidence base; validate on your market.
- "Touch" is not "profit": PoT measures whether price reaches the draw point
  within the horizon, not whether a trade toward it pays.
- The Python port covers the local path; on charts below the execution TF
  the indicator receives the same events one chart bar later (closed-bar
  data), which the port does not simulate.
- The script was checked with a Pine v6 grammar parser, a scope-aware lint
  (undeclared names, globals modified inside functions, call arity, unknown
  built-ins) and the Python port. TradingView's own compiler was not
  available in the build environment.
