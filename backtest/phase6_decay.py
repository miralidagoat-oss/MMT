#!/usr/bin/env python3
"""Year-by-year signal content for the surviving family (zero cost isolates
predictive information from the cost/volatility regime)."""
import csv, math, statistics as st
from eth_features import Bar, add_features, add_levels, add_regime, ready
from eth_engine import run, PV, TICK, COSTS
M5=dict(cooldown=8,max_hold=47,min_bar_in_day=24)
def on_cont(m=0.0):
    def s(bars,i):
        b=bars[i]
        if not ready(b): return 0
        hi,lo,a=b.f.get("onh"),b.f.get("onl"),b.f.get("atr")
        if hi is None or lo is None or not a: return 0
        if b.c>hi+m*a: return +1
        if b.c<lo-m*a: return -1
        return 0
    return s
rows=[]
with open("data/NQ_5m_full.csv") as fh:
    for r in csv.DictReader(fh): rows.append(r)
byyear={}
for r in rows: byyear.setdefault(r["session_day"][:4],[]).append(r)
c=COSTS["moderate"]; cost_usd=2*c["comm"]+2*c["slip_ticks"]*TICK*PV
print("ON-range CONTINUATION, rr=2.0, stop 3.0 ATR — signal content by year\n")
print(f"{'year':>6} {'split':>6} {'n':>5} {'WR%':>6} {'PFzero':>7} {'null95':>7} {'sig?':>5} | "
      f"{'ATR':>6} {'$risk':>6} {'cost%R':>7} {'PFmod':>7}")
for y in sorted(byyear):
    rs=byyear[y]
    bars=[Bar(int(r["time"]),float(r["open"]),float(r["high"]),float(r["low"]),
              float(r["close"]),float(r["volume"]),r["session_day"],
              int(r["et_minute"]),int(r["dow"])) for r in rs]
    bars.sort(key=lambda b:b.t)
    add_features(bars,atr_n=14); add_levels(bars); add_regime(bars)
    u=[b for b in bars if ready(b)]
    if len(u)<5000: continue
    rz=run(u,on_cont(),stop_atr=3.0,rr=2.0,cost="zero",**M5)
    rm=run(u,on_cont(),stop_atr=3.0,rr=2.0,cost="moderate",**M5)
    if rz.n<50: continue
    a=st.median([b.f['atr'] for b in u if b.f.get('atr')])
    risk=3.0*a*PV
    p95=1+4.26/math.sqrt(rz.n)
    yi=int(y)
    split="dev" if yi<=2020 else ("val" if yi<=2022 else "OOS")
    print(f"{y:>6} {split:>6} {rz.n:5d} {rz.wr:6.1f} {rz.pf:7.3f} {p95:7.3f} "
          f"{'YES' if rz.pf>p95 else '-':>5} | {a:6.2f} {risk:6.0f} "
          f"{100*cost_usd/risk:6.1f}% {rm.pf:7.3f}")
