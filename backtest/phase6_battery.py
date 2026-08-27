#!/usr/bin/env python3
"""Phase 6 - a-priori family battery on 2015-2020 development data.

Every configuration is fixed before running, ALL results are printed, and each
is judged against a null calibrated on this same series at the same trade
count. Bonferroni is applied over the whole battery.
"""
import csv, math, random, statistics as st, sys, time
from eth_features import (Bar, add_features, add_levels, add_regime, ready, swept)
from eth_engine import run

M5 = dict(cooldown=8, max_hold=47, min_bar_in_day=24)


def load_years(path, lo, hi):
    bars = []
    with open(path) as fh:
        for r in csv.DictReader(fh):
            y = int(r["session_day"][:4])
            if lo <= y <= hi:
                bars.append(Bar(int(r["time"]), float(r["open"]), float(r["high"]),
                                float(r["low"]), float(r["close"]), float(r["volume"]),
                                r["session_day"], int(r["et_minute"]), int(r["dow"])))
    bars.sort(key=lambda b: b.t)
    return bars


# ------------------------------- families ---------------------------------
def f_sweep(hi_k, lo_k, mode):
    def s(bars, i):
        b = bars[i]
        if not ready(b): return 0
        if swept(b, b.f.get(hi_k), +1): return -1 if mode == "fade" else +1
        if swept(b, b.f.get(lo_k), -1): return +1 if mode == "fade" else -1
        return 0
    return s

def f_range(hi_k, lo_k, mode, m):
    def s(bars, i):
        b = bars[i]
        if not ready(b): return 0
        hi, lo, a = b.f.get(hi_k), b.f.get(lo_k), b.f.get("atr")
        if hi is None or lo is None or not a: return 0
        if b.c > hi + m*a: return -1 if mode == "fade" else +1
        if b.c < lo - m*a: return +1 if mode == "fade" else -1
        return 0
    return s

def f_compress(th, lb, mode):
    def s(bars, i):
        b = bars[i]
        if not ready(b) or i < lb+1: return 0
        cp = b.f.get("compression")
        if cp is None or cp > th: return 0
        w = bars[i-lb:i]
        hi, lo = max(x.h for x in w), min(x.l for x in w)
        if b.c > hi: return +1 if mode == "cont" else -1
        if b.c < lo: return -1 if mode == "cont" else +1
        return 0
    return s

def f_pullback(mode):
    def s(bars, i):
        if i < 2: return 0
        b, p = bars[i], bars[i-1]
        if not ready(b): return 0
        t, ef = b.f.get("trend"), b.f.get("ema_f")
        if t is None or ef is None: return 0
        if t > 0 and p.c < p.f["ema_f"] and b.c > ef: return +1 if mode == "cont" else -1
        if t < 0 and p.c > p.f["ema_f"] and b.c < ef: return -1 if mode == "cont" else +1
        return 0
    return s

def f_vwap(k, mode):
    def s(bars, i):
        b = bars[i]
        if not ready(b): return 0
        d = b.f.get("dev_sig")
        if d is None: return 0
        below, above = d <= -k, d >= k
        if not (below or above): return 0
        if mode == "fade": return +1 if below else -1
        return -1 if below else +1
    return s


def rnd(p, seed):
    rng = random.Random(seed)
    def s(bars, i):
        if not ready(bars[i]): return 0
        return rng.choice((+1, -1)) if rng.random() < p else 0
    return s


def main():
    t0 = time.time()
    lo, hi = int(sys.argv[1]), int(sys.argv[2])
    bars = load_years("data/NQ_5m_full.csv", lo, hi)
    print(f"loaded {len(bars)} bars ({lo}-{hi})  [{time.time()-t0:.0f}s]")
    add_features(bars, atr_n=14)
    add_levels(bars, on_end_min=570, or_start_min=570, or_end_min=600)
    add_regime(bars)
    u = [b for b in bars if ready(b)]
    days = len({b.day for b in u})
    print(f"usable {len(u)} bars / {days} trading days  [{time.time()-t0:.0f}s]\n")

    # null curve on this series
    print("calibrating null ...", flush=True)
    curve = {}
    for rr in (0.5, 1.0, 2.0):
        pts = []
        for p in (0.002, 0.01, 0.04):
            pfs, ns = [], []
            for s in range(40):
                r = run(u, rnd(p, 4000+s), stop_atr=1.25, rr=rr, cost="zero", **M5)
                if r.n >= 20: pfs.append(min(r.pf, 10)); ns.append(r.n)
            if pfs:
                pfs.sort(); pts.append((st.mean(ns), pfs[min(len(pfs)-1, int(.95*len(pfs)))]))
        c = st.median([(p95-1)*math.sqrt(n) for n, p95 in pts])
        curve[rr] = c
        print(f"  rr={rr}: null PF p95 ≈ 1 + {c:.2f}/√n   [{time.time()-t0:.0f}s]", flush=True)

    tests = []
    for mode in ("fade", "cont"):
        tests.append((f"A1 sweep PDH/PDL {mode}", f_sweep("pdh", "pdl", mode)))
        tests.append((f"A1 sweep ONH/ONL {mode}", f_sweep("onh", "onl", mode)))
        for m in (0.0, 0.5):
            tests.append((f"B2 ON range {mode} m{m}", f_range("onh", "onl", mode, m)))
            tests.append((f"B2 OR range {mode} m{m}", f_range("orh", "orl", mode, m)))
    for mode in ("cont", "fade"):
        for th in (0.8, 0.9):
            tests.append((f"C1 compress<{th} {mode}", f_compress(th, 12, mode)))
        tests.append((f"C2 EMA pullback {mode}", f_pullback(mode)))
        for k in (1.5, 2.5):
            tests.append((f"D1 VWAP {k}σ {mode}", f_vwap(k, mode)))

    RRS = (0.5, 1.0, 2.0)
    K = len(tests)*len(RRS)
    zbon = 1 + (curve[1.0]*1.63)  # p99.9-ish scaling for Bonferroni
    print(f"\n{K} configurations ({len(tests)} signals x {len(RRS)} payoffs). "
          f"Bonferroni needs p < {0.05/K:.5f}\n")
    print(f"{'configuration':<26} {'rr':>4} {'n':>6} {'WR%':>6} {'PF':>6} {'expR':>7} "
          f"{'null95':>7}  verdict")
    hits = []
    for name, fn in tests:
        for rr in RRS:
            r = run(u, fn, stop_atr=1.25, rr=rr, cost="zero", **M5)
            if r.n < 100:
                continue
            p95 = 1 + curve[rr]/math.sqrt(r.n)
            p999 = 1 + (curve[rr]*1.63)/math.sqrt(r.n)
            v = "** SURVIVES **" if r.pf > p999 else ("nominal" if r.pf > p95 else "noise")
            if r.pf > p999: hits.append((r.pf, name, rr, r))
            print(f"{name:<26} {rr:4.1f} {r.n:6d} {r.wr:6.1f} {r.pf:6.3f} "
                  f"{r.expectancy:+7.3f} {p95:7.3f}  {v}")
    print(f"\n[{time.time()-t0:.0f}s]  SURVIVORS: {len(hits)} of {K}")
    for pf, name, rr, r in sorted(hits, reverse=True):
        print(f"  {name} rr={rr}: n={r.n} WR={r.wr:.1f}% PF={pf:.3f} exp={r.expectancy:+.3f}R")


if __name__ == "__main__":
    main()
