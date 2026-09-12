#!/usr/bin/env python3
"""PHASE 1 ablation: strip one component at a time from the shipped config."""
import os, sys, math, statistics as st
from dataclasses import replace
sys.path.insert(0, "/home/user/MMT/backtest")
import po3_engine as E
from evaluate import CANDIDATE, TICK
NAMED = ("pdh","pdl","pwh","pwl","asiah","asial","lonh","lonl","ibh","ibl")
PIVOT = ("pivot",)

CASES = [
    ("FULL (as shipped)",                 {}),
    ("- PO3 gate",                        dict(po3_mode="off")),
    ("+ PO3 strict (reclaim open too)",   dict(po3_mode="reclaim_open")),
    ("- min sweep depth (0 ATR)",         dict(min_sweep_atr=0.0)),
    ("- close-direction requirement",     dict(require_close_dir=False)),
    ("- cooldown (0 bars)",               dict(cooldown=0)),
    ("- fractal pivots (named only)",     dict(pools=NAMED)),
    ("- named levels (pivots only)",      dict(pools=PIVOT)),
    ("- reclaim window (same bar only)",  dict(reclaim_bars=0)),
    ("+ VWAP stretch gate ON (2 sigma)",  dict(use_vwap=True, dev_entry=2.0)),
    ("+ VWAP reclaim filter ON",          dict(vwap_reclaim=True)),
    ("+ volume filter ON (1.2x)",         dict(vol_mult=1.2)),
    ("+ RTH only",                        dict(session="rth")),
    ("- breakeven management",            dict(be_at_r=0.0)),
]

def stats(rs):
    n=len(rs)
    if n<5: return None
    m=sum(rs)/n; sd=st.stdev(rs) if n>1 else 0
    gw=sum(x for x in rs if x>0); gl=-sum(x for x in rs if x<0)
    w=sum(1 for x in rs if x>0)
    return n,100*w/n,(gw/gl if gl else 0),m,2*sd/math.sqrt(n),sum(rs)

for sym,d,tf,days in (("NDX","data_long","5m",1460),("NQ","data_po3","1h",876)):
    b=E.load_csv(f"/home/user/MMT/{d}/{sym}_{tf}.csv"); ctx=E.build_context(b)
    print(f"\n### {sym} {tf} ablation  ({days} days)")
    print(f"  {'variant':<34} {'n':>5} {'n/day':>6} {'WR%':>6} {'PF':>6} {'expR':>8} "
          f"{'95% band':>17} {'netR':>8}  {'vs full':>8}")
    print("  "+"-"*110)
    base=None
    for name,kw in CASES:
        log=[]
        E.run(b,ctx,replace(CANDIDATE,tick=TICK[sym],cost_ticks=4.0,**kw),
              outcome_log=log)
        s=stats([t["r"] for t in log])
        if s is None:
            print(f"  {name:<34} (too few)"); continue
        n,wr,pf,m,se,net=s
        if base is None: base=m
        print(f"  {name:<34} {n:>5} {n/days:>6.2f} {wr:>6.1f} {pf:>6.2f} {m:>+8.3f} "
              f"[{m-se:+.3f},{m+se:+.3f}] {net:>+8.1f}  {m-base:>+8.3f}")
