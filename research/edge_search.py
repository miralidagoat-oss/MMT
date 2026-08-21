#!/usr/bin/env python3
"""Systematic edge search on the RTH session panel.

Motivation: probe.py showed the sweep+reclaim setup this repo has been
refining for three versions has no forward edge — conditional MFE/MAE is
1.05 / 1.01 / 0.95 / 0.93 against a baseline of 1.00, and at 30m and 60m the
CONTINUATION side is the better one. Fitting entries and exits on top of that
is fitting noise, which is what the old 87-trade "PF 1.35" was.

So instead of assuming a setup, measure many candidate predictors against
forward returns on the same panel, with sample sizes big enough to mean
something, and keep only what is stable across eras.

Panel: every RTH day becomes a row of 390 one-minute bars (09:30-16:00 ET).
Decisions are evaluated on a 5-minute grid. Every feature at minute m uses
only information available at or before minute m. Responses are forward
returns normalised by a per-day volatility scale that is itself known before
the day starts, so nothing is scaled by information from the future.
"""
from __future__ import annotations

import numpy as np

import core

RTH_OPEN, RTH_CLOSE = 570, 960
NMIN = RTH_CLOSE - RTH_OPEN          # 390


def build_panel(m1):
    """(days, 390) matrices of RTH open/high/low/close/volume + day context."""
    et_min, et_day, wd = m1.et
    sel = (et_min >= RTH_OPEN) & (et_min < RTH_CLOSE) & (wd < 5)
    days = np.unique(et_day[sel])
    di = np.searchsorted(days, et_day[sel])
    mi = (et_min[sel] - RTH_OPEN).astype(np.int64)
    nd = len(days)

    O = np.full((nd, NMIN), np.nan); H = np.full((nd, NMIN), np.nan)
    L = np.full((nd, NMIN), np.nan); C = np.full((nd, NMIN), np.nan)
    V = np.zeros((nd, NMIN))
    O[di, mi] = m1.o[sel]; H[di, mi] = m1.h[sel]
    L[di, mi] = m1.l[sel]; C[di, mi] = m1.c[sel]; V[di, mi] = m1.v[sel]

    # forward-fill inside each day so a missing minute does not create a hole
    for M in (O, H, L, C):
        idx = np.where(np.isfinite(M), np.arange(NMIN)[None, :], -1)
        np.maximum.accumulate(idx, axis=1, out=idx)
        rows = np.arange(nd)[:, None]
        valid = idx >= 0
        M[:] = np.where(valid, M[rows, np.clip(idx, 0, None)], np.nan)

    filled = np.isfinite(C).sum(axis=1)
    print(f"  raw RTH days {len(days)}; minutes/day median {np.median(filled):.0f}; "
          f"dropped (<300 min) {(filled <= 300).sum()}")
    good = filled > 300
    days, O, H, L, C, V = days[good], O[good], H[good], L[good], C[good], V[good]

    # overnight context: 18:00 ET prior day -> 09:29 ET, per RTH day
    # Day D's overnight = everything from D-1's 16:00 ET close up to, but NOT
    # including, D's 09:30 open. The earlier rule flipped the session at 18:00
    # and treated "not RTH" as overnight, which put day D's own 16:00 print --
    # the closing price -- inside day D's overnight high/low. One bar per day,
    # and it leaks the session's outcome into a feature used to predict that
    # session. It has exactly the sign of the effect being measured, so it has
    # to go before any of these numbers mean anything.
    on = (et_min >= RTH_CLOSE) | (et_min < RTH_OPEN) | (wd >= 5)
    sess = et_day + (et_min >= RTH_CLOSE)
    onh = np.full(len(days), np.nan); onl = np.full(len(days), np.nan)
    k = np.searchsorted(days, sess[on])
    ok = (k < len(days)) & (sess[on] == days[np.clip(k, 0, len(days) - 1)])
    if ok.any():
        hh = np.full(len(days), -np.inf); ll = np.full(len(days), np.inf)
        np.maximum.at(hh, k[ok], m1.h[on][ok])
        np.minimum.at(ll, k[ok], m1.l[on][ok])
        onh = np.where(np.isfinite(hh) & (hh > -np.inf), hh, np.nan)
        onl = np.where(np.isfinite(ll) & (ll < np.inf), ll, np.nan)

    return dict(days=days, O=O, H=H, L=L, C=C, V=V, onh=onh, onl=onl)


