#!/usr/bin/env python3
import os, sys, math, re, statistics as st
from dataclasses import replace
sys.path.insert(0,"/home/user/MMT/backtest")
import po3_engine as E
from evaluate import CANDIDATE, TICK

# 1. intrabar stop/target ambiguity on 5m (the emulator-vs-engine gap)
for sym,d in (("NDX","data_long"),("NQ","data_po3")):
    b=E.load_csv(f"/home/user/MMT/{d}/{sym}_5m.csv"); ctx=E.build_context(b)
    log=[]; E.run(b,ctx,replace(CANDIDATE,tick=TICK[sym],cost_ticks=4.0),outcome_log=log)
    o,h,l,c=b["o"],b["h"],b["l"],b["c"]; n=len(c); amb=0
    for t in log:
        bull=t["dir"]==1; e,rk=t["entry"],t["risk"]
        stop=e-rk if bull else e+rk; tp=e+3*rk if bull else e-3*rk; be=False
        for i in range(t["bar"]+1,min(t["exit_bar"],n-1)+1):
            sh=l[i]<=stop if bull else h[i]>=stop
            th=h[i]>=tp   if bull else l[i]<=tp
            if sh and th: amb+=1; break
            if sh or th: break
            if not be:
                lv=e+(1 if bull else -1)*1.5*rk
                if (h[i]>=lv) if bull else (l[i]<=lv):
                    be=True; mv=e+(1 if bull else -1)*-0.30*rk
                    stop=max(stop,mv) if bull else min(stop,mv)
    print(f"intrabar stop+target same bar, {sym} 5m: {amb}/{len(log)} = {100*amb/len(log):.2f}%")

# 2. how much of the shipped script is inert under its own preset
src=open("/home/user/MMT/indicators/arashi_strategy.pine",encoding="utf-8").read()
inert={"vwapGate":"false","vwapReclaim":"false","volMult":"0.0","maxRiskAtr":"0.0",
       "minTargetPts":"0.0","maxSweepAtr":"0.0","eqOnly":"false",
       "sessMode":'"All hours"'}
print("\nInputs the shipped preset pins to a no-op (the code path never fires):")
for k,v in inert.items():
    m=re.search(r"^\w+\s+"+k+r"\s*=.*$",src,re.M)
    print(f"  {k:<14} -> {v:<12} | {m.group().strip()[:72] if m else '?'}")

# 3. the frequency frontier: can filters be loosened into 2-3 trades/session?
print("\nFrequency vs expectancy, NDX 5m (1460 days). RTH = 09:30-16:00 ET only.")
print(f"  {'configuration':<40} {'n':>6} {'n/day':>6} {'RTH n/day':>10} {'expR':>8} {'95% band':>17}")
b=E.load_csv("/home/user/MMT/data_long/NDX_5m.csv"); ctx=E.build_context(b)
_,mspos,_=E.calendar(b)
VAR=[("shipped",{}),
     ("PO3 off",dict(po3_mode="off")),
     ("PO3 off + sweep 0",dict(po3_mode="off",min_sweep_atr=0.0)),
     ("PO3 off + sweep 0 + no closedir",dict(po3_mode="off",min_sweep_atr=0.0,require_close_dir=False)),
     ("...+ cooldown 0",dict(po3_mode="off",min_sweep_atr=0.0,require_close_dir=False,cooldown=0)),
     ("...+ reclaim window 5",dict(po3_mode="off",min_sweep_atr=0.0,require_close_dir=False,cooldown=0,reclaim_bars=5))]
for name,kw in VAR:
    log=[]; E.run(b,ctx,replace(CANDIDATE,tick=TICK["NDX"],cost_ticks=4.0,**kw),outcome_log=log)
    rs=[t["r"] for t in log]; n=len(rs)
    rth=sum(1 for t in log if 930<=mspos[t["bar"]]<1320)
    m=sum(rs)/n; se=2*st.stdev(rs)/math.sqrt(n)
    print(f"  {name:<40} {n:>6} {n/1460:>6.2f} {rth/1460:>10.2f} {m:>+8.3f} [{m-se:+.3f},{m+se:+.3f}]")
