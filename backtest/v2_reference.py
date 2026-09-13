#!/usr/bin/env python3
"""SLOW REFERENCE implementation of the V2_PROXY event engine.

Deliberately naive: no sorted structures, no bisect, no incremental
accumulators, no pruning beyond the frozen economic rules. Every quantity is
recomputed from scratch by re-scanning the bar array. It is far too slow for
real data and is only ever run on small synthetic fixtures.

Its whole purpose is to answer one question: do the optimized engine's speed
choices preserve the economics? If `v2_features.compute_events` and
`reference_events` disagree on any fixture, the optimization changed behaviour.

Computes NO outcome.
"""
import math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE

BAR = V.BAR_SECONDS


def _median(xs):
    s = sorted(xs); n = len(s)
    return s[n//2] if n % 2 else 0.5*(s[n//2-1] + s[n//2])


def reference_events(bars):
    """Naive re-derivation of the frozen rules, bar by bar, level by level."""
    t, o, h, l, c = bars["t"], bars["o"], bars["h"], bars["l"], bars["c"]
    n = len(t)
    PEN = V.PROXY_SWEEP_PENETRATION_POINTS
    TOL = V.PROXY_TOUCH_TOLERANCE_POINTS
    DUP = V.PROXY_PIVOT_DUP_TOLERANCE_PTS
    PL = V.PIVOT_LEN
    atr = FE.wilder_atr(bars)
    date = [S.trade_date(x) for x in t]

    levels = []           # every level ever created, in creation order
    rows = []

    def live_available(i):
        return [x for x in levels if x["alive"] and x["available_ts"] <= t[i]]

    for i in range(n):
        d = date[i]
        if d is None:
            continue
        m = FE.session_windows(t[i])

        # ── A. levels available at t[i], derived ONLY from bars < i ──────
        prior = [j for j in range(i) if date[j] == d]
        if not prior and i > 0:                       # first bar of a new day
            py = [j for j in range(i) if date[j] is not None
                  and date[j] == date[i-1]]
            if py:
                op = S.session_epoch(d)[0]
                hi_j = max(py, key=lambda j: (h[j], -j))
                lo_j = min(py, key=lambda j: (l[j], j))
                hi_j = min([j for j in py if h[j] == h[hi_j]])
                lo_j = min([j for j in py if l[j] == l[lo_j]])
                _mk(levels, f"PDH-{d}", "pdh", -1, h[hi_j], t[hi_j], op, bars, atr)
                _mk(levels, f"PDL-{d}", "pdl", 1, l[lo_j], t[lo_j], op, bars, atr)
        iso = d.isocalendar()[:2]
        prior_wk = [j for j in range(i) if date[j] is not None
                    and date[j].isocalendar()[:2] == iso]
        if not prior_wk and i > 0:
            pw = [j for j in range(i) if date[j] is not None
                  and date[j].isocalendar()[:2] == date[i-1].isocalendar()[:2]]
            if pw:
                op = S.session_epoch(d)[0]
                hi_j = min([j for j in pw if h[j] == max(h[k] for k in pw)])
                lo_j = min([j for j in pw if l[j] == min(l[k] for k in pw)])
                wid = f"{iso[0]}W{iso[1]:02d}"
                _mk(levels, f"PWH-{wid}", "pwh", -1, h[hi_j], t[hi_j], op, bars, atr)
                _mk(levels, f"PWL-{wid}", "pwl", 1, l[lo_j], t[lo_j], op, bars, atr)
        for name, (a, b) in FE.WIN.items():
            if m < b:
                continue
            inwin = [j for j in range(i) if date[j] == d
                     and a <= FE.session_windows(t[j]) < b]
            if not inwin or any(x["level_id"] == f"{name.upper()}_H-{d}"
                                for x in levels):
                continue
            hi_j = min([j for j in inwin if h[j] == max(h[k] for k in inwin)])
            lo_j = min([j for j in inwin if l[j] == min(l[k] for k in inwin)])
            _mk(levels, f"{name.upper()}_H-{d}", f"{name}_h", -1,
                h[hi_j], t[hi_j], t[i], bars, atr)
            _mk(levels, f"{name.upper()}_L-{d}", f"{name}_l", 1,
                l[lo_j], t[lo_j], t[i], bars, atr)

        # ── B/C/D. first qualifying penetrations, then emit ──────────────
        a0 = atr[i]
        hits = []
        if a0 is not None and a0 > 0:
            for lv in live_available(i):
                if lv["has_emitted_sweep"]:
                    continue
                if lv["side"] == 1 and l[i] <= lv["price"] - PEN:
                    hits.append((lv, 1))
                elif lv["side"] == -1 and h[i] >= lv["price"] + PEN:
                    hits.append((lv, -1))
        for lv, _ in hits:
            lv["has_emitted_sweep"] = True
        hits.sort(key=lambda x: (x[0]["available_ts"], x[0]["level_id"]))
        for lv, direction in hits:
            rows.append({"level_id": lv["level_id"], "t0": t[i] + BAR,
                         "trade_date": d, "liquidity_class": lv["kind"],
                         "direction": direction,
                         "touch_count": lv["touch_count"],
                         "penetration_pts": V.penetration_pts(
                             direction, lv["price"], h[i], l[i]),
                         "level_prominence_atr": (
                             abs(lv["price"] - lv["prominence_reference_median"])
                             / lv["atr_at_availability"]
                             if lv["prominence_reference_median"] is not None
                             else None),
                         "level_age_min": (t[i]+BAR-lv["available_ts"])/60.0,
                         "level_formation_lag_min": (
                             lv["available_ts"]-lv["formation_ts"])/60.0,
                         "session_location": FE.session_location(t[i])})

        # ── E. touches, AFTER emission ───────────────────────────────────
        for lv in live_available(i):
            if lv["has_emitted_sweep"]:
                continue
            if l[i] <= lv["price"] + TOL and h[i] >= lv["price"] - TOL:
                lv["touch_count"] += 1

        # ── F. structural invalidation, only now ─────────────────────────
        for lv in live_available(i):
            if lv["kind"] != "pivot":
                continue
            if lv["side"] == 1 and l[i] <= lv["price"]-PEN and c[i] > lv["price"]:
                lv["alive"] = False
            elif lv["side"] == -1 and h[i] >= lv["price"]+PEN and c[i] < lv["price"]:
                lv["alive"] = False

        # ── G. pivots confirmed by this bar ──────────────────────────────
        k_ = i - PL
        if k_ - PL >= 0:
            for side, price, ok in (
                    (-1, h[k_], h[k_] == max(h[k_-PL:i+1])
                     and max(h[k_+1:i+1]) < h[k_]),
                    (1, l[k_], l[k_] == min(l[k_-PL:i+1])
                     and min(l[k_+1:i+1]) > l[k_])):
                if not ok:
                    continue
                dupe = [x for x in levels if x["alive"] and x["kind"] == "pivot"
                        and x["side"] == side
                        and abs(x["price"] - price) <= DUP
                        and x["available_ts"] <= t[i]]
                nid = f"{'PIVOT_H' if side == -1 else 'PIVOT_L'}-{t[k_]}"
                if dupe:
                    old = min(dupe, key=lambda x: x["available_ts"])
                    old["merged_from"] = sorted(
                        set(old["merged_from"]) | {old["level_id"], nid})
                    continue
                _mk(levels, nid, "pivot", side, price, t[k_], t[i]+BAR,
                    bars, atr)
    return rows


def _mk(levels, lid, kind, side, price, formation, avail, bars, atr):
    lv = FE.new_level(lid, kind, side, price, formation, avail)
    end = None
    for j, ts in enumerate(bars["t"]):
        if ts + BAR <= avail:
            end = j
    if end is not None and end >= 19 and atr[end] and atr[end] > 0:
        lv["prominence_reference_median"] = _median(bars["c"][end-19:end+1])
        lv["atr_at_availability"] = atr[end]
    levels.append(lv)
    return lv
