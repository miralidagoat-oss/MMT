# NQ contract roll policy — v1.1, FROZEN 2026-09-12

Supersedes v1.0. Written **before** any roll rule was compared on strategy
performance, and before the multi-year dataset exists. No roll variant has been
scored against PF, expectancy or any outcome metric. Future changes require a
data-integrity reason, never a performance result.

## Why absolute prices matter here

This model locates liquidity at **absolute historical price levels** — PDH/PDL,
overnight extremes, session highs/lows, equal highs/lows, unswept swings. A
back-adjusted continuous series shifts every historical price by a cumulative
offset, moving levels relative to each other across roll boundaries. That can
**manufacture or erase** the exact interactions this system trades.
**Back-adjusted data is disqualified as the primary research set.**

## PRIMARY RULE (governs whenever volume is available)

1. Each session, compare total traded volume of the front contract against the
   next deferred contract.
2. When deferred volume exceeds front volume on **two consecutive sessions**,
   the roll is *signalled* at the close of the second session.
3. The active contract switches at the **open of the next session**.

Two consecutive sessions prevents a single illiquid session from flipping the
series back and forth. Switching at the *next* open guarantees the decision uses
only information available when it is made.

## CALENDAR FALLBACK (data-integrity failure only)

Used **only** when volume is missing or zero for either contract. It is not an
optimization variable and is never selected by comparing outcomes.

> **Switch at the open of the session following the Monday preceding the third
> Friday of the contract month.**

### Disclosure on this rule

This follows the convention you specified. **I could not verify it against CME's
published roll-date table: `cmegroup.com` returns HTTP 403 to automated
requests from this environment.** For transparency, my own understanding had
been that CME's equity-index roll-date tables cite the **Thursday eight days
before the third-Friday expiry**, and I am not confident which is correct.

I am adopting your rule as directed and flagging the uncertainty rather than
silently accepting or silently overriding it. Practical impact is near zero:
this fallback fires only when volume data has already failed, and the primary
volume-crossover rule governs in all normal operation. **Worth confirming against
CME's own table before the dataset is purchased** — if it should be the Thursday,
that is a one-line change with no research consequence.

NQ expiry itself is the **third Friday** of Mar/Jun/Sep/Dec, settled on the
Special Opening Quotation that morning.

## Per-bar and per-trade record

| Field | Purpose |
|---|---|
| `contract_symbol` | e.g. `NQZ25` — the instrument actually traded |
| `contract_month` | e.g. `2025-12` |
| `expiration` | from the Databento `definition` schema |
| `is_roll_session` | true on the switch session |
| `bars_since_roll` | roll-proximity analysis |
| `price` | raw traded price, never adjusted |

Levels are computed **per contract**. A level formed on `NQU25` is never carried
onto `NQZ25`. This may under-count liquidity across a roll, but it cannot invent
a level at a price the new contract never traded.

## Mandatory roll-integrity checks — run before any strategy result is read

For ±3 sessions around every roll:

1. **Gap magnitude** — open-to-previous-close distribution, roll vs non-roll.
2. **PDH/PDL continuity** — how often a previous-day level sits outside the new
   contract's traded range. Should be ~zero given per-contract levels.
3. **VWAP discontinuity** — per-trade-day anchored VWAP should show no step
   attributable to the roll.
4. **False-sweep rate** — sweeps per session, roll vs non-roll. A spike means
   the level map is leaking across contracts.
5. **Volume profile** — the crossover should be visible and monotone.

Any failure halts research until the data or policy is fixed.
