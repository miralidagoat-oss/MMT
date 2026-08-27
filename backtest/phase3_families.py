#!/usr/bin/env python3
"""Phase 3 - premise tests for strategy families A, B2, C1, C2 on MNQ 1h.

Design against data mining:
  * every configuration is fixed a priori and ALL results are printed - nothing
    is selected after the fact;
  * each result is judged against a null distribution calibrated on the SAME
    series at the SAME trade count;
  * a Bonferroni threshold for the whole battery is applied, because running K
    tests at p<0.05 yields 0.05K false positives by construction.
"""
import random
import sys
from eth_features import (load_bars, add_features, add_levels, add_regime,
                          ready, swept)
from eth_engine import run

H1 = dict(cooldown=2, max_hold=8, min_bar_in_day=4)
M5 = dict(cooldown=12, max_hold=48, min_bar_in_day=24)
# Bar alignment differs by timeframe, so the level windows must too (see add_levels).
LEVELS = {"1h": dict(on_end_min=540, or_start_min=540, or_end_min=660),
          "5m": dict(on_end_min=570, or_start_min=570, or_end_min=600)}
RR = 0.643


# ----------------------------- null calibration ----------------------------
def rand_sig(p, seed):
    rng = random.Random(seed)
    def sig(bars, i):
        if not ready(bars[i]):
            return 0
        return rng.choice((+1, -1)) if rng.random() < p else 0
    return sig


def build_null_curve(u, runs=150):
    """PF percentiles as a function of trade count, on the real series."""
    curve = []
    for p in (0.0015, 0.004, 0.01, 0.025, 0.06):
        pfs, ns = [], []
        for s in range(runs):
            r = run(u, rand_sig(p, 55_000 + s), cost="zero", rr=RR, **H1)
            if r.n >= 5:
                pfs.append(min(r.pf, 10)); ns.append(r.n)
        if not pfs:
            continue
        pfs.sort()
        q = lambda x: pfs[min(len(pfs) - 1, int(x * len(pfs)))]
        curve.append((sum(ns) / len(ns), q(.95), q(.99), q(.999)))
    curve.sort()
    return curve


def null_at(curve, n):
    """Interpolate the null p95/p99/p999 for a given trade count."""
    if n <= curve[0][0]:
        return curve[0][1:]
    if n >= curve[-1][0]:
        return curve[-1][1:]
    for (n0, a0, b0, c0), (n1, a1, b1, c1) in zip(curve, curve[1:]):
        if n0 <= n <= n1:
            w = (n - n0) / (n1 - n0)
            return (a0 + w * (a1 - a0), b0 + w * (b1 - b0), c0 + w * (c1 - c0))
    return curve[-1][1:]


# --------------------------------- families --------------------------------
def fam_sweep(level_hi, level_lo, mode):
    """A1: wick takes out a liquidity level, bar closes back inside."""
    def sig(bars, i):
        b = bars[i]
        if not ready(b):
            return 0
        hi, lo = b.f.get(level_hi), b.f.get(level_lo)
        if swept(b, hi, +1):
            return -1 if mode == "fade" else +1
        if swept(b, lo, -1):
            return +1 if mode == "fade" else -1
        return 0
    return sig


def fam_range(level_hi, level_lo, mode, margin_atr):
    """B2: price pushes beyond a frozen range edge by `margin_atr`."""
    def sig(bars, i):
        b = bars[i]
        if not ready(b):
            return 0
        hi, lo, atr = b.f.get(level_hi), b.f.get(level_lo), b.f.get("atr")
        if hi is None or lo is None or not atr:
            return 0
        if b.c > hi + margin_atr * atr:
            return -1 if mode == "fade" else +1
        if b.c < lo - margin_atr * atr:
            return +1 if mode == "fade" else -1
        return 0
    return sig


def fam_compress(thresh, lookback, mode):
    """C1: squeeze, then a break of the recent range."""
    def sig(bars, i):
        b = bars[i]
        if not ready(b) or i < lookback + 1:
            return 0
        comp = b.f.get("compression")
        if comp is None or comp > thresh:
            return 0
        w = bars[i - lookback:i]
        hi, lo = max(x.h for x in w), min(x.l for x in w)
        if b.c > hi:
            return +1 if mode == "cont" else -1
        if b.c < lo:
            return -1 if mode == "cont" else +1
        return 0
    return sig


