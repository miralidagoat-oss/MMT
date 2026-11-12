#!/usr/bin/env python3
"""Which kind of reversal block actually holds? Every block type below is
graded by the same STRICT rules on real 1-minute data:

    TOUCH   a candle trades into the block
    HIT     price reverses `hit` points from the extreme made at the block
    100+    it goes on to reverse `target` points
    BROKEN  a candle of the chart CLOSES beyond the far side of the block
    OPEN    neither by the end of the next trade day

Every block is `width` points deep (default 60) and starts at its level, so
the block types differ only in WHERE they are - which is the thing being
tested. `chance` is the same block type on direction-scrambled copies of the
data (rz_null.py); `arbitrary` levels on the real data are a second yardstick.

Block types
  PD / PW        prior day / prior week high and low
  AS / LO / ON   Asia (18:00-03:00 ET), London (03:00-09:30), whole overnight
  OR             opening range 09:30-10:00
  PDflip         prior day high as support / low as resistance after a gap beyond it
  PDC PDM ONM    prior close, prior day midpoint, overnight midpoint
  GO RO          the 18:00 open and the 09:30 open as levels
  ADR05 ADR10    09:30 open +/- 0.5 and 1.0 average daily ranges
  RND250 RND100  the round numbers above and below the day's open
  SW1h SW4h      swing highs / lows (highest / lowest of +/- 1 hour, +/- 4 hours)
  OB             order block: the last opposite candle before a displacement
                 candle that breaks the prior hour's range
  FVG            fair-value gap: a three-candle gap of at least 0.3 average ranges
  OBn FVGn       the same two with their own depth (zone size, kept inside 10-60)
  RANDOM         arbitrary levels 0.2-1.0 average daily ranges from the open

  python3 rb_zoo.py --duka data/nq --start 20221109 --null 4
"""
import argparse
import os
import pickle
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import pandas as pd
from numba import njit

import rb_blocks
import rz_data
import rz_null


@njit(cache=True)
def grade(o, h, l, c, td, ev_i, ev_lv, ev_side, ev_w, ev_tg, ev_ttl):
    """Strict first-touch grading of independent blocks. res: 0 never touched,
    1 held, 2 broken, 3 open. Same order of checks as rb_blocks.run."""
    n, m = len(o), len(ev_i)
    res = np.zeros(m, np.int8)
    ti = np.full(m, -1, np.int64)
    bst = np.zeros(m)
    for k in range(m):
        i0, s = ev_i[k], ev_side[k]
        near = ev_lv[k]
        far = near + s * ev_w[k]
        if i0 >= n or s * (o[i0] - near) >= 0:              # price already at or inside the block
            continue
        waited = played = 0
        touched = False
        turn = best = 0.0
        for i in range(i0, n):
            if i > i0 and td[i] != td[i - 1]:
                if not touched:
                    waited += 1
                    if waited > ev_ttl[k]:
                        break
                else:
                    played += 1
                    if played >= 2:
                        res[k] = 3
                        break
            ext = h[i] if s > 0 else l[i]
            opp = l[i] if s > 0 else h[i]
            first = False
            if not touched:
                if s * (ext - near) < 0:
                    continue
                touched, first, turn = True, True, ext
                ti[k] = i
            newturn = ext if s * (ext - turn) > 0 else turn
            if s * (c[i] - far) > 0:                        # a close beyond the block ends it
                res[k] = 2
                break
            if not first:
                best = max(best, s * (turn - opp))
            best = max(best, s * (newturn - c[i]))
            if best >= ev_tg[k]:
                res[k] = 1
                break
            turn = newturn
        bst[k] = best
    return res, ti, bst


