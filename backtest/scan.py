#!/usr/bin/env python3
"""One-parameter-at-a-time scan around a baseline, using the real fill model.

A full grid search over ten parameters would find a spectacular cell by luck
alone. This instead moves one axis at a time from a baseline and reports the
whole axis, so a parameter is only adopted when its neighbours agree - a
plateau, not a spike. Win rates carry Wilson intervals and are always shown
against the breakeven rate 1/(1+RR), because at RR 3 a 30% win rate is good
and at RR 1 it is a disaster.
"""
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from study_po3 import wilson  # noqa: E402

BASE = E.Params(
    min_sweep_atr=0.25, max_sweep_atr=1.50, reclaim_bars=2,
    use_vwap=True, dev_entry=2.0, po3_mode="below_open",
    require_close_dir=True, entry_mode="reclaim_close", stop_buf_atr=0.50,
    rr=2.0, validity=12, session="all", cooldown=6,
)

AXES = {
    "entry_mode": ["reclaim_close", "wick_mid", "level_retest"],
    "rr": [1.0, 1.5, 2.0, 3.0],
    "reclaim_bars": [0, 1, 2, 3],
    "min_sweep_atr": [0.0, 0.10, 0.25, 0.50],
    "max_sweep_atr": [0.75, 1.50, 3.00, 99.0],
    "dev_entry": [1.0, 2.0, 3.0, 4.0],
    "use_vwap": [True, False],
    "po3_mode": ["off", "below_open", "reclaim_open"],
    "session": ["all", "rth", "nyam", "globex"],
    "stop_buf_atr": [0.25, 0.50, 1.00, 1.50],
    "require_close_dir": [True, False],
    "be_at_r": [0.0, 1.0],
    "eq_only": [False, True],
    "validity": [6, 12, 24],
    "cooldown": [0, 6, 12],
}

POOLSETS = {
    "all": BASE.pools,
    "named-only": ("pdh", "pdl", "pwh", "pwl", "asiah", "asial", "lonh", "lonl", "ibh", "ibl"),
    "pivots-only": ("pivot",),
    "daily+weekly": ("pdh", "pdl", "pwh", "pwl"),
    "session-only": ("asiah", "asial", "lonh", "lonl", "ibh", "ibl"),
}


def line(tag, r, p):
    d = r.wins + r.losses
    if d < 20:
        return f"  {tag:<28} n={d:<4} (too few)"
    wr = r.wins / d
    lo, hi = wilson(r.wins, d)
    be = 1.0 / (1.0 + p.rr)
    mark = "++" if lo > be else ("--" if hi < be else "  ")
    fr = 100.0 * r.fills / r.signals if r.signals else 0.0
    return (f"  {tag:<28} sig={r.signals:<4} fill={fr:4.0f}% n={d:<4} "
            f"WR={wr * 100:5.1f}%[{lo * 100:4.1f},{hi * 100:4.1f}] BE={be * 100:4.1f}% "
            f"PF={r.pf:5.2f} expR={r.expectancy:+6.3f} tick%={r.extreme_hit_rate:4.0f} {mark}")


def scan(path, label, split=(0.0, 0.6), anchor="day"):
    bars = E.load_csv(path)
    ctx = E.build_context(bars, anchor)
    n = len(bars["c"])
    lo_i, hi_i = int(n * split[0]), int(n * split[1])
    print(f"\n{'=' * 108}\n{label}  bars {lo_i}..{hi_i} of {n}   "
          f"baseline: {BASE.entry_mode} RR{BASE.rr:g} sweep[{BASE.min_sweep_atr},"
          f"{BASE.max_sweep_atr}]ATR dev{BASE.dev_entry} po3={BASE.po3_mode}\n{'=' * 108}")
    r = E.run(bars, ctx, BASE, lo_i, hi_i)
    print(line("BASELINE", r, BASE))
    for axis, vals in AXES.items():
        print(f"-- {axis}")
        for v in vals:
            p = replace(BASE, **{axis: v})
            print(line(f"{axis}={v}", E.run(bars, ctx, p, lo_i, hi_i), p))
    print("-- pools")
    for name, ps in POOLSETS.items():
        p = replace(BASE, pools=ps)
        print(line(f"pools={name}", E.run(bars, ctx, p, lo_i, hi_i), p))


if __name__ == "__main__":
    data = sys.argv[1] if len(sys.argv) > 1 else "data_po3"
    specs = sys.argv[2].split(",") if len(sys.argv) > 2 else ["MNQ_1h"]
    for spec in specs:
        scan(os.path.join(data, f"{spec}.csv"), spec)
