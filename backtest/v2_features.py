#!/usr/bin/env python3
"""CANONICAL V2_PROXY event-time feature engine. NO OUTCOME IS COMPUTED HERE.

This is THE implementation. Burn-in winsorization, the development availability
audit, Phase 1 and validation all call `compute_events()`. There is no reduced
or approximate second engine, and no feature is implemented only in a later
analysis script.

Every value is a function of bars whose close is <= EVENT_CONFIRMATION_TIME
(t0 = sweep bar open + 300s). Nothing looks forward.

Conformance note: this module was rewritten to match FEATURE_SPEC_V2.json
exactly. The previous version was reproducible but NOT spec-correct - it used a
MEAN of pre-sweep closes for prominence instead of a MEDIAN of pre-availability
closes, high-low instead of true range for 15m compression, a sqrt(12) proxy
instead of real 1H Wilder ATR, invented formation timestamps, silently
equal-weighted VWAP when volume was absent, and omitted 6 of the 22
confirmatory features entirely.
"""
import bisect, csv, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V

ATR_LEN = 14
BAR = V.BAR_SECONDS
MIN_COMPARATORS = 252


class VolumeUnavailable(Exception):
    """Session VWAP is broker-volume weighted by specification. If volume is
    absent, mis-sized or non-finite the run HALTS. It must never silently
    degrade into an equal-weighted typical-price average, which is a different
    statistic wearing the same name."""


# ── primitives ─────────────────────────────────────────────────────────────
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


def median(xs):
    s = sorted(xs); n = len(s)
    if n == 0:
        return None
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def load_raw(path, lo, hi):
    """ONE pass, t/o/h/l/c/v. Volume is Dukascopy broker-side volume; the
    winsorization script uses this same loader rather than re-reading the CSV
    to bolt volume on afterwards."""
    V.assert_v2_basis(path)                       # never the quantized file
    b = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
    with open(path) as f:
        r = csv.reader(f); next(r)
        for x in r:
            ts = int(x[0])
            if ts < lo or ts >= hi:
                continue
            b["t"].append(ts)
            for k, j in (("o", 1), ("h", 2), ("l", 3), ("c", 4), ("v", 5)):
                b[k].append(float(x[j]))
    return b


def true_range(h, l, c):
    """TR series for any timeframe: max(h-l, |h-prev_close|, |l-prev_close|)."""
    out = [h[0] - l[0]]
    for i in range(1, len(h)):
        out.append(max(h[i] - l[i], abs(h[i] - c[i-1]), abs(l[i] - c[i-1])))
    return out


def wilder_rma(tr, n=ATR_LEN):
    """FROZEN seed rule: SMA of the first n TR values, then Wilder recursion.
    min_periods = n, so index n-1 is the first defined value."""
    out = [None] * len(tr)
    if len(tr) < n:
        return out
    out[n-1] = sum(tr[:n]) / n
    for i in range(n, len(tr)):
        out[i] = (out[i-1] * (n - 1) + tr[i]) / n
    return out


def wilder_atr(b, n=ATR_LEN):
    return wilder_rma(true_range(b["h"], b["l"], b["c"]), n)


def bucket_id(ts, seconds=BAR):
    """Bucket-of-CME-trade-day index. The SAME bucket_id means the same
    wall-clock slot of the session on every date, which is exactly what the
    same-bucket comparator requires."""
    d = S.trade_date(ts)
    if d is None:
        return None
    o, _ = S.session_epoch(d)
    return (ts - o) // seconds


def session_windows(ts):
    """mspo: minutes since the 18:00 ET session open."""
    d = S.trade_date(ts)
    if d is None:
        return None
    o, _ = S.session_epoch(d)
    return (ts - o) // 60


SESSION_BUCKETS = (("overnight", 0, 480), ("london", 480, 840),
                   ("premarket", 840, 930), ("ny_open", 930, 990),
                   ("ny_morning", 990, 1080), ("midday", 1080, 1200),
                   ("ny_afternoon", 1200, 1260), ("power_hour", 1260, 1320),
                   ("post", 1320, 1380))


def session_location(ts):
    """The frozen mspo buckets. 1380-1440 is the maintenance hour and is NOT a
    bucket; `post` stays sparse on this proxy by construction."""
    m = session_windows(ts)
    if m is None:
        return None
    for name, a, b in SESSION_BUCKETS:
        if a <= m < b:
            return name
    return None