def events(B, width, target, ref, seed=7):
    """All block types -> (family names, arrays for grade())."""
    o, h, l, c, mod, td = B["o"], B["h"], B["l"], B["c"], B["mod"], B["td"]
    n = len(o)
    starts = np.flatnonzero(np.r_[True, td[1:] != td[:-1]])
    ends = np.r_[starts[1:], n]
    didx = np.repeat(np.arange(len(starts)), ends - starts)
    rng = np.random.default_rng(seed)
    ev = []                                                  # (i, level, side, family, ttl, depth or 0)

    def both(i, hi, lo, fam, ttl=0):
        if i >= 0 and not np.isnan(hi):
            ev.append((i, hi, 1, fam, ttl, 0.0))
            ev.append((i, lo, -1, fam, ttl, 0.0))

    def located(i, lv, fam, ttl=0):                          # side decided by where price is
        if i >= 0 and not np.isnan(lv) and o[i] != lv:
            ev.append((i, lv, 1 if o[i] < lv else -1, fam, ttl, 0.0))

    pH = pL = pC = wH = wL = pwH = pwL = np.nan
    ranges, kday = [], np.ones(len(starts))
    for d, (a, b) in enumerate(zip(starts, ends)):
        m = mod[a:b]
        hh, ll = h[a:b], l[a:b]
        if ref > 0 and not np.isnan(pC):
            kday[d] = pC / ref
        if d > 0 and B["wk"][a] != B["wk"][a - 1]:
            pwH, pwL, wH, wL = wH, wL, np.nan, np.nan
        adr = float(np.mean(ranges[-14:])) if len(ranges) >= 5 else np.nan

        def first(cond):
            j = np.flatnonzero(cond)
            return a + j[0] if len(j) else -1

        def hl(cond):
            return (hh[cond].max(), ll[cond].min()) if cond.any() else (np.nan, np.nan)

        i_as, i_rth, i_or = first((m >= 180) & (m < 1020)), first((m >= 570) & (m < 1020)), first((m >= 600) & (m < 1020))
        asH, asL = hl((m >= 1080) | (m < 180))
        loH, loL = hl((m >= 180) & (m < 570))
        onH, onL = hl((m >= 1080) | (m < 570))
        orH, orL = hl((m >= 570) & (m < 600))
        both(a, pH, pL, "PD")
        both(a, pwH, pwL, "PW")
        both(i_as, asH, asL, "AS")
        both(i_rth, loH, loL, "LO")
        both(i_rth, onH, onL, "ON")
        both(i_or, orH, orL, "OR")
        if not np.isnan(pH):
            if o[a] > pH:
                ev.append((a, pH, -1, "PDflip", 0, 0.0))
            if o[a] < pL:
                ev.append((a, pL, 1, "PDflip", 0, 0.0))
            located(a, pC, "PDC")
            located(a, (pH + pL) / 2, "PDM")
        if i_rth >= 0 and not np.isnan(onH):
            located(i_rth, (onH + onL) / 2, "ONM")
        located(i_as, o[a], "GO")
        if i_or >= 0 and i_rth >= 0:
            located(i_or, o[i_rth], "RO")
        if i_rth >= 0 and not np.isnan(adr):
            for mult, fam in ((0.5, "ADR05"), (1.0, "ADR10")):
                both(i_rth, o[i_rth] + mult * adr, o[i_rth] - mult * adr, fam)
        for step, fam in ((250.0, "RND250"), (100.0, "RND100")):
            st = step * kday[d]
            both(a, np.ceil(o[a] / st) * st + (st if np.ceil(o[a] / st) * st == o[a] else 0), np.floor(o[a] / st) * st, fam)
        if not np.isnan(adr):
            for _ in range(2):
                u = rng.uniform(0.2, 1.0) * adr
                both(a, o[a] + u, o[a] - u, "RANDOM")
        pH, pL, pC = hh.max(), ll.min(), c[b - 1]
        wH = pH if np.isnan(wH) else max(wH, pH)
        wL = pL if np.isnan(wL) else min(wL, pL)
        ranges.append(pH - pL)

    atr = pd.Series(h - l).rolling(100, min_periods=30).mean().shift(1).values
    same = np.r_[False, False, td[2:] == td[:-2]]
    kb = kday[didx]
    for K, fam in ((12, "SW1h"), (48, "SW4h")):               # swing pivots, confirmed K candles later
        win = 2 * K + 1
        mx = pd.Series(h).rolling(win, center=True).max().values
        mn = pd.Series(l).rolling(win, center=True).min().values
        for j in np.flatnonzero(h == mx):
            if j + K + 1 < n:
                ev.append((j + K + 1, h[j], 1, fam, 1, 0.0))
        for j in np.flatnonzero(l == mn):
            if j + K + 1 < n:
                ev.append((j + K + 1, l[j], -1, fam, 1, 0.0))
    gap_up = np.r_[0, 0, l[2:] - h[:-2]]                      # fair-value gaps
    gap_dn = np.r_[0, 0, l[:-2] - h[2:]]
    for j in np.flatnonzero(same & (gap_up >= 0.3 * atr)):
        if j + 1 < n:
            ev.append((j + 1, l[j], -1, "FVG", 1, 0.0))
            ev.append((j + 1, l[j], -1, "FVGn", 1, min(max(gap_up[j], 10 * kb[j]), 60 * kb[j])))
    for j in np.flatnonzero(same & (gap_dn >= 0.3 * atr)):
        if j + 1 < n:
            ev.append((j + 1, h[j], 1, "FVG", 1, 0.0))
            ev.append((j + 1, h[j], 1, "FVGn", 1, min(max(gap_dn[j], 10 * kb[j]), 60 * kb[j])))
    hh12 = pd.Series(h).rolling(12).max().shift(1).values     # order blocks
    ll12 = pd.Series(l).rolling(12).min().shift(1).values
    body = c - o
    used = set()
    for j in np.flatnonzero((c > hh12) & (body >= atr)):
        for m_ in range(j - 1, max(j - 6, 0), -1):
            if c[m_] < o[m_]:
                if (m_, -1) not in used and j + 1 < n:
                    used.add((m_, -1))
                    ev.append((j + 1, h[m_], -1, "OB", 1, 0.0))
                    ev.append((j + 1, h[m_], -1, "OBn", 1, min(max(h[m_] - l[m_], 10 * kb[j]), 60 * kb[j])))
                break
    for j in np.flatnonzero((c < ll12) & (-body >= atr)):
        for m_ in range(j - 1, max(j - 6, 0), -1):
            if c[m_] > o[m_]:
                if (m_, 1) not in used and j + 1 < n:
                    used.add((m_, 1))
                    ev.append((j + 1, l[m_], 1, "OB", 1, 0.0))
                    ev.append((j + 1, l[m_], 1, "OBn", 1, min(max(h[m_] - l[m_], 10 * kb[j]), 60 * kb[j])))
                break

    ev.sort(key=lambda e: e[0])
    fams = sorted({e[3] for e in ev})
    fid = {f: k for k, f in enumerate(fams)}
    i = np.array([e[0] for e in ev], np.int64)
    kk = kb[np.minimum(i, n - 1)]
    w = np.array([e[5] if e[5] > 0 else width * q for e, q in zip(ev, kk)])
    return fams, (i, np.array([e[1] for e in ev]), np.array([e[2] for e in ev], np.int64), w, target * kk,
                  np.array([e[4] for e in ev], np.int64)), np.array([fid[e[3]] for e in ev])