def features(P):
    """Causal feature matrices, all shaped (days, 390)."""
    O, H, L, C, V = P["O"], P["H"], P["L"], P["C"], P["V"]
    nd = len(C)
    open_px = O[:, 0:1]
    prev_close = np.r_[np.nan, C[:-1, -1]][:, None]

    # per-day volatility scale, known BEFORE the day starts:
    # 20-day mean RTH range, shifted one day
    rng = np.nanmax(H, axis=1) - np.nanmin(L, axis=1)
    sc = np.full(nd, np.nan)
    for i in range(21, nd):
        sc[i] = np.nanmean(rng[i - 20:i])
    scale = sc[:, None]

    run_h = np.fmax.accumulate(H, axis=1)
    run_l = np.fmin.accumulate(L, axis=1)
    cum_v = np.cumsum(np.nan_to_num(V), axis=1)
    tp = (H + L + C) / 3.0
    vwap = np.cumsum(np.nan_to_num(tp * V), axis=1) / np.maximum(cum_v, 1e-9)
    no_vol = cum_v[:, -1] <= 0
    if no_vol.any():                       # fall back to a time-weighted mean
        tw = np.cumsum(np.nan_to_num(tp), axis=1) / np.arange(1, NMIN + 1)[None, :]
        vwap[no_vol] = tw[no_vol]

    def shift(M, k):
        out = np.full_like(M, np.nan)
        out[:, k:] = M[:, :-k]
        return out

    F = {}
    F["intraday_mom"] = (C - open_px) / scale                 # 09:30 -> now
    first30 = (C[:, 29:30] - open_px) / scale
    F["first30"] = np.where(np.arange(NMIN)[None, :] >= 30,
                            first30 * np.ones((1, NMIN)), np.nan)
    F["gap"] = ((open_px - prev_close) / scale) * np.ones((1, NMIN))
    F["mom15"] = (C - shift(C, 15)) / scale
    F["mom60"] = (C - shift(C, 60)) / scale
    F["vwap_dist"] = (C - vwap) / scale
    with np.errstate(invalid="ignore"):
        F["range_pos"] = (C - run_l) / np.maximum(run_h - run_l, 1e-9) - 0.5
    F["on_range_pos"] = ((C - P["onl"][:, None])
                         / np.maximum((P["onh"] - P["onl"])[:, None], 1e-9) - 0.5)
    F["dist_onh"] = (C - P["onh"][:, None]) / scale
    F["dist_onl"] = (C - P["onl"][:, None]) / scale
    prev_h = np.r_[np.nan, np.nanmax(H, axis=1)[:-1]][:, None]
    prev_l = np.r_[np.nan, np.nanmin(L, axis=1)[:-1]][:, None]
    F["dist_pdh"] = (C - prev_h) / scale
    F["dist_pdl"] = (C - prev_l) / scale
    F["day_range_used"] = (run_h - run_l) / scale

    # realised vol so far today vs its own 20-day norm
    r1 = np.zeros_like(C); r1[:, 1:] = np.diff(C, axis=1)
    rv = np.sqrt(np.cumsum(r1 ** 2, axis=1) / np.arange(1, NMIN + 1)[None, :])
    F["rv_rel"] = rv / np.maximum(scale / np.sqrt(NMIN), 1e-9)
    return F, scale


def responses(P, scale, horizons=(30, 60, 120)):
    C = P["C"]
    R = {}
    for h in horizons:
        fwd = np.full_like(C, np.nan)
        fwd[:, :-h] = (C[:, h:] - C[:, :-h]) / scale
        R[f"y{h}"] = fwd
    eod = (C[:, -1:] - C) / scale
    eod[:, -1] = np.nan
    R["yEOD"] = eod
    return R


def spearman_ic(x, y):
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 200:
        return np.nan, 0
    a, b = x[ok], y[ok]
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    ra -= ra.mean(); rb -= rb.mean()
    d = np.sqrt((ra * ra).sum() * (rb * rb).sum())
    return float((ra * rb).sum() / d) if d > 0 else np.nan, int(ok.sum())


def decile_spread(x, y, q=5):
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 500:
        return np.nan, np.nan
    a, b = x[ok], y[ok]
    edges = np.quantile(a, np.linspace(0, 1, q + 1))
    edges[0] -= 1e-9; edges[-1] += 1e-9
    g = np.clip(np.searchsorted(edges, a, side="right") - 1, 0, q - 1)
    top = b[g == q - 1]; bot = b[g == 0]
    if len(top) < 50 or len(bot) < 50:
        return np.nan, np.nan
    spread = top.mean() - bot.mean()
    se = np.sqrt(top.var(ddof=1) / len(top) + bot.var(ddof=1) / len(bot))
    return float(spread), float(spread / se) if se > 0 else np.nan


