#!/usr/bin/env python3
"""PHASE 1 baseline: what the shipped configuration actually does on 5-minute
Nasdaq, with the full metric set, a chronological split, and a per-session
breakdown."""
import os, sys, math, statistics as st
from dataclasses import replace
sys.path.insert(0, "os.path.dirname(os.path.abspath(__file__))")
import po3_engine as E
from evaluate import CANDIDATE, TICK

SESS = [("Overnight 18:00-02:00",   0,  480),
        ("London 02:00-07:00",    480,  780),
        ("NY premkt 07:00-09:30", 780,  930),
        ("NY open 09:30-10:30",   930,  990),
        ("NY morning 10:30-12:00",990, 1080),
        ("Midday 12:00-14:00",   1080, 1200),
        ("NY pm 14:00-15:00",    1200, 1260),
        ("Power hr 15:00-16:00", 1260, 1320),
        ("Post 16:00-18:00",     1320, 1440)]

def load(d, s, tf):
    b = E.load_csv(f"/home/user/MMT/{d}/{s}_{tf}.csv")
    return b, E.build_context(b)

def run(bars, ctx, sym, p, lo=0, hi=None):
    log = []
    E.run(bars, ctx, replace(p, tick=TICK[sym], cost_ticks=4.0),
          lo, hi if hi is not None else len(bars["c"]), outcome_log=log)
    return log

def maxdd(rs):
    c = pk = w = 0.0
    for r in rs: c += r; pk = max(pk, c); w = max(w, pk - c)
    return w

def maxcl(rs):
    run = best = 0
    for r in rs:
        run = run + 1 if r < 0 else 0
        best = max(best, run)
    return best

def metrics(log, ndays):
    rs = [t["r"] for t in log]
    n = len(rs)
    if n < 5:
        return None
    w = [x for x in rs if x > 0]; l = [x for x in rs if x <= 0]
    gw = sum(w); gl = -sum(l)
    m = sum(rs)/n
    sd = st.stdev(rs) if n > 1 else 0.0
    return dict(n=n, perday=n/ndays, wr=100*len(w)/n,
                pf=gw/gl if gl else float("inf"), exp=m,
                se2=2*sd/math.sqrt(n), avgw=sum(w)/len(w) if w else 0,
                avgl=sum(l)/len(l) if l else 0, med=st.median(rs),
                dd=maxdd(rs), cl=maxcl(rs))

def show(tag, mt, wide=False):
    if mt is None:
        print(f"  {tag:<34} (too few trades)"); return
    print(f"  {tag:<34} {mt['n']:>5} {mt['perday']:>6.2f} {mt['wr']:>6.1f} "
          f"{mt['pf']:>6.2f} {mt['exp']:>+8.3f} [{mt['exp']-mt['se2']:+.3f},"
          f"{mt['exp']+mt['se2']:+.3f}] {mt['avgw']:>+6.2f} {mt['avgl']:>+6.2f} "
          f"{mt['med']:>+6.2f} {mt['dd']:>6.1f} {mt['cl']:>4}")

HDR = (f"  {'panel':<34} {'n':>5} {'n/day':>6} {'WR%':>6} {'PF':>6} {'expR':>8} "
       f"{'95% band':>17} {'avgW':>6} {'avgL':>6} {'medR':>6} {'maxDD':>6} {'maxCL':>4}")

for sym, d, tf, ndays in (("NDX","data_long","5m",1460), ("NQ","data_po3","5m",72),
                          ("NQ","data_po3","1h",876)):
    bars, ctx = load(d, sym, tf)
    n = len(bars["c"])
    log = run(bars, ctx, sym, CANDIDATE)
    print(f"\n### {sym} {tf}  ({ndays} calendar days, {n} bars) — SHIPPED CONFIG")
    print(HDR); print("  " + "-"*118)
    show("full sample", metrics(log, ndays))
    k = int(n*0.6)
    tr = run(bars, ctx, sym, CANDIDATE, 0, k)
    te = run(bars, ctx, sym, CANDIDATE, k, n)
    show("train (first 60%)", metrics(tr, ndays*0.6))
    show("TEST (last 40%, untouched)", metrics(te, ndays*0.4))
    show("longs only",  metrics([t for t in log if t["dir"] == 1], ndays))
    show("shorts only", metrics([t for t in log if t["dir"] == -1], ndays))

    _, mspos, _ = E.calendar(bars)
    print(f"\n  by session (full sample):")
    print(HDR); print("  " + "-"*118)
    for name, a, b in SESS:
        sub = [t for t in log if a <= mspos[t["bar"]] < b]
        show(name, metrics(sub, ndays))
