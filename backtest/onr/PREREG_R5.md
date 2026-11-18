# Research round 5: a second market for steadier years (written and committed 2026-11-18, before the gold and crude
data were downloaded and before any round-5 result was computed)

Rounds 1-4 exhausted changes to the NQ rules themselves (README). Steadier yearly income now needs returns whose good and
bad years differ from NQ's: a second market. Lucid Flex trades CME micros, including gold (MGC) and crude oil (MCL).

## H5-M: the book's momentum legs, unchanged, on gold and crude

Data: HistData XAUUSD (spot gold) and WTIUSD (WTI crude) 1-minute bars, 2010 - Nov 2026, converted to New York time
and checked against Yahoo GC=F / CL=F 5-minute futures bars (the last 60 days), as was done for NQ. The day sessions are
the exchanges' own:
- gold 08:20-13:30 ET;
- crude 09:00-14:30 ET.

The rules are the funded book's momentum legs with every parameter unchanged, mapped to each market's clock:
- **ADR:** mean day-session range of the last 14 full sessions.
- **Opening-drive pyramid:**
  - entry when the first 5 minutes (to 08:25 / 09:05) move at least 0.10 ADR from the session open;
  - stop 0.35 ADR;
  - add the same size at +0.15 ADR and move the stop to breakeven;
  - trail 0.25 ADR;
  - exit at the session close.
- **IB breakout:**
  - range of the first 60 minutes (to 09:20 / 10:00);
  - stop orders 1 tick beyond the range, live 2.5 hours (to 11:50 / 12:30);
  - on a drive day only the drive's side, otherwise both as an OCO;
  - stop 0.25 ADR, target 0.5 ADR, exit at the session close.
- **No overnight leg:** the S&P stretch score is an equity signal.
- **Costs:** $1.34 per micro round turn. Prices are scaled so that one point is worth $2 per contract, as for MNQ: gold x5 (MGC $10 per $1), crude x50 (MCL $100 per $1).

**Leg rule (as in round 2):** a market's leg counts only if its mean result per trade is positive with t >= 2 in BOTH
2011-18 and 2019-26, and still positive in 2019-26 with 1 tick of slippage per side. The monthly correlation with the NQ
legs is reported.

**Account rule (only for a market whose two legs both count):** of the 5 funded accounts with an eval reserve (10
accounts, Lucid's cap), k = 1 or 2 trade the second market instead of NQ:
- the eval takes that market's 5-minute drive bracket;
- the funded account trades its pyramid and IB legs;
- Auto contracts = round(350 x M x 2 / (ADR x $2)), same dollar risk as NQ.

Adopted only by PREREG_R4.md's rule against 5 NQ funded + evals: worst full year or net a year better by more than the
round-4 noise band in both halves, the other not worse by more than its band.

## H5-S: funded accounts skip overnight SELL signals

Sell signals showed no edge in any 4-year block (round 3, G1); dropping them removes variance without removing edge.
An account-level version was tested in round 2 at 25K with mixed results, so this is a re-test under round 4's stricter
method and rule, at 50K. Eval unchanged. Same rule as above.

Nothing else is tested in this round.

## Addendum (written and committed 2026-11-18, before any round-5 result and before any last-5-year result)

### 1. The last 5 years come first (the user's request)

The user asked to backtest the last 5 years and give them priority. Window: the sessions from **2021-11-15 to
2026-11-13** (the end of the data). Full calendar years inside it: 2022-2025. The 2021 stub (Nov 15 - Dec 31) and 2026
(to Nov 13) are reported but are not full years.

**Descriptive backtest (no decision):** the current rules with 1 to 5 accounts in round 4's three structures (A: N
accounts bought the same day; B: N funded + N evals in reserve; C: N accounts in all, one new eval a day), 12 start
dates (every 5 sessions from 2021-11-15), every year, round 4's metrics and eval/funded counts.

**Decision rule "5Y" (applied to every candidate below):**
1. **Noise band** from 8 placebo runs of BASE (B5: 5 funded + 5 evals in reserve):
   - score threshold 0.712, 0.715, 0.722, 0.725 (BASE 0.7187);
   - Auto-size reference 340, 345, 355, 360 (BASE 350).

   Band = the largest |placebo - BASE| of net a year (M) and of the worst full year (W). It is computed separately
   for the last 5 years and for 2011-21 (Feb 2011 - Nov 14 2021, full years 2012-2020).

   Why 8 placebos, not round 4's 4: many candidates are now scored in one window, and the round-3/4 candidates'
   last-4-year results (which overlap this window) were already seen. A wider band means fewer false passes.
2. **One variant per family:** the variant with the best result in the last 5 years. A pass by the consistency
   route beats a pass by the money route; within a route, the larger improvement wins.
3. **Adoption:** ADOPTED only if both of these hold:
   - In the last 5 years it passes round 4's rule. Either W is better by more than the band and M is not worse by
     more than the band, or M is better by more than the band and W is not worse by more than the band.
   - In 2011-21, neither M nor W is worse than BASE by more than that period's band.
4. **Several families pass:** their combination must also pass, and must beat each single change in the last 5
   years. Otherwise only the single change with the largest improvement in its passing route is adopted.

**Candidates:** every account-level change tested in rounds 3-5.
- Round 3:
  - A: risk by cushion, f = 0.4 or 0.6.
  - B: day budget 800 x M.
  - C: eval risk x0.5 or x0.75.
  - D: D1 eval on the 09:35 drive only; D2 eval skips overnight sells.
  - E: second pyramid add at +0.30.
  - F: overnight exit at 04:00, with the eval's news skip off.
- Round 4:
  - T: an eval-buying throttle of 63 or 126 sessions.
  - R: funded risk x0.5, x0.75, x1.25 or x1.5.
  - V: 7 or 8 accounts.
- Round 5:
  - S: funded accounts skip overnight sells.
  - M-gold and M-crude: k = 1 or 2 of the 5 funded accounts on that market. Each is tested only if both its legs
    count under the original leg rule or the 5Y leg rule.

**5Y leg rule:** the mean R per trade is positive with t >= 2 in the last 5 years, still positive there with 1 tick
of slippage per side, and positive in 2011-21.

For round 5's own candidates (S, M), the original rule above (2011-18 and 2019-26) is also applied and reported.

### 2. Crude oil data

HistData's WTIUSD ends on 2023-12-01; its pages for 2024 onwards hold no file. The crude series is therefore built in
two parts:
- HistData WTIUSD up to 2023-11-30;
- from 2023-12-01, Dukascopy LIGHT.CMD/USD: a WTI CFD, 1-minute bid candles in UTC, converted to New York time, with
  zero-volume minutes (market shut) dropped.

Checks before use:
- HistData's clock convention is chosen by the correlation of 5-minute moves with Dukascopy over Jan-Nov 2023,
  separately for daylight-saving and standard weeks.
- Dukascopy is checked against Yahoo CL=F over the last 60 days.

If the Dukascopy download cannot be completed, crude is tested only to Nov 2023 and cannot be adopted, because its
account test needs the last 5 years. Gold is HistData XAUUSD for the whole span (2010 - Nov 2026), checked against
Yahoo GC=F.
