#!/usr/bin/env python3
"""Event studies of the specific intraday effects that are actually documented.

The broad IC scan came back empty once the causality bug was fixed: nothing
had an economically meaningful information coefficient. That does not mean
nothing works -- IC over a 5-minute grid is the wrong lens for an EVENT.  An
opening-range breakout does not happen every 5 minutes; it happens once a day,
conditionally, and it is held for hours. Its edge lives in the joint
distribution of "when it triggers" and "what happens after", which a pooled
rank correlation averages away.

Tested here, each on 2,408 sessions with MNQ costs charged:
  ORB   opening-range breakout, stop at the opposite side, exit on the close
        (Zarattini & Aziz 2023 report real alpha for this on QQQ/TQQQ)
  IDM   intraday momentum -- first-half-hour return predicts last-half-hour
        return (Gao, Han, Li & Zhou 2018, documented on ES/SPY)
  TOD   unconditional time-of-day drift
  DOW   day-of-week

Significance is the t-statistic of the per-DAY P&L series (daily P&L is close
to independent, unlike overlapping 5-minute observations), reported alongside
the same statistic computed on each half of the sample separately.
"""
from __future__ import annotations

import numpy as np

import core
from core import POINT_VALUE, TICK
from edge_search import build_panel, features, NMIN

COMMISSION_PTS = 1.20 / POINT_VALUE      # MNQ round turn, in index points
SLIP_PTS = 1.0 * TICK                    # per market-order side

FLAT_M = 385                             # 15:55 ET, flat before the close


def _tstat(x):
    x = x[np.isfinite(x)]
    if len(x) < 30 or x.std(ddof=1) == 0:
        return 0.0, 0.0
    return float(x.mean()), float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x))))


def report(name, pnl, scale, extra=""):
    """pnl: per-day net points (NaN on days with no trade)."""
    took = np.isfinite(pnl)
    n = int(took.sum())
    if n < 30:
        print(f"{name:<34} n={n:>5}  (too few)")
        return
    p = pnl[took]
    mu, t = _tstat(p)
    # in R terms, using that day's volatility scale as the risk unit
    r = (pnl / scale[:, 0])[took]
    mu_r, t_r = _tstat(r)
    half = len(p) // 2
    _, t1 = _tstat(p[:half]); _, t2 = _tstat(p[half:])
    wr = 100.0 * (p > 0).mean()
    print(f"{name:<34} n={n:>5}  {mu:>+7.2f}pt/day  t={t:>+5.2f}  "
          f"{mu_r:>+6.3f}R  WR={wr:>4.1f}%  t(1st)={t1:>+5.2f} t(2nd)={t2:>+5.2f}  "
          f"${mu*POINT_VALUE*n/ (len(pnl)/252):>+7.0f}/yr {extra}")


def orb(P, scale, or_min=15, stop_mode="range", stop_sig=1.0, direction="both",
        min_range=None, max_range=None):
    """First break of the opening range; stop at the far side; flat at 15:55."""
    H, L, C, O = P["H"], P["L"], P["C"], P["O"]
    nd = len(C)
    pnl = np.full(nd, np.nan)
    for d in range(nd):
        if not np.isfinite(scale[d, 0]) or scale[d, 0] <= 0:
            continue
        hi = np.nanmax(H[d, :or_min]); lo = np.nanmin(L[d, :or_min])
        if not (np.isfinite(hi) and np.isfinite(lo)) or hi <= lo:
            continue
        rel = (hi - lo) / scale[d, 0]
        if min_range is not None and rel < min_range:
            continue
        if max_range is not None and rel > max_range:
            continue
        hs = H[d, or_min:FLAT_M]; ls = L[d, or_min:FLAT_M]
        up = np.flatnonzero(hs >= hi); dn = np.flatnonzero(ls <= lo)
        iu = up[0] if len(up) else 10 ** 9
        idn = dn[0] if len(dn) else 10 ** 9
        if iu == idn == 10 ** 9:
            continue
        if iu < idn:
            side, entry, m0 = 1, hi, or_min + iu
        elif idn < iu:
            side, entry, m0 = -1, lo, or_min + idn
        else:
            continue
        if direction == "long" and side < 0:
            continue
        if direction == "short" and side > 0:
            continue
        entry = entry + side * SLIP_PTS               # stop order, pays slip
        if stop_mode == "range":
            stop = lo if side == 1 else hi
        else:
            stop = entry - side * stop_sig * scale[d, 0]
        seg_h = H[d, m0:FLAT_M + 1]; seg_l = L[d, m0:FLAT_M + 1]
        hit = np.flatnonzero(seg_l <= stop) if side == 1 else np.flatnonzero(seg_h >= stop)
        if len(hit):
            exit_px = stop - side * SLIP_PTS
        else:
            exit_px = C[d, FLAT_M] - side * SLIP_PTS
        pnl[d] = (exit_px - entry) * side - COMMISSION_PTS
    return pnl


