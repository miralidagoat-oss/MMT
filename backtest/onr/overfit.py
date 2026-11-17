#!/usr/bin/env python3
"""Overfitting battery for indicators/onr_book.pine (signals, times and ADR multiples are the same in v1 and v2).

usage: overfit.py DATA_DIR

1. Edge of each funded leg by year (1 MNQ, R = initial risk).
2. Baselines on the same days and stops: opposite side and random sides.
3. Parameter neighbourhoods, split 2011-18 / 2019-26: a real effect degrades smoothly, an overfit one spikes at the
   chosen value.
4. Eval pass rate vs coin-flip sides on the same brackets.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from account import run_eval  # noqa: E402
from engine import PV, THR, Sessions, funded_on, ib_breakout, load_npz, pyramid  # noqa: E402


def year(d):
    return int(str(np.datetime64(int(d), "D"))[:4])


def tstat(x):
    x = np.asarray(x, float)
    return x.mean() / (x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 2 else np.nan


def halves(vals):
    a = [v for y, v in vals if y <= 2018]
    b = [v for y, v in vals if y >= 2019]
    return (f"2011-18 {np.mean(a):+.3f} (t {tstat(a):4.1f}, n {len(a):4d}) | "
            f"2019-26 {np.mean(b):+.3f} (t {tstat(b):4.1f}, n {len(b):4d})")


def on_vals(S, thr=THR, stop=None, side_fn=None):
    out = []
    for d in S.days:
        r = S.S[d]
        A = r["adr"]
        s = S.on_side(d, thr) if not np.isnan(A) else 0
        if not s:
            continue
        s = side_fn(s) if side_fn else s
        if stop is None:
            out.append((year(d), (r["on"]["w"].xc - r["on"]["E"]) * s / A))  # ADR units, no stop
        else:
            out.append((year(d), funded_on(S, d, s, stop_adr=stop)[0] / (stop * A * PV)))  # R units
    return out


def pyr_vals(S, k=0.10, side_fn=None, **kw):
    out = []
    for d in S.days:
        A = S.S[d]["adr"]
        s = S.od_side(d, k) if not np.isnan(A) else 0
        if s:
            s = side_fn(s) if side_fn else s
            out.append((year(d), pyramid(S, d, s, **kw)[0] / (kw.get("stop", 0.35) * A * PV)))
    return out


def ib_vals(S, **kw):
    out = []
    for d in S.days:
        A = S.S[d]["adr"]
        if np.isnan(A):
            continue
        res = ib_breakout(S, d, **kw)
        if res and res[1] != "both-skip":
            out.append((year(d), res[0] / (kw.get("stop", 0.25) * A * PV)))
    return out


def by_year(vals):
    ys = sorted({y for y, _ in vals})
    m = {y: np.mean([v for yy, v in vals if yy == y]) for y in ys}
    return " ".join(f"{y}:{m[y]:+.2f}" for y in ys) + f" | positive years {sum(v > 0 for v in m.values())}/{len(m)}"


def main(dd):
    nq, spx = load_npz(os.path.join(dd, "NSXUSD.npz")), load_npz(os.path.join(dd, "SPXUSD.npz"))
    S = Sessions(nq, spx, tf=1)
    sc = (S.score_raw, S.feats)
    rng = np.random.default_rng(7)
    print("== 1. Funded legs by year (mean R per trade, 1 MNQ, Pine fills)")
    for name, v in (("overnight (0.5 ADR stop)", on_vals(S, stop=0.5)), ("pyramid", pyr_vals(S)), ("IB breakout", ib_vals(S))):
        print(f"  {name:26s}", halves(v))
        print(f"  {'':26s}", by_year(v))
    print("== 2. Baselines (same days, same stops)")
    for name, fn in (("overnight", lambda sf=None: on_vals(S, stop=0.5, side_fn=sf)), ("pyramid", lambda sf=None: pyr_vals(S, side_fn=sf))):
        real = np.mean([v for _, v in fn()])
        opp = np.mean([v for _, v in fn(lambda s: -s)])
        rnd = [np.mean([v for _, v in fn(lambda s: int(rng.choice([-1, 1])))]) for _ in range(30)]
        print(f"  {name:10s} real {real:+.3f}R | opposite {opp:+.3f}R | random sides x30: mean {np.mean(rnd):+.3f}R, best {np.max(rnd):+.3f}R")
    print("== 3. Neighbourhoods")
    print("  overnight signal, move per trade in ADR units with no stop:")
    for thr in (0.5, 0.6, 0.7187, 0.8, 0.9, 1.0):
        print(f"    threshold {thr:<6}", halves(on_vals(S, thr)))
    for lab, ev in (("entry 18:05", dict(on=5)), ("entry 18:30", dict(on=30)), ("entry 20:00", dict(on=120)),
                    ("exit 08:25", dict(onx=865)), ("exit 09:00", dict(onx=900)), ("exit 10:00", dict(onx=960))):
        print(f"    {lab:16s}", halves(on_vals(Sessions(nq, spx, tf=1, ev=ev, score=sc))))
    print("  overnight leg, R per trade by stop width:")
    for stop in (0.35, 0.5, 0.75, 1.0, 1.5):
        print(f"    stop {stop} ADR    ", halves(on_vals(S, stop=stop)))
    print("  pyramid, R per trade:")
    for k in (0.05, 0.075, 0.10, 0.15, 0.20):
        print(f"    OD threshold {k:<5}", halves(pyr_vals(S, k)))
    for kw in (dict(stop=0.25), dict(stop=0.5), dict(add=0.10), dict(add=0.20), dict(trail=0.20), dict(trail=0.35), dict(add=9.0)):
        print(f"    {str(kw):18s}", halves(pyr_vals(S, **kw)))
    for lab, ev in (("OD at 09:33", dict(od=933)), ("OD at 09:40", dict(od=940)), ("OD at 09:45", dict(od=945))):
        print(f"    {lab:18s}", halves(pyr_vals(Sessions(nq, spx, tf=1, ev=ev, score=sc))))
    print("  IB breakout, R per trade:")
    for kw in (dict(stop=0.2), dict(stop=0.35), dict(tgt=0.35), dict(tgt=0.75)):
        print(f"    {str(kw):18s}", halves(ib_vals(S, **kw)))
    for lab, ev in (("IB 10:00", dict(ib=960)), ("IB 11:00", dict(ib=1020))):
        print(f"    {lab:18s}", halves(ib_vals(Sessions(nq, spx, tf=1, ev=ev, score=sc))))
    print("== 4. Eval pass rate vs coin-flip sides (new eval every session)")
    k0 = int(np.argmax([not np.isnan(S.S[d]["adr"]) and not np.isnan(S.S[d]["score"]) for d in S.days]))
    kmid = int(np.searchsorted(S.days, np.datetime64("2021-01-01").astype(int)))

    def pr(**kw):
        out = []
        for a, b in ((k0, kmid), (kmid, len(S.days))):
            res = [run_eval(S, k, **kw) for k in range(a, b)]
            done = [r["result"] == "pass" for r in res if r["result"] != "open"]
            out.append(100 * np.mean(done))
        return out
    real = pr()
    print(f"  strategy        2011-20 {real[0]:.1f}% | 2021-26 {real[1]:.1f}%")
    rs = []
    for seed in range(10):
        g = np.random.default_rng(seed)
        flip = {(d, leg): int(g.choice([-1, 1])) for d in S.days for leg in ("on", "od")}
        rs.append(pr(side_override=lambda d, leg, f=flip: f[(d, leg)]))
    rs = np.array(rs)
    print(f"  coin-flip x10   2011-20 mean {rs[:, 0].mean():.1f}% best {rs[:, 0].max():.1f}% | "
          f"2021-26 mean {rs[:, 1].mean():.1f}% best {rs[:, 1].max():.1f}%")


if __name__ == "__main__":
    main(sys.argv[1])
