#!/usr/bin/env python3
"""Walk-forward validation for the MM MATRIX v2 engine on intraday data.

Tunes on the first 60% of each series, then evaluates the surviving
configurations on the untouched last 40%. Selection is on pooled
out-of-sample-blind expectancy with a minimum trade count, and the report
shows every finalist's OOS result so overfitting is visible rather than
hidden behind a single headline number.
"""
import itertools
import json
import os
import sys

from mm_backtest import Params, datasets, pooled, slice_bars, line

SPLIT = 0.6
MIN_IS = 40


def main(data_dir, suffix, tick, cost_r):
    full = datasets(data_dir, suffix)
    ds_is = [(n, slice_bars(b, 0.0, SPLIT)) for n, b in full]
    ds_oos = [(n, slice_bars(b, SPLIT, 1.0)) for n, b in full]

    grid = {
        "sw":        [4, 5, 8],
        "disp_atr":  [0.5, 1.0, 1.5],
        "min_rr":    [1.5, 2.0, 3.0],
        "req_ind":   [True, False],
        "req_pd":    [True, False],
        "sl_atr":    [0.1, 0.25, 0.5],
        "eq_tol":    [0.10, 0.25],
        "max_hold":  [100, 200],
        "cool_bars": [5],
        "poi_depth": [25],
    }
    keys = list(grid)
    combos = list(itertools.product(*(grid[k] for k in keys)))
    print(f"{len(combos)} configurations · {len(full)} datasets · suffix {suffix}", flush=True)

    rows = []
    for idx, vals in enumerate(combos):
        kw = dict(zip(keys, vals))
        p = Params(tick=tick, cost_r=cost_r, **kw)
        r, pfs = pooled(ds_is, p)
        if r.n < MIN_IS:
            continue
        # robustness: every market must be non-losing in sample
        if min(pfs) < 0.9:
            continue
        rows.append((r.exp_r, r.pf, r.n, kw))
        if idx % 200 == 0:
            print(f"  ...{idx}/{len(combos)}", flush=True)

    rows.sort(key=lambda x: -x[0])
    print(f"\n{len(rows)} configs passed the in-sample filters\n")
    print("TOP 12 IN-SAMPLE, THEN THEIR UNTOUCHED OUT-OF-SAMPLE RESULT")
    print("-" * 110)
    for exp_r, pf, nn, kw in rows[:12]:
        p = Params(tick=tick, cost_r=cost_r, **kw)
        ro, pfo = pooled(ds_oos, p)
        print(f"IS  expR={exp_r:+.3f} PF={pf:4.2f} n={nn:<4}  "
              f"OOS expR={ro.exp_r:+.3f} PF={ro.pf:4.2f} n={ro.n:<4} "
              f"totR={ro.sum_r:+7.1f} minPF={min(pfo):4.2f}  {json.dumps(kw)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
