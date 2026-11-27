# Research round 7: published strategies on the user's MNQ file (written and committed 2026-11-27, before any round-7 result)

The user asked for strategies that could work better than, or alongside, the ONR book. They should come from
research papers, websites and published strategies, and be backtested on their real MNQ data (Dec 2019 - Nov 2026)
in every configuration, including mixes of indicators. This file fixes the rules, the configurations and the tests
before any of them is run. Nothing below is changed after a result is seen. If something has to change, for example
a rule that cannot be computed, the change is added at the end under a dated heading, with the reason.

## Already known (earlier rounds, other data; listed so a reader knows what was in view)

- On the Nasdaq CFD and NQ series 2011-2026 (round 2): last-half-hour momentum (Gao et al.) was slightly reversed
  (t -1.9 / -2.0). Noise-area momentum made +0.016 / +0.020 ADR a day (t 1.8 / 2.5) and the 5-minute ORB +0.03R /
  +0.15R (t 0.5 / 2.6); neither was validated. The European-open overnight drift vanished after 2019 (round 3),
  matching the NY Fed's 2026 note. None of these was tested on the user's MNQ file.
- Literature read for this round (full texts where available):
  - Zarattini, Aziz & Barbon, *Beat the Market* (SSRN 4824172, 2024/2025): the noise area.
  - Zarattini & Aziz, *Can Day Trading Really Be Profitable?* (SSRN 4416622, 2023): the 5-minute ORB on QQQ.
  - Zarattini, Barbon & Aziz, *A Profitable Day Trading Strategy for the U.S. Equity Market* (2024): ORB on stocks in play.
  - Zarattini & Aziz, *VWAP: The Holy Grail for Day Trading Systems* (2023).
  - Gao, Han, Li & Zhou, *JFE* 2018: market intraday momentum.
  - Baltussen, Da, Lammers & Martens, *JFE* 2021: the rest-of-day return predicts the last half-hour.
  - Rosa, *J. Futures Markets* 2022: thresholds help; out of sample the effect fades.
  - Baltussen, Da & Soebhag, *End-of-Day Reversal* (2026): stocks only, so it is not tested on an index future.
  - Boyarchenko, Larsen & Whelan, *RFS* 2023, and the NY Fed's *Disappearing Overnight Drift* (2026).
  - Crabel, *Day Trading with Short Term Price Patterns and Opening Range Breakout* (1990): ORB, NR4/NR7, the stretch.
  - Williams: volatility breakout.
  - Lakonishok & Smidt 1988; McConnell & Xu 2008: turn of the month. Ariel 1990: pre-holiday days.
  - Lucca & Moench 2015 and Kurov et al. 2021: the pre-FOMC drift and its fading.
  - Pagonidis: the IBS. Connors: RSI(2).
  - Mesfin, arXiv 2605.04004 and 2605.11423 (2026): 14 OHLCV signal families on 5-minute MNQ 2021-2025; none passed at a
    2-point round-trip cost.
  - Replications that failed after costs: an MQL5 replication of the ORB paper on five indices (NQ gross +0.13R,
    net about 0), QuantConnect replications of the VWAP paper, and a 2011-2026 test of ICT's Silver Bullet on ES/NQ/YM/GC
    (negative after costs in 92 of 92 hour-market cells).
- Considered and not tested:
  - Mesfin's two positive controls: GMM/Markov regime classifiers whose fitted states cannot be reproduced from the
    text, and whose own author flags selection exposure.
  - The paper's volatility-targeted sizing of SPY: here every trade is 1 MNQ in the screen, and the prop book's own
    sizing in the account test.
  - Cross-sectional stock effects.

## Data and execution (fixed)

- **Bars:** the user's MNQ file
  (`MICRONASDAQ100_futures_5m_2019-12-01_2026-11-23.parquet`), 5-minute bars as recorded, with their volume.
  Its times, opens, highs, lows and closes must equal `NQFUT.npz` exactly, or nothing runs. The S&P 500 CFD input is
  used only for the book's own overnight score, in the reference rows and in the account test. Session = 18:00 ET to
  17:00 ET. RTH = 09:30-16:00 ET. ADR = the engine's, the mean RTH range of the last 14 full sessions.
