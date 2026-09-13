#!/usr/bin/env python3
"""CME trade-day boundaries, timezone-aware (PRE-V2 GATE 1).

The defect this replaces: partitions.py treated a calendar date as UTC midnight
and applied fixed +/-6h and +30h offsets to reach session boundaries. Those
offsets are wrong twice over - they encode neither the 18:00 ET open nor the
US DST rules - and they leaked a trade day at each partition edge.

Definition, applied here and nowhere else:

    a CME trade day labelled D opens at 18:00 ET on calendar day D-1
    and closes at 17:00 ET on calendar day D, as a HALF-OPEN interval
    [open, close). The 17:00-18:00 ET maintenance hour belongs to NEITHER
    session and is reported as None rather than silently attached to one.

Local aware timestamps are constructed first and converted to UTC only once the
boundary is known, so the zoneinfo database supplies the offset. No fixed UTC-4,
no fixed UTC-5, no hand-picked seasonal dates.
"""
import datetime as dt
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
UTC = dt.timezone.utc
OPEN_T = dt.time(18, 0)      # 18:00 ET on D-1
CLOSE_T = dt.time(17, 0)     # 17:00 ET on D
MAINTENANCE = "maintenance"  # returned by classify() for 17:00-18:00 ET


def _et(ts):
    """Any instant -> aware ET. Accepts epoch seconds or aware datetime."""
    if isinstance(ts, (int, float)):
        return dt.datetime.fromtimestamp(ts, UTC).astimezone(ET)
    if ts.tzinfo is None:
        raise ValueError("naive datetime: refusing to guess a timezone")
    return ts.astimezone(ET)


def trade_date(ts):
    """CME trade date for an instant, or None during the maintenance hour.

    None is deliberate. Returning a date for 17:30 ET would attach the
    maintenance hour to a session, which is exactly the silent misattribution
    this module exists to prevent.
    """
    e = _et(ts)
    t = e.time()
    if t >= OPEN_T:
        return e.date() + dt.timedelta(days=1)
    if t < CLOSE_T:
        return e.date()
    return None


def classify(ts):
    """'session' or 'maintenance' - the explicit form of trade_date's None."""
    return MAINTENANCE if trade_date(ts) is None else "session"


def session_bounds(d):
    """(open_utc, close_utc) for trade date `d`, half-open [open, close).

    Both boundaries are built as ET-local wall-clock times and then converted,
    so a session spanning a DST transition is still exactly 23 wall-clock hours
    and the conversion is the tz database's problem, not ours.
    """
    op = dt.datetime.combine(d - dt.timedelta(days=1), OPEN_T, tzinfo=ET)
    cl = dt.datetime.combine(d, CLOSE_T, tzinfo=ET)
    return op.astimezone(UTC), cl.astimezone(UTC)


def session_epoch(d):
    """session_bounds as epoch seconds, for comparing against bar timestamps."""
    o, c = session_bounds(d)
    return int(o.timestamp()), int(c.timestamp())


def span_epoch(first_date, last_date):
    """Epoch bounds covering trade dates [first_date, last_date] inclusive.

    Returns (start, end) with end EXCLUSIVE: bars satisfying
    start <= t < end belong to exactly those trade dates.
    """
    s, _ = session_epoch(first_date)
    _, e = session_epoch(last_date)
    return s, e


def eligible_trade_dates(timestamps, first_date=None, last_date=None):
    """Distinct trade dates actually present in `timestamps`.

    This is the §GATE 2 denominator: trade dates containing evaluation-eligible
    bars, never bars-loaded days, warm-up days or nominal partition dates.
    """
    out = set()
    for ts in timestamps:
        d = trade_date(ts)
        if d is None:
            continue
        if first_date and d < first_date:
            continue
        if last_date and d > last_date:
            continue
        out.add(d)
    return out
