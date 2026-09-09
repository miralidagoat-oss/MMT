#!/usr/bin/env python3
"""Does the swept extreme actually hold better than a random level?

The model's real claim is narrow and testable: after a liquidity sweep is
reclaimed, the extreme of that sweep is a structurally significant low/high, so
a stop placed just beyond it survives more often than a stop placed the same
distance away at an arbitrary moment.

For every event we build the exact trade the indicator would build (entry,
stop = sweep extreme -/+ buffer, target = R multiple of the risk) and walk it
forward under the backtest's pessimistic rules. Then we build a MATCHED
CONTROL: same bar-of-day distribution, same direction, same risk distance in
ATR, but entered at a random unrelated bar. The difference between the two hit
rates is the edge attributable to the sweep, with everything else held equal.
"""
import math
import os
import random
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from study_po3 import wilson  # noqa: E402


def walk(bars, i, d, entry, stop, rr, maxbars):
    """+rr*risk before the stop? None if neither inside the horizon."""
    h, l, c = bars["h"], bars["l"], bars["c"]
    risk = (entry - stop) * d
    if risk <= 0:
        return None
    tp = entry + d * rr * risk
    for j in range(i + 1, min(i + 1 + maxbars, len(c))):
        adverse = (l[j] <= stop) if d == 1 else (h[j] >= stop)
        favour = (h[j] >= tp) if d == 1 else (l[j] <= tp)
        if adverse:
            return False
        if favour:
            return True
    return None


def report(tag, flags, rr):
    got = [f for f in flags if f is not None]
    n, k = len(got), sum(f for f in flags if f is not None)
    if n < 25:
        return f"{tag:<34} n={n:<5} (too few)"
    p = k / n
    lo, hi = wilson(k, n)
    be = 1.0 / (1.0 + rr)
    pf = (p * rr) / (1 - p) if p < 1 else float("inf")
    edge = "+" if lo > be else ("-" if hi < be else " ")
    return (f"{tag:<34} n={n:<5} WR={p * 100:5.1f}% "
            f"CI[{lo * 100:4.1f},{hi * 100:4.1f}] BE={be * 100:4.1f}% "
            f"PF={pf:5.2f} {edge}")


def study(path, label, split=0.6, buf=0.25, maxbars=48, seed=7):
    bars = E.load_csv(path)
    ctx = E.build_context(bars)
    atr = ctx["atr"]
    n = len(bars["c"])
    hi = int(n * split)
    ev = []
    p = E.Params(min_sweep_atr=0.0, max_sweep_atr=99.0, use_vwap=False,
                 po3_mode="off", require_close_dir=False, cooldown=0,
                 reclaim_bars=3)
    E.run(bars, ctx, p, collector=ev.append)
    ev = [e for e in ev if e["bar"] < hi and atr[e["bar"]]]

    rng = random.Random(seed)
    print(f"\n{'=' * 84}\n{label}: sweep-extreme stop vs matched random control "
          f"(in-sample bars <{hi}/{n}, buffer {buf} ATR, {maxbars}-bar horizon)"
          f"\n{'=' * 84}")

    for rr in (1.0, 2.0, 3.0):
        real, ctrl = [], []
        for e in ev:
            i, d, a = e["bar"], e["dir"], e["atr"]
            entry = e["close"]
            stop = e["extreme"] - buf * a if d == 1 else e["extreme"] + buf * a
            real.append(walk(bars, i, d, entry, stop, rr, maxbars))
            # control: identical direction and identical risk in ATR units,
            # but anchored to an unrelated bar
            risk_atr = abs(entry - stop) / a
            for _ in range(3):                    # 3 controls per event
                j = rng.randrange(60, hi)
                aj = atr[j]
                if not aj:
                    continue
                ej = bars["c"][j]
                sj = ej - d * risk_atr * aj
                ctrl.append(walk(bars, j, d, ej, sj, rr, maxbars))
        print(report(f"  RR 1:{rr:g}  sweep events", real, rr))
        print(report(f"  RR 1:{rr:g}  matched control", ctrl, rr))

    # which conditioning actually separates? tested at 1:2 only, to keep the
    # number of comparisons small and the conclusions readable
    rr = 2.0
    flags = []
    for e in ev:
        i, d, a = e["bar"], e["dir"], e["atr"]
        stop = e["extreme"] - buf * a if d == 1 else e["extreme"] + buf * a
        flags.append(walk(bars, i, d, e["close"], stop, rr, maxbars))
    print("-" * 84)

    def bucket(name, keyfn, order=None):
        g = defaultdict(list)
        for e, f in zip(ev, flags):
            g[keyfn(e)].append(f)
        for kk in (order or sorted(g)):
            if kk in g:
                print(report(f"  {name}={kk}", g[kk], rr))

    def band(x, edges):
        for a, b in zip(edges, edges[1:]):
            if a <= x < b:
                return f"[{a},{b})"
        return f">={edges[-1]}" if x >= edges[-1] else f"<{edges[0]}"

    bucket("vwapZ", lambda e: band(e["vwap_z"] * e["dir"], [-4, -2, -1, 0]))
    bucket("depth", lambda e: band(e["depth_atr"], [0, .25, .5, 1.0]))
    bucket("lag", lambda e: min(e["lag"], 3))
    bucket("closeDir", lambda e: e["close_dir"])
    bucket("po3open", lambda e: band(e["open_atr"], [-2, 0, .5, 1.5]))
    bucket("sess", lambda e: ("asia" if e["mspo"] < E.M_ASIA_END else
                              "london" if e["mspo"] < E.M_LON_END else
                              "nyam" if e["mspo"] < E.M_NYAM_CLOSE else
                              "nypm" if e["mspo"] < E.M_RTH_CLOSE else "late"),
           order=["asia", "london", "nyam", "nypm", "late"])
    bucket("dir", lambda e: "long" if e["dir"] == 1 else "short")
    bucket("reclaimSize", lambda e: band(e["reclaim_atr"], [0, .25, .5, 1.0]))


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "data_po3"
    for spec in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["MNQ_1h"]):
        study(os.path.join(data, f"{spec}.csv"), spec)
