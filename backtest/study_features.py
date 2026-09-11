#!/usr/bin/env python3
"""Conditional analysis of already-taken signals.

Every trade the model fires is logged with the features that were knowable at
signal time, plus the R it eventually booked. This asks: is there a subset of
those signals that is reliably better, so the model could be made more
selective (or sized differently) without inventing a new rule?

Each bucket is reported on the CME futures AND on the independent index-CFD
series. A split is only interesting if both agree and the gap is wider than the
error bars - otherwise it is a slice of noise.
"""
import math
import os
import sys
from collections import defaultdict
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from evaluate import CANDIDATE, TICK  # noqa: E402

FUT = [("data_po3", s) for s in ("MNQ", "NQ", "ES", "YM", "RTY")]
CFD = [("data_long", s) for s in ("NDX", "SPX", "DJI")]


def collect(panel, tf="1h", p=None):
    p = p or CANDIDATE
    out = []
    for d, s in panel:
        path = os.path.join(d, f"{s}_{tf}.csv")
        if not os.path.exists(path):
            continue
        bars = E.load_csv(path)
        ctx = E.build_context(bars)
        log = []
        E.run(bars, ctx, replace(p, tick=TICK[s], cost_ticks=4.0),
              0, len(bars["c"]), outcome_log=log)
        for rec in log:
            rec["sym"] = s
        out += log
    return out


def stat(rows):
    rs = [r["r"] for r in rows]
    n = len(rs)
    if n < 30:
        return None
    m = sum(rs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in rs) / (n - 1))
    return m, 2 * sd / math.sqrt(n), n


def show(name, keyfn, fut, cfd, order=None):
    gf, gc = defaultdict(list), defaultdict(list)
    for r in fut:
        gf[keyfn(r)].append(r)
    for r in cfd:
        gc[keyfn(r)].append(r)
    keys = order or sorted(set(gf) | set(gc), key=str)
    print(f"\n-- {name}")
    print(f"{'bucket':<22} {'FUT expR':>10} {'+/-2SE':>8} {'n':>6}   "
          f"{'CFD expR':>10} {'+/-2SE':>8} {'n':>6}   agree?")
    for k in keys:
        a, b = stat(gf.get(k, [])), stat(gc.get(k, []))
        if a is None and b is None:
            continue
        fa = f"{a[0]:>+10.4f} {a[1]:>8.4f} {a[2]:>6}" if a else f"{'(thin)':>10} {'':>8} {len(gf.get(k,[])):>6}"
        fb = f"{b[0]:>+10.4f} {b[1]:>8.4f} {b[2]:>6}" if b else f"{'(thin)':>10} {'':>8} {len(gc.get(k,[])):>6}"
        agree = ""
        if a and b:
            agree = "both +" if a[0] > 0 and b[0] > 0 else ("both -" if a[0] < 0 and b[0] < 0 else "disagree")
        print(f"{str(k):<22} {fa}   {fb}   {agree}")


def band(x, edges):
    for lo, hi in zip(edges, edges[1:]):
        if lo <= x < hi:
            return f"[{lo},{hi})"
    return f">={edges[-1]}" if x >= edges[-1] else f"<{edges[0]}"


def main(tf="1h"):
    fut, cfd = collect(FUT, tf), collect(CFD, tf)
    print(f"Conditional analysis of fired signals, {tf}, cost 4 ticks")
    a, b = stat(fut), stat(cfd)
    print(f"ALL: futures {a[0]:+.4f} +/-{a[1]:.4f} (n={a[2]})   "
          f"CFD {b[0]:+.4f} +/-{b[1]:.4f} (n={b[2]})")

    show("pools taken out by the raid, count",
         lambda r: min(len(r["kind"].split("+")), 3), fut, cfd, order=[1, 2, 3])
    show("did the raid include a day/week level?",
         lambda r: "yes" if any(k in r["kind"] for k in ("pdh", "pdl", "pwh", "pwl"))
         else "pivots/sessions only", fut, cfd)
    show("sweep depth (ATR)",
         lambda r: band(r["depth_atr"], [0.35, 0.6, 1.0, 1.5]), fut, cfd)
    show("bars from raid to reclaim", lambda r: min(r["lag"], 2), fut, cfd, order=[0, 1, 2])
    show("reclaim bar size (ATR)",
         lambda r: band(r["range_atr"], [0, 1.0, 1.5, 2.5]), fut, cfd)
    show("how far the reclaim closed past the level (ATR)",
         lambda r: band(r["reclaim_atr"], [0, 0.25, 0.6, 1.2]), fut, cfd)
    show("relative volume on the reclaim bar",
         lambda r: band(r["vol_rel"], [0, 0.8, 1.2, 2.0]) if r["vol_rel"] else "n/a",
         fut, cfd)
    show("session of the reclaim",
         lambda r: ("asia" if r["mspo"] < 480 else "london" if r["mspo"] < 840
                    else "ny-am" if r["mspo"] < 1020 else "ny-pm" if r["mspo"] < 1320
                    else "late"), fut, cfd,
         order=["asia", "london", "ny-am", "ny-pm", "late"])
    show("direction", lambda r: "long" if r["dir"] == 1 else "short", fut, cfd)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "1h")
