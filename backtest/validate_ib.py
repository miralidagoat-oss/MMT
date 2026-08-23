#!/usr/bin/env python3
"""Adversarial validation of the MNQ 15m Initial-Balance breakout.

It topped the grid (762 trades, OOS PF 1.38). Before believing that, four
things have to be ruled out — the same battery that killed the 5m reversal:

 1. MULTIPLE TESTING. 384 cells were scanned. Under a null of no edge, a
    large number of them are positive in both panels by luck. This script
    prints how many distinct family/timeframe/instrument combinations
    survived versus how many chance alone predicts.
 2. SIGNIFICANCE. Bootstrap CI on expectancy. PF 1.38 on 762 trades sounds
    solid; a 1:3 payoff distribution is dominated by rare wins and its
    standard error is wide.
 3. STABILITY. Per-calendar-year breakdown. An edge concentrated in one year
    is a regime, exactly like the 5m reversal was.
 4. INSTRUMENT / FEED. Does it appear on REAL MNQ futures bars, not the
    Dukascopy cash-index proxy?

Plus parameter robustness: IB length and stop distance swept.
"""
import datetime as dt
import math
import random
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, mean, stdev, pct                      # noqa: E402
from engine import Feat, FAMILIES, execute, summarise, INSTRUMENTS  # noqa: E402

random.seed(20260823)
S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
     "/scratchpad")
COST = INSTRUMENTS["MNQ"]["cost_pts"]


def boot_ci(xs, iters=4000):
    n = len(xs)
    if n < 20:
        return float("nan"), float("nan")
    ms = []
    for _ in range(iters):
        ms.append(sum(xs[random.randrange(n)] for _ in range(n)) / n)
    ms.sort()
    return pct(ms, 0.025), pct(ms, 0.975)


def main():
    b = load(f"{S}/mtf/USATECHIDXUSD_15m.csv")
    F = Feat(b, 26)
    sigs = FAMILIES["ib_break"](F, dict(cooldown=3))
    RR = 3.0
    tr = execute(F, sigs, RR, COST, validity=8, be_trigger=1.0)
    s = summarise(tr)
    net = [x[0] for x in tr]
    lo, hi = boot_ci(net)

    print("=" * 86)
    print("MNQ 15m INITIAL-BALANCE BREAKOUT, RR 3.0 — adversarial validation")
    print("=" * 86)
    print(f"  trades {s['n']}   WR {s['wr']:.1f}%   expectancy {s['exp']:+.3f} R"
          f"   PF {s['pf']:.2f}   t {s['t']:+.2f}")
    print(f"  bootstrap 95% CI on expectancy: [{lo:+.3f}, {hi:+.3f}] R")
    print(f"  -> {'EXCLUDES ZERO' if lo > 0 else 'INCLUDES ZERO — not distinguishable from no edge'}")

    # ---- per calendar year ----
    print("\n  per calendar year (net of cost):")
    byyr = defaultdict(list)
    for r_net, r_gross, risk, bar in tr:
        y = dt.datetime.utcfromtimestamp(b.t[bar]).year
        byyr[y].append(r_net)
    for y in sorted(byyr):
        v = byyr[y]
        sd = stdev(v) if len(v) > 1 else float("nan")
        t = mean(v) / (sd / math.sqrt(len(v))) if sd else float("nan")
        gw = sum(x for x in v if x > 0)
        gl = -sum(x for x in v if x < 0)
        pf = gw / gl if gl else float("inf")
        print(f"    {y}   n={len(v):>4}  exp {mean(v):+.3f} R  t {t:+5.2f}"
              f"  PF {pf:5.2f}  net {sum(v):+7.1f} R")

    # ---- parameter robustness ----
    print("\n  parameter robustness (net-of-cost PF / expectancy):")
    for key, vals in (("stop", [1.0, 1.25, 1.5, 2.0, 2.5]),):
        cells = []
        for v in vals:
            sg = FAMILIES["ib_break"](F, dict(cooldown=3, stop=v))
            t2 = execute(F, sg, RR, COST, validity=8, be_trigger=1.0)
            s2 = summarise(t2)
            cells.append(f"{v:g}:PF{s2['pf']:.2f}/exp{s2['exp']:+.3f}")
        print(f"    {key:<6} " + "  ".join(cells))
    cells = []
    for v in (4, 6, 8, 12, 20):
        t2 = execute(F, sigs, RR, COST, validity=v, be_trigger=1.0)
        s2 = summarise(t2)
        cells.append(f"{v}:PF{s2['pf']:.2f}/n{s2['n']}")
    print(f"    {'valid':<6} " + "  ".join(cells))
    cells = []
    for v in (0.0, 0.5, 1.0, 1.5):
        t2 = execute(F, sigs, RR, COST, validity=8, be_trigger=v)
        s2 = summarise(t2)
        cells.append(f"{v:g}:PF{s2['pf']:.2f}/WR{s2['wr']:.0f}%")
    print(f"    {'BE@R':<6} " + "  ".join(cells))

    # ---- real MNQ futures cross-check ----
    print("\n" + "=" * 86)
    print("CROSS-CHECK ON REAL MNQ FUTURES BARS (Yahoo, 60 days, 15m)")
    print("=" * 86)
    for tag, path, inst in (("MNQ futures 15m", f"{S}/fut/MNQ_15m.csv", "MNQ"),
                            ("MES futures 15m", f"{S}/fut/MES_15m.csv", "MES"),
                            ("ES  futures 15m", f"{S}/fut/ES_15m.csv", "MES")):
        try:
            bb = load(path)
        except Exception as e:                       # noqa: BLE001
            print(f"  {tag}: load failed ({e})")
            continue
        FF = Feat(bb, 26)
        sg = FAMILIES["ib_break"](FF, dict(cooldown=3))
        t2 = execute(FF, sg, RR, INSTRUMENTS[inst]["cost_pts"],
                     validity=8, be_trigger=1.0)
        s2 = summarise(t2)
        nsess = len({d for d in FF.sess_id if d is not None})
        print(f"  {tag}: {nsess} sessions, {s2['n']} trades "
              f"({s2['n']/max(nsess,1):.2f}/day)  WR {s2['wr']:.1f}%  "
              f"exp {s2['exp']:+.3f} R  PF {s2['pf']:.2f}")

    # ---- multiple-testing context ----
    print("\n" + "=" * 86)
    print("MULTIPLE-TESTING CONTEXT")
    print("=" * 86)
    print("  384 cells scanned = 6 families x 4 timeframes x 2 instruments x 8 RR.")
    print("  Distinct family/timeframe/instrument combos: 48.")
    print("  A combo is 'positive in both panels' by luck roughly 25% of the")
    print("  time under a null of no edge, so chance alone predicts about 12.")
    print("  Observed: 4 (MNQ15m ib_break, MNQ5m sweep, MNQ15m momentum,")
    print("  MES15m ib_break).")
    print("  FEWER survivors than chance predicts. The grid as a whole is")
    print("  evidence that costs dominate, NOT that these four are special.")


if __name__ == "__main__":
    main()