def same_bucket_percentile(value, history, t0, min_periods=MIN_COMPARATORS):
    """Percentile of `value` among same-bucket comparators from PRIOR dates.

    `history` is (trade_date, bucket_id, timestamp, value) restricted to ONE
    bucket. Every comparator timestamp must be strictly earlier than t0 -
    enforced here, not assumed - and exactly the most recent `min_periods` are
    used. Fewer than that returns None: missing, never partial history, never a
    neighbouring bucket standing in.
    """
    prior = [h for h in history if h[2] < t0 and h[3] is not None]
    if len(prior) < min_periods:
        return None
    ref = sorted(x[3] for x in prior[-min_periods:])
    below = sum(1 for v in ref if v < value)
    ties = sum(1 for v in ref if v == value)
    return (below + 0.5 * ties) / len(ref)


def build_state(bars):
    """Per-bar causal state: ATR, 78-bar realized vol, bucket, trade date."""
    t, c = bars["t"], bars["c"]
    atr = wilder_atr(bars)
    logret = [None] * len(t)
    for i in range(1, len(t)):
        if c[i-1] > 0 and c[i] > 0:
            logret[i] = math.log(c[i] / c[i-1])
    rv = [None] * len(t)
    run = 0
    for i in range(len(t)):
        run = run + 1 if (i and logret[i] is not None) else 0
        if run >= 78:
            rv[i] = math.sqrt(sum(logret[k]**2 for k in range(i-77, i+1)))
    return {"atr": atr, "rv": rv, "tr": true_range(bars["h"], bars["l"], c),
            "bucket": [bucket_id(x) for x in t],
            "date": [S.trade_date(x) for x in t]}


def session_vwap(bars, st):
    """Session-anchored broker-volume-weighted VWAP and sigma, reset at each
    18:00 ET open. FAILS CLOSED: no volume, wrong length or a non-finite weight
    HALTS instead of degrading to an equal-weighted average."""
    t, h, l, c = bars["t"], bars["h"], bars["l"], bars["c"]
    v = bars.get("v")
    if v is None:
        raise VolumeUnavailable(
            "session VWAP is broker-volume weighted by specification and the "
            "bar set carries no 'v' column")
    if len(v) != len(t):
        raise VolumeUnavailable(
            f"volume length {len(v)} != bar count {len(t)}")
    for i, x in enumerate(v):
        if x != x or x in (float("inf"), float("-inf")) or x < 0:
            raise VolumeUnavailable(
                f"invalid volume weight at bar index {i}")
    date = st["date"]
    vwap = [None]*len(t); sig = [None]*len(t); nbar = [0]*len(t)
    sid = [None]*len(t)
    cur = _sentinel = object(); pv = pvv = pvol = 0.0; k = 0
    for i in range(len(t)):
        if date[i] != cur:
            cur = date[i]; pv = pvv = pvol = 0.0; k = 0
        tp = (h[i] + l[i] + c[i]) / 3.0
        w = v[i]
        pv += tp * w; pvv += tp * tp * w; pvol += w; k += 1
        sid[i] = date[i]
        if pvol <= 0:
            continue                       # a zero-volume prefix has no VWAP
        m = pv / pvol
        vwap[i] = m
        sig[i] = math.sqrt(max(0.0, pvv / pvol - m * m))
        nbar[i] = k
    return vwap, sig, nbar, sid


# ── HTF series, aligned to the CME trade day ───────────────────────────────
def htf_series(bars, seconds):
    """Completed higher-timeframe buckets in chronological order.

    Each entry carries start/end, OHLC, true range, its CME trade date and its
    bucket-of-trade-day index. Buckets are anchored to the trade day, not to
    wall-clock UTC, because every comparator in the spec is 'the SAME bucket of
    the trade day'.
    """
    t, o, h, l, c = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    order, byk = [], {}
    for i in range(len(t)):
        d = S.trade_date(t[i])
        if d is None:
            continue
        so, _ = S.session_epoch(d)
        idx = (t[i] - so) // seconds
        k = (d, idx)
        b = byk.get(k)
        if b is None:
            b = {"date": d, "idx": idx, "start": so + idx * seconds,
                 "end": so + (idx + 1) * seconds, "o": o[i], "h": h[i],
                 "l": l[i], "c": c[i]}
            byk[k] = b; order.append(b)
        else:
            b["h"] = max(b["h"], h[i]); b["l"] = min(b["l"], l[i]); b["c"] = c[i]
    order.sort(key=lambda b: b["start"])
    cl = [b["c"] for b in order]
    tr = true_range([b["h"] for b in order], [b["l"] for b in order], cl)
    for j, b in enumerate(order):
        b["tr"] = tr[j]
        b["logret"] = (math.log(cl[j]/cl[j-1])
                       if j and cl[j-1] > 0 and cl[j] > 0 else None)
    return order


