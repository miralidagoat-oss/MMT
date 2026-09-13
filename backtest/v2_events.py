#!/usr/bin/env python3
"""V2 event, sweep, level-universe and episode definitions.

Definitions only. This module computes NO forward outcome, NO MFE/MAE, no
feature/outcome relationship. It exists so those definitions are frozen and
testable before the first outcome is visible.

Basis class: PROXY. The current data is a Dukascopy CFD, not CME NQ.
"""
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S

# ── proxy price grid (audit item 16) ──────────────────────────────────────
# The basis is a Dukascopy BID-quote CFD. Its quotes are NOT on an NQ tick grid:
# only ~2% of raw highs land on 0.25. V2 reads the RAW file and does not round
# it. 0.25 is applied only as an NQ-LIKE MINIMUM PENETRATION THRESHOLD, and is
# never described as the CFD's native tick.
PROXY_SWEEP_PENETRATION_POINTS = 0.25
RAW_BASIS = "data_ndx/NDX_5m.csv"        # V2 reads this
QUANTIZED_BASIS = "data_ndx_q/NDX_5m.csv"  # V1 only; irreversibly rounded

BAR_SECONDS = 300
# Stored stamps are BAR_OPEN_TIME (proven in test_v2_causality.py: 18:00 ET
# stamps exist, and a bar CLOSING at 18:00 would span the maintenance halt).
def event_confirmation_time(sweep_bar_open_ts):
    """The event is causally known no earlier than the sweep bar's CLOSE.
    5-minute OHLC never reveals the intrabar crossing instant, so nothing here
    pretends to know it."""
    return sweep_bar_open_ts + BAR_SECONDS


def landmark_time(t0, minutes):
    """Landmarks run from EVENT_CONFIRMATION_TIME, not the bar open."""
    return t0 + minutes * 60


LANDMARKS_MIN = (5, 10, 15, 30)
LANDMARK_REMAINING_HORIZON_MIN = 30    # SAME for every landmark, frozen
LANDMARK_ATR = "ATR0"                  # frozen: the ATR known at t0

EPISODE_WINDOW_MIN = 60     # measured from EPISODE START, never chained
EPISODE_ATR_MULT = 0.5

# ── pivot economics, separated from storage (audit item 15) ───────────────
PIVOT_LEN = 5                # frozen explicitly, no symbolic reference
MAX_ACTIVE_POOLS = 20000     # SAFETY CEILING ONLY - never an economic rule
PIVOT_DUP_TOLERANCE_POINTS = PROXY_SWEEP_PENETRATION_POINTS


class PoolCeilingExceeded(Exception):
    """The computational ceiling would bind. A resource limit must never decide
    whether a liquidity level economically exists, so this HALTS rather than
    silently pruning a valid level."""


def merge_duplicate_pivots(existing, new):
    """Duplicate pivots within one tolerance band. Every survivor is explicit:

        price            -> the OLDER level's price (it defined the band first)
        level_id         -> the OLDER level's id
        formation time   -> the OLDER level's formation time
        availability     -> the OLDER level's availability time
        touch_count      -> summed, so the merged level keeps both histories

    'Older' means the earlier AVAILABILITY time, since that is when the
    algorithm could first act on it.
    """
    a, b = (existing, new) if existing["available_ts"] <= new["available_ts"] \
        else (new, existing)
    return {"level_id": a["level_id"], "price": a["price"],
            "formation_ts": a["formation_ts"], "available_ts": a["available_ts"],
            "touch_count": a.get("touch_count", 0) + b.get("touch_count", 0),
            "merged_from": sorted({a["level_id"], b["level_id"]})}

# ── G. sweep definition, frozen ────────────────────────────────────────────
#
#   SELL-SIDE SWEEP  (direction +1, hypothesised bullish reversal)
#       raw_low  <=  level - PROXY_SWEEP_PENETRATION_POINTS
#   BUY-SIDE SWEEP   (direction -1, hypothesised bearish reversal)
#       raw_high >=  level + PROXY_SWEEP_PENETRATION_POINTS
#
# The full 0.25-point penetration is REQUIRED. A touch exactly equal to the
# level is NOT a sweep - predeclared here, not after observing outcome
# differences. Rationale: resting liquidity at a level is not demonstrably taken
# until price trades through it; equality is consistent with the level holding.
# The threshold is an NQ-LIKE minimum applied to RAW CFD quotes, not the CFD's
# native tick - the raw series is never rounded to imitate NQ.
#
# Trigger fields: LOW for sell-side, HIGH for buy-side. Close is not used to
# trigger; it is used only for close_vs_level_atr at the same bar's close.
#
# GAPS: if a bar's entire range opens beyond the level (sell-side: high < level),
# the level was gapped through. It is still a sweep; penetration is measured from
# the level to the bar low as usual, and `gapped` is recorded True so gapped
# events can be excluded in sensitivity without redefining the event.
#
# SIMULTANEOUS LEVELS: one bar penetrating N levels emits N separate events,
# each with its own event_id and level_id. They are collapsed into ONE episode
# by the state machine below; no level's characteristics are discarded.


