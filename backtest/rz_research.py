#!/usr/bin/env python3
"""Research battery behind the reversal-zone indicator.

Every reversal idea below is turned into a CAUSAL marker (it uses only bars
that closed before the marker prints), run on real 1-minute data, and run
again on direction-scrambled copies of the same data (rz_null.py). The only
thing reported as an edge is real minus null.

    reversal  = price travels T away from the marker ...
    ... before it runs more than H past it         (H = "heat", T = target)

Under pure chance P(reversal) ~ H / (T + H). Nothing can change that
arithmetic; an edge is whatever the market does on top of it.

Commands
  proxy    Nasdaq-100 CFD vs real MNQ=F: is the long history a fair stand-in?
  law      the precision-vs-odds curve for markers placed at random moments
  levels   first touch of every classic level (prior-day / overnight / London /
           Asia / weekly / multi-day highs & lows, opening range, initial
           balance, intraday swing highs & lows) + arbitrary placebo levels
  ml       can 33 context features (time, extension, velocity, RSI, trend,
           confluence ...) tell good taps from bad? cross-validated AUC
  shock    fade fast moves (x ADR within m minutes)
  clock    fade the preceding move at fixed New-York clock times
  round    round-number levels              (real MNQ=F prices only)
  volume   volume climax at a new extreme   (real MNQ=F volume only)
  smt      ES / NQ divergence at a new 4-hour extreme (joint null)
  daily    daily-bar oversold / overbought closes on real NQ=F since 2000

Usage
  python3 rz_research.py <command> --duka DIR [--spx DIR] [--yahoo DIR]
                                   [--start YYYYMMDD] [--end YYYYMMDD] [--null N]

Needs numpy + pandas; numba makes it fast (optional); `ml` needs scikit-learn.
"""
import argparse
import os
import sys
import warnings

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # works under `python3 -I` too
import rz_data  # noqa: E402
import rz_engine  # noqa: E402
import rz_null  # noqa: E402

try:
    from numba import njit
except ImportError:                      # pure-Python fallback: same numbers, much slower
    def njit(*args, **kwargs):
        if len(args) == 1 and callable(args[0]):
            return args[0]
        return lambda f: f

warnings.filterwarnings("ignore")
HG_ADR = np.array([0.03, 0.04, 0.05, 0.06, 0.08, 0.10, 0.15])     # heat budgets, x ADR
HG_PTS = np.array([20.0, 25.0, 30.0, 40.0, 50.0, 75.0])           # heat budgets, points


# ── core measurement ─────────────────────────────────────────────────────────

@njit(cache=True)
def first_touch(high, low, opn, start, end, level, side):
    """First bar in [start, end) that reaches `level` coming from the far side.
    side=+1: resistance (price must start below). Returns (bar, tap_price)."""
    if start >= end:
        return -1, np.nan
    if side > 0:
        if opn[start] >= level:
            return -1, np.nan
        for i in range(start, end):
            if high[i] >= level:
                return i, (level if opn[i] < level else opn[i])
    else:
        if opn[start] <= level:
            return -1, np.nan
        for i in range(start, end):
            if low[i] <= level:
                return i, (level if opn[i] > level else opn[i])
    return -1, np.nan


@njit(cache=True)
def outcome(high, low, i0, p0, side, horizon_end, hgrid):
    """Marker at price p0 during bar i0. For every heat budget returns the best
    run away from p0 achieved BEFORE heat exceeded that budget. Pessimistic:
    the marker bar only counts against the marker, and inside every later bar
    the adverse extreme is assumed to print first."""
    nh = len(hgrid)
    run_before = np.zeros(nh)
    alive = np.ones(nh, dtype=np.bool_)
    heat = (high[i0] - p0) if side > 0 else (p0 - low[i0])
    for k in range(nh):
        if heat > hgrid[k]:
            alive[k] = False
    for j in range(i0 + 1, horizon_end):
        if side > 0:
            adv = high[j] - p0
            fav = p0 - low[j]
        else:
            adv = p0 - low[j]
            fav = high[j] - p0
        any_alive = False
        for k in range(nh):
            if alive[k]:
                if adv > hgrid[k]:
                    alive[k] = False
                else:
                    any_alive = True
                    if fav > run_before[k]:
                        run_before[k] = fav
        if not any_alive:
            break
    return run_before


@njit(cache=True)
def outcome_from_open(high, low, i0, p0, side, horizon_end, hgrid):
    """Same as outcome() for a marker printed at the OPEN of bar i0: the whole
    bar comes after the marker, so it is graded like any later bar."""
    nh = len(hgrid)
    run_before = np.zeros(nh)
    alive = np.ones(nh, dtype=np.bool_)
    for j in range(i0, horizon_end):
        if side > 0:
            adv = high[j] - p0
            fav = p0 - low[j]
        else:
            adv = p0 - low[j]
            fav = high[j] - p0
        any_alive = False
        for k in range(nh):
            if alive[k]:
                if adv > hgrid[k]:
                    alive[k] = False
                else:
                    any_alive = True
                    if fav > run_before[k]:
                        run_before[k] = fav
        if not any_alive:
            break
    return run_before