def htf_aggregates(bars, st, seconds):
    """Back-compatible view: (agg, newest_per_bar, sorted_keys)."""
    ser = htf_series(bars, seconds)
    agg = {b["start"]: [b["o"], b["h"], b["l"], b["c"]] for b in ser}
    ends = [b["end"] for b in ser]
    newest = [None]*len(bars["t"])
    for i, ts in enumerate(bars["t"]):
        j = bisect.bisect_right(ends, ts + BAR) - 1
        newest[i] = ser[j]["start"] if j >= 0 else None
    return agg, newest, sorted(agg)


# ── level identity and lifecycle ───────────────────────────────────────────
def _level_id(kind, stamp):
    return f"{kind.upper()}-{stamp}"


class Level(dict):
    """A level instance. `level_id` is immutable, assigned at creation, and
    survives list reordering, pruning, dict rebuilds, merging and
    serialization. View positions like 'pivot0' are NOT identities."""


def new_level(level_id, kind, side, price, formation, avail):
    return Level(level_id=level_id, kind=kind, side=side, price=price,
                 formation_ts=formation, available_ts=avail, touch_count=0,
                 has_emitted_sweep=False, merged_from=[], alive=True,
                 atr_at_availability=None, prominence_reference_median=None)


class _SortedLevels:
    """Price-ordered live levels for one side, so per-bar sweep detection and
    nearest-neighbour lookup stay linear in the levels actually involved
    instead of scanning every level on every bar."""

    def __init__(self):
        self.p = []; self.lv = []

    def add(self, level):
        j = bisect.bisect_left(self.p, level["price"])
        self.p.insert(j, level["price"]); self.lv.insert(j, level)

    def remove(self, level):
        j = bisect.bisect_left(self.p, level["price"])
        while j < len(self.p) and self.p[j] == level["price"]:
            if self.lv[j] is level:
                del self.p[j]; del self.lv[j]; return True
            j += 1
        return False

    def between(self, lo, hi):
        a = bisect.bisect_left(self.p, lo); b = bisect.bisect_right(self.p, hi)
        return self.lv[a:b]

    def ge(self, x):
        return self.lv[bisect.bisect_left(self.p, x):]

    def le(self, x):
        return self.lv[:bisect.bisect_right(self.p, x)]

    def nearest_other(self, price, exclude):
        """Distance to the closest OTHER level on this side, or None."""
        j = bisect.bisect_left(self.p, price)
        best = None
        for k in (j-1, j, j+1):
            if 0 <= k < len(self.lv) and self.lv[k] is not exclude:
                d = abs(self.lv[k]["price"] - price)
                best = d if best is None else min(best, d)
        return best


# ── the canonical engine ───────────────────────────────────────────────────
WINSORIZED = ("level_age_min", "level_formation_lag_min", "level_prominence_atr",
              "competing_liquidity_atr", "penetration_pts", "penetration_atr",
              "close_vs_level_atr", "wick_body_ratio", "vwap_dist_pts",
              "vwap_dist_sigma", "vwap_slope_sigma_per_bar",
              "minutes_since_session_open", "range_compression",
              "dist_session_open_atr", "dist_weekly_open_atr",
              "dist_overnight_high_atr", "dist_overnight_low_atr",
              "htf_15m_compression", "htf_1h_dist_ref_atr")

