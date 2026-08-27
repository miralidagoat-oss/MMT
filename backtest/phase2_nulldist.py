#!/usr/bin/env python3
"""Null distribution of PF from random entries on the real MNQ 5m ETH series.

This calibrates every other number in the project. With ~45 trading days, how
extreme must a profit factor be before it means anything? Anything inside this
band is indistinguishable from chance and must not be reported as an edge.
"""
import random
import statistics as st
import sys
from eth_features import load_bars, add_features, ready
from eth_engine import run

def rand_sig(p, seed):
    rng = random.Random(seed)
    def sig(bars, i):
        if not ready(bars[i]):
            return 0
        return rng.choice((+1, -1)) if rng.random() < p else 0
    return sig

def pct(sorted_v, q):
    return sorted_v[min(len(sorted_v) - 1, int(q * len(sorted_v)))]

def main():
    bars = load_bars(sys.argv[1] if len(sys.argv) > 1 else "data/MNQ_5m.csv")
    add_features(bars)
    u = [b for b in bars if ready(b)]
    N = int(sys.argv[2]) if len(sys.argv) > 2 else 300

    for label, p, cost in (("~170 trades, zero cost", 0.02, "zero"),
                           ("~170 trades, moderate cost", 0.02, "moderate"),
                           ("~60 trades, zero cost", 0.007, "zero")):
        pfs, wrs, exps, ns = [], [], [], []
        for s in range(N):
            r = run(u, rand_sig(p, 10_000 + s), cost=cost, rr=0.643)
            if r.n < 5:
                continue
            pfs.append(min(r.pf, 10)); wrs.append(r.wr)
            exps.append(r.expectancy); ns.append(r.n)
        pfs.sort(); wrs.sort(); exps.sort()
        print(f"\n=== NULL: {label}  ({len(pfs)} runs, median n={int(st.median(ns))}) ===")
        print(f"  PF   p05={pct(pfs,.05):.2f}  p25={pct(pfs,.25):.2f}  med={pct(pfs,.5):.2f}"
              f"  p75={pct(pfs,.75):.2f}  p95={pct(pfs,.95):.2f}  p99={pct(pfs,.99):.2f}")
        print(f"  WR%  p05={pct(wrs,.05):.1f}  med={pct(wrs,.5):.1f}  p95={pct(wrs,.95):.1f}")
        print(f"  expR p05={pct(exps,.05):+.3f} med={pct(exps,.5):+.3f} p95={pct(exps,.95):+.3f}")
        print(f"  -> a candidate must beat PF {pct(pfs,.95):.2f} (p<0.05) "
              f"or {pct(pfs,.99):.2f} (p<0.01) to be distinguishable from chance.")

if __name__ == "__main__":
    main()