@njit(cache=True)
def eval_events(high, low, adr, i0s, p0s, sides, horizon, hg_adr, hg_pts):
    m = len(i0s)
    n = len(high)
    out_a = np.full((m, len(hg_adr)), np.nan)
    out_p = np.full((m, len(hg_pts)), np.nan)
    for k in range(m):
        a = adr[i0s[k]]
        if not (a > 0.0):
            continue
        end = min(n, i0s[k] + horizon)
        ra = outcome(high, low, i0s[k], p0s[k], sides[k], end, hg_adr * a)
        rp = outcome(high, low, i0s[k], p0s[k], sides[k], end, hg_pts)
        for j in range(len(hg_adr)):
            out_a[k, j] = ra[j] / a
        for j in range(len(hg_pts)):
            out_p[k, j] = rp[j]
    return out_a, out_p


def scols(df):
    out = rz_engine.session_cols(df) if "mins" not in df.columns else df.copy()
    out["rth"] = (out.mins >= 570) & (out.mins < 960)
    return out


def daily_table(df):
    d = df.groupby("trade_date").agg(o=("open", "first"), h=("high", "max"), l=("low", "min"), c=("close", "last"))
    r = df[df.rth].groupby("trade_date").agg(ro=("open", "first"), rh=("high", "max"), rl=("low", "min"),
                                             rc=("close", "last"))
    d = d.join(r)
    d["rng"] = d.h - d.l
    d["adr"] = d.rng.rolling(20, min_periods=10).mean().shift(1)     # known before the session
    return d


def prep(df):
    df = scols(df)
    d = daily_table(df)
    return {"df": df, "o": df.open.values.astype(np.float64), "h": df.high.values.astype(np.float64),
            "l": df.low.values.astype(np.float64), "c": df.close.values.astype(np.float64),
            "mins": df.mins.values.astype(np.int64), "td": df.trade_date.values, "n": len(df), "daily": d,
            "adr": pd.Series(df.trade_date.values).map(d.adr).values.astype(np.float64)}


def grade(a, ev, horizon=600):
    """Attach outcome columns nXX (run before heat > 0.XX ADR, in ADR) and pXX
    (run before heat > XX points, in points) to an event table with i0/p0/side."""
    if len(ev) == 0:
        return ev
    ra, rp = eval_events(a["h"], a["l"], a["adr"], ev.i0.values.astype(np.int64), ev.p0.values.astype(np.float64),
                         ev.side.values.astype(np.int64), horizon, HG_ADR, HG_PTS)
    for j, hv in enumerate(HG_ADR):
        ev[f"n{int(round(hv * 100)):02d}"] = ra[:, j]
    for j, hv in enumerate(HG_PTS):
        ev[f"p{int(hv)}"] = rp[:, j]
    ev["mins"] = a["mins"][ev.i0.values]
    ev["date"] = a["td"][ev.i0.values]
    return ev.dropna(subset=["n06"])


def real_and_null(df, gen, n_null, horizon=600, **kw):
    def one(d):
        a = prep(d)
        return grade(a, gen(a, **kw), horizon)
    return one(df), [one(rz_null.scramble(df, 500 + s)) for s in range(n_null)]


def compare(real, nulls, by, col="n06", T=0.20, min_n=30):
    """hit% of real vs mean hit% of the surrogates, per group."""
    def rate(ev):
        e = ev.assign(hit=(ev[col] >= T).astype(float))
        return e.groupby(by, observed=True).hit.agg(["mean", "size"])
    r = rate(real)
    nm = pd.concat([rate(x)["mean"] for x in nulls], axis=1)
    out = pd.DataFrame({"hit%": 100 * r["mean"], "n": r["size"], "null%": 100 * nm.mean(axis=1)})
    out["lift"] = out["hit%"] - out["null%"]
    out["z"] = out.lift / (100 * np.sqrt((out["null%"] / 100) * (1 - out["null%"] / 100) / out.n))
    return out[out.n >= min_n]


def show(title, tab):
    print(f"\n== {title} ==")
    print(tab.round(2).to_string() if len(tab) else "(no rows)")


# ── level catalogue + context features ───────────────────────────────────────

