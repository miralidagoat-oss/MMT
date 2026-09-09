#!/usr/bin/env python3
"""Edge study for the PO3/VWAP/sweep model.

Answers, before any parameter is fitted: after a liquidity sweep is reclaimed,
does price actually travel in the reclaim direction more often than chance?

Method: a symmetric double-barrier test. From the reclaim bar's close, walk
forward and record whether +k*ATR (favourable) or -k*ATR (adverse) is touched
first. Ties inside one bar are scored adverse, matching the backtest's
pessimism. p_up > 0.5 means directional edge; at symmetric barriers the
implied profit factor is p/(1-p).

A baseline is computed from evenly spaced bars over the same window, so the
conditional numbers are read against the instrument's own drift, not 0.5.
"""
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402


def barrier(bars, atr, i, d, k_up, k_dn, maxbars):
    """Does +k_up*ATR print before -k_dn*ATR, starting the bar after i?"""
    h, l, c = bars["h"], bars["l"], bars["c"]
    a = atr[i]
    if a is None or a <= 0:
        return None
    entry = c[i]
    up = entry + k_up * a * d
    dn = entry - k_dn * a * d
    n = len(c)
    for j in range(i + 1, min(i + 1 + maxbars, n)):
        adverse = (l[j] <= dn) if d == 1 else (h[j] >= dn)
        favour = (h[j] >= up) if d == 1 else (l[j] <= up)
        if adverse:          # pessimistic: adverse wins a same-bar tie
            return False
        if favour:
            return True
    return None              # neither barrier inside the horizon


def wilson(k, n, z=1.96):
    """Wilson score interval - honest error bars on a hit rate."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (centre - half, centre + half)


def summarise(name, flags):
    got = [f for f in flags if f is not None]
    n = len(got)
    k = sum(got)
    if n < 25:
        return f"{name:<28} n={n:<5} (too few)"
    p = k / n
    lo, hi = wilson(k, n)
    pf = p / (1 - p) if p < 1 else float("inf")
    return (f"{name:<28} n={n:<5} p_up={p * 100:5.1f}%  "
            f"95%CI[{lo * 100:4.1f},{hi * 100:4.1f}]  PF@1:1={pf:4.2f}")


def study(path, split=0.6, k_up=1.0, k_dn=1.0, maxbars=48, label=""):
    bars = E.load_csv(path)
    ctx = E.build_context(bars)
    n = len(bars["c"])
    hi = int(n * split)
    ev = []
    p = E.Params(min_sweep_atr=0.0, max_sweep_atr=99.0, use_vwap=False,
                 po3_mode="off", require_close_dir=False, cooldown=0,
                 reclaim_bars=3)
    E.run(bars, ctx, p, collector=ev.append)
    ev = [e for e in ev if e["bar"] < hi]          # in-sample only
    atr = ctx["atr"]

    print(f"\n{'=' * 78}\n{label or os.path.basename(path)}  "
          f"in-sample bars 0..{hi} of {n}   barriers +{k_up}/-{k_dn} ATR, "
          f"{maxbars}-bar horizon\n{'=' * 78}")

    # baseline: same test from evenly spaced bars, both directions
    base = []
    for i in range(60, hi, 7):
        for d in (1, -1):
            base.append(barrier(bars, atr, i, d, k_up, k_dn, maxbars))
    print(summarise("BASELINE (every 7th bar)", base))

    allf = [barrier(bars, atr, e["bar"], e["dir"], k_up, k_dn, maxbars) for e in ev]
    print(summarise("ALL sweep+reclaim events", allf))
    print("-" * 78)

    def bucket(name, keyfn, order=None):
        g = defaultdict(list)
        for e, f in zip(ev, allf):
            g[keyfn(e)].append(f)
        keys = order if order else sorted(g)
        for kk in keys:
            if kk in g:
                print(summarise(f"  {name}={kk}", g[kk]))

    def band(x, edges):
        for a, b in zip(edges, edges[1:]):
            if a <= x < b:
                return f"[{a},{b})"
        return f">={edges[-1]}" if x >= edges[-1] else f"<{edges[0]}"

    bucket("vwap_z", lambda e: band(e["vwap_z"] * e["dir"], [-4, -2, -1, 0, 1]))
    print("-" * 78)
    bucket("depth_atr", lambda e: band(e["depth_atr"], [0, .1, .25, .5, 1.0]))
    print("-" * 78)
    bucket("lag", lambda e: min(e["lag"], 3))
    print("-" * 78)
    bucket("close_dir", lambda e: e["close_dir"])
    print("-" * 78)
    bucket("po3_open_atr", lambda e: band(e["open_atr"], [-2, 0, .5, 1.5]))
    print("-" * 78)
    bucket("session", lambda e: ("asia" if e["mspo"] < E.M_ASIA_END else
                                 "london" if e["mspo"] < E.M_LON_END else
                                 "nyam" if e["mspo"] < E.M_NYAM_CLOSE else
                                 "nypm" if e["mspo"] < E.M_RTH_CLOSE else "late"),
           order=["asia", "london", "nyam", "nypm", "late"])
    print("-" * 78)
    bucket("dir", lambda e: "long" if e["dir"] == 1 else "short")
    print("-" * 78)
    bucket("pool", lambda e: e["kind"] if "+" not in e["kind"] else "multi")
    print("-" * 78)
    bucket("reclaim_atr", lambda e: band(e["reclaim_atr"], [0, .25, .5, 1.0]))


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "data_po3"
    for sym in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["MNQ"]):
        study(os.path.join(data, f"{sym}_1h.csv"), label=f"{sym} 1h")
