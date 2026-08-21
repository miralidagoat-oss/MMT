#!/usr/bin/env python3
"""Multi-asset RTH panel: align S&P, VIX, bonds, gold and FX onto the NQ grid.

Everything tested in this repo so far has looked at NQ alone. A single-asset
OHLCV feature space is the most heavily mined data in existence, which is
consistent with what the scan found in it: nothing above |IC| 0.02. Relative
information -- NQ against ES, the VIX term, the dollar -- is a different
space, and it is the one direction the earlier work pointed at without
testing.

Every asset is resampled onto the same (day x 390 minute) RTH grid as NQ, so
a feature at minute m sees only prices stamped at or before minute m.
"""
from __future__ import annotations

import os

import numpy as np

import core
from edge_search import NMIN, RTH_OPEN, RTH_CLOSE

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")


def grid_for(m1, days):
    """(len(days), 390) close matrix for a 1m series on the given ET day list."""
    et_min, et_day, wd = m1.et
    sel = (et_min >= RTH_OPEN) & (et_min < RTH_CLOSE) & (wd < 5)
    di = np.searchsorted(days, et_day[sel])
    valid = (di < len(days)) & (days[np.clip(di, 0, len(days) - 1)] == et_day[sel])
    mi = (et_min[sel] - RTH_OPEN).astype(np.int64)

    C = np.full((len(days), NMIN), np.nan)
    C[di[valid], mi[valid]] = m1.c[sel][valid]
    # forward-fill within each day (assets halt or print sparsely)
    idx = np.where(np.isfinite(C), np.arange(NMIN)[None, :], -1)
    np.maximum.accumulate(idx, axis=1, out=idx)
    rows = np.arange(len(days))[:, None]
    C = np.where(idx >= 0, C[rows, np.clip(idx, 0, None)], np.nan)
    return C


def load_side(sym, days):
    path = os.path.join(DATA, f"{sym}_1m.npz")
    if not os.path.exists(path):
        return None
    a = np.load(path)["bars"]
    b = core.Bars(a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4], a[:, 5])
    return grid_for(b, days)


def cross_features(P, scale, syms=("USA500IDXUSD", "VOLIDXUSD",
                                   "USTBONDTRUSD", "XAUUSD", "EURUSD")):
    """Causal cross-asset features on the NQ day/minute grid."""
    days = P["days"]
    C = P["C"]
    F = {}
    loaded = {}
    for s in syms:
        g = load_side(s, days)
        if g is not None and np.isfinite(g).mean() > 0.3:
            loaded[s] = g

    def shift(M, k):
        o = np.full_like(M, np.nan)
        o[:, k:] = M[:, :-k]
        return o

    nq_ret = np.log(np.maximum(C, 1e-9)) - np.log(np.maximum(C[:, 0:1], 1e-9))

    es = loaded.get("USA500IDXUSD")
    if es is not None:
        es_ret = np.log(np.maximum(es, 1e-9)) - np.log(np.maximum(es[:, 0:1], 1e-9))
        # NQ's move relative to ES, in units of NQ's own daily scale
        rel_px = (nq_ret - es_ret) * C
        F["es_rel_day"] = rel_px / scale
        for k in (15, 60):
            r_nq = np.log(np.maximum(C, 1e-9)) - np.log(np.maximum(shift(C, k), 1e-9))
            r_es = np.log(np.maximum(es, 1e-9)) - np.log(np.maximum(shift(es, k), 1e-9))
            F[f"es_rel_{k}"] = (r_nq - r_es) * C / scale
            # ES's own recent move: does the broader tape lead NQ?
            F[f"es_mom_{k}"] = r_es * C / scale

    vix = loaded.get("VOLIDXUSD")
    if vix is not None:
        F["vix_chg"] = (vix - vix[:, 0:1]) / np.maximum(vix[:, 0:1], 1e-9)
        lvl = vix[:, 0]
        pr = np.full(len(lvl), np.nan)
        for i in range(60, len(lvl)):
            w = lvl[i - 60:i]
            w = w[np.isfinite(w)]
            if len(w) > 20 and np.isfinite(lvl[i]):
                pr[i] = (w < lvl[i]).mean()
        F["vix_pctile"] = pr[:, None] * np.ones((1, NMIN))

    for s, key in (("USTBONDTRUSD", "bond"), ("XAUUSD", "gold"), ("EURUSD", "fx")):
        g = loaded.get(s)
        if g is not None:
            F[f"{key}_day"] = (np.log(np.maximum(g, 1e-9))
                               - np.log(np.maximum(g[:, 0:1], 1e-9))) * 100.0
            F[f"{key}_15"] = (np.log(np.maximum(g, 1e-9))
                              - np.log(np.maximum(shift(g, 15), 1e-9))) * 100.0
    return F, list(loaded)