@njit(cache=True)
def causal_swings(high, low, thr):
    """Zigzag that emits a swing only when it becomes KNOWN (price has retraced
    thr from it). Returns confirm_bar, extreme_bar, price, kind (+1 high)."""
    n = len(high)
    cb = np.empty(n, np.int64)
    eb = np.empty(n, np.int64)
    pr = np.empty(n, np.float64)
    kd = np.empty(n, np.int64)
    m = 0
    hi_i = 0
    lo_i = 0
    direction = 0
    for i in range(1, n):
        t = thr[i]
        if not (t > 0.0):
            continue
        if direction >= 0 and high[i] > high[hi_i]:
            hi_i = i
        if direction <= 0 and low[i] < low[lo_i]:
            lo_i = i
        if direction >= 0 and hi_i < i and high[hi_i] - low[i] >= t:
            cb[m] = i
            eb[m] = hi_i
            pr[m] = high[hi_i]
            kd[m] = 1
            m += 1
            direction = -1
            lo_i = i
        elif direction <= 0 and lo_i < i and high[i] - low[lo_i] >= t:
            cb[m] = i
            eb[m] = lo_i
            pr[m] = low[lo_i]
            kd[m] = -1
            m += 1
            direction = 1
            hi_i = i
    return cb[:m], eb[:m], pr[:m], kd[:m]


@njit(cache=True)
def rsi_series(close, length):
    n = len(close)
    out = np.full(n, np.nan)
    if n <= length:
        return out
    g = 0.0
    ls = 0.0
    for i in range(1, length + 1):
        d = close[i] - close[i - 1]
        if d > 0:
            g += d
        else:
            ls -= d
    g /= length
    ls /= length
    out[length] = 100.0 - 100.0 / (1.0 + g / ls) if ls > 0 else 100.0
    for i in range(length + 1, n):
        d = close[i] - close[i - 1]
        g = (g * (length - 1) + (d if d > 0 else 0.0)) / length
        ls = (ls * (length - 1) + (-d if d < 0 else 0.0)) / length
        out[i] = 100.0 - 100.0 / (1.0 + g / ls) if ls > 0 else 100.0
    return out


def _idx(mins_seg, a, target):
    """First bar of a trade-date segment at/after an ET clock time (18:00 -> 17:00 day)."""
    return a + int(np.searchsorted((mins_seg - 1080) % 1440, (target - 1080) % 1440, side="left"))


FEATURES = ["side", "natural", "mins", "dow", "rng_sofar", "is_ext", "pos_rng", "ext_pc", "ext_go", "ext_ro", "gap",
            "on_rng", "ret1", "ret5", "dma20", "prng", "pclosepos", "vol_ratio", "rsi", "age_min", "age_live",
            "v5", "v15", "v30", "v60", "v120", "v240", "eff120", "rv30", "confl", "confl_beyond", "leg240", "fam_code"]


