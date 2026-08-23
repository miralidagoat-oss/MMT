#!/usr/bin/env python3
"""Isolate FEED effects from PERIOD effects for the 5m fade signal.

The 60-day Yahoo MNQ sample shows a fade edge ~6x larger than 3 years of
Dukascopy Nasdaq-100. Two candidate explanations, with opposite implications:

  PERIOD  - Jun-Aug 2026 was genuinely a strong mean-reversion regime.
            Then the signal is real but regime-dependent (and the 3y average
            is the honest expectation).
  FEED    - Yahoo's bar construction manufactures the effect.
            Then the signal is not real at all.

Running the SAME window on BOTH feeds separates them. Also prints a rolling
per-quarter breakdown so regime-dependence can be seen directly rather than
assumed.

Usage: python3 window_compare.py
"""
import datetime as dt
import math
import sys
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from lib5m import load, is_rth, mean, newey_west_t   # noqa: E402

BP = 1e4


def fade_edge(b, t0=None, t1=None):
    """Mean fade P&L in bp using open-to-open execution, plus diagnostics."""
    idx = [i for i in range(b.n) if is_rth(b.t[i])
           and (t0 is None or b.t[i] >= t0) and (t1 is None or b.t[i] <= t1)]
    sess = defaultdict(list)
    for i in idx:
        sess[b.et[i][0]].append(i)
    xs = []
    for d, ids in sorted(sess.items()):
        if len(ids) < 20:
            continue
        for k in range(1, len(ids) - 2):
            if (b.t[ids[k]] - b.t[ids[k - 1]] != 300
                    or b.t[ids[k + 1]] - b.t[ids[k]] != 300
                    or b.t[ids[k + 2]] - b.t[ids[k + 1]] != 300):
                continue
            r = b.c[ids[k]] / b.c[ids[k - 1]] - 1.0
            if r == 0:
                continue
            s = -math.copysign(1.0, r)
            xs.append(s * (b.o[ids[k + 2]] / b.o[ids[k + 1]] - 1.0) * BP)
    px = mean([b.c[i] for i in idx]) if idx else float("nan")
    return xs, px, len(sess)


def line(tag, xs, px, nsess, cost_pts=1.5):
    if not xs:
        print(f"  {tag:<38} no data")
        return
    cost_bp = cost_pts / px * BP
    m = mean(xs)
    print(f"  {tag:<38}{nsess:>5}{len(xs):>8}{m:>9.3f}"
          f"{newey_west_t(xs,5):>8.2f}{cost_bp:>9.3f}{m-cost_bp:>9.3f}"
          f"   {'TRADEABLE' if m-cost_bp>0 else 'below cost'}")


def main():
    S = ("/tmp/claude-0/-home-user-MMT/27a82464-d2f9-501f-9943-16ff47f75ebb"
         "/scratchpad")
    yh = load(f"{S}/dataYH/MNQ_5m.csv")
    dk = load(f"{S}/data5m/USATECHIDXUSD_5m.csv")

    t0, t1 = yh.t[0], yh.t[-1]
    d0 = dt.datetime.utcfromtimestamp(t0).date()
    d1 = dt.datetime.utcfromtimestamp(t1).date()

    hdr = (f"  {'dataset / window':<38}{'sess':>5}{'n':>8}{'mean_bp':>9}"
           f"{'t_NW':>8}{'cost_bp':>9}{'net_bp':>9}")
    print("\n=== FEED vs PERIOD: same window, two independent feeds ===")
    print(hdr)
    print("  " + "-" * 86)
    xs, px, ns = fade_edge(yh)
    line(f"Yahoo MNQ futures  {d0}..{d1}", xs, px, ns)
    xs, px, ns = fade_edge(dk, t0, t1)
    line(f"Dukascopy NDX cash {d0}..{d1}", xs, px, ns)
    xs, px, ns = fade_edge(dk)
    line("Dukascopy NDX cash  full 3 years", xs, px, ns)

    print("\n=== Dukascopy NDX by calendar quarter (regime stability) ===")
    print(hdr)
    print("  " + "-" * 86)
    qs = defaultdict(list)
    for i in range(dk.n):
        d = dt.datetime.utcfromtimestamp(dk.t[i])
        qs[(d.year, (d.month - 1) // 3 + 1)].append(i)
    for (y, q), ids in sorted(qs.items()):
        if len(ids) < 2000:
            continue
        a, z = dk.t[ids[0]], dk.t[ids[-1]]
        xs, px, ns = fade_edge(dk, a, z)
        line(f"{y} Q{q}", xs, px, ns)


if __name__ == "__main__":
    main()
