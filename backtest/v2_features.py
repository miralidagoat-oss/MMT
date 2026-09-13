#!/usr/bin/env python3
"""Event-time feature computation for V2_PROXY. NO OUTCOME IS COMPUTED HERE.

This module exists so the winsorization constants can be frozen from the
DEVELOPMENT BURN-IN before any forward return is calculated. Computing
event-time features on burn-in inspects no outcome: every value below is a
function of bars at or before EVENT_CONFIRMATION_TIME.
"""
import csv, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V

ATR_LEN = 14
BAR = V.BAR_SECONDS


def quantile(sorted_x, q):
    """FROZEN: NumPy-compatible 'linear' (type 7) interpolation."""
    n = len(sorted_x)
    if n == 0:
        raise ValueError("empty sample")
    if n == 1:
        return float(sorted_x[0])
    h = (n - 1) * q
    j = int(math.floor(h))
    g = h - j
    return ((1 - g) * sorted_x[j] + g * sorted_x[j + 1]) if j + 1 < n \
        else float(sorted_x[j])


def load_raw(path, lo, hi):
    V.assert_v2_basis(path)                       # never the quantized file
    t, o, h, l, c = [], [], [], [], []
    with open(path) as f:
        r = csv.reader(f); next(r)
        for x in r:
            ts = int(x[0])
            if ts < lo or ts >= hi:
                continue
            t.append(ts); o.append(float(x[1])); h.append(float(x[2]))
            l.append(float(x[3])); c.append(float(x[4]))
    return {"t": t, "o": o, "h": h, "l": l, "c": c}


def wilder_atr(b, n=ATR_LEN):
    h, l, c = b["h"], b["l"], b["c"]
    tr = [h[0] - l[0]]
    for i in range(1, len(h)):
        tr.append(max(h[i] - l[i], abs(h[i] - c[i-1]), abs(l[i] - c[i-1])))
    out = [None] * len(tr)
    if len(tr) < n:
        return out
    seed = sum(tr[:n]) / n
    out[n-1] = seed
    for i in range(n, len(tr)):
        out[i] = (out[i-1] * (n - 1) + tr[i]) / n
    return out


def bucket_id(ts):
    """Completed 5-minute bucket-of-CME-trade-day containing ts.

    Index from the trade day's 18:00 ET open, so the SAME bucket_id means the
    same wall-clock slot of the session on every date - which is what the
    same-bucket comparator requires.
    """
    d = S.trade_date(ts)
    if d is None:
        return None
    o, _ = S.session_epoch(d)
    return (ts - o) // BAR


def build_state(bars):
    """Per-bar causal state: ATR, realized vol, bucket, trade date."""
    t = bars["t"]; c = bars["c"]
    atr = wilder_atr(bars)
    logret = [None] * len(t)
    for i in range(1, len(t)):
        if c[i-1] > 0 and c[i] > 0:
            logret[i] = math.log(c[i] / c[i-1])
    rv = [None] * len(t)
    for i in range(len(t)):
        if i >= 78 and all(logret[k] is not None for k in range(i-77, i+1)):
            rv[i] = math.sqrt(sum(logret[k]**2 for k in range(i-77, i+1)))
    return {"atr": atr, "rv": rv,
            "bucket": [bucket_id(x) for x in t],
            "date": [S.trade_date(x) for x in t]}


def same_bucket_percentile(value, history, t0, min_periods=252):
    """Percentile of `value` among same-bucket comparators from PRIOR dates.

    `history` is a list of (trade_date, bucket_id, timestamp, value) already
    restricted to one bucket. Every comparator timestamp must be strictly
    earlier than t0 - enforced here, not assumed - and exactly the most recent
    `min_periods` are used. Fewer than that returns None: the feature is
    missing, never computed on partial history and never given a neighbouring
    bucket as a stand-in.
    """
    prior = [h for h in history if h[2] < t0 and h[3] is not None]
    if len(prior) < min_periods:
        return None
    ref = sorted(x[3] for x in prior[-min_periods:])
    below = sum(1 for v in ref if v < value)
    ties = sum(1 for v in ref if v == value)
    return (below + 0.5 * ties) / len(ref)


# ── level generation, causal ───────────────────────────────────────────────
def session_windows(ts):
    """mspo of an instant: minutes since the 18:00 ET session open."""
    d = S.trade_date(ts)
    if d is None:
        return None
    o, _ = S.session_epoch(d)
    return (ts - o) // 60


