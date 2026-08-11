#!/usr/bin/env python3
"""MNQ walk-forward: tune on the first 60% of MNQ 1h (2y of data), validate
on the untouched last 40%, cross-validate on NQ 1h (same underlying, other
contract), then score the chosen config on every intraday timeframe."""
import itertools
import json
import os
import sys

from backtest import Params, Result, load, run
from walkforward import slice_bars


def agg_of(r_list):
    agg = Result()
    for r in r_list:
        agg.signals += r.signals
        agg.fills += r.fills
        agg.wins += r.wins
        agg.losses += r.losses
        agg.expired += r.expired
        agg.exits += r.exits
        agg.hold_bars += r.hold_bars
    return agg


def main(mnq_dir, nq_dir):
    mnq_1h = load(os.path.join(mnq_dir, "MNQ_1h.csv"))
    nq_1h = load(os.path.join(nq_dir, "NQ_1h.csv"))
    is_bars = slice_bars(mnq_1h, 0.0, 0.6)
    oos_bars = slice_bars(mnq_1h, 0.6, 1.0)

    grid = {
        "rr": [1.5, 2.0, 3.0, 4.0],
        "min_close_pos": [0.6, 0.7],
        "sweep_sigma": [0.25, 0.5, 0.75],
        "range_exp": [0.8, 1.0],
        "stop_sigma": [0.5, 1.0, 1.5],
        "validity": [12, 24],
        "vol_mult": [0.8, 1.2],
    }
    keys = list(grid)
    ranked = []
    for combo in itertools.product(*grid.values()):
        p = Params(min_wick=0.35, cooldown=10, use_regime=False,
                   **dict(zip(keys, combo)))
        r = run(is_bars, p)
        closed = r.wins + r.losses
        if closed < 30:
            continue
        ranked.append((r.expectancy, r.pf, r.wr, closed, dict(zip(keys, combo))))
    ranked.sort(reverse=True, key=lambda x: x[0])

    print("── top 8 in-sample (MNQ 1h, first 60%) ──")
    print(f"{'expR':>6} {'PF':>5} {'WR%':>5} {'n':>4}  params")
    for exp, pf, wr, nn, kv in ranked[:8]:
        print(f"{exp:6.3f} {pf:5.2f} {wr:5.1f} {nn:4d}  {kv}")

    print("\n── out-of-sample (MNQ 1h last 40%) + cross-val (NQ 1h full) ──")
    print(f"{'oosExpR':>7} {'oosPF':>6} {'oosWR':>6} {'oosN':>4} | {'nqExpR':>6} {'nqPF':>5} {'nqN':>4}  params")
    for exp, pf, wr, nn, kv in ranked[:8]:
        p = Params(min_wick=0.35, cooldown=10, use_regime=False, **kv)
        ro = run(oos_bars, p)
        rn = run(nq_1h, p)
        print(f"{ro.expectancy:7.3f} {ro.pf:6.2f} {ro.wr:6.1f} {ro.wins + ro.losses:4d} | "
              f"{rn.expectancy:6.3f} {rn.pf:5.2f} {rn.wins + rn.losses:4d}  {kv}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