def gen_levels(a, n_placebo=12, seed=3, other=None, swing_frac=0.2, swing_max_age=1440):
    """First touch of every level of the catalogue, with the context known at
    the touch. `natural` = 1 when a high is met from below / a low from above."""
    df, d = a["df"], a["daily"].copy()
    o, h, l, c, mins, n = a["o"], a["h"], a["l"], a["c"], a["mins"], a["n"]
    d["radr"] = (d.rh - d.rl).rolling(20, min_periods=10).mean().shift(1)
    for k in (1, 2, 3):
        d[f"rh{k}"] = d.rh.shift(k)
        d[f"rl{k}"] = d.rl.shift(k)
    d["pc"] = d.rc.shift(1)
    for w in (5, 10, 20):
        d[f"hh{w}"] = d.h.rolling(w).max().shift(1)
        d[f"ll{w}"] = d.l.rolling(w).min().shift(1)
    wk = d.index.to_period("W-FRI")
    d["pwh"] = wk.map(d.h.groupby(wk).max().shift(1)).values
    d["pwl"] = wk.map(d.l.groupby(wk).min().shift(1)).values
    d["ret1"] = (d.rc / d.rc.shift(1) - 1).shift(1)
    d["ret5"] = (d.rc / d.rc.shift(5) - 1).shift(1)
    d["ma20"] = d.rc.rolling(20).mean().shift(1)
    d["prng"] = (d.rng / d.rng.rolling(20, min_periods=10).mean()).shift(1)
    d["pclosepos"] = ((d.rc - d.rl) / (d.rh - d.rl)).shift(1)
    d["adr5"] = d.rng.rolling(5).mean().shift(1)
    td = a["td"]
    bounds = np.flatnonzero(np.r_[True, td[1:] != td[:-1], True])
    rsi = rsi_series(c, 70)                                     # ~ 5-minute RSI(14) on 1-minute bars
    cb, eb, pr, kd = causal_swings(h, l, swing_frac * np.nan_to_num(a["adr"], nan=0.0))
    oth = None
    if other is not None:
        oj = other.reindex(df.index)
        oth = (oj.high.values.astype(float), oj.low.values.astype(float), oj.close.values.astype(float))
    rng = np.random.default_rng(seed)
    rows, sw = [], 0
    for A, B in zip(bounds[:-1], bounds[1:]):
        day = pd.Timestamp(td[A])
        r = d.loc[day]
        if not (np.isfinite(r.adr) and np.isfinite(r.pc) and np.isfinite(r.rh1) and np.isfinite(r.ma20)):
            continue
        adr = float(r.adr)
        seg = mins[A:B]
        i_open, i_ib, i_or, i_3am, i_noon = (_idx(seg, A, t) for t in (570, 630, 600, 180, 720))
        if i_open >= B or i_open <= A:
            continue
        ro, go = o[i_open], o[A]
        L = [("PD", r.rh1, A, 1), ("PD", r.rl1, A, -1), ("PDC", r.pc, A, 0), ("PW", r.pwh, A, 1), ("PW", r.pwl, A, -1),
             ("PD2", r.rh2, A, 1), ("PD2", r.rl2, A, -1), ("PD3", r.rh3, A, 1), ("PD3", r.rl3, A, -1)]
        for w in (5, 10, 20):
            L += [(f"X{w}", r[f"hh{w}"], A, 1), (f"X{w}", r[f"ll{w}"], A, -1)]
        L += [("ON", h[A:i_open].max(), i_open, 1), ("ON", l[A:i_open].min(), i_open, -1)]
        if i_3am > A:
            L += [("AS", h[A:i_3am].max(), i_3am, 1), ("AS", l[A:i_3am].min(), i_3am, -1)]
        if i_open > i_3am:
            L += [("LO", h[i_3am:i_open].max(), i_open, 1), ("LO", l[i_3am:i_open].min(), i_open, -1)]
        for fam, i_end in (("IB", i_ib), ("OR", i_or), ("AM", i_noon)):
            if i_open < i_end < B:
                L += [(fam, h[i_open:i_end].max(), i_end, 1), (fam, l[i_open:i_end].min(), i_end, -1)]
        L += [("RO", ro, i_open + 5, 0), ("GO", go, A + 5, 0)]
        known_px = np.array([x[1] for x in L if np.isfinite(x[1])])
        for j in range(n_placebo):                               # arbitrary levels (Osler-style control)
            p = r.pc + rng.uniform(-1.3, 1.3) * adr
            if np.min(np.abs(known_px - p)) >= 0.05 * adr:
                L.append(("PLACEBO", p, A if j % 2 == 0 else i_open, 0))
        levels = [(f, p, lv, ns, -1) for f, p, lv, ns in L]
        while sw < len(cb) and cb[sw] < A:
            sw += 1
        k = sw
        while k < len(cb) and cb[k] < B:                         # swings confirmed during this session
            levels.append(("SW", pr[k], cb[k] + 1, int(kd[k]), eb[k]))
            k += 1
        known = [x for x in levels if np.isfinite(x[1]) and x[0] != "PLACEBO"]
        kpx = np.array([x[1] for x in known])
        kfam = [x[0] for x in known]
        klive = np.array([x[2] for x in known])                  # bar from which each level is KNOWN
        for fam, price, live, nat, ebar in levels:
            if not np.isfinite(price) or live >= B:
                continue
            side = 1 if o[live] < price else -1
            i0, p0 = first_touch(h, l, o, live, B if fam != "SW" else min(n, live + swing_max_age), float(price), side)
            if i0 < 0 or i0 < A + 30:
                continue
            da = A if i0 >= A else max(0, i0 - 600)
            hi_b = h[da:i0].max() if i0 > da else p0
            lo_b = l[da:i0].min() if i0 > da else p0
            hi_s, lo_s = max(hi_b, p0), min(lo_b, p0)
            row = {"family": fam, "side": side, "natural": int(nat == side) if nat != 0 else -1, "level": price,
                   "p0": p0, "i0": i0, "dow": day.dayofweek,
                   "rng_sofar": (hi_s - lo_s) / adr,
                   "is_ext": float((side > 0 and p0 >= hi_b) or (side < 0 and p0 <= lo_b)),
                   "pos_rng": (p0 - lo_s) / max(hi_s - lo_s, 1e-9),
                   "ext_pc": side * (p0 - r.pc) / adr, "ext_go": side * (p0 - go) / adr,
                   "ext_ro": side * (p0 - ro) / adr if i0 > i_open else np.nan,
                   "gap": side * (ro - r.pc) / adr if i0 >= i_open else np.nan,
                   "on_rng": (h[A:i_open].max() - l[A:i_open].min()) / adr if i0 >= i_open else np.nan,
                   "ret1": side * r.ret1, "ret5": side * r.ret5, "dma20": side * (p0 - r.ma20) / adr,
                   "prng": r.prng, "pclosepos": r.pclosepos if side > 0 else 1 - r.pclosepos,
                   "vol_ratio": r.adr5 / adr, "rsi": rsi[i0 - 1] if side > 0 else 100.0 - rsi[i0 - 1],
                   "age_min": (i0 - ebar) if fam == "SW" else np.nan, "age_live": i0 - live}
            for m in (5, 15, 30, 60, 120, 240):                  # approach velocity
                row[f"v{m}"] = side * (p0 - c[i0 - m]) / adr if i0 - m >= 0 else np.nan
            j = max(0, i0 - 120)
            path = np.abs(np.diff(c[j:i0])).sum()
            row["eff120"] = abs(c[i0 - 1] - c[j]) / path if path > 0 else np.nan
            row["rv30"] = (h[max(0, i0 - 30):i0].max() - l[max(0, i0 - 30):i0].min()) / adr
            # confluence counts ONLY levels already known before the tap bar. (Counting
            # levels that the reversal itself later creates is a look-ahead leak: it took
            # the cross-validated AUC of the model below from 0.49 to a bogus 0.62.)
            near = (np.abs(kpx - price) <= 0.04 * adr) & (klive < i0)
            row["confl"] = len(set(f for f, nr in zip(kfam, near) if nr and f != fam))
            row["confl_beyond"] = int(((side * (kpx - price) > 0) & (side * (kpx - price) <= 0.10 * adr)
                                       & (klive < i0)).sum())
            j = max(0, i0 - 240)
            row["leg240"] = (p0 - l[j:i0].min()) / adr if side > 0 else (h[j:i0].max() - p0) / adr
            if oth is not None:
                oh, ol, oc = oth
                j = max(A, i0 - 240)
                if np.isfinite(oc[i0 - 1]) and i0 - j > 30:
                    if side > 0:
                        own_new = p0 >= h[j:i0].max()
                        oth_new = np.nanmax(oh[i0 - 3:i0 + 1]) >= np.nanmax(oh[j:i0])
                    else:
                        own_new = p0 <= l[j:i0].min()
                        oth_new = np.nanmin(ol[i0 - 3:i0 + 1]) <= np.nanmin(ol[j:i0])
                    row["div"] = ("not at a new 4h extreme" if not own_new else
                                  "new extreme, ES confirms" if oth_new else "new extreme, ES DIVERGES")
            rows.append(row)
    return pd.DataFrame(rows)