def iter_levels(bars, st):
    """YIELD (bar_index, active_levels) one bar at a time.

    The first version stored a snapshot dict PER BAR. With pivots accumulating
    across the burn-in that is O(n^2) in time and memory - it reached 13.8 GB
    resident before being killed. Streaming keeps one live mapping and prunes
    pivots on structural invalidation (swept AND reclaimed), which is the
    ECONOMIC lifetime rule; MAX_ACTIVE_POOLS still HALTS rather than pruning a
    valid level.

    Availability is always the moment the algorithm could first know the level:
    a session extremum at the window's close, a pivot PIVOT_LEN bars after its
    formation bar - never backdated.
    """
    t, o, h, l, c = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    n = len(t)
    date, bucket = st["date"], st["bucket"]
    active = {}                      # key -> dict(price, side, formation, avail)
    day_h = day_l = None; cur_day = None
    prev_day_h = prev_day_l = None
    wk_h = wk_l = None; cur_wk = None; prev_wk_h = prev_wk_l = None
    win = {"asia": (0, 480), "lon": (480, 840), "ib": (930, 990)}
    acc = {k: [None, None] for k in win}
    pivots = []
    PL = V.PIVOT_LEN

    for i in range(n):
        d = date[i]
        if d is None:
            yield i, active
            continue
        m = session_windows(t[i])
        if d != cur_day:
            prev_day_h, prev_day_l = day_h, day_l
            day_h = day_l = None; cur_day = d
            acc = {k: [None, None] for k in win}
            active = {k: v for k, v in active.items()
                      if k in ("pwh", "pwl") or k.startswith("pivot")}
            if prev_day_h is not None:
                o_, _ = S.session_epoch(d)
                active["pdh"] = dict(price=prev_day_h, side=-1, kind="pdh",
                                     formation=o_ - 1, avail=o_)
                active["pdl"] = dict(price=prev_day_l, side=1, kind="pdl",
                                     formation=o_ - 1, avail=o_)
        iso = d.isocalendar()[:2]
        if iso != cur_wk:
            prev_wk_h, prev_wk_l = wk_h, wk_l
            wk_h = wk_l = None; cur_wk = iso
            if prev_wk_h is not None:
                o_, _ = S.session_epoch(d)
                active["pwh"] = dict(price=prev_wk_h, side=-1, kind="pwh",
                                     formation=o_ - 1, avail=o_)
                active["pwl"] = dict(price=prev_wk_l, side=1, kind="pwl",
                                     formation=o_ - 1, avail=o_)
        day_h = h[i] if day_h is None else max(day_h, h[i])
        day_l = l[i] if day_l is None else min(day_l, l[i])
        wk_h = h[i] if wk_h is None else max(wk_h, h[i])
        wk_l = l[i] if wk_l is None else min(wk_l, l[i])
        for k, (a, b) in win.items():
            if a <= m < b:
                acc[k][0] = h[i] if acc[k][0] is None else max(acc[k][0], h[i])
                acc[k][1] = l[i] if acc[k][1] is None else min(acc[k][1], l[i])
            elif m >= b and acc[k][0] is not None and f"{k}_h" not in active:
                nm = {"asia": "asia", "lon": "lon", "ib": "ib"}[k]
                active[f"{nm}_h"] = dict(price=acc[k][0], side=-1,
                                         kind=f"{nm}_h", formation=t[i] - 1,
                                         avail=t[i])
                active[f"{nm}_l"] = dict(price=acc[k][1], side=1,
                                         kind=f"{nm}_l", formation=t[i] - 1,
                                         avail=t[i])
        # fractal pivots: bar k confirmed at k+PL, availability = close of k+PL
        k_ = i - PL
        if k_ - PL >= 0:
            wh = h[k_-PL:i+1]; wl = l[k_-PL:i+1]
            if h[k_] == max(wh) and max(h[k_+1:i+1]) < h[k_]:
                pivots.append(dict(price=h[k_], side=-1, kind="pivot",
                                   formation=t[k_], avail=t[i] + BAR))
            if l[k_] == min(wl) and min(l[k_+1:i+1]) > l[k_]:
                pivots.append(dict(price=l[k_], side=1, kind="pivot",
                                   formation=t[k_], avail=t[i] + BAR))
            if len(pivots) > V.MAX_ACTIVE_POOLS:
                raise V.PoolCeilingExceeded(
                    f"{len(pivots)} pivots exceeds the safety ceiling "
                    f"{V.MAX_ACTIVE_POOLS}; HALTING rather than pruning a valid "
                    "economic level")
        # economic pruning: a pivot dies when structurally invalidated, i.e.
        # swept AND reclaimed on the same bar. Never pruned for being old.
        live = []
        for pv in pivots:
            if pv["avail"] > t[i]:
                live.append(pv)
                continue
            if pv["side"] == 1:
                if (l[i] <= pv["price"] - V.PROXY_SWEEP_PENETRATION_POINTS
                        and c[i] > pv["price"]):
                    continue
            else:
                if (h[i] >= pv["price"] + V.PROXY_SWEEP_PENETRATION_POINTS
                        and c[i] < pv["price"]):
                    continue
            live.append(pv)
        pivots = live
        view = dict(active)
        for j, pv in enumerate(pivots):
            if pv["avail"] <= t[i]:
                view[f"pivot{j}"] = pv
        yield i, view