- **Rolls:**
  - The file is the raw front contract. A rule comparing prices across a session boundary (prior close, gaps,
    multi-day indicators) uses roll-adjusted prices.
  - **Identifying a roll:** at the Monday and Tuesday 18:00 opens of each expiry week (the week of the third Friday of
    Mar/Jun/Sep/Dec), take the gap from the last close to the first open, minus the S&P CFD's move over the same span
    in MNQ points. The larger of the two is the roll if it exceeds 50 points. This finds every roll from Sep 2022 to
    Sep 2026 (+65 to +300 points). Before that, carry was near zero, the roll jumps were below the noise of ordinary
    18:00 gaps (under about 20 points, 0.1 ADR), and they are left unadjusted.
  - **Adjusting:** an earlier session's price is shifted by the sum of the roll offsets between the two sessions;
    daily indicator series are ratio-adjusted. P&L always uses raw prices, and no trade is open at a roll, since
    rolls fall on 18:00 opens.
- **Decisions and fills (strict convention for the screen):**
  - Every decision uses only bars closed so far.
  - Market orders fill at the next bar's open.
  - Stop orders fill at the stop, or at the bar's open if it gaps through.
  - A limit order needs a 1-tick trade-through and fills at its price.
  - After a market entry at a bar's open, that bar's range counts.
  - In a stop-entry's fill bar, the protective stop counts if reached and a target does not.
  - When a stop and a target are both reachable in one bar, the stop wins.
  - Time exits are market orders at the open of the bar starting at the exit time (16:00 = the open of the 16:00 bar).
  - A session that ends early (half days) closes everything at its last bar.
  - No position is held past 16:00 ET or into a roll.
