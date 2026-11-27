#!/usr/bin/env python3
"""The 5-minute ORB (round 7's F1) on the Nasdaq-100 and S&P 500 CFDs at the MNQ file's bar size: the CFD's 1-minute
bars are combined into 5-minute bars (on the session clock, as the MNQ file is), then traded exactly as
check_proposals.orb_trades does, at 0 and 1 tick of slippage on each fill.

usage: python3 -I check_orb_cfd5.py CFD_DATA_DIR OUT_DIR       # writes OUT_DIR/orb_cfd5.json
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_proposals as CP  # noqa: E402
from engine import Sessions, load_npz  # noqa: E402


def to5(bars):
    """1-minute bars (t = open time, NY wall-clock minutes) -> 5-minute bars starting on multiples of 5 minutes."""
    t, o, h, l, c = bars
    b = t // 5
    starts = np.r_[0, np.flatnonzero(np.diff(b)) + 1]
    ends = np.r_[starts[1:], len(t)]
    return (b[starts] * 5, o[starts], np.maximum.reduceat(h, starts), np.minimum.reduceat(l, starts), c[ends - 1])


def main(dd, out):
    spx1 = load_npz(os.path.join(dd, "SPXUSD.npz"))
    res = {}
    for name, f in (("NQ CFD", "NSXUSD.npz"), ("S&P CFD", "SPXUSD.npz")):
        S5 = Sessions(to5(load_npz(os.path.join(dd, f))), spx1, tf=5)
        for slip in (0.0, 0.25):
            rows = CP.orb_trades(S5, slip)
            R = [(d, r) for d, s, u, r in rows]
            yrs = CP.by_year(R)
            pre = [v for y, v in yrs.items() if "2011" <= y <= "2020"]
            res[f"{name} 5-min bars, {int(slip / 0.25)} tick"] = dict(
                pooled_2011_2020=CP.pooled(R, "2011-01-01", "2020-12-31"), pooled_2021_2026=CP.pooled(R, "2021-01-01", "2026-12-31"),
                years_up_2011_2020=f"{sum(1 for v in pre if v[1] > 0)} of {len(pre)}", by_year=yrs)
            print(name, slip, res[f"{name} 5-min bars, {int(slip / 0.25)} tick"]["pooled_2011_2020"],
                  res[f"{name} 5-min bars, {int(slip / 0.25)} tick"]["years_up_2011_2020"], flush=True)
    json.dump(res, open(os.path.join(out, "orb_cfd5.json"), "w"), indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