EVENT_FIELDS = (
    "level_id", "t0", "trade_date", "bucket",
    # the 29 declared event-time fields
    "direction", "liquidity_class", "level_kind_dynamic", "session_location",
    "level_age_min", "level_formation_lag_min", "touch_count",
    "level_prominence_atr", "competing_liquidity_atr",
    "penetration_pts", "penetration_atr", "close_vs_level_atr",
    "same_bar_reclaim", "wick_body_ratio",
    "vwap_dist_pts", "vwap_dist_sigma", "vwap_slope_sigma_per_bar",
    "minutes_since_session_open", "atr_percentile", "realized_vol_state",
    "range_compression", "dist_session_open_atr", "dist_weekly_open_atr",
    "dist_overnight_high_atr", "dist_overnight_low_atr",
    "htf_15m_compression", "htf_1h_range_pctile", "htf_1h_vol_state",
    "htf_1h_dist_ref_atr")

WIN = {"asia": (0, 480), "lon": (480, 840), "ib": (930, 990)}


def _clip(x, lo, hi):
    return None if x is None else max(lo, min(hi, x))


def _attach_prominence(lv, bars, atr, end_idx):
    """Metadata frozen AT AVAILABILITY so the feature cannot drift with sweep
    timing: the MEDIAN of the 20 closes preceding availability, and the ATR
    known at availability. `end_idx` is the last bar whose close <= availability."""
    c = bars["c"]
    if end_idx is None or end_idx < 19:
        return
    a = atr[end_idx]
    if a is None or a <= 0 or a != a:
        return
    lv["prominence_reference_median"] = median(c[end_idx-19:end_idx+1])
    lv["atr_at_availability"] = a