def is_sweep(direction, level, bar_high, bar_low):
    """Exact sweep test on RAW quotes. +1 sell-side, -1 buy-side."""
    if direction == 1:
        return bar_low <= level - PROXY_SWEEP_PENETRATION_POINTS
    return bar_high >= level + PROXY_SWEEP_PENETRATION_POINTS


def penetration_pts(direction, level, bar_high, bar_low):
    return (level - bar_low) if direction == 1 else (bar_high - level)


def is_gapped(direction, level, bar_high, bar_low):
    """True when the bar never traded on the level's own side of it."""
    return (bar_high < level) if direction == 1 else (bar_low > level)


# ── H. liquidity-level universe, exhaustive ────────────────────────────────
#
# Every permitted generator. Nothing outside this table may create a level.
# Reused from V1's engine machinery at the commit recorded in PROTOCOL_V2.md;
# each dynamic construction beyond `pivot` is a NEW hypothesis family and must
# enter the ledger before its result is seen.
LEVEL_UNIVERSE = {
    "pdh": dict(formation="high of the previous CME trade day",
                availability="18:00 ET session open of the current trade day",
                expiration="end of the current trade day", price="high",
                timeframe="5m", touch_update="none - price fixed at formation",
                invalidated="never; expires only", duplicates="n/a - one per day",
                survives_session=False, side=-1),
    "pdl": dict(formation="low of the previous CME trade day",
                availability="18:00 ET session open of the current trade day",
                expiration="end of the current trade day", price="low",
                timeframe="5m", touch_update="none", invalidated="never",
                duplicates="n/a", survives_session=False, side=1),
    "pwh": dict(formation="high of the previous CME trade week",
                availability="Sunday 18:00 ET open of the current week",
                expiration="end of the current trade week", price="high",
                timeframe="5m", touch_update="none", invalidated="never",
                duplicates="n/a", survives_session=True, side=-1),
    "pwl": dict(formation="low of the previous CME trade week",
                availability="Sunday 18:00 ET open of the current week",
                expiration="end of the current trade week", price="low",
                timeframe="5m", touch_update="none", invalidated="never",
                duplicates="n/a", survives_session=True, side=1),
    "asia_h": dict(formation="high over [18:00, 02:00) ET",
                   availability="02:00 ET (window closed)",
                   expiration="end of the current trade day", price="high",
                   timeframe="5m", touch_update="none", invalidated="never",
                   duplicates="n/a", survives_session=False, side=-1),
    "asia_l": dict(formation="low over [18:00, 02:00) ET",
                   availability="02:00 ET", expiration="end of trade day",
                   price="low", timeframe="5m", touch_update="none",
                   invalidated="never", duplicates="n/a",
                   survives_session=False, side=1),
    "lon_h": dict(formation="high over [02:00, 08:00) ET",
                  availability="08:00 ET", expiration="end of trade day",
                  price="high", timeframe="5m", touch_update="none",
                  invalidated="never", duplicates="n/a",
                  survives_session=False, side=-1),
    "lon_l": dict(formation="low over [02:00, 08:00) ET",
                  availability="08:00 ET", expiration="end of trade day",
                  price="low", timeframe="5m", touch_update="none",
                  invalidated="never", duplicates="n/a",
                  survives_session=False, side=1),
    "ib_h": dict(formation="high over [09:30, 10:30) ET (initial balance)",
                 availability="10:30 ET", expiration="end of trade day",
                 price="high", timeframe="5m", touch_update="none",
                 invalidated="never", duplicates="n/a",
                 survives_session=False, side=-1),
    "ib_l": dict(formation="low over [09:30, 10:30) ET",
                 availability="10:30 ET", expiration="end of trade day",
                 price="low", timeframe="5m", touch_update="none",
                 invalidated="never", duplicates="n/a",
                 survives_session=False, side=1),
    "pivot": dict(formation="bar k whose high is the max (or low the min) of "
                            "[k-PIVOT_LEN, k+PIVOT_LEN]",
                  availability="close of bar k+PIVOT_LEN - NEVER backdated to k",
                  expiration="NONE from storage pressure. Economic lifetime "
                             "runs from availability until structural "
                             "invalidation (swept AND reclaimed). A pivot never "
                             "expires merely because newer pivots formed.",
                  price="high or low of bar k", timeframe="5m",
                  touch_update="touch_count increments; price never moves",
                  invalidated="removed once swept and reclaimed",
                  duplicates="within PIVOT_DUP_TOLERANCE_POINTS merge via "
                             "merge_duplicate_pivots(): price, level_id, "
                             "formation and availability all survive from the "
                             "OLDER level; touch counts sum",
                  survives_session=True, side="both"),
}


