# NQ contract roll policy — v1.2, FROZEN 2026-09-12

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

### Provenance of this rule

**Verified independently by the operator against CME's published U.S.
equity-index convention: customary roll date = the Monday preceding the third
Friday of the expiration month.** My earlier uncertainty — I had believed it was
the Thursday eight days before expiry, and `cmegroup.com` returns HTTP 403 to
automated requests from this environment so I could not check — is resolved.
The rule stands as written and is no longer flagged.

NQ expiry itself is the **third Friday** of Mar/Jun/Sep/Dec, settled on the
Special Opening Quotation that morning.

## Warm-up is NOT level carryover — the distinction is load-bearing

Two different things that must never be conflated:

| Forbidden | Required |
|---|---|
| A price level formed on `NQU25` becoming a level on `NQZ25` | `NQZ25` using its **own** pre-roll history to warm state |

When `NQZ25` becomes active it must already possess a legitimate ATR, realized
volatility, session/VWAP history, market structure and its **own**
contract-specific liquidity pools. It obtains those from **its own genuine
1-minute bars in the 30 calendar days before its active start**, during which it
was listed and trading as the deferred contract.

So: **no cross-contract price-level carryover** does **not** mean **no pre-roll
history from the incoming contract**. The incoming contract's warm-up bars are
real trades at real prices in that instrument, and using them is causal and
correct. What is forbidden is transplanting a level *discovered on a different
instrument*.

No trade may be taken during a warm-up window. Warm-up exists only to
initialize state.

## Dataset manifest — every minute bar must remain attributable

The research dataset is **never** transformed into a stitched series in which
the source contract can no longer be identified. Every minute bar carries, or
permits exact recovery of:

| Field | |
|---|---|
| `raw_symbol` | the actual CME contract, e.g. `NQZ25` |
| `ts_event` | UTC nanosecond timestamp |
| `open/high/low/close/volume` | raw, unadjusted |
| `trade_date` | CME trade day (18:00 ET roll) |
| `phase` | `warmup` or `active` |
| `roll_regime` | sessions since / until the nearest roll |

The backtest must always be able to answer: *"which actual CME NQ contract
produced this bar?"* Any pipeline step that loses this is a defect.

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
