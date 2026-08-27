#!/usr/bin/env python3
"""Do the Phase 6 survivors survive COSTS? Development split only."""
import csv, math, statistics as st, sys
from eth_features import Bar, add_features, add_levels, add_regime, ready
from eth_engine import run, PV, TICK, COSTS
M5=dict(cooldown=8,max_hold=47,min_bar_in_day=24)

def load_years(path, lo, hi):
    bars=[]
    with open(path) as fh:
        for r in csv.DictReader(fh):
            y=int(r["session_day"][:4])
            if lo<=y<=hi:
                bars.append(Bar(int(r["time"]),float(r["open"]),float(r["high"]),
                                float(r["low"]),float(r["close"]),float(r["volume"]),
                                r["session_day"],int(r["et_minute"]),int(r["dow"])))
    bars.sort(key=lambda b:b.t); return bars

def on_cont(m):
    def s(bars,i):
        b=bars[i]
        if not ready(b): return 0
        hi,lo,a=b.f.get("onh"),b.f.get("onl"),b.f.get("atr")
        if hi is None or lo is None or not a: return 0
        if b.c>hi+m*a: return +1
        if b.c<lo-m*a: return -1
        return 0
    return s

lo,hi=int(sys.argv[1]),int(sys.argv[2])
bars=load_years("data/NQ_5m_full.csv",lo,hi)
add_features(bars,atr_n=14); add_levels(bars); add_regime(bars)
u=[b for b in bars if ready(b)]
days=len({b.day for b in u})
print(f"{lo}-{hi}: {len(u)} bars / {days} days\n")
print("SURVIVOR: overnight-range CONTINUATION at 2:1 payoff.")
print("Note this is the OPPOSITE structure to the 0.393 target that was tuned earlier.\n")
medatr=st.median([b.f['atr'] for b in u if b.f.get('atr')])
print(f"median ATR(14) on this split = {medatr:.2f} pts\n")
print(f"{'stopATR':>8} {'stop pts':>9} {'MNQ $risk':>10} {'cost%R':>8} | "
      f"{'n':>6} {'WR%':>6} {'PF zero':>8} {'PF mod':>8} {'expR mod':>9} {'null95':>7}")
c=COSTS["moderate"]; cost_usd=2*c["comm"]+2*c["slip_ticks"]*TICK*PV
for sa in (1.25,2.0,3.0,4.0,5.0):
    rz=run(u,on_cont(0.0),stop_atr=sa,rr=2.0,cost="zero",**M5)
    rm=run(u,on_cont(0.0),stop_atr=sa,rr=2.0,cost="moderate",**M5)
    stop_pts=sa*medatr; risk=stop_pts*PV
    p95=1+4.26/math.sqrt(max(rm.n,1))
    print(f"{sa:8.2f} {stop_pts:9.1f} {risk:10.0f} {100*cost_usd/risk:7.1f}% | "
          f"{rm.n:6d} {rm.wr:6.1f} {rz.pf:8.3f} {rm.pf:8.3f} {rm.expectancy:+9.3f} {p95:7.3f}")
print("\n(null95 is the chance threshold at that trade count; PF must beat it)")