def table(B, width, target, ref, cut, hit):
    """Per block type: [graded, hit rate, 100+ rate] for the whole sample, then hit rate in each half."""
    fams, arr, fam = events(B, width, target, ref)
    res, ti, best = grade(B["o"], B["h"], B["l"], B["c"], B["td"], *arr)
    t = B["index"][np.maximum(ti, 0)]
    is_hit = best >= arr[4] * hit / target - 1e-9
    out = {}
    for k, name in enumerate(fams):
        row = []
        for sel in (np.ones(len(res), bool), np.asarray(t < cut), np.asarray(t >= cut)):
            m = (fam == k) & (ti >= 0) & sel
            hits, broken = (is_hit & m).sum(), ((res == 2) & ~is_hit & m).sum()
            graded = max(int(hits + broken), 1)
            row += [int(hits + broken), 100.0 * hits / graded, 100.0 * ((res == 1) & m).sum() / graded]
        out[name] = row
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--duka")
    ap.add_argument("--cache")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--tf", type=int, default=5)
    ap.add_argument("--width", type=float, default=60.0)
    ap.add_argument("--target", type=float, default=100.0)
    ap.add_argument("--hit", type=float, default=45.0)
    ap.add_argument("--scale", action="store_true")
    ap.add_argument("--null", type=int, default=4)
    args = ap.parse_args()
    args.csv = None
    df = rb_blocks.load(args)
    B = rb_blocks.prep(df, args.tf)
    ref = float(B["c"][-1]) if args.scale else 0.0
    mid = df.index[0] + (df.index[-1] - df.index[0]) / 2
    real = table(B, args.width, args.target, ref, mid, args.hit)
    nulls = []
    for s in range(args.null):
        Bn = rb_blocks.prep(rz_null.scramble(df, 900 + s), args.tf)
        nulls.append(table(Bn, args.width, args.target, float(Bn["c"][-1]) if args.scale else 0.0, mid, args.hit))
    days = len(np.unique(B["td"]))
    print(f"{df.index[0].date()} -> {df.index[-1].date()}, {args.tf}-minute candles, strict close-through break, "
          f"blocks {args.width:.0f} deep, reversal {args.target:.0f}{' (scaled to price)' if args.scale else ''}; "
          f"first / second half split at {mid.date()}")
    print(f"HIT = a reversal of {args.hit:.0f} before any candle closes beyond the block; chance = scrambled copies")
    print(f"{'block type':10s} {'graded':>8s} {'/day':>5s} {'HIT':>7s} {'chance':>7s} {'z':>6s} {'to ' + format(args.target, '.0f') + '+':>8s}   {'1st half':>9s} {'2nd half':>9s}")
    for name, r in sorted(real.items(), key=lambda kv: -kv[1][1]):
        ch = np.array([x[name][1] for x in nulls if name in x])
        z = (r[1] - ch.mean()) / ch.std() if len(ch) > 1 and ch.std() > 0 else np.nan
        print(f"{name:10s} {r[0]:8d} {r[0] / days:5.1f} {r[1]:6.1f}% {ch.mean() if len(ch) else np.nan:6.1f}% {z:+6.1f} {r[2]:7.1f}%   "
              f"{r[4]:8.1f}% {r[7]:8.1f}%")


if __name__ == "__main__":
    main()
