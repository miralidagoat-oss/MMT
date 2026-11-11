#!/usr/bin/env python3
"""Reversal-zone engine — bar-for-bar Python port of
indicators/mnq_reversal_zones.pine.

The engine walks intraday bars exactly like the Pine script does:

  * a ZONE is created the moment its level becomes known (a session has just
    closed) and never moves afterwards;
  * a TAP is the first bar that trades at the level (near edge of the zone);
  * the zone is graded with deliberately pessimistic OHLC rules:
      - FAIL  when price trades beyond the far edge (level +/- depth)
      - WIN   when price has travelled `target` points away from the tap price
              before that happens
      - inside one bar the far edge is always assumed to print first, and a
        win is never credited on the tap bar itself.

Nothing here looks ahead: every level is taken from bars that closed before the
zone was drawn. The same file is used for real data and for the
direction-scrambled null model (rz_null.py), so every hit-rate is reported next
to what pure chance produces under identical rules.
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

NY = "America/New_York"

# session clock, minutes after ET midnight
GLOBEX_OPEN = 18 * 60        # 18:00  new trade date starts
ASIA_END = 3 * 60            # 03:00  Asia session high/low become known
RTH_OPEN = 9 * 60 + 30       # 09:30  London + overnight high/low become known
RTH_CLOSE = 16 * 60          # 16:00  RTH high/low become known (next day's PDH/PDL)

FAMILIES = ("ON", "LO", "AS", "PD", "X5", "PW")


@dataclass
class Params:
    target_pts: float = 100.0      # reversal size that counts as a hit
    target_adr: float = 0.0        # if > 0: target = target_adr * ADR (overrides target_pts)
    depth_adr: float = 0.06        # zone depth as a fraction of ADR20
    depth_pts: float = 0.0         # if > 0: fixed zone depth in points (overrides depth_adr)
    adr_len: int = 20
    max_bars_min: int = 600        # minutes a tapped zone may stay unresolved
    families: tuple = FAMILIES


@dataclass
class Zone:
    fam: str
    name: str
    side: int                # +1 top zone (resistance), -1 bottom zone (support)
    level: float
    depth: float
    target: float
    born: int                # bar index at which the zone became known
    trade_date: object
    tap_bar: int = -1
    tap_price: float = np.nan
    result: str = "untouched"    # untouched | open | win | fail | timeout | void
    end_bar: int = -1
    heat: float = 0.0            # worst excursion beyond the tap price while live
    run: float = 0.0             # best excursion away from the tap price while live


def session_cols(df):
    """df: DataFrame indexed by UTC timestamps with open/high/low/close."""
    et = df.index.tz_convert(NY)
    out = df.copy()
    out["mins"] = et.hour * 60 + et.minute
    out["trade_date"] = (et + pd.Timedelta(hours=6)).normalize().tz_localize(None)
    return out


def daily_from_intraday(df):
    """Globex-day (18:00 -> 17:00 ET) high/low/range per trade date."""
    g = df.groupby("trade_date")
    d = g.agg(h=("high", "max"), l=("low", "min"))
    d["rng"] = d.h - d.l
    return d


def daily_context(df, adr_len=20, daily=None):
    """Per-trade-date values that are known BEFORE the session starts:
    ADR (mean range of the prior adr_len sessions), 5-day high/low, prior
    calendar-week high/low. `daily` may supply real daily bars (index =
    trade date, columns h/l) when the intraday history is too short."""
    d = daily if daily is not None else daily_from_intraday(df)
    d = d.sort_index().copy()
    d["rng"] = d.h - d.l
    ctx = pd.DataFrame(index=d.index)
    ctx["adr"] = d.rng.rolling(adr_len, min_periods=adr_len).mean().shift(1)
    ctx["x5h"] = d.h.rolling(5, min_periods=5).max().shift(1)
    ctx["x5l"] = d.l.rolling(5, min_periods=5).min().shift(1)
    wk = d.index.to_period("W-FRI")
    wh = d.h.groupby(wk).max()
    wl = d.l.groupby(wk).min()
    ctx["pwh"] = wk.map(wh.shift(1)).values
    ctx["pwl"] = wk.map(wl.shift(1)).values
    return ctx


def run(df, p: Params = None, daily=None, tf_min=1):
    """Walk the bars; returns list[Zone]. df must come from session_cols()."""
    p = p or Params()
    if "mins" not in df.columns:
        df = session_cols(df)
    ctx = daily_context(df, p.adr_len, daily)
    o = df.open.values.astype(float)
    h = df.high.values.astype(float)
    l = df.low.values.astype(float)
    mins = df.mins.values.astype(int)
    td = df.trade_date.values
    n = len(df)
    max_bars = max(1, int(round(p.max_bars_min / tf_min)))

    zones = []          # all zones ever created
    live = []           # zones waiting for a tap, or tapped and unresolved

    # running session trackers
    cur_td = None
    adr = np.nan
    as_h = as_l = lo_h = lo_l = rth_h = rth_l = np.nan
    pd_h = pd_l = np.nan            # yesterday's RTH extremes (finalised at the Globex open)
    did_asia = did_rth_open = False
    ctx_row = None
    day_count = 0       # trade dates whose 18:00 ET start was actually observed

    def new_zone(fam, name, side, level, i):
        if fam not in p.families or not np.isfinite(level) or not np.isfinite(adr):
            return
        # the first loaded session is partial: its ranges are not trustworthy,
        # and yesterday's RTH range needs one more fully observed session
        if day_count < (2 if fam == "PD" else 1):
            return
        # the level must still be ahead of price: a top zone needs price below it
        if (side > 0 and o[i] >= level) or (side < 0 and o[i] <= level):
            return
        depth = p.depth_pts if p.depth_pts > 0 else p.depth_adr * adr
        target = p.target_adr * adr if p.target_adr > 0 else p.target_pts
        z = Zone(fam, name, side, float(level), float(depth), float(target), i, cur_td)
        zones.append(z)
        live.append(z)

    for i in range(n):
        m = mins[i]
        # ── new Globex trade date ────────────────────────────────────────────
        if td[i] != cur_td:
            # zones that were never tapped die with the session they belong to
            for z in live:
                if z.result == "untouched":
                    z.result = "void"
                    z.end_bar = i
            live = [z for z in live if z.result == "open"]
            if cur_td is not None:
                day_count += 1
            cur_td = td[i]
            pd_h, pd_l = rth_h, rth_l            # yesterday's completed RTH range
            as_h = as_l = lo_h = lo_l = rth_h = rth_l = np.nan
            did_asia = did_rth_open = False
            key = pd.Timestamp(cur_td)
            ctx_row = ctx.loc[key] if key in ctx.index else None
            adr = float(ctx_row.adr) if ctx_row is not None else np.nan
            new_zone("PD", "PDH", 1, pd_h, i)
            new_zone("PD", "PDL", -1, pd_l, i)
            if ctx_row is not None:
                new_zone("X5", "5DH", 1, ctx_row.x5h, i)
                new_zone("X5", "5DL", -1, ctx_row.x5l, i)
                new_zone("PW", "PWH", 1, ctx_row.pwh, i)
                new_zone("PW", "PWL", -1, ctx_row.pwl, i)

        in_asia = m >= GLOBEX_OPEN or m < ASIA_END
        in_london = ASIA_END <= m < RTH_OPEN
        in_rth = RTH_OPEN <= m < RTH_CLOSE

        # ── session boundaries: levels become known, zones are born ──────────
        if not did_asia and not in_asia:
            did_asia = True
            new_zone("AS", "ASH", 1, as_h, i)
            new_zone("AS", "ASL", -1, as_l, i)
        if not did_rth_open and m >= RTH_OPEN and m < GLOBEX_OPEN:
            did_rth_open = True
            on_h = np.nanmax([as_h, lo_h]) if np.isfinite(as_h) or np.isfinite(lo_h) else np.nan
            on_l = np.nanmin([as_l, lo_l]) if np.isfinite(as_l) or np.isfinite(lo_l) else np.nan
            new_zone("ON", "ONH", 1, on_h, i)
            new_zone("ON", "ONL", -1, on_l, i)
            # the London extreme is its own zone only when it is not the overnight extreme
            if np.isfinite(lo_h) and lo_h < on_h:
                new_zone("LO", "LOH", 1, lo_h, i)
            if np.isfinite(lo_l) and lo_l > on_l:
                new_zone("LO", "LOL", -1, lo_l, i)
            # an untapped Asia zone that coincides with the overnight extreme is the same level
            for z in live:
                if z.fam == "AS" and z.result == "untouched" and (
                        (z.side > 0 and z.level == on_h) or (z.side < 0 and z.level == on_l)):
                    z.result = "void"
                    z.end_bar = i
            live = [z for z in live if z.result in ("untouched", "open")]

        # ── zone engine: taps and grading on this bar ────────────────────────
        if live:
            keep = []
            for z in live:
                if z.result == "untouched":
                    # a zone may be tapped on the bar it is born: its level is
                    # built from bars that closed before this bar opened
                    hit = h[i] >= z.level if z.side > 0 else l[i] <= z.level
                    if not hit:
                        keep.append(z)
                        continue
                    gapped = o[i] > z.level if z.side > 0 else o[i] < z.level
                    z.tap_bar = i
                    z.tap_price = o[i] if gapped else z.level
                    z.result = "open"
                    # tap bar: only the adverse side is graded (pessimistic)
                    adv = (h[i] - z.tap_price) if z.side > 0 else (z.tap_price - l[i])
                    z.heat = max(0.0, adv)
                    far = z.level + z.side * z.depth
                    if (h[i] > far) if z.side > 0 else (l[i] < far):
                        z.result = "fail"
                        z.end_bar = i
                    else:
                        keep.append(z)
                    continue
                # tapped and still open
                far = z.level + z.side * z.depth
                adv = (h[i] - z.tap_price) if z.side > 0 else (z.tap_price - l[i])
                fav = (z.tap_price - l[i]) if z.side > 0 else (h[i] - z.tap_price)
                if adv > z.heat:
                    z.heat = adv
                if (h[i] > far) if z.side > 0 else (l[i] < far):
                    z.result = "fail"
                    z.end_bar = i
                    continue
                if fav > z.run:
                    z.run = fav
                if fav >= z.target:
                    z.result = "win"
                    z.end_bar = i
                    continue
                if i - z.tap_bar >= max_bars:
                    z.result = "timeout"
                    z.end_bar = i
                    continue
                keep.append(z)
            live = keep

        # ── update session trackers with this bar (after zones were born) ────
        if in_asia:
            as_h = h[i] if not np.isfinite(as_h) else max(as_h, h[i])
            as_l = l[i] if not np.isfinite(as_l) else min(as_l, l[i])
        elif in_london:
            lo_h = h[i] if not np.isfinite(lo_h) else max(lo_h, h[i])
            lo_l = l[i] if not np.isfinite(lo_l) else min(lo_l, l[i])
        elif in_rth:
            rth_h = h[i] if not np.isfinite(rth_h) else max(rth_h, h[i])
            rth_l = l[i] if not np.isfinite(rth_l) else min(rth_l, l[i])
    return zones


def to_frame(zones, df):
    mins = df.mins.values
    rows = []
    for z in zones:
        if z.tap_bar < 0:
            continue
        rows.append({"date": pd.Timestamp(z.trade_date), "fam": z.fam, "name": z.name, "side": z.side,
                     "level": z.level, "depth": z.depth, "target": z.target, "tap_bar": z.tap_bar,
                     "tap_mins": int(mins[z.tap_bar]), "tap_price": z.tap_price, "result": z.result,
                     "bars": (z.end_bar - z.tap_bar) if z.end_bar >= 0 else np.nan,
                     "heat": z.heat, "run": z.run})
    return pd.DataFrame(rows)


def summarize(taps, by="fam"):
    """Hit-rate table. Timeouts / still-open zones are reported but excluded
    from the hit-rate denominator (they are neither a reversal nor a failure)."""
    if len(taps) == 0:
        return pd.DataFrame()
    g = taps.groupby(by)
    out = pd.DataFrame({
        "taps": g.size(),
        "win": g.apply(lambda x: (x.result == "win").sum()),
        "fail": g.apply(lambda x: (x.result == "fail").sum()),
        "other": g.apply(lambda x: (~x.result.isin(["win", "fail"])).sum()),
    })
    dec = (out.win + out.fail).clip(lower=1)
    out["hit%"] = 100.0 * out.win / dec
    # chance level for a driftless market: depth / (target + depth)
    ch = g.apply(lambda x: (x.depth / (x.target + x.depth)).mean())
    out["chance%"] = 100.0 * ch
    return out
