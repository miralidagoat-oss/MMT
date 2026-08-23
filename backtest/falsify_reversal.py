#!/usr/bin/env python3
"""Adversarial falsification of the 5-minute reversal signal.

The battery in research5m.py found exactly one hypothesis surviving FDR:
fading the previous 5m bar's direction. Before believing it, three things must
be ruled out, because each would produce the same statistic without any
tradeable edge:

 1. NON-TRADEABLE ENTRY. The naive test enters at close[i]. You cannot trade
    at a close that has already printed. The only executable version enters at
    open[i+1]. This script splits the close-to-close return into
        phantom   = open[i+1] / close[i]  - 1     (NOT capturable)
        tradeable = close[i+1] / open[i+1] - 1    (capturable)
    If the edge lives in `phantom`, it is an accounting illusion.

 2. BID-ASK BOUNCE (Roll 1984). Closes alternate between bid and ask, which
    manufactures negative autocorrelation. Magnitude is bounded by the
    half-spread, so this script prints the half-spread in bp for comparison.

 3. TIME-OF-DAY CONCENTRATION. If the whole effect sits in one or two bars of
    the day (the open, the close auction), it is a session artifact, not a
    general reversal, and must be modelled as such or discarded.

Usage: python3 falsify_reversal.py <csv> [label]
"""
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import (load, is_rth, mean, stdev, newey_west_t, pct,   # noqa: E402
                   MNQ_TICK, RTH_OPEN, RTH_CLOSE)

BP = 1e4


def analyse(b, label, cost_pts=1.5):
    idx = [i for i in range(b.n) if is_rth(b.t[i])]
    px = mean([b.c[i] for i in idx])
    cost_bp = cost_pts / px * BP
    half_spread_bp = (MNQ_TICK / 2.0) / px * BP

    print(f"\n{'='*92}\n{label}\n{'='*92}")
    print(f"RTH bars {len(idx)}   mean index {px:.0f}")
    print(f"cost {cost_pts} pts = {cost_bp:.3f} bp RT   |   "
          f"half-spread {MNQ_TICK/2:.3f} pts = {half_spread_bp:.4f} bp")

    # group into contiguous sessions so bar i-1 / i / i+1 are truly adjacent
    sess = defaultdict(list)
    for i in idx:
        sess[b.et[i][0]].append(i)

    total, phantom, tradeable = [], [], []
    by_tod = defaultdict(list)
    autocorr_num, autocorr_d1, autocorr_d2 = 0.0, 0.0, 0.0
    rets_all = []

    for d, ids in sorted(sess.items()):
        if len(ids) < 20:
            continue
        for k in range(1, len(ids) - 1):
            i0, i1, i2 = ids[k - 1], ids[k], ids[k + 1]
            r_prev = b.c[i1] / b.c[i0] - 1.0
            if r_prev == 0:
                continue
            sign = -math.copysign(1.0, r_prev)          # fade it
            r_cc = (b.c[i2] / b.c[i1] - 1.0) * BP        # close -> close
            r_ph = (b.o[i2] / b.c[i1] - 1.0) * BP        # close -> next open
            r_tr = (b.c[i2] / b.o[i2] - 1.0) * BP        # next open -> close
            total.append(sign * r_cc)
            phantom.append(sign * r_ph)
            tradeable.append(sign * r_tr)
            by_tod[b.et[i1][4]].append(sign * r_tr)
            rets_all.append(r_prev * BP)

    # first-order autocorrelation of 5m returns
    n = len(rets_all)
    m = mean(rets_all)
    for k in range(1, n):
        autocorr_num += (rets_all[k] - m) * (rets_all[k - 1] - m)
    autocorr_d1 = sum((x - m) ** 2 for x in rets_all)
    rho = autocorr_num / autocorr_d1 if autocorr_d1 else float("nan")

    def row(name, xs, note=""):
        t = newey_west_t(xs, lags=5)
        net = mean(xs) - cost_bp
        print(f"  {name:<34}{len(xs):>7}{mean(xs):>10.3f}{t:>8.2f}"
              f"{net:>10.3f}   {note}")

    print(f"\n  5m return AR(1) rho = {rho:+.4f}   "
          f"(negative => mechanical reversal present)")
    print(f"\n  {'decomposition':<34}{'n':>7}{'mean_bp':>10}{'t_NW':>8}{'net_bp':>10}")
    print("  " + "-" * 74)
    row("TOTAL  close[i] -> close[i+1]", total, "<- the naive, NON-tradeable test")
    row("PHANTOM close[i] -> open[i+1]", phantom, "<- cannot be captured")
    row("TRADEABLE open[i+1] -> close[i+1]", tradeable, "<- the only real one")

    # cost sensitivity on the tradeable leg only
    print(f"\n  cost sensitivity (TRADEABLE leg, mean {mean(tradeable):.3f} bp):")
    for cp in (0.5, 1.0, 1.5, 2.0, 2.5):
        cb = cp / px * BP
        net = mean(tradeable) - cb
        verdict = "profitable" if net > 0 else "LOSS"
        print(f"    round turn {cp:>4.1f} pts = {cb:5.3f} bp  ->  net "
              f"{net:+7.3f} bp/trade   {verdict}")

    # time-of-day concentration of the tradeable leg
    print(f"\n  TRADEABLE leg by time of day (ET), top/bottom 6 of "
          f"{len(by_tod)} buckets:")
    rows = [(mean(v), len(v), tod) for tod, v in by_tod.items() if len(v) > 20]
    rows.sort(reverse=True)
    for mv, nn, tod in rows[:6]:
        print(f"    {tod//60:02d}:{tod%60:02d}  mean {mv:+7.3f} bp  n={nn}")
    print("    ...")
    for mv, nn, tod in rows[-6:]:
        print(f"    {tod//60:02d}:{tod%60:02d}  mean {mv:+7.3f} bp  n={nn}")

    # how much of the total effect is just the open and the close?
    edge_bars = [tod for _, _, tod in rows if tod in (RTH_OPEN, RTH_CLOSE - 5)]
    core = [x for tod, v in by_tod.items() if tod not in (RTH_OPEN, RTH_CLOSE - 5)
            for x in v]
    if core:
        print(f"\n  excluding the 09:30 and 15:55 bars: mean "
              f"{mean(core):+.3f} bp  t_NW {newey_west_t(core,5):+.2f}  "
              f"net {mean(core)-cost_bp:+.3f} bp")
    return dict(total=mean(total), tradeable=mean(tradeable),
                phantom=mean(phantom), cost_bp=cost_bp)


def main():
    path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else path.rsplit("/", 1)[-1]
    analyse(load(path), label)


if __name__ == "__main__":
    main()
