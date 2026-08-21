#!/usr/bin/env python3
"""MMT-ORB: opening-range breakout on NQ, built as a risk-normalised strategy
with a real ledger, then walked forward.

Why this and not the sweep-reversion system this repo started with: the sweep
setup has no measurable forward edge (probe.py), and the broad feature scan
found nothing with tradeable information content once a leaking bar was
removed from the overnight range (edge_search.py). The opening-range breakout
is the only candidate left standing with both a positive point estimate and a
mechanism you can state in one sentence -- the first hour sets a reference
that the day's directional flow either respects or breaks, and breaking it
concentrates order flow on one side.

It is also, on this sample, regime-dependent in a way nobody should trade
blind: six consecutive losing years to 2020, five consecutive winning years
from 2021. Everything here is arranged so that fact stays visible instead of
being averaged into a headline number.

Risk is normalised: one trade risks 1R, where R is the distance from entry to
the initial stop, so a wide-stop day and a tight-stop day contribute equally.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

import core
from core import POINT_VALUE, TICK
from edge_search import build_panel, features, NMIN
import engine

FLAT_M = 385                       # 15:55 ET


@dataclass
class OrbParams:
    or_min: int = 30               # opening-range length, minutes
    buffer_ticks: float = 1.0      # entry beyond the level
    stop_mode: str = "far"         # "far" = opposite OR side | "sig"
    stop_sig: float = 1.0          # used when stop_mode == "sig"
    max_stop_sig: float = 1.5      # cap risk per trade, in daily-scale units
    min_or: float = 0.0            # OR width filter, in daily-scale units
    max_or: float = 9.9
    trail_sig: float = 0.0         # 0 = off, else trail by k * daily scale
    be_at_r: float = 0.0           # 0 = off, else move stop to entry at +kR
    direction: str = "both"        # both | long | short
    reentry: bool = False          # allow a second break after a stop-out

    def copy(self, **kw):
        return OrbParams(**{**asdict(self), **kw})


def run_orb(P, scale, p: OrbParams, day_lo=0, day_hi=None,
            commission_pts=1.20 / POINT_VALUE, slip_pts=TICK):
    """Simulate the ORB day by day on 1-minute bars. Returns an engine ledger."""
    H, L, C = P["H"], P["L"], P["C"]
    days = P["days"]
    nd = len(C)
    day_hi = nd if day_hi is None else day_hi
    buf = p.buffer_ticks * TICK
    out = []

    for d in range(day_lo, day_hi):
        sc = scale[d, 0]
        if not np.isfinite(sc) or sc <= 0:
            continue
        hi = np.nanmax(H[d, :p.or_min]); lo = np.nanmin(L[d, :p.or_min])
        if not (np.isfinite(hi) and np.isfinite(lo)) or hi <= lo:
            continue
        width = (hi - lo) / sc
        if not (p.min_or <= width <= p.max_or):
            continue

        m = p.or_min
        tries = 0
        while m < FLAT_M and tries < (2 if p.reentry else 1):
            tries += 1
            up_lvl, dn_lvl = hi + buf, lo - buf
            seg_h = H[d, m:FLAT_M]; seg_l = L[d, m:FLAT_M]
            up = np.flatnonzero(seg_h >= up_lvl)
            dn = np.flatnonzero(seg_l <= dn_lvl)
            iu = up[0] if len(up) else 10 ** 9
            idn = dn[0] if len(dn) else 10 ** 9
            if iu == idn:
                break
            side = 1 if iu < idn else -1
            m0 = m + min(iu, idn)
            if (p.direction == "long" and side < 0) or \
               (p.direction == "short" and side > 0):
                break
            entry = (up_lvl if side == 1 else dn_lvl) + side * slip_pts

            if p.stop_mode == "far":
                stop = lo if side == 1 else hi
            else:
                stop = entry - side * p.stop_sig * sc
            risk = abs(entry - stop)
            if risk > p.max_stop_sig * sc:               # cap risk per trade
                stop = entry - side * p.max_stop_sig * sc
                risk = abs(entry - stop)
            if risk < 4 * TICK:
                break

            cur_stop = stop
            be_done = False
            peak = entry
            exit_m, exit_px, reason = -1, np.nan, engine.X_FLAT
            for j in range(m0, FLAT_M + 1):
                h_, l_ = H[d, j], L[d, j]
                if side == 1:
                    peak = max(peak, h_)
                    if l_ <= cur_stop:
                        exit_m, exit_px = j, cur_stop - slip_pts
                        reason = engine.X_BE if be_done else engine.X_STOP
                        break
                else:
                    peak = min(peak, l_)
                    if h_ >= cur_stop:
                        exit_m, exit_px = j, cur_stop + slip_pts
                        reason = engine.X_BE if be_done else engine.X_STOP
                        break
                mfe = (peak - entry) * side / risk
                if p.be_at_r > 0 and not be_done and mfe >= p.be_at_r:
                    cand = entry
                    if (cand > cur_stop) if side == 1 else (cand < cur_stop):
                        cur_stop, be_done = cand, True
                if p.trail_sig > 0:
                    cand = peak - side * p.trail_sig * sc
                    if (cand > cur_stop) if side == 1 else (cand < cur_stop):
                        cur_stop = cand
            if exit_m < 0:
                exit_m, exit_px, reason = FLAT_M, C[d, FLAT_M] - side * slip_pts, engine.X_FLAT

            gross = (exit_px - entry) * side
            net = gross - commission_pts
            ts = int(days[d]) * 86400
            out.append((ts, ts + m0 * 60, ts + exit_m * 60, side, entry, stop,
                        np.nan, exit_px, risk, reason, gross / risk, net / risk,
                        net * POINT_VALUE, 0.0, (peak - entry) * side / risk,
                        exit_m - m0, 570 + m0, int(days[d]), p.or_min))
            if reason in (engine.X_STOP, engine.X_BE) and p.reentry:
                m = exit_m + 1
            else:
                break

    return np.array(out, dtype=engine.TRADE_DTYPE) if out else \
        np.empty(0, dtype=engine.TRADE_DTYPE)


# ── walk-forward over calendar time ──────────────────────────────────────────

def wf_orb(P, scale, grid, n_folds=8, min_trades=60):
    """Anchored walk-forward: choose parameters on everything before the fold,
    trade the fold untouched, stitch the out-of-sample ledgers."""
    nd = len(P["C"])
    edges = np.linspace(0, nd, n_folds + 2).astype(int)
    oos, picks = [], []
    for k in range(1, n_folds + 1):
        best, best_score = None, -1e18
        for p in grid:
            led = run_orb(P, scale, p, 0, edges[k])
            if len(led) < min_trades:
                continue
            r = led["r_net"]
            sc = r.mean() - 0.5 * abs(r.mean()) / np.sqrt(len(r))
            if sc > best_score:
                best_score, best = sc, p
        if best is None:
            continue
        led = run_orb(P, scale, best, edges[k], edges[k + 1])
        picks.append((k, best, engine.stats(led)))
        if len(led):
            oos.append(led)
    ledger = np.concatenate(oos) if oos else np.empty(0, dtype=engine.TRADE_DTYPE)
    return ledger, picks


def default_grid():
    g = []
    for om in (5, 15, 30, 60):
        for sm, ss in (("far", 1.0), ("sig", 0.5), ("sig", 1.0)):
            for tr in (0.0, 0.75):
                for be in (0.0, 1.0):
                    g.append(OrbParams(or_min=om, stop_mode=sm, stop_sig=ss,
                                       trail_sig=tr, be_at_r=be))
    return g


if __name__ == "__main__":
    m1 = core.load_1m()
    P = build_panel(m1)
    F, scale = features(P)
    grid = default_grid()
    print(f"panel {len(P['C'])} sessions | grid {len(grid)} configs\n")

    led, picks = wf_orb(P, scale, grid, n_folds=8)
    print("walk-forward fold selections (chosen on prior data only):")
    for k, p, s in picks:
        yr0 = str(np.datetime64(int(P['days'][0]) * 86400, 's'))[:4]
        print(f"  fold {k}: or={p.or_min:>2}m stop={p.stop_mode}/{p.stop_sig} "
              f"trail={p.trail_sig} be={p.be_at_r}  ->  "
              f"n={s['n']:>4} exp={s['exp']:>+6.3f}R net={s['net_r']:>+7.1f}R")
    print()
    print(engine.fmt(engine.stats(led), "STITCHED OUT-OF-SAMPLE"))
