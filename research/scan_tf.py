#!/usr/bin/env python3
"""Which timeframe actually holds the edge? Full-sample scan, costs on.

This is the question the old README could not answer: its 1m verdict rested on
7 days of data and its 5m/15m/30m verdicts on 60. With ~11 years of 1-minute
bars underneath, each timeframe gets hundreds to thousands of trades.
"""
import sys
import numpy as np

import core, engine, lab, strategy
from strategy import Params

m1 = core.load_1m()
lab.describe(m1, "NDX 1m")
lv = strategy.liquidity_levels(m1, 30)
print()

print(f"{'tf':>4} {'sig':>6} {'taken':>6} {'fill%':>6} {'WR%':>6} {'PF':>6} "
      f"{'exp R':>8} {'net R':>9} {'DD':>7} {'SR/trade':>9} {'$/yr':>10}")
print("-" * 92)
years = (m1.t[-1] - m1.t[0]) / (365.25 * 86400)
rows = []
for tf in (1, 2, 3, 5, 10, 15, 30, 60):
    p = Params(tf=tf)
    led, st = lab.run(m1, p, lv=lv)
    s = engine.stats(led)
    fill = 100.0 * st["taken"] / max(st["signals"] - st["skipped_busy"], 1)
    sr = (led["r_net"].mean() / led["r_net"].std(ddof=1)) if len(led) > 2 else 0
    print(f"{tf:>4} {st['signals']:>6} {st['taken']:>6} {fill:>6.1f} "
          f"{s['wr']:>6.1f} {s['pf']:>6.2f} {s['exp']:>+8.3f} {s['net_r']:>+9.1f} "
          f"{s['dd']:>7.1f} {sr:>9.3f} {s['usd']/years:>10,.0f}")
    rows.append((tf, s, st))