def synth_like(m1, seed=0):
    """Same timestamps, same per-bar volatility, but a pure random walk.

    Any feature that scores well HERE is scoring on the geometry of the test,
    not on the market. This control is the reason to trust (or discard) the
    numbers in the real table -- an IC of -0.34 is either the best intraday
    signal ever found or a measurement artifact, and only this tells you which.
    """
    rng = np.random.default_rng(seed)
    r = np.zeros(len(m1))
    real = np.zeros(len(m1))
    real[1:] = np.diff(np.log(m1.c))
    sd = np.std(real[np.isfinite(real) & (np.abs(real) < 0.01)])
    r[1:] = rng.normal(0, sd, len(m1) - 1)
    c = float(m1.c[0]) * np.exp(np.cumsum(r))
    w = np.abs(rng.normal(0, sd, len(m1))) * c
    return core.Bars(m1.t, c, c + w, c - w, c, m1.v)


def ic_matrix(fm, ym, grid):
    x = np.where(grid, fm, np.nan).ravel()
    y = np.where(grid, ym, np.nan).ravel()
    return spearman_ic(x, y)


def main(n_null=20, seed=0):
    """Report IC against a DAY-PERMUTATION null.

    The naive IC table is not interpretable on its own. Running the identical
    pipeline on a synthetic random walk gives on_range_pos an IC of -0.19 with
    t = -122 and perfect era stability -- on data with no edge in it at all.
    The artifact comes from pooling minutes: late in the session |feature| is
    large while the forward horizon (and so the response variance) is small,
    and the rank transform turns that into correlation.

    The fix is a null that keeps every bit of that geometry and destroys only
    the thing being tested. Permuting which day's RESPONSE row goes with which
    day's FEATURE row leaves both marginal structures, the intraday volatility
    profile and the horizon-shrinkage pattern exactly intact, while severing
    the actual predictive link. What survives that is signal.
    """
    m1 = core.load_1m()
    P = build_panel(m1)
    nd = len(P["days"])
    print(f"panel: {nd} RTH days x {NMIN} minutes, null = {n_null} day-permutations\n")
    F, scale = features(P)
    R = responses(P, scale)

    grid = np.zeros((nd, NMIN), dtype=bool)
    grid[:, 5:376:5] = True
    grid &= np.isfinite(scale)

    rng = np.random.default_rng(seed)
    perms = [rng.permutation(nd) for _ in range(n_null)]
    half = nd // 2

    print(f"{'feature':<16} {'resp':>6} {'IC':>8} {'null mu':>8} {'null sd':>8} "
          f"{'z':>7} {'IC_1st':>8} {'IC_2nd':>8}")
    print("-" * 76)
    rows = []
    for fname, fm in F.items():
        for rname in ("y30", "y60", "yEOD"):
            ym = R[rname]
            ic, n = ic_matrix(fm, ym, grid)
            if not np.isfinite(ic):
                continue
            null = np.array([ic_matrix(fm, ym[pm], grid)[0] for pm in perms])
            null = null[np.isfinite(null)]
            if len(null) < 5:
                continue
            mu, sd = null.mean(), null.std(ddof=1)
            z = (ic - mu) / sd if sd > 0 else 0.0
            e1 = np.zeros((nd, NMIN), bool); e1[:half] = True
            ic1, _ = ic_matrix(fm, ym, grid & e1)
            ic2, _ = ic_matrix(fm, ym, grid & ~e1)
            rows.append((abs(z), fname, rname, ic, mu, sd, z, ic1, ic2))
    rows.sort(reverse=True)
    for _, fname, rname, ic, mu, sd, z, ic1, ic2 in rows:
        flag = ""
        if abs(z) > 3 and np.isfinite(ic1) and np.isfinite(ic2) and \
                np.sign(ic1 - mu) == np.sign(ic2 - mu):
            flag = "  <-- SURVIVES"
        print(f"{fname:<16} {rname:>6} {ic:>+8.4f} {mu:>+8.4f} {sd:>8.4f} "
              f"{z:>+7.1f} {ic1:>+8.4f} {ic2:>+8.4f}{flag}")


if __name__ == "__main__":
    main()


# ── path-permutation null (the decisive one) ─────────────────────────────────