def micro_features(P, scale):
    """NQ-internal features the earlier scan never touched: participation,
    buying pressure, and how stale the session's extremes are.

    Caveat on volume: the Dukascopy feed reports broker volume, not CME
    volume. It correlates with real activity but it is not the tape's volume,
    so any feature built on it is a proxy and is treated as one.
    """
    H, L, C, O, V = P["H"], P["L"], P["C"], P["O"], P["V"]
    nd, nm = C.shape
    F = {}

    def shift(M, k):
        o = np.full_like(M, np.nan)
        o[:, k:] = M[:, :-k]
        return o

    # participation: cumulative volume vs the typical curve for that minute,
    # built from a trailing 60-day window so it is causal
    cv = np.cumsum(np.nan_to_num(V), axis=1)
    typ = np.full_like(cv, np.nan)
    for i in range(60, nd):
        typ[i] = np.nanmedian(cv[i - 60:i], axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        F["rel_volume"] = np.where(typ > 0, cv / typ, np.nan)

    # buying pressure: where each bar closed inside its own range, averaged
    rng = np.maximum(H - L, 1e-9)
    bp = (C - L) / rng - 0.5
    for k in (15, 60):
        cs = np.cumsum(np.nan_to_num(bp), axis=1)
        out = np.full_like(bp, np.nan)
        out[:, k:] = (cs[:, k:] - cs[:, :-k]) / k
        F[f"buy_press_{k}"] = out

    # how long since the session extremes were set (a stale high is a
    # different situation from one printed a minute ago)
    run_h = np.fmax.accumulate(H, axis=1)
    run_l = np.fmin.accumulate(L, axis=1)
    age_h = np.zeros_like(C); age_l = np.zeros_like(C)
    for m in range(1, nm):
        age_h[:, m] = np.where(H[:, m] >= run_h[:, m - 1], 0, age_h[:, m - 1] + 1)
        age_l[:, m] = np.where(L[:, m] <= run_l[:, m - 1], 0, age_l[:, m - 1] + 1)
    F["age_high"] = age_h / 390.0
    F["age_low"] = age_l / 390.0

    # realised skew of recent 1m returns
    r = np.zeros_like(C); r[:, 1:] = np.diff(C, axis=1)
    k = 60
    cs1 = np.cumsum(np.nan_to_num(r), axis=1)
    cs2 = np.cumsum(np.nan_to_num(r ** 2), axis=1)
    cs3 = np.cumsum(np.nan_to_num(r ** 3), axis=1)
    out = np.full_like(C, np.nan)
    m1_ = np.full_like(C, np.nan); m2_ = np.full_like(C, np.nan); m3_ = np.full_like(C, np.nan)
    m1_[:, k:] = (cs1[:, k:] - cs1[:, :-k]) / k
    m2_[:, k:] = (cs2[:, k:] - cs2[:, :-k]) / k
    m3_[:, k:] = (cs3[:, k:] - cs3[:, :-k]) / k
    var = np.maximum(m2_ - m1_ ** 2, 1e-12)
    out = (m3_ - 3 * m1_ * var - m1_ ** 3) / var ** 1.5
    F["skew60"] = np.clip(out, -5, 5)

    # minute of day, so the model can condition on session phase
    F["tod"] = (np.arange(nm)[None, :] / float(nm)) * np.ones((nd, 1))
    return F
