#!/usr/bin/env python3
"""Repair isolated bad prints in a 5-minute NQ / MNQ futures file, checked against the Nasdaq-100 CFD.

usage: python3 -I clean_prints.py FUT_NPZ CFD_NPZ OUT_NPZ      (writes OUT_NPZ and OUT_NPZ.json; prep_nqfut.py calls
                                                                repair() on the series it builds)
A bar is a candidate when one of its prices jumps out and straight back (bars at most 10 minutes apart; T = 0.5% of the
previous close):
  open   more than T from both the previous close and the bar's own close, while those two are within a quarter of it;
  close  more than T from both the bar's open and the next open, while those two are within a quarter of it;
  high / low  more than T beyond the bar's open and close, the previous close and the next open.
It is a bad print when the CFD moved less than 40% as far: the futures' move is from the previous close to the outlying
price (in %), the CFD's is its largest move the same way from its own previous close over that bar and the next one
(feeds lag each other in fast markets, and the CFD's quotes can freeze for a minute or two). The bar is then rebuilt
from the CFD's 5-minute bar at the futures' level (the median futures - CFD close of the nearest 24 bars both have), as
prep_nqfut.py already fills missing bars. A candidate the CFD cannot check (no CFD bar then) is left alone.
In the files of this study that repairs two bars, both a single price far from everything around it while the CFD and
the S&P were quiet: 2021-01-26 00:00 ET in the NQ export (high 14,959.50 among bars of 14,794-14,827: high -> 14,807.57)
and 2026-10-30 15:00 ET in Yahoo's MNQ=F and NQ=F (open = high = 29,562.00 after a 28,234.50 close: open -> 28,319.99,
high -> 28,333.12). Every other candidate was either
matched by the CFD or the S&P (March 2020, the April 2025 tariff days, CPI and jobs releases) or fell where the CFD has
no bars, on a news event (the COVID Sunday open, Amazon and Nvidia earnings, the March 2023 jobs report). The CFD made
85% of the Nov 5 2026 10:50 drop (its own bar closed near the low only because its quotes froze at 10:53-10:54): kept.
"""
import json
import sys

import numpy as np

FRAC, K, SHARE = 0.005, 4.0, 0.40


def resample5(t, o, h, l, c):
    g = t // 5 * 5
    idx = np.r_[0, np.flatnonzero(np.diff(g)) + 1]
    end = np.r_[idx[1:], len(t)] - 1
    return g[idx], o[idx], np.maximum.reduceat(h, idx), np.minimum.reduceat(l, idx), c[end]


def excursions(o, h, l, c, pc, no):
    """The four jump-and-back measures of one bar, in price units (0 when the rule does not apply)."""
    T = FRAC * pc
    out = {}
    d1, d2 = abs(o - pc), abs(o - c)
    if d1 > T and d2 > T and abs(c - pc) < min(d1, d2) / K:
        out["open"] = d1
    d1, d2 = abs(c - o), abs(c - no)
    if d1 > T and d2 > T and abs(no - o) < min(d1, d2) / K:
        out["close"] = d1
    e = h - max(o, c, pc, no)
    if e > T:
        out["high"] = e
    e = min(o, c, pc, no) - l
    if e > T:
        out["low"] = e
    return out


def move(kind, o, h, l, c, pc):
    """The futures' move to the outlying price from the previous close: (direction, % of the previous close)."""
    p = {"open": o, "close": c, "high": h, "low": l}[kind]
    return (1 if p > pc else -1), 100.0 * abs(p - pc) / pc


def cfd_move(ch, cl, cc, j, sign):
    """The CFD's largest move in that direction from its close before bar j, over bars j and j + 1 (%)."""
    base = cc[j - 1]
    if sign > 0:
        return 100.0 * max(0.0, ch[j:j + 2].max() - base) / base
    return 100.0 * max(0.0, base - cl[j:j + 2].min()) / base


def repair(t, o, h, l, c, cfd):
    """cfd: (t, o, h, l, c) of the CFD in 1-minute bars. Returns repaired copies and the list of repairs."""
    o, h, l, c = (np.array(x, dtype=float) for x in (o, h, l, c))
    ct, co, ch, cl, cc = resample5(*cfd)
    pos = {int(m): i for i, m in enumerate(ct)}
    fixes = []
    for i in range(1, len(t) - 1):
        if t[i] - t[i - 1] > 10 or t[i + 1] - t[i] > 10:
            continue
        ex = excursions(o[i], h[i], l[i], c[i], c[i - 1], o[i + 1])
        if not ex:
            continue
        j = pos.get(int(t[i]))
        if j is None or j == 0 or j + 1 >= len(ct) or ct[j] - ct[j - 1] > 10 or ct[j + 1] - ct[j] > 10:
            continue  # the CFD cannot check it: leave it
        share = 0.0
        for kd in ex:
            sign, fm = move(kd, o[i], h[i], l[i], c[i], c[i - 1])
            share = max(share, cfd_move(ch, cl, cc, j, sign) / fm if fm > 0 else 1.0)
        if share >= SHARE:
            continue  # the CFD moved too: a real move
        near = [k for k in range(max(0, i - 24), min(len(t), i + 25)) if k != i and int(t[k]) in pos]
        diffs = sorted(c[k] - cc[pos[int(t[k])]] for k in near)
        off = float(np.median(diffs))
        before = (float(o[i]), float(h[i]), float(l[i]), float(c[i]))
        # replace only the outlying price(s) by the CFD's at the futures' level, again until none is left (a bad open that
        # was also the high leaves an outlying high), then keep the bar consistent; the other prices stay as recorded
        new = dict(open=co[j] + off, high=ch[j] + off, low=cl[j] + off, close=cc[j] + off)
        cur = dict(open=o[i], high=h[i], low=l[i], close=c[i])
        for _ in range(4):
            ex2 = excursions(cur["open"], cur["high"], cur["low"], cur["close"], c[i - 1], o[i + 1])
            if not ex2:
                break
            for kd in ex2:
                cur[kd] = new[kd]
        cur["high"] = max(cur["high"], cur["open"], cur["close"])
        cur["low"] = min(cur["low"], cur["open"], cur["close"])
        o[i], h[i], l[i], c[i] = cur["open"], cur["high"], cur["low"], cur["close"]
        fixes.append(dict(time_et=str(np.datetime64(int(t[i]), "m")), kinds={k: round(float(v), 2) for k, v in ex.items()},
                          cfd_share=round(float(share), 3), before=before,
                          after=tuple(round(float(x), 2) for x in (o[i], h[i], l[i], c[i])), offset=round(off, 2)))
    return o, h, l, c, fixes


def main(fut_path, cfd_path, out):
    z, zc = np.load(fut_path), np.load(cfd_path)
    t = z["t"].astype(np.int64)
    cfd = (zc["t"].astype(np.int64), zc["o"], zc["h"], zc["l"], zc["c"])
    o, h, l, c, fixes = repair(t, z["o"], z["h"], z["l"], z["c"], cfd)
    np.savez_compressed(out, t=t, o=o, h=h, l=l, c=c)
    json.dump(dict(source=fut_path, repaired=fixes), open(out + ".json", "w"), indent=1)
    print(json.dumps(fixes, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:4])