def path_null_panel(P, scale, rng):
    """Keep each day's overnight context; swap in another day's intraday path.

    The two nulls tried before disagreed, and the disagreement is informative:

      * synthetic random walk      -> on_range_pos IC -0.19  (says: artifact)
      * day-permuted responses     -> on_range_pos IC  0.00  (says: real)

    They differ in what they preserve. The feature (C_m - onh) and the response
    (C_390 - C_m) share the term C_m. Permuting response ROWS breaks that
    sharing, so that null cannot see the shared-term artifact at all -- it
    dissolves the very thing in question. The synthetic control keeps the
    sharing but changes the price process.

    This null keeps both: the substituted path supplies BOTH C_m and C_390, so
    every shared-term and horizon-shrinkage effect survives intact, while the
    real link between the overnight range and the session that followed it is
    destroyed. Paths are volatility-matched to the day they replace so the
    normalisation stays comparable.
    """
    nd = len(P["C"])
    perm = rng.permutation(nd)
    C, H, L = P["C"], P["H"], P["L"]
    sc = scale[:, 0]

    lc = np.log(np.maximum(C, 1e-9))
    r = np.zeros_like(lc)
    r[:, 1:] = np.diff(lc, axis=1)

    ratio = np.where(np.isfinite(sc[perm]) & (sc[perm] > 0),
                     sc / np.maximum(sc[perm], 1e-9), 1.0)
    ratio = np.clip(np.nan_to_num(ratio, nan=1.0), 0.2, 5.0)[:, None]

    r_new = r[perm] * ratio
    c_new = C[:, 0:1] * np.exp(np.cumsum(np.nan_to_num(r_new), axis=1))
    with np.errstate(invalid="ignore", divide="ignore"):
        up = np.clip(H[perm] / np.maximum(C[perm], 1e-9) - 1.0, 0, None) * ratio
        dn = np.clip(1.0 - L[perm] / np.maximum(C[perm], 1e-9), 0, None) * ratio
    Q = dict(P)
    Q["C"] = c_new
    Q["H"] = c_new * (1.0 + np.nan_to_num(up))
    Q["L"] = c_new * (1.0 - np.nan_to_num(dn))
    Q["V"] = P["V"][perm]
    return Q


def decisive(n_null=12, seed=1):
    m1 = core.load_1m()
    P = build_panel(m1)
    nd = len(P["C"])
    F, scale = features(P)
    R = responses(P, scale)
    grid = np.zeros((nd, NMIN), dtype=bool)
    grid[:, 5:376:5] = True
    grid &= np.isfinite(scale)

    watch = [("on_range_pos", "yEOD"), ("dist_onh", "yEOD"), ("dist_onl", "yEOD"),
             ("on_range_pos", "y60"), ("dist_onh", "y60"), ("dist_onl", "y60"),
             ("on_range_pos", "y30"), ("rv_rel", "y60"), ("day_range_used", "y60"),
             ("first30", "y60"), ("intraday_mom", "y60")]

    rng = np.random.default_rng(seed)
    nulls = {k: [] for k in watch}
    for _ in range(n_null):
        Q = path_null_panel(P, scale, rng)
        FQ, _ = features(Q)
        RQ = responses(Q, scale)
        for fname, rname in watch:
            ic, _ = ic_matrix(FQ[fname], RQ[rname], grid)
            if np.isfinite(ic):
                nulls[(fname, rname)].append(ic)

    print(f"panel {nd} days | path-permutation null, {n_null} draws\n")
    print(f"{'feature':<16} {'resp':>6} {'IC real':>9} {'null mu':>9} {'null sd':>9} "
          f"{'z':>7}  verdict")
    print("-" * 78)
    out = []
    for fname, rname in watch:
        ic, _ = ic_matrix(F[fname], R[rname], grid)
        arr = np.array(nulls[(fname, rname)])
        if len(arr) < 4:
            continue
        mu, sd = arr.mean(), arr.std(ddof=1)
        z = (ic - mu) / sd if sd > 0 else 0.0
        v = "REAL" if abs(z) > 3 else ("artifact" if abs(ic - mu) < 2 * sd else "weak")
        out.append((abs(z), fname, rname, ic, mu, sd, z, v))
    for _, fname, rname, ic, mu, sd, z, v in sorted(out, reverse=True):
        print(f"{fname:<16} {rname:>6} {ic:>+9.4f} {mu:>+9.4f} {sd:>9.4f} "
              f"{z:>+7.1f}  {v}")
