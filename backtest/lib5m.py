#!/usr/bin/env python3
"""Shared loading / statistics helpers for the MNQ 5-minute research.

Pure stdlib (no numpy/pandas in this container). Everything is expressed in
INDEX POINTS, because the cost hurdle for MNQ is naturally quoted that way:

    MNQ multiplier   $2.00 per index point   (CME, verified)
    tick             0.25 index points = $0.50
    realistic RT     ~1.0-1.75 index points  (1-tick spread both ways +
                     commission + stop slippage)

All timestamps are UTC epoch seconds. Session logic converts to US Eastern,
which is what actually matters for index futures (RTH 09:30-16:00 ET).
"""
import csv
import datetime as dt
import math

# ── contract economics ───────────────────────────────────────────────────────
MNQ_POINT_VALUE = 2.0      # USD per index point
MNQ_TICK = 0.25            # index points
COST_RT_POINTS = 1.5       # base-case round-turn friction, index points
COST_LOW = 1.0
COST_HIGH = 2.5

ET = dt.timezone(dt.timedelta(hours=-5))   # placeholder; use et_parts() instead


# ── US Eastern with DST (stdlib only, no zoneinfo data guarantee) ────────────
def _nth_weekday(year, month, weekday, n):
    d = dt.date(year, month, 1)
    delta = (weekday - d.weekday()) % 7
    return d + dt.timedelta(days=delta + 7 * (n - 1))


def _dst_bounds(year):
    # US: DST starts 2nd Sunday March 02:00 local (07:00 UTC),
    #     ends 1st Sunday November 02:00 local (06:00 UTC)
    start = _nth_weekday(year, 3, 6, 2)
    end = _nth_weekday(year, 11, 6, 1)
    s = dt.datetime(start.year, start.month, start.day, 7,
                    tzinfo=dt.timezone.utc).timestamp()
    e = dt.datetime(end.year, end.month, end.day, 6,
                    tzinfo=dt.timezone.utc).timestamp()
    return s, e


_DST_CACHE = {}


def et_offset(ts):
    """Return UTC offset in hours for US Eastern at epoch `ts`."""
    y = dt.datetime.utcfromtimestamp(ts).year
    if y not in _DST_CACHE:
        _DST_CACHE[y] = _dst_bounds(y)
    s, e = _DST_CACHE[y]
    return -4 if s <= ts < e else -5


def et_parts(ts):
    """(date, hour, minute, weekday, minutes_since_midnight) in US Eastern."""
    local = dt.datetime.utcfromtimestamp(ts + et_offset(ts) * 3600)
    return (local.date(), local.hour, local.minute, local.weekday(),
            local.hour * 60 + local.minute)


RTH_OPEN = 9 * 60 + 30     # 570
RTH_CLOSE = 16 * 60        # 960


def is_rth(ts):
    d, _, _, wd, m = et_parts(ts)
    return wd < 5 and RTH_OPEN <= m < RTH_CLOSE


# ── data ─────────────────────────────────────────────────────────────────────
class Bars:
    """Column-oriented OHLCV series with cached session metadata."""

    __slots__ = ("t", "o", "h", "l", "c", "v", "n", "_et")

    def __init__(self, rows):
        rows = sorted(rows)
        self.t = [r[0] for r in rows]
        self.o = [r[1] for r in rows]
        self.h = [r[2] for r in rows]
        self.l = [r[3] for r in rows]
        self.c = [r[4] for r in rows]
        self.v = [r[5] for r in rows]
        self.n = len(rows)
        self._et = None

    @property
    def et(self):
        if self._et is None:
            self._et = [et_parts(x) for x in self.t]
        return self._et

    def slice(self, i0, i1):
        return Bars(list(zip(self.t[i0:i1], self.o[i0:i1], self.h[i0:i1],
                             self.l[i0:i1], self.c[i0:i1], self.v[i0:i1])))


def load(path):
    rows = []
    with open(path) as f:
        for r in csv.DictReader(f):
            rows.append((int(float(r["time"])), float(r["open"]),
                         float(r["high"]), float(r["low"]),
                         float(r["close"]), float(r["volume"])))
    return Bars(rows)


# ── small stats helpers ──────────────────────────────────────────────────────
def mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else float("nan")


def stdev(xs):
    xs = list(xs)
    if len(xs) < 2:
        return float("nan")
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def tstat(xs):
    """One-sample t-statistic vs 0."""
    xs = list(xs)
    if len(xs) < 3:
        return float("nan")
    s = stdev(xs)
    if not s or math.isnan(s) or s == 0:
        return float("nan")
    return mean(xs) / (s / math.sqrt(len(xs)))


def newey_west_t(xs, lags=5):
    """t-stat with a Newey-West HAC correction for serial correlation.

    Overlapping intraday samples are autocorrelated; the plain t-stat
    overstates significance. This is the honest version.
    """
    xs = list(xs)
    n = len(xs)
    if n < 10:
        return float("nan")
    m = sum(xs) / n
    e = [x - m for x in xs]
    gamma0 = sum(v * v for v in e) / n
    var = gamma0
    for L in range(1, min(lags, n - 1) + 1):
        g = sum(e[i] * e[i - L] for i in range(L, n)) / n
        var += 2.0 * (1.0 - L / (lags + 1.0)) * g
    if var <= 0:
        return float("nan")
    return m / math.sqrt(var / n)


def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * q
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return xs[lo] if lo == hi else xs[lo] * (hi - k) + xs[hi] * (k - lo)


def sharpe_from_trades(rs, trades_per_year):
    """Annualised Sharpe from a list of per-trade returns."""
    if len(rs) < 3:
        return float("nan")
    s = stdev(rs)
    if not s or math.isnan(s) or s == 0:
        return float("nan")
    return (mean(rs) / s) * math.sqrt(trades_per_year)
