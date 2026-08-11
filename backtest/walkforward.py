#!/usr/bin/env python3
"""Walk-forward validation for the v3 logic on 1h data.

Tunes on the first 60% of each series (in-sample), then evaluates the top
in-sample configurations untouched on the remaining 40% (out-of-sample).
"""
import itertools
import os
import sys

from backtest import Params, Result, load, run

SPLIT = 0.6


def slice_bars(bars, a, b):
    n = len(bars[0])
    i, j = int(n * a), int(n * b)
    return tuple(s[i:j] for s in bars)


def pooled(ds, p):
    agg = Result()
    per_pf = []
    for _, bars in ds:
        r = run(bars, p)
        agg.signals += r.signals
        agg.fills += r.fills
        agg.wins += r.wins
        agg.losses += r.losses
        agg.expired += r.expired
        agg.exits += r.exits
        agg.hold_bars += r.hold_bars
        per_pf.append(r.pf)
    return agg, per_pf


def main(data_dir):
    ds_full = [(n[:-4], load(os.path.join(data_dir, n)))
               for n in sorted(os.listdir(data_dir)) if n.endswith("_3600.csv")]
    ds_is = [(n, slice_bars(b, 0.0, SPLIT)) for n, b in ds_full]
    ds_oos = [(n, slice_bars(b, SPLIT, 1.0)) for n, b in ds_full]

    grid = {
        "rr": [2.0, 3.0, 4.0],
        "min_wick": [0.35, 0.45],
        "min_close_pos": [0.6, 0.7],
        "sweep_sigma": [0.25, 0.5, 0.75],
        "range_exp": [0.8, 1.0],
        "stop_sigma": [0.5, 1.0],
        "cooldown": [6, 10],
        "use_regime": [False],
    }
    keys = list(grid)
    ranked = []
    for combo in itertools.product(*grid.values()):
        p = Params(**dict(zip(keys, combo)))
        agg, per_pf = pooled(ds_is, p)
        closed = agg.wins + agg.losses
        if closed < 25:
            continue
        pos = sum(1 for x in per_pf if x > 1.0)
        ranked.append((pos, agg.expectancy, agg.pf, agg.wr, closed, dict(zip(keys, combo))))
    ranked.sort(reverse=True, key=lambda x: (x[0], x[1]))

    print("── top 5 in-sample (first 60% of each 1h series) ──")
    print(f"{'ds+':>3} {'expR':>6} {'PF':>5} {'WR%':>5} {'n':>4}  params")
    for pos, exp, pf, wr, nn, kv in ranked[:5]:
        print(f"{pos:>3} {exp:6.3f} {pf:5.2f} {wr:5.1f} {nn:4d}  {kv}")

    print("\n── same configs on untouched out-of-sample (last 40%) ──")
    print(f"{'expR':>6} {'PF':>5} {'WR%':>5} {'n':>4} {'netR':>6}  params")
    for pos, _, _, _, _, kv in ranked[:5]:
        p = Params(**kv)
        agg, per_pf = pooled(ds_oos, p)
        closed = agg.wins + agg.losses
        print(f"{agg.expectancy:6.3f} {agg.pf:5.2f} {agg.wr:5.1f} {closed:4d} {agg.net_r:6.1f}  {kv}")


if __name__ == "__main__":
    main(sys.argv[1])
