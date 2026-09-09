#!/usr/bin/env python3
"""Placebo test: are the signals doing the work, or are the exit rules?

A stop/target scheme with a breakeven rule can look profitable on *any* entry
in a drifting market. This takes every real signal, keeps its direction and its
risk distance in ATR units, and re-plants it at random unrelated bars, then
manages it with byte-identical exit logic. If the control matches the real
edge, the signal is decoration and the result is an artifact of the management.
"""
import os
import random
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from study_po3 import wilson  # noqa: E402
from evaluate import CANDIDATE, TICK  # noqa: E402


def manage(bars, i, d, entry, risk, p):
    """Identical exit logic to po3_engine.run: stop wins same-bar ties, no
    target credit on the entry bar, breakeven armed only after exit checks."""
    h, l, c = bars["h"], bars["l"], bars["c"]
    stop = entry - d * risk
    tp = entry + d * p.rr * risk
    be = False
    for j in range(i + 1, len(c)):
        stop_hit = (l[j] <= stop) if d == 1 else (h[j] >= stop)
        tp_hit = (h[j] >= tp) if d == 1 else (l[j] <= tp)
        if stop_hit:
            return 0.0 if be else -1.0
        if tp_hit:
            return p.rr
        if p.be_at_r > 0 and not be:
            lvl = entry + d * p.be_at_r * risk
            if (h[j] >= lvl) if d == 1 else (l[j] <= lvl):
                be = True
                stop = entry
    return None      # never resolved before the data ended


def score(tag, rs, rr):
    rs = [r for r in rs if r is not None]
    w = sum(1 for r in rs if r > 0)
    lo_ = sum(1 for r in rs if r < 0)
    d = w + lo_
    if d < 20:
        return f"{tag:<34} (too few)"
    p = w / d
    a, b = wilson(w, d)
    gw = sum(r for r in rs if r > 0)
    gl = -sum(r for r in rs if r < 0)
    pf = gw / gl if gl else float("inf")
    return (f"{tag:<34} n={len(rs):<5} W/L={w}/{lo_} WR={p * 100:5.1f}%"
            f"[{a * 100:4.1f},{b * 100:4.1f}] PF={pf:5.2f} "
            f"expR={sum(rs) / len(rs):+.3f}")


def run(path, label, p, k=5, seed=11):
    bars = E.load_csv(path)
    ctx = E.build_context(bars)
    atr = ctx["atr"]
    n = len(bars["c"])
    rng = random.Random(seed)

    sigs = []
    ev = []
    E.run(bars, ctx, p, 0, n, collector=ev.append)
    # rebuild the accepted signals' geometry by re-running with a recorder
    res = E.run(bars, ctx, p, 0, n)

    # re-derive accepted signals: rerun the gates by replaying the engine and
    # capturing the trades it opens
    accepted = []
    orig_run = E.run

    # simplest faithful route: the engine already books trades; mirror its
    # construction here from the collector events that pass the same gates
    for e in ev:
        i, d, a = e["bar"], e["dir"], e["atr"]
        if a is None:
            continue
        depth = e["depth_atr"]
        if depth < p.min_sweep_atr or depth > p.max_sweep_atr:
            continue
        if p.require_close_dir and not e["close_dir"]:
            continue
        if p.use_vwap:
            if not e["vwap_ok"]:
                continue
            z = (e["extreme"] - e["vwap"]) / e["vsd"]
            if d == 1 and z > -p.dev_entry:
                continue
            if d == -1 and z < p.dev_entry:
                continue
        if p.po3_mode != "off" and e["period_open"] is not None:
            if d == 1 and not e["extreme"] < e["period_open"]:
                continue
            if d == -1 and not e["extreme"] > e["period_open"]:
                continue
        if e["lag"] > p.reclaim_bars:
            continue
        accepted.append(e)

    real, ctrl = [], []
    for e in accepted:
        i, d, a = e["bar"], e["dir"], e["atr"]
        entry = e["close"]
        stop = e["extreme"] - p.stop_buf_atr * a if d == 1 else e["extreme"] + p.stop_buf_atr * a
        risk = abs(entry - stop)
        if risk < 2 * p.tick:
            continue
        real.append(manage(bars, i, d, entry, risk, p))
        risk_atr = risk / a
        for _ in range(k):
            j = rng.randrange(60, n - 5)
            aj = atr[j]
            if not aj:
                continue
            ctrl.append(manage(bars, j, d, bars["c"][j], risk_atr * aj, p))

    print(f"\n{label}")
    print(score("  real signals", real, p.rr))
    print(score(f"  matched random control (x{k})", ctrl, p.rr))


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "data_po3"
    for spec in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["MNQ_1h"]):
        sym = spec.split("_")[0]
        run(os.path.join(data, f"{spec}.csv"), spec,
            replace(CANDIDATE, tick=TICK[sym]))
