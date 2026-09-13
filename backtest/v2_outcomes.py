#!/usr/bin/env python3
"""FROZEN outcome layer for V2_PROXY Phase 1.

Implements ONLY the already-frozen definitions in FEATURE_SPEC_V2["outcomes"]
and ["landmark_features"]. No new metric is introduced here.

    Y_H  = direction * (C_H - C0) / ATR0
           C_H is the close of the bar whose CLOSE timestamp is EXACTLY t0+H.
           No nearest bar, no interpolation, no carry. Missing -> CENSORED.

    MFE/MAE use ONLY bars strictly after t0 whose close is <= t0+H. The sweep
    bar is EXCLUDED: its high/low may contain pre-confirmation movement.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2_events as V

BAR = V.BAR_SECONDS
HORIZONS = (5, 15, 30, 60)
PRIMARY = 30
LANDMARKS = (5, 10, 15, 30)
LANDMARK_REMAINING_MIN = 30          # FIXED 30m from TL for EVERY landmark


def build_index(bars):
    """open-stamp -> bar position, for one partition only."""
    return {ts: i for i, ts in enumerate(bars["t"])}


def endpoint_index(idx, t0, minutes):
    """The bar whose CLOSE is exactly t0 + minutes. Its stored OPEN stamp is
    that close minus one bar. Returns None if that exact bar is absent."""
    return idx.get(t0 + minutes * 60 - BAR)


def path_complete(idx, t0, minutes):
    """Every bar from the one opening at t0 through the endpoint must exist."""
    end_open = t0 + minutes * 60 - BAR
    ts = t0
    while ts <= end_open:
        if ts not in idx:
            return False
        ts += BAR
    return True


def outcomes(row, bars, idx):
    """All frozen outcomes for ONE event. Censored horizons are None."""
    t, h, l, c = bars["t"], bars["h"], bars["l"], bars["c"]
    t0 = row["t0"]; d = row["direction"]; c0 = row["c0"]; a0 = row["atr0"]
    out = {}
    for H in HORIZONS:
        j = endpoint_index(idx, t0, H)
        ok = j is not None and path_complete(idx, t0, H)
        out[f"y_{H}"] = (d * (c[j] - c0) / a0) if ok else None

        # MFE/MAE over bars strictly after t0 with close <= t0+H
        first = idx.get(t0)
        if ok and first is not None:
            hi = lo = None; hi_ts = lo_ts = None
            k = first
            while k <= j:
                if hi is None or h[k] > hi: hi, hi_ts = h[k], t[k] + BAR
                if lo is None or l[k] < lo: lo, lo_ts = l[k], t[k] + BAR
                k += 1
            if d == 1:
                mfe, mfe_ts = hi - c0, hi_ts
                mae, mae_ts = c0 - lo, lo_ts
            else:
                mfe, mfe_ts = c0 - lo, lo_ts
                mae, mae_ts = hi - c0, hi_ts
            out[f"mfe_{H}"] = mfe / a0
            out[f"mae_{H}"] = mae / a0
            out[f"time_to_mfe_{H}"] = (mfe_ts - t0) / 60.0
            out[f"time_to_mae_{H}"] = (mae_ts - t0) / 60.0
        else:
            for k_ in (f"mfe_{H}", f"mae_{H}", f"time_to_mfe_{H}",
                       f"time_to_mae_{H}"):
                out[k_] = None

    # ── frozen secondary outcomes, evaluated over the PRIMARY window ──────
    j = endpoint_index(idx, t0, PRIMARY)
    first = idx.get(t0)
    if j is not None and first is not None and path_complete(idx, t0, PRIMARY):
        rng = range(first, j + 1)
        def touched(price):
            return (price is not None
                    and any(l[k] <= price <= h[k] for k in rng))
        out["vwap_reached"] = touched(row.get("vwap_at_t0"))
        out["level_revisited"] = touched(row.get("level_price"))
        op = row.get("opposing_level_price")
        out["opposing_liquidity_reached"] = touched(op) if op is not None else None
    else:
        out["vwap_reached"] = out["level_revisited"] = None
        out["opposing_liquidity_reached"] = None
    return out


def landmarks(row, bars, idx):
    """Frozen landmark analysis. At landmark L only information timestamped
    <= TL is usable; the remaining horizon is FIXED at 30 minutes from TL for
    EVERY landmark; ATR0 is the denominator throughout so it cannot drift."""
    t, h, l, c = bars["t"], bars["h"], bars["l"], bars["c"]
    t0 = row["t0"]; d = row["direction"]; c0 = row["c0"]; a0 = row["atr0"]
    lvl = row["level_price"]
    res = {}
    first = idx.get(t0)
    for L in LANDMARKS:
        TL = t0 + L * 60
        jl = endpoint_index(idx, t0, L)                  # bar closing at TL
        je = endpoint_index(idx, TL, LANDMARK_REMAINING_MIN)
        base = {"reclaim_occurred_by_L": None,
                "reclaim_latency_min_if_by_L": None,
                "reclaim_magnitude_atr_if_by_L": None,
                "distance_travelled_atr_by_L": None,
                "displacement_observed_atr_by_L": None,
                "bars_elapsed": None, "remaining_return": None}
        if jl is not None and first is not None and path_complete(idx, t0, L):
            rec_ts = rec_mag = None
            dist = disp = 0.0
            for k in range(first, jl + 1):
                signed = d * (c[k] - lvl)
                if signed > 0 and rec_ts is None:
                    rec_ts = t[k] + BAR
                    rec_mag = signed / a0
                dist = max(dist, abs(c[k] - c0) / a0)
                disp = max(disp, d * (c[k] - c0) / a0)
            base.update(reclaim_occurred_by_L=rec_ts is not None,
                        reclaim_latency_min_if_by_L=(
                            (rec_ts - t0) / 60.0 if rec_ts else None),
                        reclaim_magnitude_atr_if_by_L=rec_mag,
                        distance_travelled_atr_by_L=dist,
                        displacement_observed_atr_by_L=disp,
                        bars_elapsed=jl - first + 1)
        if (jl is not None and je is not None
                and path_complete(idx, TL, LANDMARK_REMAINING_MIN)):
            base["remaining_return"] = d * (c[je] - c[jl]) / a0
        res[L] = base
    return res
