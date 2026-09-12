# NQ contract roll policy — FROZEN 2026-09-12, before any strategy result was viewed

Version 1.0. This document was written **before** any roll rule was compared on
strategy performance. No roll variant has been scored against PF, expectancy or
any other outcome metric. If a future version changes this rule, the reason must
be a data-integrity defect, never a performance result.

## Why this matters for this strategy specifically

The model locates liquidity at **absolute historical price levels** — PDH/PDL,
overnight extremes, session highs/lows, equal highs/lows, unswept swings. A
back-adjusted continuous series shifts every historical price by a cumulative
offset. That does not merely rescale the chart: it moves levels relative to each
other across roll boundaries, which can **manufacture or erase** the exact
liquidity interactions this system trades. Back-adjusted data is therefore
disqualified as the primary research set.

## The rule

**Primary (used whenever volume is available):**

1. For each session, compare total traded volume of the front contract against
   the next deferred contract.
2. When deferred volume exceeds front volume on **two consecutive sessions**,
   the roll is *signalled* at the close of the second session.
3. The active contract switches at the **open of the next session**.

Two consecutive sessions prevents a single illiquid session from flipping the
series back and forth. Switching at the *next* open means the decision uses only
information available when it is made — no same-session hindsight.

**Fallback (only if volume is missing or zero for either contract):**

Switch at the open of the session following the **second Thursday of the
contract month**, which is 8 calendar days before the third-Friday expiry and
matches CME's published roll convention for the equity index complex.

**Never:** choosing roll dates by comparing strategy results.

## What the engine records for every bar and every trade

| Field | Purpose |
|---|---|
| `contract_symbol` | e.g. `NQZ25` — the actual instrument traded |
| `contract_month` | e.g. `2025-12` |
| `expiration` | from the Databento `definition` schema |
| `is_roll_session` | true on the session where the switch occurs |
| `bars_since_roll` | for roll-proximity analysis |
| `price` | raw traded price, never adjusted |

Levels (PDH/PDL, overnight, session extremes) are computed **per contract**.
A level formed on `NQU25` is not carried onto `NQZ25`. This is the conservative
choice: it may under-count liquidity across a roll, but it cannot invent a level
at a price the new contract never traded.

## Mandatory roll-integrity checks (run before any strategy result is read)

For the ±3 sessions around every roll:

1. **Gap magnitude** — distribution of open-to-previous-close across roll vs
   non-roll sessions. A roll gap materially larger than the non-roll
   distribution is expected; one that is *not* larger suggests the roll did not
   actually happen where the policy says.
2. **PDH/PDL continuity** — how often a previous-day level sits outside the new
   contract's traded range. Should be near zero given per-contract levels.
3. **VWAP discontinuity** — session VWAP anchored per trade day should show no
   step attributable to the roll.
4. **False sweep rate** — sweep detections per session, roll vs non-roll. A
   spike on roll sessions means the level map is leaking across contracts.
5. **Volume profile** — the crossover should be visible and monotone, not noisy.

Any check that fails halts research until the data or the policy is fixed.