# ── event-time features (NO OUTCOME) ───────────────────────────────────────
WINSORIZED = ("level_age_min", "level_formation_lag_min", "level_prominence_atr",
              "competing_liquidity_atr", "penetration_pts", "penetration_atr",
              "close_vs_level_atr", "wick_body_ratio", "vwap_dist_pts",
              "vwap_dist_sigma", "vwap_slope_sigma_per_bar",
              "minutes_since_session_open", "range_compression",
              "dist_session_open_atr", "dist_weekly_open_atr",
              "dist_overnight_high_atr", "dist_overnight_low_atr",
              "htf_15m_compression", "htf_1h_dist_ref_atr")


def session_vwap(bars, st):
    """Session-anchored VWAP and sigma, reset at each 18:00 ET open.

    Volume is BROKER volume on this proxy; every VWAP feature is proxy-specific
    and labelled so. Unweighted variance is not used - sigma is the
    volume-weighted RMS deviation from VWAP, population denominator, reset with
    the anchor.
    """
    t, h, l, c = bars["t"], bars["h"], bars["l"], bars["c"]
    v = bars.get("v") or [1.0] * len(t)
    date = st["date"]
    vwap = [None]*len(t); sig = [None]*len(t); nbar = [0]*len(t)
    cur = None; pv = pvv = pvol = 0.0; k = 0
    for i in range(len(t)):
        if date[i] != cur:
            cur = date[i]; pv = pvv = pvol = 0.0; k = 0
        tp = (h[i] + l[i] + c[i]) / 3.0
        w = max(v[i], 1e-12)
        pv += tp * w; pvv += tp * tp * w; pvol += w; k += 1
        m = pv / pvol
        var = max(0.0, pvv / pvol - m * m)
        vwap[i] = m; sig[i] = math.sqrt(var); nbar[i] = k
    return vwap, sig, nbar