def compute_events(bars, st=None, trace=None):
    """THE event-time feature computation. Returns one row per (bar, level)
    first qualifying penetration. Computes NO outcome.

    `trace`, if given, is a dict that receives every level object created, so
    tests can inspect lifecycle state (alive / has_emitted_sweep / touch_count)
    without a second engine. It is diagnostic only and reads no outcome."""
    st = st or build_state(bars)
    t, o, h, l, c = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    atr, date, tr = st["atr"], st["date"], st["tr"]
    rv = st["rv"]
    n = len(t)
    vwap, vsig, vnbar, vsid = session_vwap(bars, st)
    ser15, ser1h = htf_series(bars, 900), htf_series(bars, 3600)
    end15 = [b["end"] for b in ser15]; end1h = [b["end"] for b in ser1h]
    atr1h = wilder_rma([b["tr"] for b in ser1h])
    first1h = {}
    for b in ser1h:
        first1h.setdefault(b["date"], b)

    # ── comparator histories, filtered strictly by timestamp at use ──────
    atr_hist, rv_hist = {}, {}
    for i in range(n):
        if date[i] is None or st["bucket"][i] is None:
            continue
        bk = st["bucket"][i]; ts = t[i] + BAR
        if atr[i] is not None:
            atr_hist.setdefault(bk, []).append((date[i], bk, ts, atr[i]))
        if rv[i] is not None:
            rv_hist.setdefault(bk, []).append((date[i], bk, ts, rv[i]))
    rng_hist, vol_hist = {}, {}
    for j, b in enumerate(ser1h):
        rng_hist.setdefault(b["idx"], []).append(
            (b["date"], b["idx"], b["end"], b["h"] - b["l"]))
        lrs = [ser1h[k]["logret"] for k in range(j-23, j+1)] if j >= 23 else None
        vs = (math.sqrt(sum(x*x for x in lrs))
              if lrs and all(x is not None for x in lrs) else None)
        b["volstat"] = vs
        vol_hist.setdefault(b["idx"], []).append(
            (b["date"], b["idx"], b["end"], vs))

    # ── level state ──────────────────────────────────────────────────────
    avail_side = {1: _SortedLevels(), -1: _SortedLevels()}   # all live+available
    unswept = {1: _SortedLevels(), -1: _SortedLevels()}      # not yet consumed
    pivots = []                                              # live pivot objects
    rows = []
    cur_day = cur_wk = None
    day_h = day_l = day_h_ts = day_l_ts = None
    prev = None
    wk_h = wk_l = wk_h_ts = wk_l_ts = None
    prev_wk = None
    acc = {k: [None, None, None, None] for k in WIN}          # hi,hi_ts,lo,lo_ts
    made = set()
    day_open, wk_open, on_hi, on_lo = {}, {}, {}, {}
    PEN = V.PROXY_SWEEP_PENETRATION_POINTS
    TOL = V.PROXY_TOUCH_TOLERANCE_POINTS
    DUP = V.PROXY_PIVOT_DUP_TOLERANCE_PTS
    PL = V.PIVOT_LEN

    allv = trace.setdefault("levels", []) if trace is not None else None

    def publish(lv, end_idx):
        _attach_prominence(lv, bars, atr, end_idx)
        if allv is not None:
            allv.append(lv)
        avail_side[lv["side"]].add(lv); unswept[lv["side"]].add(lv)

    def retire(lv):
        lv["alive"] = False
        avail_side[lv["side"]].remove(lv)
        unswept[lv["side"]].remove(lv)

    for i in range(n):
        d = date[i]
        if d is None:                       # maintenance hour: neither session
            continue

        # ── A. levels that become available at t[i], from bars < i only ──
        if d != cur_day:
            if prev is not None and prev[0] is not None:
                op, _ = S.session_epoch(d)
                for kind, side, px, fts in (("pdh", -1, prev[0], prev[1]),
                                            ("pdl", 1, prev[2], prev[3])):
                    publish(new_level(_level_id(kind, d), kind, side, px,
                                      fts, op), i-1)
            prev = None
            day_h = day_l = day_h_ts = day_l_ts = None
            acc = {k: [None, None, None, None] for k in WIN}
            made = set()
            cur_day = d
        iso = d.isocalendar()[:2]
        if iso != cur_wk:
            if prev_wk is not None and prev_wk[0] is not None:
                op, _ = S.session_epoch(d)
                wid = f"{iso[0]}W{iso[1]:02d}"
                for kind, side, px, fts in (("pwh", -1, prev_wk[0], prev_wk[1]),
                                            ("pwl", 1, prev_wk[2], prev_wk[3])):
                    publish(new_level(_level_id(kind, wid), kind, side, px,
                                      fts, op), i-1)
            prev_wk = None
            wk_h = wk_l = wk_h_ts = wk_l_ts = None
            cur_wk = iso
        m = session_windows(t[i])
        if d not in day_open:
            day_open[d] = o[i]
        if iso not in wk_open:
            wk_open[iso] = o[i]
        if m < 930:
            on_hi[d] = h[i] if d not in on_hi else max(on_hi[d], h[i])
            on_lo[d] = l[i] if d not in on_lo else min(on_lo[d], l[i])
        for k, (a, b) in WIN.items():
            if m >= b and acc[k][0] is not None and k not in made:
                made.add(k)
                for suf, side, px, fts in (("h", -1, acc[k][0], acc[k][1]),
                                           ("l", 1, acc[k][2], acc[k][3])):
                    kind = f"{k}_{suf}"
                    publish(new_level(_level_id(kind, d), kind, side, px,
                                      fts, t[i]), i-1)

        # ── B/C/D. first qualifying penetrations on THIS bar, then emit ──
        a0 = atr[i]
        hit = []
        if a0 is not None and a0 > 0:
            hit += [(x, 1) for x in unswept[1].ge(l[i] + PEN)]
            hit += [(x, -1) for x in unswept[-1].le(h[i] - PEN)]
        for lv, direction in hit:
            lv["has_emitted_sweep"] = True
            unswept[lv["side"]].remove(lv)
        hit.sort(key=lambda x: (x[0]["available_ts"], x[0]["level_id"]))
        t0 = t[i] + BAR
        for lv, direction in hit:
            rows.append(_row(lv, direction, i, t0, d, m, bars, st, a0,
                             vwap, vsig, vnbar, vsid, tr, rv,
                             atr_hist, rv_hist, rng_hist, vol_hist,
                             ser15, end15, ser1h, end1h, atr1h, first1h,
                             avail_side, day_open, wk_open, on_hi, on_lo, iso))

        # ── E. touch/current-bar state updates, AFTER emission ───────────
        for side in (1, -1):
            for lv in unswept[side].between(l[i] - TOL, h[i] + TOL):
                if lv["available_ts"] <= t[i]:
                    lv["touch_count"] += 1

        # ── F. structural invalidation, only now, for SUBSEQUENT bars ────
        for pv in list(pivots):
            if not pv["alive"] or pv["available_ts"] > t[i]:
                continue
            if pv["side"] == 1:
                dead = l[i] <= pv["price"] - PEN and c[i] > pv["price"]
            else:
                dead = h[i] >= pv["price"] + PEN and c[i] < pv["price"]
            if dead:
                retire(pv); pivots.remove(pv)

        # ── G. pivots confirmed by this bar, available from the next ─────
        k_ = i - PL
        if k_ - PL >= 0:
            for side, price, ok in (
                    (-1, h[k_], h[k_] == max(h[k_-PL:i+1])
                     and max(h[k_+1:i+1]) < h[k_]),
                    (1, l[k_], l[k_] == min(l[k_-PL:i+1])
                     and min(l[k_+1:i+1]) > l[k_])):
                if not ok:
                    continue
                dupe = None
                for other in avail_side[side].between(price - DUP, price + DUP):
                    if other["kind"] == "pivot" and other["alive"]:
                        dupe = other; break
                nid = _level_id("pivot_h" if side == -1 else "pivot_l", t[k_])
                if dupe is not None:
                    # frozen rule: the OLDER availability survives entirely
                    dupe["touch_count"] += 0
                    if nid not in dupe["merged_from"]:
                        dupe["merged_from"] = sorted(
                            set(dupe["merged_from"]) | {dupe["level_id"], nid})
                    continue
                lv = new_level(nid, "pivot", side, price, t[k_], t[i] + BAR)
                pivots.append(lv); publish(lv, i)
                if len(pivots) > V.MAX_ACTIVE_POOLS:
                    raise V.PoolCeilingExceeded(
                        f"{len(pivots)} pivots exceeds the safety ceiling "
                        f"{V.MAX_ACTIVE_POOLS}; HALTING rather than pruning a "
                        "valid economic level")

        # ── running extremes, with TRUE formation timestamps ─────────────
        if day_h is None or h[i] > day_h:
            day_h, day_h_ts = h[i], t[i]
        if day_l is None or l[i] < day_l:
            day_l, day_l_ts = l[i], t[i]
        if wk_h is None or h[i] > wk_h:
            wk_h, wk_h_ts = h[i], t[i]
        if wk_l is None or l[i] < wk_l:
            wk_l, wk_l_ts = l[i], t[i]
        prev = (day_h, day_h_ts, day_l, day_l_ts)
        prev_wk = (wk_h, wk_h_ts, wk_l, wk_l_ts)
        for k, (a, b) in WIN.items():
            if a <= m < b:
                if acc[k][0] is None or h[i] > acc[k][0]:
                    acc[k][0], acc[k][1] = h[i], t[i]
                if acc[k][2] is None or l[i] < acc[k][2]:
                    acc[k][2], acc[k][3] = l[i], t[i]
    return rows


