#!/usr/bin/env python3
"""Adversarial test of the single best-looking Phase 3 candidate.

"B2 overnight-range continuation" showed 67.3% WR / PF 1.40 on the 5m series at
zero cost - the most attractive number in the whole battery, and exactly the
shape a careless study would headline. This script tries to destroy it.
"""
import sys
from eth_features import (load_bars, add_features, add_levels, add_regime, ready)
from eth_engine import run

M5 = dict(cooldown=12, max_hold=48, min_bar_in_day=24)
H1 = dict(cooldown=2, max_hold=8, min_bar_in_day=4)
LV5 = dict(on_end_min=570, or_start_min=570, or_end_min=600)
LV1 = dict(on_end_min=540, or_start_min=540, or_end_min=660)


def on_break_cont(margin):
    def sig(bars, i):
        b = bars[i]
        if not ready(b):
            return 0
        hi, lo, atr = b.f.get("onh"), b.f.get("onl"), b.f.get("atr")
        if hi is None or lo is None or not atr:
            return 0
        if b.c > hi + margin * atr:
            return +1
        if b.c < lo - margin * atr:
            return -1
        return 0
    return sig


def prep(path, lv):
    bars = load_bars(path)
    add_features(bars); add_levels(bars, **lv); add_regime(bars)
    return [b for b in bars if ready(b)]


def main():
    u5 = prep("data/MNQ_5m.csv", LV5)
    u1 = prep("data/MNQ_1h.csv", LV1)

    print("=== TEST 1: does it survive realistic costs? (5m, m=0.0) ===")
    for c in ("zero", "base", "moderate", "harsh"):
        r = run(u5, on_break_cont(0.0), cost=c, rr=0.643, **M5)
        print(f"  {r.summary(c)}")

    print("\n=== TEST 2: does the SAME rule hold on 1h, 612 days? ===")
    print("  (if the premise is real it should not flip sign across timeframes)")
    for c in ("zero", "moderate"):
        r = run(u1, on_break_cont(0.0), cost=c, rr=0.643, **H1)
        print(f"  1h {r.summary(c)}")

    print("\n=== TEST 3: screen / holdout on 5m (34d / 17d), moderate cost ===")
    days = sorted({b.day for b in u5})
    cut = days[int(len(days) * 0.667)]
    scr = [b for b in u5 if b.day < cut]
    hld = [b for b in u5 if b.day >= cut]
    for nm, seg in (("screen", scr), ("holdout", hld)):
        r = run(seg, on_break_cont(0.0), cost="moderate", rr=0.643, **M5)
        print(f"  {r.summary(nm)}")

    print("\n=== TEST 4: profit concentration (5m, zero cost - its best case) ===")
    r = run(u5, on_break_cont(0.0), cost="zero", rr=0.643, **M5)
    rs = sorted((t.r for t in r.trades), reverse=True)
    for k in (0, 3, 5, 10):
        kept = rs[k:]
        g = sum(x for x in kept if x > 0); b = -sum(x for x in kept if x <= 0)
        pf = g / b if b > 0 else float("inf")
        print(f"  remove top {k:2d} trades -> n={len(kept):3d} PF={pf:5.2f} "
              f"net={sum(kept):+6.1f}R")

    print("\n=== TEST 5: time-of-day concentration (5m, zero cost) ===")
    buckets = {}
    for t in r.trades:
        h = t.etm // 60
        buckets.setdefault(h, []).append(t.r)
    print(f"  {'ET':>3} {'n':>4} {'netR':>7} {'WR%':>6}")
    for h in sorted(buckets):
        v = buckets[h]
        wr = 100 * sum(1 for x in v if x > 0) / len(v)
        print(f"  {h:02d} {len(v):4d} {sum(v):+7.1f} {wr:6.1f}")
    tot = sum(t.r for t in r.trades)
    top = max(buckets.items(), key=lambda kv: sum(kv[1]))
    print(f"  -> total {tot:+.1f}R; single best hour {top[0]:02d} ET contributes "
          f"{sum(top[1]):+.1f}R ({100*sum(top[1])/tot if tot else 0:.0f}% of all profit)")


if __name__ == "__main__":
    main()