# ── other causal markers ─────────────────────────────────────────────────────

@njit(cache=True)
def _shock(o, h, l, c, adr, m, thr):
    n = len(c)
    i0 = np.empty(n, np.int64)
    p0 = np.empty(n, np.float64)
    sd = np.empty(n, np.int64)
    k = 0
    last_up = -10 ** 9
    last_dn = -10 ** 9
    for i in range(m + 1, n):
        a = adr[i]
        if not (a > 0.0) or not (adr[i - 1] > 0.0):
            continue
        up = c[i - m] + thr * a
        dn = c[i - m] - thr * a
        if h[i] >= up and i - last_up > m and h[i - 1] < c[i - 1 - m] + thr * adr[i - 1]:
            i0[k] = i
            p0[k] = up if o[i] < up else o[i]
            sd[k] = 1
            k += 1
            last_up = i
        if l[i] <= dn and i - last_dn > m and l[i - 1] > c[i - 1 - m] - thr * adr[i - 1]:
            i0[k] = i
            p0[k] = dn if o[i] > dn else o[i]
            sd[k] = -1
            k += 1
            last_dn = i
    return i0[:k], p0[:k], sd[:k]


def gen_shock(a, grid=((5, 0.08), (5, 0.12), (5, 0.18), (15, 0.15), (15, 0.22), (15, 0.30), (30, 0.20), (30, 0.30),
                        (30, 0.42), (60, 0.30), (60, 0.45), (60, 0.60), (120, 0.40), (120, 0.60), (120, 0.80))):
    """Fade marker the moment price has moved thr x ADR within the last m minutes."""
    out = []
    for m, thr in grid:
        i0, p0, sd = _shock(a["o"], a["h"], a["l"], a["c"], a["adr"], m, thr)
        out.append(pd.DataFrame({"i0": i0, "p0": p0, "side": sd, "m": m, "thr": thr}))
    return pd.concat(out, ignore_index=True)