def _row(lv, direction, i, t0, d, m, bars, st, a0, vwap, vsig, vnbar, vsid,
         tr, rv, atr_hist, rv_hist, rng_hist, vol_hist, ser15, end15,
         ser1h, end1h, atr1h, first1h, avail_side, day_open, wk_open,
         on_hi, on_lo, iso):
    """ONE event row: all 29 declared event-time fields, each to its frozen
    formula. A causally unavailable feature receives the frozen missing state -
    it is never silently omitted and never given a placeholder."""
    o, h, l, c = bars["o"], bars["h"], bars["l"], bars["c"]
    price = lv["price"]
    pen = V.penetration_pts(direction, price, h[i], l[i])
    close_vs = ((c[i]-price)/a0) if direction == 1 else ((price-c[i])/a0)

    # level_prominence_atr: MEDIAN of the 20 closes preceding AVAILABILITY over
    # the ATR known AT AVAILABILITY - both frozen when the level was created
    prom = (abs(price - lv["prominence_reference_median"])
            / lv["atr_at_availability"]
            if lv["prominence_reference_median"] is not None else None)

    nb = avail_side[lv["side"]].nearest_other(price, lv)
    comp = (nb / a0) if nb is not None else 10.0

    # VWAP slope: t-12 must be in the SAME VWAP session, which needs 13
    # observations including t, not 12
    slope = None
    if (i >= 12 and vnbar[i] >= 13 and vsid[i] is not None
            and vsid[i] == vsid[i-12] and vsig[i] and vsig[i] > 0
            and vwap[i] is not None and vwap[i-12] is not None):
        slope = (vwap[i] - vwap[i-12]) / (12 * vsig[i])

    # range_compression: full 12/72 windows of CLOSED 5m true ranges, no
    # partial window, frozen clip
    rc = None
    if i >= 71:
        r12 = sum(tr[i-11:i+1]) / 12.0
        r72 = sum(tr[i-71:i+1]) / 72.0
        rc = _clip(r12 / r72, 0.1, 5.0) if r72 > 0 else None

    # htf_15m_compression: TRUE RANGE, all 16 closed buckets required
    b15 = None
    j15 = bisect.bisect_right(end15, t0) - 1
    if j15 >= 15:
        w = ser15[j15-15:j15+1]
        m4 = sum(x["tr"] for x in w[-4:]) / 4.0
        m16 = sum(x["tr"] for x in w) / 16.0
        b15 = _clip(m4 / m16, 0.1, 5.0) if m16 > 0 else None

    # 1H features off ACTUAL closed 1H bars
    j1 = bisect.bisect_right(end1h, t0) - 1
    h1 = rngp = volp = None
    if j1 >= 0:
        nb1 = ser1h[j1]
        ref = first1h.get(d)
        a1 = atr1h[j1]
        if ref is not None and a1 is not None and a1 > 0:
            h1 = (nb1["c"] - ref["o"]) / a1
        rngp = same_bucket_percentile(nb1["h"] - nb1["l"],
                                      rng_hist.get(nb1["idx"], []), t0)
        if nb1.get("volstat") is not None:
            volp = same_bucket_percentile(nb1["volstat"],
                                          vol_hist.get(nb1["idx"], []), t0)

    bk = st["bucket"][i]
    atrp = same_bucket_percentile(a0, atr_hist.get(bk, []), t0)
    rvp = (same_bucket_percentile(rv[i], rv_hist.get(bk, []), t0)
           if rv[i] is not None else None)

    vd = (c[i] - vwap[i]) if vwap[i] is not None else None
    return {
        "level_id": lv["level_id"], "t0": t0, "trade_date": d, "bucket": bk,
        "direction": direction,
        "liquidity_class": lv["kind"],
        "level_kind_dynamic": lv["kind"] == "pivot",
        "session_location": session_location(t0 - BAR),
        "level_age_min": (t0 - lv["available_ts"]) / 60.0,
        "level_formation_lag_min": (lv["available_ts"] - lv["formation_ts"]) / 60.0,
        "touch_count": lv["touch_count"],
        "level_prominence_atr": prom,
        "competing_liquidity_atr": comp,
        "penetration_pts": pen,
        "penetration_atr": pen / a0,
        "close_vs_level_atr": close_vs,
        "same_bar_reclaim": close_vs > 0,
        "wick_body_ratio": _clip(
            V.wick_body_ratio(direction, o[i], h[i], l[i], c[i]), 0.0, 10.0),
        "vwap_dist_pts": vd,
        "vwap_dist_sigma": ((c[i]-vwap[i])/vsig[i])
                           if vsig[i] and vsig[i] > 0 and vwap[i] is not None
                           else None,
        "vwap_slope_sigma_per_bar": slope,
        "minutes_since_session_open": (t0 - S.session_epoch(d)[0]) / 60.0,
        "atr_percentile": atrp,
        "realized_vol_state": rvp,
        "range_compression": rc,
        "dist_session_open_atr": (c[i] - day_open[d]) / a0,
        "dist_weekly_open_atr": (c[i] - wk_open[iso]) / a0,
        "dist_overnight_high_atr": ((c[i] - on_hi[d]) / a0
                                    if m >= 930 and d in on_hi else None),
        "dist_overnight_low_atr": ((c[i] - on_lo[d]) / a0
                                   if m >= 930 and d in on_lo else None),
        "htf_15m_compression": b15,
        "htf_1h_range_pctile": rngp,
        "htf_1h_vol_state": volp,
        "htf_1h_dist_ref_atr": h1,
    }


def event_time_features(bars, st=None, *args, **kw):
    """Back-compatible alias. Extra positional arguments from the old
    signature are ignored: the canonical engine derives VWAP and the HTF
    series itself, so no caller can supply a differently-built input."""
    return compute_events(bars, st)
