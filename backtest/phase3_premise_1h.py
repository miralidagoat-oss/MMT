#!/usr/bin/env python3
"""Phase 3 - test family PREMISES on MNQ 1h, where power exists.

Track A's 5m series has 45 usable trading days; the null distribution shows a
70% win rate and a PF of 1.52 both occur by chance at ~70 trades. Testing six
strategy families there would produce a spurious winner with near-certainty
(1 - 0.95^N). So the *premise* of each family is tested first on 617 trading
days of MNQ 1h, and only premises that survive get taken back down to 5m.
"""
import random
import statistics as st
import sys
from eth_features import load_bars, add_features, ready
from eth_engine import run

# 1h sessions hold ~23 bars, so the 5m gating constants must scale down.
H1 = dict(cooldown=2, max_hold=8, min_bar_in_day=4)


def stretch_sig(k, mode, confirm):
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
        if confirm:
            if below and not b.c > b.o:
                return 0
            if above and not b.c < b.o:
                return 0
        if mode == "fade":
            return +1 if below else -1
        return -1 if below else +1
    return sig


def rand_sig(p, seed):
    rng = random.Random(seed)
    def sig(bars, i):
        if not ready(bars[i]):
            return 0
        return rng.choice((+1, -1)) if rng.random() < p else 0
    return sig


def null_band(u, target_n, cost, runs=200):
    """Null PF percentiles at roughly `target_n` trades."""
    p = target_n / max(len(u), 1) / 2.2
    pfs = []
    for s in range(runs):
        r = run(u, rand_sig(p, 77_000 + s), cost=cost, rr=0.643, **H1)
        if r.n >= 5:
            pfs.append(min(r.pf, 10))
    pfs.sort()
    q = lambda x: pfs[min(len(pfs) - 1, int(x * len(pfs)))]
    return q(.05), q(.5), q(.95), q(.99)


def main():
    bars = load_bars(sys.argv[1] if len(sys.argv) > 1 else "data/MNQ_1h.csv")
    add_features(bars, norm_days=10, min_days=5)
    u = [b for b in bars if ready(b)]
    days = sorted({b.day for b in u})
    print(f"MNQ 1h ETH | {len(u)} usable bars over {len(days)} trading days "
          f"({days[0]} .. {days[-1]})\n")

    print("=== VWAP stretch premise on 1h, zero cost (signal content only) ===\n")
    print(f"{'k':>4} {'confirm':>8} | {'FADE':<40} | {'CONT':<40}")
    rows = []
    for k in (1.0, 1.5, 2.0, 2.5):
        for confirm in (True, False):
            f = run(u, stretch_sig(k, "fade", confirm), cost="zero", rr=0.643, **H1)
            c = run(u, stretch_sig(k, "cont", confirm), cost="zero", rr=0.643, **H1)
            print(f"{k:4.1f} {str(confirm):>8} | "
                  f"n={f.n:4d} WR={f.wr:5.1f}% PF={f.pf:5.2f} exp={f.expectancy:+.3f}R | "
                  f"n={c.n:4d} WR={c.wr:5.1f}% PF={c.pf:5.2f} exp={c.expectancy:+.3f}R")
            rows.append((k, confirm, f, c))

    print("\n=== Null band on the SAME 1h series (what chance alone produces) ===")
    for tn in (150, 400, 900):
        lo, med, hi, hi99 = null_band(u, tn, "zero")
        print(f"  ~{tn:4d} trades: PF p05={lo:.2f} med={med:.2f} "
              f"p95={hi:.2f} p99={hi99:.2f}")

    print("\n=== Verdict per configuration (zero cost, vs its own null p95) ===")
    for k, confirm, f, c in rows:
        for name, r in (("fade", f), ("cont", c)):
            if r.n < 30:
                continue
            lo, med, hi, hi99 = null_band(u, r.n, "zero", runs=120)
            sig = "SIGNIFICANT" if r.pf > hi else "inside noise"
            print(f"  k={k:3.1f} confirm={str(confirm):<5} {name:<4} "
                  f"n={r.n:4d} PF={r.pf:5.2f} vs null p95={hi:5.2f}  -> {sig}")


if __name__ == "__main__":
    main()
