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
