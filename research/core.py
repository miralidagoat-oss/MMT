#!/usr/bin/env python3
"""Data plumbing, session clock and indicators for the MMT futures research stack.

Design rules, each one traceable to a defect found in the previous generation
of this repo (see README "what failed"):

  F1  every indicator is unit-checked for non-constant, finite output
  F6  indicators expose an explicit warmup index; nothing may signal before it
  F15 session времени uses the real IANA tz database, never a fixed UTC offset
"""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import numpy as np

ET = ZoneInfo("America/New_York")

# ── contract spec: MNQ (Micro E-mini Nasdaq-100) ─────────────────────────────
TICK = 0.25            # index points per tick
TICK_VALUE = 0.50      # $ per tick, MNQ  (NQ = $5.00)
POINT_VALUE = 2.00     # $ per index point, MNQ (NQ = $20.00)


# ── loading / resampling ─────────────────────────────────────────────────────

class Bars:
    """Column-store OHLCV with a cached ET session clock."""

    __slots__ = ("t", "o", "h", "l", "c", "v", "_et")

    def __init__(self, t, o, h, l, c, v):
        self.t = np.asarray(t, dtype=np.int64)
        self.o = np.asarray(o, dtype=np.float64)
        self.h = np.asarray(h, dtype=np.float64)
        self.l = np.asarray(l, dtype=np.float64)
        self.c = np.asarray(c, dtype=np.float64)
        self.v = np.asarray(v, dtype=np.float64)
        self._et = None

    def __len__(self):
        return len(self.t)

    def slice(self, i, j):
        return Bars(self.t[i:j], self.o[i:j], self.h[i:j], self.l[i:j],
                    self.c[i:j], self.v[i:j])

    # -- ET session clock ---------------------------------------------------
    @property
    def et(self):
        """(minute_of_day_ET, day_ordinal_ET, weekday_ET) arrays."""
        if self._et is None:
            self._et = _et_clock(self.t)
        return self._et

    @property
    def et_minute(self):
        return self.et[0]

    @property
    def et_day(self):
        return self.et[1]


def _et_clock(ts):
    """Vectorised UTC->ET conversion using real DST transition boundaries."""
    ts = np.asarray(ts, dtype=np.int64)
    lo = dt.datetime.fromtimestamp(int(ts[0]), dt.timezone.utc)
    hi = dt.datetime.fromtimestamp(int(ts[-1]), dt.timezone.utc)
    # build the offset step function from each year's two DST transitions
    edges, offs = [], []
    probe = dt.datetime(lo.year, 1, 1, tzinfo=dt.timezone.utc)
    step = dt.timedelta(hours=1)
    cur = None
    while probe <= hi + dt.timedelta(days=1):
        off = int(probe.astimezone(ET).utcoffset().total_seconds())
        if off != cur:
            edges.append(int(probe.timestamp()))
            offs.append(off)
            cur = off
        probe += step
    edges = np.asarray(edges, dtype=np.int64)
    offs = np.asarray(offs, dtype=np.int64)
    idx = np.searchsorted(edges, ts, side="right") - 1
    local = ts + offs[np.clip(idx, 0, len(offs) - 1)]
    minute = ((local % 86400) // 60).astype(np.int32)
    day = (local // 86400).astype(np.int64)
    # 1970-01-01 was a Thursday, so with Monday=0 the epoch day maps to 3.
    # Using +4 here silently made Sunday=0, which meant every `wd < 5` filter
    # in this codebase kept Sundays and threw away every Friday.
    weekday = ((day + 3) % 7).astype(np.int8)   # Mon=0 .. Sun=6
    return minute, day, weekday


def load_1m(path=None):
    import os
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "data", "ndx_1m.npz")
    a = np.load(path)["bars"]
    return Bars(a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4], a[:, 5])


def resample(b: Bars, minutes: int, anchor_min: int = 570):
    """Aggregate 1m bars to `minutes`, with buckets anchored to `anchor_min`
    (minutes past ET midnight; 570 = 09:30 ET) so intraday bars line up with
    the RTH open instead of straddling it — hourly bars on a futures chart
    anchored to :00 UTC put the cash open in the middle of a candle.

    Returns aggregated Bars plus `src_end`: index into the 1m series of the
    LAST 1m bar in each aggregate bar. A signal computed from aggregate bar k
    is only actionable from 1m bar src_end[k]+1 onward — that mapping is what
    keeps the execution simulator free of lookahead (F2).
    """
    minute, day, _ = b.et
    slot = (day * 1440 + minute - anchor_min) // minutes
    # bucket boundaries
    new = np.empty(len(slot), dtype=bool)
    new[0] = True
    np.not_equal(slot[1:], slot[:-1], out=new[1:])
    start = np.flatnonzero(new)
    end = np.r_[start[1:] - 1, len(slot) - 1]

    o = b.o[start]
    c = b.c[end]
    h = np.maximum.reduceat(b.h, start)
    l = np.minimum.reduceat(b.l, start)
    v = np.add.reduceat(b.v, start)
    t = b.t[start]
    return Bars(t, o, h, l, c, v), end


# ── indicators (all warmup-explicit, all checked) ────────────────────────────