- **Costs:**
  - $1.00 commission per MNQ round turn (the user's).
  - 1 tick (0.25 point, $0.50) of slippage on every market and stop fill, entry and exit.
  - No slippage on limit fills.
  - Stress test: 2 ticks a fill.
- **Size in the screen:** 1 MNQ a trade. Statistics are in ADR units (net points / that session's ADR) so that 2020's
  and 2026's volatility count alike. $ at 1 MNQ are reported too.

## Periods (fixed)

- **Design:** from each rule's first computable session (about Dec 20 2019 to Jan 2 2020) to Dec 30 2022. Selection
  uses this period only.
- **Out of sample:** Jan 3 2023 to Nov 20 2026. It is looked at once, for the configurations selected on the design period.
- **Walk-forward** (reported, no decisions): each year 2022-2026 is traded with the configuration that was best on all
  data before it.

## Candidate families and every configuration (1,556 in all)

Unless a rule says otherwise:
- entries are market orders at the next bar's open after the signal bar;
- one position at a time, and one trade a session;
- everything is flat at 16:00;
- R = |entry - initial stop|.

**F1 - ORB, first-candle direction** (Zarattini & Aziz 2023): 108 configurations.
- Opening range: 09:30 to 09:30 + L, with L in {5, 15, 30} minutes.
- Direction: the sign of the range's close minus the 09:30 open. No trade if they are equal.
- Entry: at the open of the bar after the range.
- Stop: the range's opposite extreme (the paper's), 0.10 ADR or 0.25 ADR.
- Target: none, 2R, 5R or 10R (the paper's).
- Filter: |range move| >= f x ADR, with f in {0, 0.05, 0.10}.
- The paper's own setting is L 5, extreme stop, 10R, f 0.

**F2 - ORB, breakout orders** (Crabel 1990): 432 configurations.
- Opening range of L in {5, 15, 30, 60} minutes.
- Orders: a buy stop 1 tick above the range and a sell stop 1 tick below it, as an OCO, live from the range's end to
  C in {11:00, 13:00, 15:00}. If both are touched in one bar, no trade.
- Stop: the range's other side, its midpoint, or 0.25 ADR.
- Target: none, 1R or 2R.
- Filter: none, NR4 (the prior RTH range is the narrowest of the last 4), NR7, or an inside prior day.

**F3 - Noise area** (Zarattini, Aziz & Barbon 2024): 108 configurations.
- sigma(t) = the mean over the last n sessions of |close of the bar ending at time t / that session's 09:30 open - 1|,
  with n in {7, 14, 21}.
- Bands: UB = A x (1 + m x sigma), LB = B x (1 - m x sigma).
  - A = max(open, prior close) and B = min(open, prior close) when gap-adjusted, as in the paper.
  - A = B = open when not.
  - m in {1.0, 1.25, 1.5}.
- Checks at bar closes every k in {30, 60} minutes from 10:00 to 15:30: long above UB, short below LB.
- Exit, checked at the same times: the opposite band (a flip), back inside the current band, or the paper's final
  rule, a long exits below max(UB, VWAP) and a short above min(LB, VWAP).
- Re-entry is allowed at a later check. VWAP is from 09:30, on the bars' (H+L+C)/3 weighted by volume.
- The paper's setting is n 14, m 1.0, k 30, gap-adjusted, band + VWAP.

**F4 - Market intraday momentum** (Gao et al. 2018; Baltussen et al. 2021; Rosa 2022): 120 configurations.
- Predictor, one of:
  - ONFH: prior RTH close to 10:00;
  - ROD: prior close to 15:30;
  - FH: 09:30 to 10:00;
  - MID: 10:00 to 15:30;
  - RTH: 09:30 to 15:30.
  The prior close is roll-adjusted.
- Direction: momentum or reversal.
- Threshold: |predictor| >= q x ADR, with q in {0, 0.25, 0.5}.
- Trade 15:30 -> 16:00, or 15:00 -> 16:00. In the 15:00 window, ROD, MID and RTH end at 15:00.
- Stop: none or 0.10 ADR.

**F5 - VWAP** (Zarattini & Aziz 2023; practice): 28 configurations.
- Trend, 16 configurations.
  - From T0 in {09:35, 10:00}, at checks every bar or every 30 minutes: long above VWAP + d x ADR, short below
    VWAP - d x ADR, otherwise keep the position. Flips are allowed.
  - d in {0, 0.02, 0.05, 0.10}.
  - The paper's setting is 09:35, d 0, every bar.
- Reversion, 12 configurations, one trade a session.
  - From 10:00 to C in {12:00, 15:00}, fade a close that is >= k x ADR from VWAP, with k in {0.25, 0.40, 0.60}.
  - Exit with a limit at VWAP, a stop s x ADR beyond the entry (s in {0.25, 0.50}), or at 16:00.

**F6 - Opening gap** (practice; Mesfin 2026): 96 configurations.
- g = (09:30 open - prior RTH close, roll-adjusted) / ADR.
- Mode: fade or continuation.
- |g| in [0.05, 0.25), [0.25, 0.50), [0.50, inf) or [0.10, inf).
- Entry: at the open of the 09:30, 09:35 or 10:00 bar. A fade is skipped if the gap has already filled.
- Stop: 0.25 or 0.50 ADR.
- Exit: 11:00 or 16:00. A fade also takes profit with a limit at the prior close.

**F7 - Overnight (Globex) range** (practice): 54 configurations.
- ONH/ONL = the high and low from 18:00 to 09:25.
- Breakout: stop orders 1 tick beyond them, OCO.
- Fade: limit orders at them; the first touch with a 1-tick trade-through fills.
- Live 09:30 to C in {11:00, 13:00, 15:00}.
- Stop: 0.15, 0.25 or 0.50 ADR. Target: none, 1R or 2R.

**F8 - Volatility breakout** (Williams; Crabel's stretch): 60 configurations.
- Stop orders at the 09:30 open +/- k x X, OCO, live from 09:35 to C in {13:00, 15:30}.
- X: the prior RTH range, ADR, or Crabel's stretch (the 10-session mean of min(high - open, open - low)).
- k in {0.2, 0.3, 0.4, 0.5, 0.6}.
- Stop: at the open, or 0.25 ADR.

**F9 - Calendar and event days** (Lakonishok & Smidt; Ariel; Lucca & Moench; practice): 34 configurations, long only.
- Days:
  - turn of the month (the last trading day and the first 3);
  - the trading day before a weekday market holiday;
  - scheduled FOMC statement days, from the Fed's calendars (`fomc_dates.txt`; unscheduled meetings and notation
    votes are left out);
  - Mondays;
  - a Tuesday after a down Monday (Monday's RTH close below the prior RTH close);
  - Fridays;
  - the monthly options expiry (the third Friday);
  - quarterly expiry Fridays.
- Window: RTH 09:30 -> 16:00, or the evening before, 18:10 -> 09:30.
- Stop: none or 0.5 ADR.
- Plus FOMC 09:30 -> 14:00 (the pre-announcement window), with or without the stop.

**F10 - Daily mean reversion, held overnight** (Pagonidis; Connors; practice): 96 configurations.
- Signals at the RTH close, 12 settings:
  - IBS = (C - L)/(H - L) of the RTH session, with thresholds 0.1/0.9, 0.2/0.8 or 0.3/0.7;
  - RSI(2) of daily RTH closes (ratio-adjusted), with thresholds 5/95, 10/90 or 20/80;
  - an N-day low/high close, N in {3, 5, 10};
  - N or more consecutive lower/higher closes, N in {2, 3, 4}.
- Long when oversold, short when overbought.
- Sides: long only, or both.
- Hold: 18:10 -> 09:30 (the book's overnight window), or 18:10 -> 16:00 the next day.
- Stop: none or 0.5 ADR.

**F11 - Indicators on 5-minute RTH bars, and mixes** (practice): 402 configurations.
- Indicators are continuous across sessions and roll-adjusted. Entries 09:45-15:00, at most 3 trades a session.
- 25 base rules, each traded long and short:
  - EMA crosses, (fast, slow) in {(5,20), (9,21), (12,26), (20,50)};
  - the MACD(12,26,9) crossing its signal line;
  - RSI fades: n 2 at 10/90 and 20/80; n 7 and 14 at 20/80 and 30/70;
  - RSI trend: n in {2, 7, 14}, crossing 60/40;
  - Bollinger(20, 2.0 / 2.5): fade (a close beyond a band, exit at the middle band) and breakout;
  - Donchian breakout of the prior 12, 24 or 48 bars;
  - Supertrend(10, 2 / 3) flips;
  - Keltner(EMA20 +/- 2 ATR10): fade and breakout.
- Exits:
  - the opposite signal (for fades: the middle band, or RSI 50);
  - a 2 x ATR(14) stop plus the opposite signal;
  - a 60-minute time stop.
- Filters (the mixes):
  - none;
  - with the VWAP side;
  - with the daily trend (the prior RTH close above its 5-day mean);
  - ADX(14) > 25;
  - with the book's overnight signal when there is one.
- That gives 25 x 3 x 5 = 375 configurations.
- Two-indicator mixes, 3 x 3 x 3 = 27:
  - a trend side: EMA(20,50), VWAP or Supertrend(10,3);
  - times a trigger: an RSI(2) pullback below 10 / above 90, a Bollinger(20,2) band touch, or a Donchian(12) breakout;
  - times the 3 exits.

**F12 - ICT Silver Bullet** (practice, as specified in the GoodBadBitcoin write-up): 9 configurations.
- Windows: 03:00-04:00, 10:00-11:00 or 14:00-15:00 ET.
- Sweep: inside the window, a bar trades 1 tick through an untouched level. The levels are the prior RTH high/low,
  the Asia high/low (20:00-24:00), the London high/low (02:00-05:00), the prior hour's high/low and 5-bar swings.
- The gap: then 3 bars in the window, the middle one with a body >= 1.0 ATR(14) and a gap between bars 1 and 3 of
  >= 0.1 ATR and >= 2 ticks, against the swept side.
- Entry: a limit at the gap's near edge, before the window ends.
- Stop: 1 tick beyond the sweep's extreme.
- Target: the nearest opposite untouched level (skipped if under 1.5R), 2R, or 3R.
- Time stop: the window's end + 60 minutes. One trade a window.

**F13 - Session drift and Asia/London breakouts** (Boyarchenko et al.; NY Fed; practice): 9 configurations.
- Long-only windows: 02:00 -> 03:00, 02:00 -> 04:00, 18:10 -> 09:30 every night, 18:10 -> 02:00, and 04:00 -> 09:30.
- Asia (20:00-02:00) range breakout and fade, 02:00-06:00, with the stop at the other side or 0.25 ADR, exit 09:25.

**Reference rows** (not candidates): the book's three funded legs, in the same harness and at the same costs:
- the overnight leg (score +/-0.7187, 18:10 -> 09:30, 0.5 ADR stop);
- the 09:35 pyramid;
- the drive-side IB breakout.

## Selection (design period only)

- **Choosing:** in each family, among configurations with at least 60 design-period trades (30 for F9), the one
  with the highest t-statistic of daily net P&L in ADR units goes forward. Days without a trade count as 0. The top 5
  are listed.
- **Measures:** t = mean / sd x sqrt(days). For each configuration the report gives trades, win rate, net per trade
  (points, ADR, and R where there is a stop), the t-statistic, an annualized Sharpe, the deepest drawdown and each year.

## Out-of-sample pass rule (one look; all five must hold)

- **P1:** the out-of-sample t-statistic of daily net P&L (ADR units, 1 tick) is >= 2.0.
- **P2:** net positive in at least 3 of the 4 out-of-sample years (2023, 2024, 2025, 2026 to Nov 20).
- **P3:** out-of-sample net above the 95th percentile of 400 copies with random sides.
  - Each copy keeps the same entry and exit times, with the stops and targets mirrored.
  - Single-trade families simulate both sides of every trade exactly.
  - Families that flip intraday mirror each day's whole position path. Its gross is negated and the costs kept.
  - Long-only rules (F9, F13 drift, F10 long-only) use random days instead: 400 draws of as many random sessions,
    held long in the same window.
- **P4:** out-of-sample net is still positive at 2 ticks a fill.
- **P5:** at least 30 out-of-sample trades.

A configuration that passes is a survivor. If none passes, the round says so.

## Overfitting diagnostics (reported, no decisions)

- PBO by CSCV: 16 contiguous blocks of the full sample, per family and for all 1,556 configurations.
- The deflated Sharpe ratio of each selected configuration, counting the trials in its family and in the round.
- The walk-forward record above.
- For every family's selection, the median t-statistic of its parameter neighbours, which shows whether it sits on a
  plateau or a spike.
- Each selection's daily-P&L correlation with the book's legs and with the whole funded book.

## Account test of the survivors (the mixes with the book)

Only for survivors, after the screen. It uses the engine's account machinery and the published conventions: fills
at the event bar's close and no slippage, for the book and the new leg alike. A stress run uses 1 tick a fill for both.

- **How a survivor joins the book:**
  - **(a) Funded:** a fourth leg, at N MNQ like the others (N = round(350 x M / ADR)). Its stop risk counts in the
    day budget of 600 x M, in time order with the book's legs. It is skipped if it would hold the opposite side of an
    open book position, as the IB breakout already is.
  - **(b) Eval:** a trigger after the book's two, with the eval's usual bracket and still one trade a session. Only
    for single-trade survivors.
  - **(c) Replacement:** it replaces a book leg, only if it beat that leg out of sample in the screen.
- **Accounts:** as published.
  - Lucid 50K 5 funded + 5 evals: 40% rule and add-on, closed after the 4th payout.
  - Topstep 50K 5 XFAs + 5 Combines: Standard payouts, No Activation Fee path.
  - 12 start dates each.
  - Windows: the last 5 years and since Dec 2019, and out of sample only from Jan 3 2023.
- **Noise bands at $1.00:** 8 placebo runs (score threshold 0.712 / 0.715 / 0.722 / 0.725; size reference 340 / 345 /
  355 / 360), per account type and window.
- **Rule 5Y**, as in round 5: adopt only if, over the last 5 years:
  - it beats the current book by more than the band on net a year or on the worst full year;
  - without the other measure falling by more than its band;
  - and Dec 2019 - Nov 2021 is not worse than its band on either.
  If several survivors pass, they are adopted together only if the combination beats each one alone under the same rule.

## Reporting (whatever the results)

The report covers, in `results_r7/` and the README:
- every family's design selection with its out-of-sample result and the five tests;
- every configuration's design and out-of-sample statistics, in a CSV;
- the reference rows;
- PBO, deflated Sharpe, walk-forward, the random-side controls and the correlations;
- and the account results for any survivor.

The 1,556 configurations make it certain that some look good on the design period by luck. Only the single
out-of-sample look and the controls decide.

## Addendum (2026-11-27, written while building the harness, before any configuration was run)

Two details made precise; neither changes a rule's intent, and no result had been computed.

- **F6 entries at 09:30:** a market order at the 09:30 open cannot know that open. For the 09:30 entry, the gap is
  measured from the last price before it, the 09:25 bar's close. For the 09:35 and 10:00 entries it is measured from
  the 09:30 open, as written.
- **F13's five drift windows trade every session.** A random-day control drawn from the same window *is* the rule, so P3
  cannot apply to them. They are judged on P1, P2, P4 and P5 and reported as the drift controls of the long-only
  rules. F13's Asia breakout and fade keep the random-side control.
