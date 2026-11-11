#!/usr/bin/env python3
"""Reversal-zone engine — bar-for-bar Python port of
indicators/mnq_reversal_zones.pine.

The engine walks intraday bars exactly like the Pine script does.

ZONES (drawn before price gets there)
  A zone is created the moment its level becomes known - a session has just
  closed, or an intraday swing has just been confirmed - and it never moves
  afterwards. A top zone sits on a prior high, a bottom zone on a prior low.

TIER 1 - TAP (zero lag)
  The first bar that trades at the level. Graded pessimistically:
      FAIL  price trades beyond the far edge of the zone (level +/- depth)
      HIT   price travels `target` points away from the tap price first
  Inside one bar the far edge is assumed to print first; a hit is never
  credited on the tap bar itself.

TIER 2 - RECLAIM (confirmed failed breakout, one bar-close of lag)
  After a tap, the first LATER bar that closes back inside the level, within
  `reclaim_window_min` minutes and without price having run more than
  `sweep_max_adr` x ADR beyond the level. The marker is that bar's close.
      FAIL  price trades back through the sweep extreme (+ a small buffer)
      HIT   price travels `target` points away from the reclaim close first
  Graded from the next bar on, stop checked first inside each bar.
  Each reclaim is flagged WITH-TREND when it points the way of the long-term
  trend (a bottom while yesterday's close is above its 200-session average,
  a top while it is below) - the only place a real edge was measured.

Nothing looks ahead: every level is built from bars that closed before the
zone was drawn. The same code runs on real data and on the direction-scrambled
null model (rz_null.py), so every hit rate is reported next to what pure
chance produces under identical rules.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

NY = "America/New_York"

# session clock, minutes after ET midnight
GLOBEX_OPEN = 18 * 60        # 18:00  new trade date; prior-day / 5-session / weekly zones
ASIA_END = 3 * 60            # 03:00  Asia high/low known
RTH_OPEN = 9 * 60 + 30       # 09:30  overnight + London high/low known
OR_END = 10 * 60             # 10:00  opening-range (first 30 min) high/low known
IB_END = 10 * 60 + 30        # 10:30  initial-balance (first hour) high/low known
AM_END = 12 * 60             # 12:00  morning-session high/low known
RTH_CLOSE = 16 * 60          # 16:00  RTH high/low known (tomorrow's prior-day zone)

FAMILIES = ("ON", "LO", "AS", "PD", "X5", "PW", "OR", "IB", "AM", "SW")


@dataclass
class Params:
    target_pts: float = 100.0        # reversal size that counts as a hit
    target_adr: float = 0.0          # if > 0: target = target_adr * ADR (overrides target_pts)
    depth_adr: float = 0.06          # zone depth as a fraction of ADR
    depth_pts: float = 0.0           # if > 0: fixed zone depth in points (overrides depth_adr)
    adr_len: int = 20
    trend_len: int = 200             # sessions in the long-term trend average
    max_grade_min: int = 600         # minutes a tapped / reclaimed zone may stay unresolved
    sweep_max_adr: float = 0.20      # a run deeper than this beyond the level = broken, no reclaim
    reclaim_window_min: int = 30     # the close back inside must come within this many minutes of the tap
    reclaim_min_dwell: int = 1       # ... and at least this many bars after the tap bar
    stop_buffer_adr: float = 0.01    # reclaim stop = sweep extreme + this * ADR
    swing_adr: float = 0.20          # intraday swing size (x ADR) that makes a swing high/low a zone
    swing_max_age_min: int = 1440    # an untapped swing zone is dropped after this many minutes
    families: tuple = FAMILIES


@dataclass
class Zone:
    fam: str
    name: str
    side: int                    # +1 top zone (prior high), -1 bottom zone (prior low)
    level: float
    depth: float
    target: float
    adr: float
    born: int                    # bar index at which the zone became known
    trade_date: object
    # tier 1 - tap
    tap_bar: int = -1
    tap_price: float = np.nan
    result: str = "untouched"    # untouched | open | win | fail | timeout | void
    end_bar: int = -1
    # tier 2 - reclaim
    ext: float = np.nan          # sweep extreme since the tap
    rc_state: str = "none"       # none | watch | open | win | fail | timeout | off
    rc_bar: int = -1
    rc_price: float = np.nan
    rc_stop: float = np.nan
    rc_end: int = -1
    rc_trend: int = 0            # long-term trend on the reclaim's trade date: +1 up, -1 down, 0 unknown


def session_cols(df):
    """df: DataFrame indexed by UTC timestamps with open/high/low/close."""
    et = df.index.tz_convert(NY)
    out = df.copy()
    out["mins"] = et.hour * 60 + et.minute
    out["trade_date"] = (et + pd.Timedelta(hours=6)).normalize().tz_localize(None)
    return out


def daily_from_intraday(df):
    """Globex-day (18:00 -> 17:00 ET) high/low/close per trade date."""
    return df.groupby("trade_date").agg(h=("high", "max"), l=("low", "min"), c=("close", "last"))


def trend_from_closes(close, n=200):
    """+1 / -1: yesterday's close above / below its own n-session average.
    Uses only closes before the session it is assigned to."""
    prev = close.shift(1)
    sma = close.rolling(n, min_periods=n).mean().shift(1)
    return np.sign(prev - sma)


def daily_context(df, adr_len=20, daily=None, trend=None, trend_len=200):
    """Per-trade-date values known BEFORE the session starts: ADR (mean range of
    the prior adr_len sessions), 5-session high/low, prior calendar-week
    high/low, long-term trend. `daily` may supply real daily bars (index =
    trade date, columns h/l[/c]) when the intraday history is too short to
    build them; `trend` may supply a ready-made +1/-1 series by trade date."""
    d = (daily if daily is not None else daily_from_intraday(df)).sort_index().copy()
    d["rng"] = d.h - d.l
    ctx = pd.DataFrame(index=d.index)
    if trend is not None:
        ctx["trend"] = trend.reindex(ctx.index)
    elif "c" in d.columns:
        ctx["trend"] = trend_from_closes(d.c, trend_len)
    else:
        ctx["trend"] = np.nan
    ctx["adr"] = d.rng.rolling(adr_len, min_periods=adr_len).mean().shift(1)
    ctx["x5h"] = d.h.rolling(5, min_periods=5).max().shift(1)
    ctx["x5l"] = d.l.rolling(5, min_periods=5).min().shift(1)
    wk = d.index.to_period("W-FRI")
    ctx["pwh"] = wk.map(d.h.groupby(wk).max().shift(1)).values
    ctx["pwl"] = wk.map(d.l.groupby(wk).min().shift(1)).values
    return ctx


def run(df, p: Params = None, daily=None, tf_min=1, trend=None):
    """Walk the bars; returns list[Zone]. df must come from session_cols()."""
    p = p or Params()
    if "mins" not in df.columns:
        df = session_cols(df)
    ctx = daily_context(df, p.adr_len, daily, trend, p.trend_len)
    o = df.open.values.astype(float)
    h = df.high.values.astype(float)
    l = df.low.values.astype(float)
    c = df.close.values.astype(float)
    mins = df.mins.values.astype(int)
    td = df.trade_date.values
    n = len(df)
    bars = lambda minutes: max(1, int(np.ceil(minutes / tf_min)))   # noqa: E731
    max_bars = bars(p.max_grade_min)
    win_bars = bars(p.reclaim_window_min)
    swing_age = bars(p.swing_max_age_min)

    zones, live = [], []

    cur_td = None
    adr = np.nan
    cur_trend = 0
    as_h = as_l = lo_h = lo_l = rth_h = rth_l = np.nan
    pd_h = pd_l = np.nan
    did_asia = did_open = did_or = did_ib = did_am = False
    day_count = 0            # trade dates whose 18:00 ET start was actually observed
    # causal zigzag for intraday swing zones
    zz_dir = 0
    zz_hi = zz_lo = np.nan
    zz_hi_bar = zz_lo_bar = -1
    pending_swing = None     # (side, price) confirmed on the previous bar

    def new_zone(fam, name, side, level, i):
        if fam not in p.families or not np.isfinite(level) or not np.isfinite(adr):
            return
        # the first loaded session is partial; yesterday's RTH range needs one
        # more fully observed session than everything else
        if day_count < (2 if fam == "PD" else 1):
            return
        # the level must still be ahead of price: a top zone needs price below it
        if (side > 0 and o[i] >= level) or (side < 0 and o[i] <= level):
            return
        # one zone per level: an untapped zone already sitting there is the same thing
        for z in live:
            if z.result == "untouched" and z.side == side and z.level == level:
                return
        depth = p.depth_pts if p.depth_pts > 0 else p.depth_adr * adr
        target = p.target_adr * adr if p.target_adr > 0 else p.target_pts
        z = Zone(fam, name, side, float(level), float(depth), float(target), float(adr), i, cur_td)
        zones.append(z)
        live.append(z)

    for i in range(n):
        m = mins[i]
        # ── 1) new Globex trade date ─────────────────────────────────────────
        if td[i] != cur_td:
            for z in live:
                if z.result == "untouched" and z.fam != "SW":
                    z.result = "void"        # never tapped: dies with its session
                    z.end_bar = i
            live = [z for z in live if z.result in ("untouched", "open") or z.rc_state in ("watch", "open")]
            if cur_td is not None:
                day_count += 1
            cur_td = td[i]
            pd_h, pd_l = rth_h, rth_l        # yesterday's completed RTH range
            as_h = as_l = lo_h = lo_l = rth_h = rth_l = np.nan
            did_asia = did_open = did_or = did_ib = did_am = False
            key = pd.Timestamp(cur_td)
            row = ctx.loc[key] if key in ctx.index else None
            adr = float(row.adr) if row is not None else np.nan
            cur_trend = int(row.trend) if row is not None and np.isfinite(row.trend) else 0
            new_zone("PD", "PDH", 1, pd_h, i)
            new_zone("PD", "PDL", -1, pd_l, i)
            if row is not None:
                new_zone("X5", "5DH", 1, row.x5h, i)
                new_zone("X5", "5DL", -1, row.x5l, i)
                new_zone("PW", "PWH", 1, row.pwh, i)
                new_zone("PW", "PWL", -1, row.pwl, i)

        in_asia = m >= GLOBEX_OPEN or m < ASIA_END
        in_london = ASIA_END <= m < RTH_OPEN
        in_rth = RTH_OPEN <= m < RTH_CLOSE
        day_part = m < GLOBEX_OPEN          # 00:00-17:59 ET part of the trade date

        # ── 2) session boundaries: levels become known, zones are born ───────
        if not did_asia and not in_asia:
            did_asia = True
            new_zone("AS", "ASH", 1, as_h, i)
            new_zone("AS", "ASL", -1, as_l, i)
        if not did_open and day_part and m >= RTH_OPEN:
            did_open = True
            on_h = np.nanmax([as_h, lo_h]) if np.isfinite(as_h) or np.isfinite(lo_h) else np.nan
            on_l = np.nanmin([as_l, lo_l]) if np.isfinite(as_l) or np.isfinite(lo_l) else np.nan
            new_zone("ON", "ONH", 1, on_h, i)
            new_zone("ON", "ONL", -1, on_l, i)
            new_zone("LO", "LOH", 1, lo_h, i)
            new_zone("LO", "LOL", -1, lo_l, i)
        if not did_or and day_part and m >= OR_END:
            did_or = True
            new_zone("OR", "ORH", 1, rth_h, i)
            new_zone("OR", "ORL", -1, rth_l, i)
        if not did_ib and day_part and m >= IB_END:
            did_ib = True
            new_zone("IB", "IBH", 1, rth_h, i)
            new_zone("IB", "IBL", -1, rth_l, i)
        if not did_am and day_part and m >= AM_END:
            did_am = True
            new_zone("AM", "AMH", 1, rth_h, i)
            new_zone("AM", "AML", -1, rth_l, i)
        # a swing confirmed on the previous bar becomes a zone now
        if pending_swing is not None:
            new_zone("SW", "SWH" if pending_swing[0] > 0 else "SWL", pending_swing[0], pending_swing[1], i)
            pending_swing = None

        # ── 3) zone engine ───────────────────────────────────────────────────
        if live:
            keep = []
            for z in live:
                s = z.side
                if z.result == "untouched":
                    if z.fam == "SW" and i - z.born > swing_age:
                        z.result = "void"
                        z.end_bar = i
                        continue
                    hit = h[i] >= z.level if s > 0 else l[i] <= z.level
                    if not hit:
                        keep.append(z)
                        continue
                    # TAP - legal on the birth bar: the level is built from
                    # bars that closed before this bar opened
                    gapped = o[i] > z.level if s > 0 else o[i] < z.level
                    z.tap_bar = i
                    z.tap_price = o[i] if gapped else z.level
                    z.result = "open"
                    z.ext = h[i] if s > 0 else l[i]
                    far = z.level + s * z.depth
                    if (h[i] > far) if s > 0 else (l[i] < far):
                        z.result = "fail"
                        z.end_bar = i
                    # reclaim watch starts unless the level is already broken, or
                    # the tap bar itself closed back inside (same-bar rejection)
                    closed_in = c[i] < z.level if s > 0 else c[i] > z.level
                    if s * (z.ext - z.level) > p.sweep_max_adr * z.adr or closed_in:
                        z.rc_state = "off"
                    else:
                        z.rc_state = "watch"
                else:
                    # tier 1: tap grading
                    if z.result == "open":
                        far = z.level + s * z.depth
                        fav = (z.tap_price - l[i]) if s > 0 else (h[i] - z.tap_price)
                        if (h[i] > far) if s > 0 else (l[i] < far):
                            z.result = "fail"
                            z.end_bar = i
                        elif fav >= z.target:
                            z.result = "win"
                            z.end_bar = i
                        elif i - z.tap_bar >= max_bars:
                            z.result = "timeout"
                            z.end_bar = i
                    # tier 2: reclaim
                    if z.rc_state == "watch":
                        z.ext = max(z.ext, h[i]) if s > 0 else min(z.ext, l[i])
                        closed_in = c[i] < z.level if s > 0 else c[i] > z.level
                        if i - z.tap_bar > win_bars or s * (z.ext - z.level) > p.sweep_max_adr * z.adr:
                            z.rc_state = "off"
                        elif closed_in and i - z.tap_bar >= p.reclaim_min_dwell:
                            z.rc_state = "open"
                            z.rc_bar = i
                            z.rc_price = c[i]
                            z.rc_stop = z.ext + s * p.stop_buffer_adr * z.adr
                            z.rc_trend = cur_trend
                    elif z.rc_state == "open":
                        stopped = h[i] >= z.rc_stop if s > 0 else l[i] <= z.rc_stop
                        fav = (z.rc_price - l[i]) if s > 0 else (h[i] - z.rc_price)
                        if stopped:
                            z.rc_state = "fail"
                            z.rc_end = i
                        elif fav >= z.target:
                            z.rc_state = "win"
                            z.rc_end = i
                        elif i - z.rc_bar >= max_bars:
                            z.rc_state = "timeout"
                            z.rc_end = i
                if z.result == "open" or z.rc_state in ("watch", "open"):
                    keep.append(z)
            live = keep

        # ── 4) session trackers (after the zones were born from them) ────────
        if in_asia:
            as_h = h[i] if not np.isfinite(as_h) else max(as_h, h[i])
            as_l = l[i] if not np.isfinite(as_l) else min(as_l, l[i])
        elif in_london:
            lo_h = h[i] if not np.isfinite(lo_h) else max(lo_h, h[i])
            lo_l = l[i] if not np.isfinite(lo_l) else min(lo_l, l[i])
        elif in_rth:
            rth_h = h[i] if not np.isfinite(rth_h) else max(rth_h, h[i])
            rth_l = l[i] if not np.isfinite(rth_l) else min(rth_l, l[i])

        # ── 5) causal zigzag: a swing is known once price has retraced from it ─
        if np.isfinite(adr):
            thr = p.swing_adr * adr
            if zz_hi_bar < 0:
                zz_hi, zz_lo, zz_hi_bar, zz_lo_bar = h[i], l[i], i, i
            else:
                if zz_dir >= 0 and h[i] > zz_hi:
                    zz_hi, zz_hi_bar = h[i], i
                if zz_dir <= 0 and l[i] < zz_lo:
                    zz_lo, zz_lo_bar = l[i], i
                if zz_dir >= 0 and zz_hi_bar < i and zz_hi - l[i] >= thr:
                    pending_swing = (1, zz_hi)           # swing high confirmed
                    zz_dir = -1
                    zz_lo, zz_lo_bar = l[i], i
                elif zz_dir <= 0 and zz_lo_bar < i and h[i] - zz_lo >= thr:
                    pending_swing = (-1, zz_lo)          # swing low confirmed
                    zz_dir = 1
                    zz_hi, zz_hi_bar = h[i], i
    return zones


# ── reporting ────────────────────────────────────────────────────────────────

def taps_frame(zones, df):
    """One row per tapped zone, both tiers."""
    mins = df.mins.values
    rows = []
    for z in zones:
        if z.tap_bar < 0:
            continue
        has_rc = z.rc_bar >= 0
        rows.append({
            "date": pd.Timestamp(z.trade_date), "fam": z.fam, "name": z.name, "side": z.side,
            "level": z.level, "depth": z.depth, "target": z.target, "adr": z.adr,
            "tap_bar": z.tap_bar, "tap_mins": int(mins[z.tap_bar]), "tap_price": z.tap_price,
            "tap_result": z.result,
            "rc": has_rc, "rc_result": z.rc_state if has_rc else "",
            "rc_bar": z.rc_bar, "rc_price": z.rc_price,
            "rc_stop_dist": abs(z.rc_stop - z.rc_price) if has_rc else np.nan,
            "rc_lag": z.side * (z.ext - z.rc_price) if has_rc else np.nan,    # points behind the sweep extreme
            "rc_dwell": (z.rc_bar - z.tap_bar) if has_rc else np.nan,
            # with-trend: a bottom in an up-trend or a top in a down-trend
            "rc_with_trend": bool(has_rc and z.side * z.rc_trend < 0),
            "rc_trend": z.rc_trend if has_rc else 0,
        })
    return pd.DataFrame(rows)


def score(frame, tier="tap", by=None):
    """Hit-rate table for one tier. Timeouts / unresolved are counted but kept
    out of the hit-rate denominator (they are neither a reversal nor a failure).
    chance% is the driftless-market probability of the same bet:
        risk / (target + risk), risk = zone depth (tap) or stop distance (reclaim)."""
    if len(frame) == 0:
        return pd.DataFrame()
    f = frame.copy()
    if tier == "tap":
        f["res"] = f.tap_result
        f["risk"] = f.depth
    else:
        f = f[f.rc]
        f["res"] = f.rc_result
        f["risk"] = f.rc_stop_dist
    if len(f) == 0:
        return pd.DataFrame()
    f["chance"] = f.risk / (f.target + f.risk)
    f["_all"] = "ALL"
    g = f.groupby(by if by is not None else "_all")
    out = pd.DataFrame({
        "n": g.size(),
        "hit": g.apply(lambda x: int((x.res == "win").sum())),
        "fail": g.apply(lambda x: int((x.res == "fail").sum())),
    })
    out["other"] = out.n - out.hit - out.fail
    out["hit%"] = 100.0 * out.hit / (out.hit + out.fail).clip(lower=1)
    out["chance%"] = 100.0 * g.apply(lambda x: x.chance[x.res.isin(["win", "fail"])].mean())
    return out
