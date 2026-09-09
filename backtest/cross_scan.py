#!/usr/bin/env python3
"""Corroborate every parameter choice on markets that never selected it.

The candidate was tuned on MNQ 1h in-sample. Here each axis is re-swept and
scored twice: on MNQ, and pooled across NQ/ES/YM/RTY - four instruments that
took no part in the selection. A setting is only worth adopting if the
never-selected pool agrees. Where MNQ prefers one value and the pool prefers
another, the pool wins; that is the whole point of holding it back.
"""
import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E  # noqa: E402
from evaluate import CANDIDATE, TICK  # noqa: E402

HOLDOUT = ["NQ", "ES", "YM", "RTY"]
SELECT = "MNQ"

AXES = {
    "min_sweep_atr": [0.0, 0.15, 0.25, 0.35, 0.50, 0.75],
    "reclaim_bars": [0, 1, 2, 3, 4],
    "dev_entry": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
    "use_vwap": [True, False],
    "vwap_reclaim": [False, True],
    "po3_mode": ["off", "below_open", "reclaim_open"],
    "po3_period": ["day", "week"],
    "rr": [1.0, 1.5, 2.0, 2.5, 3.0, 4.0],
    "be_at_r": [0.0, 0.5, 1.0, 1.5],
    "stop_buf_atr": [0.25, 0.35, 0.50, 0.75, 1.00],
    "require_close_dir": [True, False],
    "vol_mult": [0.0, 0.8, 1.0, 1.3, 1.6],
    "max_risk_atr": [0.0, 1.5, 2.0, 3.0],
    "session": ["all", "rth", "nyam", "globex"],
    "cooldown": [0, 3, 6, 12],
    "tp_mode": ["rr", "vwap"],
    "eq_only": [False, True],
    "entry_mode": ["reclaim_close", "level_retest", "wick_mid"],
}


def load(data, tf="1h"):
    cache = {}
    for sym in [SELECT] + HOLDOUT:
        path = os.path.join(data, f"{sym}_{tf}.csv")
        bars = E.load_csv(path)
        cache[sym] = (bars, E.build_context(bars))
    return cache


def evaluate(cache, p, syms, cost, split=None):
    """`split` restricts which bars may originate a signal. MNQ is always
    scored on its in-sample window so that the MNQ out-of-sample window stays
    genuinely untouched by parameter selection."""
    pooled = E.Result()
    for sym in syms:
        bars, ctx = cache[sym]
        n = len(bars["c"])
        pp = replace(p, tick=TICK[sym], cost_ticks=cost)
        lo, hi = (0, n) if split is None else (int(n * split[0]), int(n * split[1]))
        pooled.merge(E.run(bars, ctx, pp, lo, hi))
    return pooled


def main(data, cost=4.0, tf="1h"):
    cache = load(data, tf)
    print(f"\n{'=' * 96}\naxis corroboration on {tf}, cost {cost} ticks   "
          f"{SELECT} = selection market (IN-SAMPLE 60% ONLY, so its OOS stays "
          f"clean), POOL = {'+'.join(HOLDOUT)}\n{'=' * 96}")
    print(f"{'setting':<34} {SELECT + ' n':>6} {'PF':>6} {'expR':>7}   "
          f"{'POOL n':>6} {'PF':>6} {'expR':>7}  {'sym+':>4}")
    for axis, vals in AXES.items():
        print(f"-- {axis}")
        for v in vals:
            p = replace(CANDIDATE, **{axis: v})
            m = evaluate(cache, p, [SELECT], cost, split=(0.0, 0.6))
            pool = evaluate(cache, p, HOLDOUT, cost)
            pos = sum(1 for s in HOLDOUT
                      if evaluate(cache, p, [s], cost).expectancy > 0)
            star = " *" if v == getattr(CANDIDATE, axis) else "  "
            print(f"  {axis}={v!s:<22}{star}{len(m.exits):>6} {m.pf:>6.2f} "
                  f"{m.expectancy:>+7.3f}   {len(pool.exits):>6} {pool.pf:>6.2f} "
                  f"{pool.expectancy:>+7.3f}  {pos:>3}/4")


if __name__ == "__main__":
    # usage: cross_scan.py [data_dir] [cost_ticks] [tf] [select] [holdout,csv]
    if len(sys.argv) > 4:
        SELECT = sys.argv[4]
    if len(sys.argv) > 5:
        HOLDOUT = sys.argv[5].split(",")
    main(sys.argv[1] if len(sys.argv) > 1 else "data_po3",
         float(sys.argv[2]) if len(sys.argv) > 2 else 4.0,
         sys.argv[3] if len(sys.argv) > 3 else "1h")