def idm(P, scale, sig_start=0, sig_end=30, hold_start=360, hold_end=FLAT_M,
        flip=False):
    """Intraday momentum: sign of an early return traded over a later window."""
    C, O = P["C"], P["O"]
    nd = len(C)
    pnl = np.full(nd, np.nan)
    for d in range(nd):
        if not np.isfinite(scale[d, 0]):
            continue
        ref = O[d, 0] if sig_start == 0 else C[d, sig_start - 1]
        s = C[d, sig_end - 1] - ref
        if not np.isfinite(s) or s == 0:
            continue
        side = int(np.sign(s)) * (-1 if flip else 1)
        e = C[d, hold_start] + side * SLIP_PTS
        x = C[d, hold_end] - side * SLIP_PTS
        pnl[d] = (x - e) * side - COMMISSION_PTS
    return pnl


def tod(P, scale, m0, m1_, side=1):
    C = P["C"]
    e = C[:, m0] + side * SLIP_PTS
    x = C[:, m1_] - side * SLIP_PTS
    return (x - e) * side - COMMISSION_PTS


def main():
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    nd = len(P["C"])
    yrs = nd / 252.0
    print(f"\npanel {nd} sessions (~{yrs:.1f} yrs), MNQ costs charged "
          f"({COMMISSION_PTS:.2f}pt commission + {SLIP_PTS}pt/side slip)\n")

    print("== opening range breakout ==")
    for om in (5, 15, 30, 60):
        report(f"ORB {om}m, stop=far side", orb(P, scale, om), scale)
    for om in (15, 30):
        for ss in (0.5, 1.0):
            report(f"ORB {om}m, stop={ss}sig", orb(P, scale, om, "sig", ss), scale)
    report("ORB 30m longs only", orb(P, scale, 30, direction="long"), scale)
    report("ORB 30m shorts only", orb(P, scale, 30, direction="short"), scale)
    report("ORB 30m, narrow OR (<0.35)", orb(P, scale, 30, max_range=0.35), scale)
    report("ORB 30m, wide OR (>0.5)", orb(P, scale, 30, min_range=0.5), scale)

    print("\n== intraday momentum (Gao et al.) ==")
    report("IDM first30 -> last30", idm(P, scale), scale)
    report("IDM first30 -> last30 FLIPPED", idm(P, scale, flip=True), scale)
    report("IDM first30 -> last60", idm(P, scale, hold_start=330), scale)
    report("IDM open->12:00 -> last30", idm(P, scale, sig_end=150), scale)
    report("IDM first15 -> last30", idm(P, scale, sig_end=15), scale)

    print("\n== unconditional time-of-day drift (long) ==")
    for a, b, lbl in ((0, 30, "09:30-10:00"), (0, 60, "09:30-10:30"),
                      (30, 150, "10:00-12:00"), (150, 330, "12:00-15:00"),
                      (330, FLAT_M, "15:00-15:55"), (0, FLAT_M, "09:30-15:55")):
        report(f"long {lbl}", tod(P, scale, a, b), scale)

    print("\n== day of week (long 09:30-15:55) ==")
    dow = (P["days"] + 3) % 7   # Mon=0 .. Sun=6
    full = tod(P, scale, 0, FLAT_M)
    for k, nm in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri"]):
        p = np.where(dow == k, full, np.nan)
        report(f"  {nm}", p, scale)


if __name__ == "__main__":
    main()