def htf_aggregates(bars, st, seconds):
    """Completed HTF buckets: (start_ts -> [open,high,low,close]) plus, per bar,
    the newest bucket whose close has already passed."""
    t, o, h, l, c = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    agg = {}
    for i in range(len(t)):
        k = t[i] - (t[i] % seconds)
        b = agg.get(k)
        if b is None:
            agg[k] = [o[i], h[i], l[i], c[i]]
        else:
            b[1] = max(b[1], h[i]); b[2] = min(b[2], l[i]); b[3] = c[i]
    newest = [None]*len(t)
    for i in range(len(t)):
        t0 = t[i] + BAR                        # information set at confirmation
        k = ((t0 - seconds) // seconds) * seconds
        newest[i] = k if k in agg else None
    return agg, newest


def event_time_features(bars, st, level_stream, vwap, vsig, vnbar,
                        agg15, new15, agg1h, new1h):
    """One row per (bar, level) sweep. Every value is known at t0 = bar open +
    300s. NOTHING here looks forward."""
    t, o, h, l, c = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    atr, date, bucket = st["atr"], st["date"], st["bucket"]
    rows = []
    day_open = {}; wk_open = {}; on_hi = {}; on_lo = {}
    tr = []
    for i in range(len(t)):
        tr.append(h[i]-l[i] if i == 0 else
                  max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1])))
    for i, levels in level_stream:
        d = date[i]
        if d is None or atr[i] is None or atr[i] <= 0:
            continue
        if d not in day_open:
            day_open[d] = o[i]
        iso = d.isocalendar()[:2]
        if iso not in wk_open:
            wk_open[iso] = o[i]
        m = session_windows(t[i])
        if m is not None and m < 930:                  # overnight accumulates
            on_hi[d] = h[i] if d not in on_hi else max(on_hi[d], h[i])
            on_lo[d] = l[i] if d not in on_lo else min(on_lo[d], l[i])
        t0 = t[i] + BAR
        a0 = atr[i]
        for key, lv in (levels or {}).items():
            if lv["avail"] > t[i]:
                continue
            side = lv["side"]; price = lv["price"]
            direction = 1 if side == 1 else -1
            if not V.is_sweep(direction, price, h[i], l[i]):
                continue
            pen = V.penetration_pts(direction, price, h[i], l[i])
            close_vs = ((c[i]-price)/a0) if direction == 1 else ((price-c[i])/a0)
            comp = [abs(x["price"]-price)/a0 for k2, x in levels.items()
                    if k2 != key and x["side"] == side]
            rng12 = [tr[j] for j in range(max(0, i-11), i+1)]
            rng72 = [tr[j] for j in range(max(0, i-71), i+1)]
            k15, k1h = new15[i], new1h[i]
            b15 = None
            if k15 is not None:
                ks = sorted(x for x in agg15 if x <= k15)[-16:]
                if len(ks) == 16:
                    r4 = sum(agg15[x][1]-agg15[x][2] for x in ks[-4:])/4
                    r16 = sum(agg15[x][1]-agg15[x][2] for x in ks)/16
                    b15 = max(0.1, min(5.0, r4/r16)) if r16 > 0 else None
            h1 = None
            if k1h is not None and d in day_open:
                o1 = S.session_epoch(d)[0]
                first1h = o1 - (o1 % 3600)
                if first1h in agg1h:
                    a1h = a0 * 12 ** 0.5              # 1H ATR proxy scale
                    h1 = (agg1h[k1h][3] - agg1h[first1h][0]) / a1h
            row = {
              "t0": t0, "trade_date": d, "bucket": bucket[i],
              "direction": direction, "liquidity_class": lv["kind"],
              "level_age_min": (t0-lv["avail"])/60.0,
              "level_formation_lag_min": (lv["avail"]-lv["formation"])/60.0,
              "level_prominence_atr": abs(price - (
                  sum(c[max(0,i-20):i])/max(1,len(c[max(0,i-20):i])))) / a0,
              "competing_liquidity_atr": min(comp) if comp else 10.0,
              "penetration_pts": pen, "penetration_atr": pen/a0,
              "close_vs_level_atr": close_vs,
              "wick_body_ratio": V.wick_body_ratio(direction, o[i], h[i], l[i], c[i]),
              "vwap_dist_pts": c[i]-vwap[i],
              "vwap_dist_sigma": ((c[i]-vwap[i])/vsig[i]) if vsig[i] and vsig[i] > 0 else None,
              # item 9: insufficient history is MISSING, never 0.0
              "vwap_slope_sigma_per_bar": (
                  ((vwap[i]-vwap[i-12])/(12*vsig[i]))
                  if vnbar[i] >= 12 and i >= 12 and vsig[i] and vsig[i] > 0 else None),
              "minutes_since_session_open": (t0 - S.session_epoch(d)[0])/60.0,
              "range_compression": (max(0.1, min(5.0,
                  (sum(rng12)/len(rng12))/(sum(rng72)/len(rng72))))
                  if rng72 and sum(rng72) > 0 else None),
              "dist_session_open_atr": (c[i]-day_open[d])/a0,
              "dist_weekly_open_atr": (c[i]-wk_open[iso])/a0,
              "dist_overnight_high_atr": ((c[i]-on_hi[d])/a0
                                          if m is not None and m >= 930 and d in on_hi else None),
              "dist_overnight_low_atr": ((c[i]-on_lo[d])/a0
                                         if m is not None and m >= 930 and d in on_lo else None),
              "htf_15m_compression": b15, "htf_1h_dist_ref_atr": h1,
            }
            rows.append(row)
    return rows
