# Research round 6: the strategy without its overnight trade, and a replacement (written and committed 2026-11-18, before any round-6 result)

The user asked to backtest the strategy with the overnight trade removed, and to try putting something else in its
place.

## Already known (seen in earlier rounds, listed so a reader knows what was in view)

- **Round 3, D1:** the eval trades the 09:35 drive only, funded accounts unchanged. Over the last 5 years it was
  inside the noise (round 5: net a year −$379, worst year +$1,370), and its 2011–21 worst year was lower.
- **Round 5, S:** funded accounts skip overnight sell signals. Inside the noise.
- **Legs:** overnight buy signals have the edge and sells do not (round 3, G1). Over the last 4 years, buys with the
  0.5 ADR stop made +0.122R a trade (t 1.4).

## Candidates

**Family N, no overnight trade:**
- **N1:** no overnight trade anywhere.
  - The eval trades only the 09:35 opening drive.
  - Funded accounts trade the pyramid and the IB breakout; with no overnight trade, the IB always fits the day's risk
    budget.
- **N2:** funded accounts without the overnight trade; the eval unchanged.
- **N3:** the eval without the overnight trade; funded accounts unchanged. This is round 3's D1, scored again here
  for completeness.

**Family U, a replacement in the overnight's place:**
- **U1:** N1, plus a second chance for the eval on sessions with no 09:35 drive. On those sessions the eval takes the
  10:30 IB breakout:
  - both stop orders 1 tick beyond the first hour's range, as an OCO, live until 13:00 ET;
  - if both sides are touched in one bar, no trade;
  - the eval's usual bracket (same size, stop and target rules), held to 16:00;
  - a stop reached inside the fill bar counts as stopped;
  - still one trade a session.

## Rule

**Rule 5Y** of `PREREG_R5.md`'s addendum, unchanged. The noise bands are round 5's 8 placebo runs:

| Period | Net a year | Worst full year |
|---|---|---|
| Last 5 years | ±$11,596 | ±$9,884 |
| 2011–21 | ±$2,005 | ±$6,103 |

- **One variant per family:** the best one over the last 5 years is the only one considered.
- **Adoption:** adopted only if it passes over the last 5 years and is not worse than the band in 2011–21.
- **Original rule:** also reported (2011–18 and 2019–26, round 4's bands).

## Descriptive only, no decision

- The overnight trade's own share of one funded account's results, by year, 2011–2026 and over the last 5 years.
- The eval's overnight trades against its 09:35 drive trades.
- N1 with 1 to 5 accounts in round 4's three structures over the last 5 years, so the strategy without the
  overnight trade has the same tables as the current one.

Nothing else is tested in this round.