def gen_clock(a, times=tuple(list(range(120, 541, 60)) + list(range(570, 961, 15)) + [1080, 1140, 1200, 1260]),
              lookbacks=(30, 60, 120)):
    """At fixed ET clock times, a fade marker against the move of the last m minutes."""
    mins, o, c, adr = a["mins"], a["o"], a["c"], a["adr"]
    out = []
    for t in times:
        idx = np.flatnonzero(mins == t)
        for m in lookbacks:
            ok = idx[idx - m - 1 >= 0]
            mv = o[ok] - c[ok - 1 - m]
            good = np.isfinite(adr[ok]) & (mv != 0)
            out.append(pd.DataFrame({"i0": ok[good], "p0": o[ok[good]], "side": np.sign(mv[good]).astype(np.int64),
                                     "t": t, "m": m}))
    ev = pd.concat(out, ignore_index=True)
    ev["hhmm"] = (ev.t // 60).astype(str).str.zfill(2) + ":" + (ev.t % 60).astype(str).str.zfill(2)
    return ev


def gen_round(a, steps=(100, 250, 500, 1000), rearm=0.10):
    """Tap of a round number approached from at least rearm x ADR away."""
    o, h, l, c, adr, n = a["o"], a["h"], a["l"], a["c"], a["adr"], a["n"]
    rows = []
    for step in steps:
        armed = {}
        for i in range(1, n):
            if not (adr[i] > 0):
                continue
            up, dn = np.ceil(c[i - 1] / step) * step, np.floor(c[i - 1] / step) * step
            if up - c[i - 1] >= rearm * adr[i]:
                armed[up] = 1
            if c[i - 1] - dn >= rearm * adr[i]:
                armed[dn] = -1
            for lv, sd in list(armed.items()):
                if sd > 0 and h[i] >= lv and o[i] < lv:
                    rows.append((i, lv, 1))
                    del armed[lv]
                elif sd < 0 and l[i] <= lv and o[i] > lv:
                    rows.append((i, lv, -1))
                    del armed[lv]
                elif abs(lv - c[i]) > 3 * adr[i]:
                    del armed[lv]
    ev = pd.DataFrame(rows, columns=["i0", "p0", "side"]).drop_duplicates()
    ev["kind"] = np.where(ev.p0 % 1000 == 0, "x000", np.where(ev.p0 % 500 == 0, "x500",
                          np.where(ev.p0 % 250 == 0, "x250/x750", "other x00")))
    return ev


def gen_volume(a, look=30):
    """Bar that makes a new `look`-minute extreme; marker at the NEXT bar's open,
    bucketed by that bar's volume relative to the prior 20 bars."""
    df, h, l, o, n = a["df"], a["h"], a["l"], a["o"], a["n"]
    rv = (df.volume / df.volume.rolling(20).mean().shift(1)).values
    hh = pd.Series(h).rolling(look).max().shift(1).values
    ll = pd.Series(l).rolling(look).min().shift(1).values
    i = np.arange(look + 1, n - 1)
    up, dn = i[h[i] > hh[i]], i[l[i] < ll[i]]
    ev = pd.DataFrame({"i0": np.r_[up, dn] + 1, "p0": o[np.r_[up, dn] + 1],
                       "side": np.r_[np.ones(len(up)), -np.ones(len(dn))].astype(np.int64),
                       "rvol": rv[np.r_[up, dn]]})
    ev["vol"] = pd.cut(ev.rvol, [0, 1, 2, 3, 5, 1e9], labels=["<1x", "1-2x", "2-3x", "3-5x", ">5x"])
    return ev.dropna(subset=["vol"])


# ── commands ─────────────────────────────────────────────────────────────────

def load_nq(args):
    return rz_data.load_duka(args.duka, start=args.start, end=args.end)


def load_mnq(args, name="MNQ_1m.csv"):
    df, fixed = rz_data.clean_yahoo(rz_data.load_csv(os.path.join(args.yahoo, name)))
    print(f"real MNQ=F {name}: {len(df):,} bars, {fixed} glitched extreme(s) repaired")
    return df


def cmd_proxy(args):
    cfd = rz_data.load_duka(args.duka, start=args.start, end=args.end)
    mnq = load_mnq(args)
    j = cfd.join(mnq, lsuffix="_cfd", rsuffix="_mnq", how="inner")
    r1c, r1m = np.log(j.close_cfd).diff(), np.log(j.close_mnq).diff()
    basis = j.close_mnq - j.close_cfd
    print(f"overlap {len(j):,} one-minute bars  {j.index[0]} -> {j.index[-1]}")
    print(f"1-minute return correlation  {r1c.corr(r1m):.4f}")
    print(f"5-minute return correlation  {np.log(j.close_cfd).diff(5).corr(np.log(j.close_mnq).diff(5)):.4f}")
    print(f"lead/lag check (corr at -1, 0, +1 bars): "
          f"{r1c.corr(r1m.shift(-1)):.3f}  {r1c.corr(r1m):.3f}  {r1c.corr(r1m.shift(1)):.3f}")
    print(f"mean 1-minute range: CFD {(j.high_cfd - j.low_cfd).mean():.2f} pts, MNQ {(j.high_mnq - j.low_mnq).mean():.2f} pts")
    print(f"futures basis (MNQ - CFD): first day {basis.iloc[:1000].mean():.0f} pts -> last day {basis.iloc[-1000:].mean():.0f} pts")


def cmd_law(args):
    hg = np.array([5., 10., 15., 20., 30., 40., 50., 75., 100., 150., 200.])
    sets = [("Nasdaq-100 CFD 1m", load_nq(args))]
    if args.yahoo:
        sets.append(("REAL MNQ=F 1m", load_mnq(args)))
    for name, df in sets:
        h, l, o = (df[x].values.astype(float) for x in ("high", "low", "open"))
        rng = np.random.default_rng(5)
        idx = np.sort(rng.integers(5, len(df) - 5, 60000))
        sides = rng.choice(np.array([-1, 1]), len(idx))
        hits = np.zeros(len(hg))
        for i0, s in zip(idx, sides):
            hits += outcome_from_open(h, l, i0, o[i0], s, min(len(h), i0 + 3000), hg) >= args.target
        print(f"\n{name}: {len(idx):,} markers at random moments, target {args.target:.0f} pts")
        print("  heat allowed   reversed   chance = heat/(target+heat)")
        for hv, x in zip(hg, hits):
            print(f"  {hv:6.0f} pts     {100 * x / len(idx):5.1f}%      {100 * hv / (hv + args.target):5.1f}%")


def cmd_levels(args):
    real, nulls = real_and_null(load_nq(args), gen_levels, args.null)
    for e in [real] + nulls:
        e["grp"] = np.where(e.family == "PLACEBO", "PLACEBO (arbitrary level)",
                            np.where(e.natural == 1, e.family, e.family + " (flipped role)"))
    print(f"{len(real):,} first touches on {real.date.nunique()} sessions; chance for these settings ~ 23%")
    show("first touch: reversal >= 0.2 ADR before heat > 0.06 ADR", compare(real, nulls, "grp").sort_values("z"))
    show("first touch: reversal >= 100 pts before heat > 30 pts", compare(real, nulls, "grp", "p30", 100.0).sort_values("z"))


def cmd_ml(args):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    a = prep(load_nq(args))
    ev = grade(a, gen_levels(a, n_placebo=0)).sort_values("i0").reset_index(drop=True)
    ev["y"] = (ev.n06 >= 0.20).astype(int)
    ev["fam_code"] = ev.family.astype("category").cat.codes
    dates = np.sort(ev.date.unique())
    pred = np.full(len(ev), np.nan)
    for fold in np.array_split(dates, 5):                          # blocked time-series CV with a 4-day embargo
        te = ev.date.isin(fold)
        tr = ~ev.date.between(fold[0] - pd.Timedelta(days=4), fold[-1] + pd.Timedelta(days=4))
        m = HistGradientBoostingClassifier(max_depth=3, max_iter=150, learning_rate=0.04, min_samples_leaf=60,
                                           l2_regularization=1.0).fit(ev.loc[tr, FEATURES], ev.loc[tr, "y"])
        pred[te.values] = m.predict_proba(ev.loc[te, FEATURES])[:, 1]
    ev["pred"] = pred
    print(f"{len(ev):,} level taps on {len(dates)} sessions, base rate {100 * ev.y.mean():.1f}%, {len(FEATURES)} features")
    print(f"cross-validated AUC {roc_auc_score(ev.y, ev.pred):.3f}   (0.50 = no skill)")
    dec = ev.assign(decile=pd.qcut(ev.pred, 10, labels=False)).groupby("decile").agg(
        n=("y", "size"), predicted=("pred", "mean"), actual=("y", "mean"))
    show("model deciles: predicted vs actual reversal rate", 100 * dec[["predicted", "actual"]].assign(n=dec.n / 100))


def cmd_shock(args):
    real, nulls = real_and_null(load_nq(args), gen_shock, args.null)
    show("fade a fast move: reversal >= 0.2 ADR before heat > 0.06 ADR  (m = minutes, thr = move in ADR)",
         compare(real, nulls, ["m", "thr"]))
    for e in [real] + nulls:
        e["sess"] = np.where((e.mins >= 570) & (e.mins < 960), "RTH", "overnight")
        e["dir"] = np.where(e.side > 0, "fade a spike up", "fade a drop")
    show("pooled by session and direction", compare(real, nulls, ["sess", "dir"]))


def cmd_clock(args):
    real, nulls = real_and_null(load_nq(args), gen_clock, args.null)
    tab = compare(real, nulls, ["hhmm", "m"], min_n=40)
    lift = tab.reset_index().pivot(index="hhmm", columns="m", values="lift").add_prefix("lift_m")
    z = tab.reset_index().pivot(index="hhmm", columns="m", values="z").add_prefix("z_m")
    show("fade the last m minutes at a fixed ET clock time (lift in points of hit-rate, z-score)",
         pd.concat([lift, z], axis=1))
    print(f"\n|z| > 2 in {(tab.z.abs() > 2).sum()} of {len(tab)} cells (chance alone gives ~{0.0455 * len(tab):.0f}). "
          "Run two different periods (--start/--end) and compare: the lifts do not persist.")


def cmd_round(args):
    for name, horizon in (("MNQ_1m.csv", 600), ("MNQ_5m.csv", 120)):
        real, nulls = real_and_null(load_mnq(args, name), gen_round, max(args.null, 20), horizon)
        show(f"round numbers on real MNQ=F ({name}): reversal >= 0.2 ADR before heat > 0.06 ADR",
             compare(real, nulls, "kind", min_n=10))


def cmd_volume(args):
    real, nulls = real_and_null(load_mnq(args), gen_volume, max(args.null, 20))
    show("volume climax at a new 30-minute extreme, real MNQ=F volume (marker = next bar's open)",
         compare(real, nulls, "vol", min_n=20))


def cmd_smt(args):
    nq, sp = load_nq(args), rz_data.load_duka(args.spx, start=args.start, end=args.end)
    idx = nq.index.intersection(sp.index)
    nq, sp = nq.loc[idx], sp.loc[idx]
    print(f"aligned NQ/ES bars {len(idx):,}  {idx[0]} -> {idx[-1]}  "
          f"1-minute return correlation {np.log(nq.close).diff().corr(np.log(sp.close).diff()):.3f}")

    def one(x, y):
        a = prep(x)
        e = grade(a, gen_levels(a, n_placebo=0, other=y))
        return e.dropna(subset=["div"])
    real = one(nq, sp)
    nulls = [one(*rz_null.scramble_pair(nq, sp, 4000 + s)) for s in range(args.null)]   # identical flips for both
    show("level taps by ES/NQ divergence state: reversal >= 0.2 ADR before heat > 0.06 ADR",
         compare(real, nulls, "div"))


def cmd_daily(args):
    d = pd.read_csv(os.path.join(args.yahoo, "NQ_1d.csv"))
    c = d.set_index(pd.to_datetime(d.time, unit="s")).close
    chg = c.diff()
    up = chg.clip(lower=0).ewm(alpha=0.5, adjust=False).mean()
    dn = (-chg.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean()
    rsi2 = 100 - 100 / (1 + up / dn)
    ret = c.pct_change()
    f1 = c.shift(-1) / c - 1                                   # next session's close-to-close return
    conds = {"all days": pd.Series(True, index=c.index), "RSI(2) < 10 (oversold)": rsi2 < 10,
             "3 down closes": (ret < 0) & (ret.shift(1) < 0) & (ret.shift(2) < 0),
             "RSI(2) > 90 (overbought)": rsi2 > 90,
             "3 up closes": (ret > 0) & (ret.shift(1) > 0) & (ret.shift(2) > 0)}
    print(f"real NQ=F daily closes, {c.index[0].date()} -> {c.index[-1].date()}: next-session return after ...")
    for era in (("2000", "2012"), ("2013", "2020"), ("2021", "2026")):
        print(f"\n  {era[0]}-{era[1]}")
        for name, m in conds.items():
            y = f1[m].loc[era[0]:era[1]].dropna()
            print(f"    {name:26s} n={len(y):5d}  mean {100 * y.mean():+.3f}%  t={y.mean() / (y.std() / np.sqrt(len(y))):+.2f}"
                  f"  up {100 * (y > 0).mean():.1f}%")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["proxy", "law", "levels", "ml", "shock", "clock", "round", "volume", "smt", "daily"])
    ap.add_argument("--duka", help="directory of Dukascopy USATECHIDXUSD day files")
    ap.add_argument("--spx", help="directory of Dukascopy USA500IDXUSD day files (smt)")
    ap.add_argument("--yahoo", help="directory with MNQ_1m.csv / MNQ_5m.csv / NQ_1d.csv from rz_data.py yahoo")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--null", type=int, default=8)
    ap.add_argument("--target", type=float, default=100.0)
    args = ap.parse_args()
    pd.set_option("display.width", 220)
    pd.set_option("display.max_rows", 300)
    need = {"proxy": ("duka", "yahoo"), "law": ("duka",), "levels": ("duka",), "ml": ("duka",), "shock": ("duka",),
            "clock": ("duka",), "round": ("yahoo",), "volume": ("yahoo",), "smt": ("duka", "spx"),
            "daily": ("yahoo",)}[args.command]
    for k in need:
        if not getattr(args, k):
            ap.error(f"`{args.command}` needs --{k}")
    globals()[f"cmd_{args.command}"](args)


if __name__ == "__main__":
    main()