def fam_pullback(mode):
    """C2: EMA-aligned pullback that closes back in the trend direction."""
    def sig(bars, i):
        b, p = bars[i], bars[i - 1]
        if not ready(b) or i < 2:
            return 0
        t = b.f.get("trend")
        ef = b.f.get("ema_f")
        if t is None or ef is None:
            return 0
        if t > 0 and p.c < p.f["ema_f"] and b.c > ef:
            return +1 if mode == "cont" else -1
        if t < 0 and p.c > p.f["ema_f"] and b.c < ef:
            return -1 if mode == "cont" else +1
        return 0
    return sig


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "data/MNQ_1h.csv"
    tf = sys.argv[2] if len(sys.argv) > 2 else "1h"
    global H1
    H1 = M5 if tf == "5m" else H1
    bars = load_bars(path)
    add_features(bars); add_levels(bars, **LEVELS[tf]); add_regime(bars)
    u = [b for b in bars if ready(b)]
    days = sorted({b.day for b in u})
    print(f"{path} | {len(u)} usable bars / {len(days)} trading days\n")
    print("Calibrating null on the real series ...")
    curve = build_null_curve(u)
    print("  null PF p95 by trade count: " +
          "  ".join(f"n~{int(n)}:{a:.2f}" for n, a, _, _ in curve))

    tests = []
    for mode in ("fade", "cont"):
        tests.append((f"A1 sweep PDH/PDL {mode}", fam_sweep("pdh", "pdl", mode)))
        tests.append((f"A1 sweep ONH/ONL {mode}", fam_sweep("onh", "onl", mode)))
    for mode in ("fade", "cont"):
        for m in (0.0, 0.5):
            tests.append((f"B2 ON range {mode} m={m}", fam_range("onh", "onl", mode, m)))
            tests.append((f"B2 OR range {mode} m={m}", fam_range("orh", "orl", mode, m)))
    for mode in ("cont", "fade"):
        for th in (0.8, 0.9):
            tests.append((f"C1 compress<{th} {mode}", fam_compress(th, 12, mode)))
    for mode in ("cont", "fade"):
        tests.append((f"C2 EMA pullback {mode}", fam_pullback(mode)))

    K = len(tests)
    print(f"\n=== {K} a-priori configurations, zero cost (signal content only) ===")
    print(f"Bonferroni: with K={K}, a genuine claim needs p < 0.05/{K} = {0.05/K:.4f},")
    print("i.e. the PF must clear roughly the null p99.9 column, not p95.\n")
    print(f"{'configuration':<28} {'n':>5} {'WR%':>6} {'PF':>6} {'expR':>7} | "
          f"{'p95':>5} {'p99':>5} {'p99.9':>6} | verdict")
    hits = []
    for name, fn in tests:
        r = run(u, fn, cost="zero", rr=RR, **H1)
        if r.n < 25:
            print(f"{name:<28} {r.n:5d} {'':>6} {'':>6} {'':>7} |"
                  f" {'':>5} {'':>5} {'':>6} | too few trades - not evaluable")
            continue
        p95, p99, p999 = null_at(curve, r.n)
        if r.pf > p999:
            v = "SURVIVES Bonferroni"; hits.append((name, r))
        elif r.pf > p95:
            v = "nominal only (dies under K)"
        else:
            v = "inside noise"
        print(f"{name:<28} {r.n:5d} {r.wr:6.1f} {r.pf:6.2f} {r.expectancy:+7.3f} | "
              f"{p95:5.2f} {p99:5.2f} {p999:6.2f} | {v}")

    print(f"\n=== SUMMARY: {len(hits)} of {K} configurations survive multiple testing ===")
    for name, r in hits:
        print(f"  {name}: n={r.n} WR={r.wr:.1f}% PF={r.pf:.2f} exp={r.expectancy:+.3f}R")
    if not hits:
        print("  none.")


if __name__ == "__main__":
    main()
