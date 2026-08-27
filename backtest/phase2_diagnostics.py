#!/usr/bin/env python3
"""Phase 2 diagnostics: validate the engine, then test whether MNQ 5m ETH
mean-reverts or trends around session VWAP.

The random-entry control is the key engine test. With a stop at -1R and a target
at +0.643R, a driftless random walk hits the target first with probability
1/(1+0.643) = 60.9%, giving PF ~= 1.00 at zero cost. If the engine reproduces
that, its fill accounting is unbiased. If a *signal* also reproduces it, the
signal carries no information.
"""
import random
import sys
from eth_features import load_bars, add_features, ready
from eth_engine import run

RR = 0.643


def rand_sig(p, seed):
    rng = random.Random(seed)
    def sig(bars, i):
        if not ready(bars[i]):
            return 0
        if rng.random() < p:
            return rng.choice((+1, -1))
        return 0
    return sig


def stretch_sig(k, mode, confirm):
    """mode='fade' trades back toward VWAP; mode='cont' trades with the stretch."""
    def sig(bars, i):
        b = bars[i]
        if not ready(b):
            return 0
        dev = b.f.get("dev_sig")
        if dev is None:
            return 0
        below, above = dev <= -k, dev >= k
        if not (below or above):
            return 0
        if confirm:                       # bar closes back toward VWAP
            if below and not b.c > b.o:
                return 0
            if above and not b.c < b.o:
                return 0
        if mode == "fade":
            return +1 if below else -1
        return -1 if below else +1        # continuation
    return sig


def main():
    bars = load_bars(sys.argv[1] if len(sys.argv) > 1 else "data/MNQ_5m.csv")
    add_features(bars)
    u = [b for b in bars if ready(b)]

    print("=== ENGINE VALIDATION: random entries, zero cost ===")
    print(f"theory: WR -> {100/(1+RR):.1f}%, PF -> 1.00 if the engine is unbiased\n")
    for seed in (1, 2, 3, 4, 5):
        r = run(u, rand_sig(0.02, seed), cost="zero", rr=RR)
        print(f"  {r.summary(f'random seed {seed}')}")
    print("\n  same, with moderate costs (this is the drag a signal must overcome):")
    for seed in (1, 2, 3):
        r = run(u, rand_sig(0.02, seed), cost="moderate", rr=RR)
        print(f"  {r.summary(f'random seed {seed}')}")

    print("\n=== DOES MNQ 5m FADE OR TREND AWAY FROM SESSION VWAP? ===")
    print("Same trigger, opposite directions. Zero cost, to isolate signal content")
    print("from cost drag. PF 1.00 = no information.\n")
    print(f"{'k':>4} {'confirm':>8} | {'FADE (revert to VWAP)':<44} | {'CONT (with the stretch)':<44}")
    for k in (1.5, 2.0, 2.5):
        for confirm in (True, False):
            f = run(u, stretch_sig(k, "fade", confirm), cost="zero", rr=RR)
            c = run(u, stretch_sig(k, "cont", confirm), cost="zero", rr=RR)
            fs = f"n={f.n:4d} WR={f.wr:5.1f}% PF={f.pf:5.2f} exp={f.expectancy:+.3f}R"
            cs = f"n={c.n:4d} WR={c.wr:5.1f}% PF={c.pf:5.2f} exp={c.expectancy:+.3f}R"
            print(f"{k:4.1f} {str(confirm):>8} | {fs:<44} | {cs:<44}")


if __name__ == "__main__":
    main()