def ewma_sigma(c, lam=0.94, seed=20):
    """EWMA volatility of log returns, expressed in PRICE units per bar.

    F1: the previous engine computed log(close/close) == 0 and shipped a stop
    of exactly zero width. This returns price-unit sigma and the caller must
    respect `warm`.
    """
    c = np.asarray(c, dtype=np.float64)
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.log(c[1:] / c[:-1])
    var = np.full(n, np.nan)
    if n <= seed:
        return np.zeros(n) , n
    var[seed] = np.var(r[1:seed + 1])
    for i in range(seed + 1, n):
        var[i] = lam * var[i - 1] + (1.0 - lam) * r[i] * r[i]
    sig = np.sqrt(np.maximum(var, 0.0)) * c
    return sig, seed + 1


def rolling_max(x, n):
    """Max of the n bars ENDING at i-1 (strictly prior, no self-inclusion)."""
    x = np.asarray(x, dtype=np.float64)
    out = np.full(len(x), np.nan)
    if len(x) <= n:
        return out
    from numpy.lib.stride_tricks import sliding_window_view
    w = sliding_window_view(x, n).max(axis=1)
    out[n:] = w[:-1]
    return out


def rolling_min(x, n):
    x = np.asarray(x, dtype=np.float64)
    out = np.full(len(x), np.nan)
    if len(x) <= n:
        return out
    from numpy.lib.stride_tricks import sliding_window_view
    w = sliding_window_view(x, n).min(axis=1)
    out[n:] = w[:-1]
    return out


def rolling_mean(x, n):
    """Mean of the n bars ending at i (inclusive), NaN-safe.

    A plain cumsum is not NaN-safe: one NaN anywhere poisons every later
    value. That bug produced an all-NaN variance ratio and was caught by the
    selftest below, which is the entire reason the selftest exists.  Windows
    containing any NaN return NaN; complete windows return the true mean.
    """
    x = np.asarray(x, dtype=np.float64)
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    ok = np.isfinite(x)
    xz = np.where(ok, x, 0.0)
    cs = np.cumsum(np.r_[0.0, xz])
    cn = np.cumsum(np.r_[0, ok.astype(np.int64)])
    s = cs[n:] - cs[:-n]
    k = cn[n:] - cn[:-n]
    full = k == n
    out[n - 1:] = np.where(full, s / n, np.nan)
    return out


def variance_ratio(c, q=10, win=120):
    """Lo-MacKinlay variance ratio over a rolling window.

    VR = Var(q-bar returns) / (q * Var(1-bar returns)).
      VR < 1  -> mean-reverting tape (sweeps snap back)   -> reversion regime
      VR > 1  -> trending tape (sweeps run)               -> continuation

    This replaces the EMA trend filter that the old study found actively
    harmful (F10). An EMA asks "which way is price?"; that is the wrong
    question for a reversion setup. The variance ratio asks "does this tape
    revert or continue?", which is the question the setup actually depends on.
    Computed on log returns, strictly causal.
    """
    c = np.asarray(c, dtype=np.float64)
    n = len(c)
    out = np.full(n, np.nan)
    r1 = np.full(n, np.nan)
    r1[1:] = np.log(c[1:] / c[:-1])
    rq = np.full(n, np.nan)
    rq[q:] = np.log(c[q:] / c[:-q])

    m1 = rolling_mean(r1 * r1, win)
    mq = rolling_mean(rq * rq, win)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = mq / (q * m1)
    out[~np.isfinite(out)] = np.nan
    return out


def pct_rank(x, win):
    """Rolling percentile rank of x[i] within the trailing `win` values."""
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    out = np.full(n, np.nan)
    from numpy.lib.stride_tricks import sliding_window_view
    if n < win:
        return out
    w = sliding_window_view(x, win)
    out[win - 1:] = (w < w[:, -1:]).sum(axis=1) / float(win)
    return out


# ── self-checks (F1) ─────────────────────────────────────────────────────────

def _selftest():
    rng = np.random.default_rng(0)
    px = 15000 * np.exp(np.cumsum(rng.normal(0, 2e-4, 5000)))
    sig, warm = ewma_sigma(px)
    assert np.all(np.isfinite(sig[warm:])), "sigma has non-finite values"
    assert sig[warm:].std() > 0, "F1 REGRESSION: sigma is constant"
    assert sig[warm:].mean() > 0, "F1 REGRESSION: sigma is zero"

    hi = rolling_max(px, 20)
    assert np.isnan(hi[:20]).all()
    for i in (25, 400, 4999):                       # strictly prior window
        assert hi[i] == px[i - 20:i].max()

    vr = variance_ratio(px, q=10, win=120)
    ok = np.isfinite(vr)
    assert ok.sum() > 1000 and 0.5 < np.nanmedian(vr) < 2.0, "VR out of range"

    # random walk -> VR ~ 1; strong trend -> VR > 1
    trend = np.cumsum(np.full(5000, 1.0)) + rng.normal(0, .5, 5000)
    assert np.nanmedian(variance_ratio(np.exp(trend / 5000) * 100, 10, 120)) > 1.5

    # weekday mapping must be Mon=0..Sun=6 against known calendar dates
    import datetime as _dt
    for iso, want in (("2024-01-15", 0), ("2024-01-19", 4), ("2024-01-20", 5),
                      ("2024-01-21", 6), ("2020-02-29", 5)):
        ts = int(_dt.datetime.fromisoformat(iso + "T15:00:00+00:00").timestamp())
        _, _, w = _et_clock(np.array([ts - 60, ts], dtype=np.int64))
        assert int(w[-1]) == want, f"weekday {iso}: got {int(w[-1])} want {want}"

    pr = pct_rank(px, 100)
    assert np.nanmin(pr) >= 0 and np.nanmax(pr) <= 1
    print("core selftest OK")


if __name__ == "__main__":
    _selftest()