# ── F. episode state machine, deterministic ────────────────────────────────
class EpisodeTracker:
    """One deterministic rule, replacing V1's two inconsistent ones.

    An event joins the open episode ONLY IF all three hold:
        same sweep direction
        (event_time - EPISODE_START) <= EPISODE_WINDOW_MIN
        |level - episode_reference_level| <= EPISODE_ATR_MULT * ATR_AT_START

    Otherwise it opens a new episode. An opposite-direction event ALWAYS opens a
    new episode on that side.

    The window is measured from EPISODE START, so A(0) B(50) C(100) cannot chain
    into one 100-minute episode: C is 100 minutes from the start and opens a new
    episode even though it is 50 minutes from B.

    The ATR used for the 0.5-ATR threshold is the one known AT EPISODE START and
    is frozen for that episode's lifetime; recomputing it from later bars would
    let future volatility decide the clustering.

    Nested levels do not discard anything: every constituent level_id is kept in
    the episode's `level_ids`.
    """

    def __init__(self):
        self.open = {}          # direction -> episode dict
        self.episodes = []
        self._next = 0

    def _start(self, direction, ts, level, atr, level_id, event_id):
        self._next += 1
        ep = {"episode_id": f"E{self._next:07d}", "direction": direction,
              "start_ts": ts, "reference_level": level, "atr_at_start": atr,
              "level_ids": [level_id], "event_ids": [event_id],
              "n_events": 1}
        self.open[direction] = ep
        self.episodes.append(ep)
        return ep

    def assign(self, direction, ts, level, atr, level_id, event_id):
        """Return the episode this event belongs to. Deterministic."""
        ep = self.open.get(direction)
        if ep is None:
            return self._start(direction, ts, level, atr, level_id, event_id)
        within_time = (ts - ep["start_ts"]) <= EPISODE_WINDOW_MIN * 60
        within_price = abs(level - ep["reference_level"]) <= \
            EPISODE_ATR_MULT * ep["atr_at_start"]
        if within_time and within_price:
            ep["n_events"] += 1
            ep["event_ids"].append(event_id)
            if level_id not in ep["level_ids"]:
                ep["level_ids"].append(level_id)
            return ep
        return self._start(direction, ts, level, atr, level_id, event_id)

    def note_opposite(self, direction):
        """An opposite-direction event always opens a new episode on its own
        side; it does not close the other side's open episode."""
        self.open.pop(-direction, None)


# ── D/E. feature-class membership, enforced ────────────────────────────────
EVENT_TIME_PROHIBITED = frozenset({
    "reclaim_latency_min", "reclaim_magnitude_atr", "reclaim_occurred",
    "displacement_after_event", "htf_directional_agreement",
    "mfe", "mae", "mfe_atr", "mae_atr", "forward_return",
})


def assert_event_time_row(row):
    """Fail closed if a future-dependent key reaches a baseline predictor row.

    Enforced in code rather than trusted to discipline, because the natural
    mistake - recording a future reclaim as NaN at event time and filling it in
    later - looks harmless at the call site.
    """
    bad = sorted(set(row) & EVENT_TIME_PROHIBITED)
    if bad:
        raise ValueError(
            f"future-dependent feature(s) in an event-time row: {bad}. "
            "These belong to LANDMARK or OUTCOME classes (FEATURE_SPEC_V2.json)."
        )
    return True


class InsufficientHistory(Exception):
    """A 252-day feature was requested without 252 days of history."""


def require_history(name, available_days, required_days=252):
    """Fail closed. A 252-day percentile computed on partial history is not a
    smaller-sample estimate of the same thing - it is a different statistic."""
    if available_days < required_days:
        raise InsufficientHistory(
            f"{name} requires {required_days} eligible trade days of history; "
            f"{available_days} available. The event is INELIGIBLE. Partial "
            "history is never substituted.")
    return True
