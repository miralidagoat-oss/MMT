#!/usr/bin/env python3
"""Phase 2 - baseline B1: session-VWAP mean reversion on MNQ 5m ETH.

Hypothesis: intraday flow around the session VWAP is mean-reverting. When price
is stretched a long way from VWAP in sigma terms AND the current bar closes back
toward VWAP (a rejection), the next move tends to continue toward VWAP.

Deliberately 3 rules. Nothing is tuned here; parameters are chosen a priori from
the Phase 1 viable design region (stop 1.25 ATR ~= 35 pts) and the whole
sensitivity curve is reported rather than its best point.
"""
import sys
from eth_features import load_bars, add_features, ready, split_by_day
from eth_engine import run, band, COSTS


def make_b1(k_sigma):
    """+1 fade upward from below VWAP, -1 fade downward from above."""
    def sig(bars, i):
        b = bars[i]
        if not ready(b):
            return 0
        dev = b.f.get("dev_sig")
        if dev is None:
            return 0
        # Rule 1: stretched from session VWAP.  Rule 2: bar closes back toward it.
        if dev <= -k_sigma and b.c > b.o:
            return +1
        if dev >= k_sigma and b.c < b.o:
            return -1
        return 0
    return sig


def report(bars, label, k, **kw):
    p, o = band(bars, make_b1(k), **kw)
    days = len({b.day for b in bars})
    tpd = p.n / days if days else 0
    gap = abs(p.pf - o.pf)
    print(f"  k={k:3.1f} | {p.summary('pess'):<72}")
    print(f"        | {o.summary('opt'):<72}")
    print(f"        | trades/day={tpd:4.2f}  path-band(PF)={gap:5.2f} "
          f"{'FLAG: path-dominated' if gap > 0.50 else ''}")
    return p, o


def main():
    bars = load_bars(sys.argv[1] if len(sys.argv)>1 else "data/MNQ_5m.csv")
    add_features(bars)
    usable = [b for b in bars if ready(b)]
    days = sorted({b.day for b in usable})
    print(f"MNQ 5m ETH | {len(usable)} usable bars over {len(days)} trading days "
          f"({days[0]} .. {days[-1]})\n")

    print("=== BASELINE B1: VWAP mean reversion, moderate costs, pessimistic vs optimistic ===")
    print("stop=1.25 ATR, rr=0.643 (the payoff that gives PF 1.50 at 70% WR)\n")
    for k in (1.5, 2.0, 2.5, 3.0):
        report(usable, "full", k, cost="moderate")
        print()

    print("=== COST SENSITIVITY at k=2.0 (pessimistic path) ===")
    for c in ("zero", "base", "moderate", "harsh"):
        r = run(usable, make_b1(2.0), cost=c)
        print(f"  {r.summary(c)}")

    print("\n=== SCREEN / HOLDOUT (34d / 17d) - overfit sanity check, NOT an OOS claim ===")
    screen, hold = split_by_day(usable, 0.667)
    for k in (2.0, 2.5):
        rs = run(screen, make_b1(k), cost="moderate")
        rh = run(hold, make_b1(k), cost="moderate")
        print(f"  k={k}: {rs.summary('screen')}")
        print(f"        {rh.summary('holdout')}")


if __name__ == "__main__":
    main()
