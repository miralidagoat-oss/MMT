#!/usr/bin/env python3
"""How large an improvement is even DETECTABLE on the NQ 5m sample we have?
This bounds what Phase 2 can prove, independently of any idea's merit."""
import math, os, sys, statistics as st
from dataclasses import replace
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E
from evaluate import CANDIDATE

TICK_NQ = 0.25
b = E.load_csv("data_nq/NQ_5m.csv"); ctx = E.build_context(b)
log = []
E.run(b, ctx, replace(CANDIDATE, tick=TICK_NQ, cost_ticks=4.0), outcome_log=log)
rs = [t["r"] for t in log]
n, sd = len(rs), st.stdev(rs)
_, mspos, _ = E.calendar(b)
import datetime
from zoneinfo import ZoneInfo
days = len({datetime.datetime.fromtimestamp(t, ZoneInfo("America/New_York")).date()
            for t in b["t"]})

print(f"NQ 5m, front-month continuous, {days} trading days")
print(f"  trades {n}   per-trade sd {sd:.2f}R   mean {sum(rs)/n:+.3f}R")
print(f"  standard error {sd/math.sqrt(n):.3f}R   95% half-width {2*sd/math.sqrt(n):.3f}R\n")

# detectable effect at 95% confidence / 80% power ~= 2.8 * SE
print("Smallest improvement DETECTABLE at 95% confidence, 80% power:")
for k, label in ((n, f"current sample ({n} trades, {days} days)"),
                 (500, "500 trades"), (1000, "1,000 trades"), (2000, "2,000 trades")):
    mde = 2.8 * sd / math.sqrt(k)
    est_days = k / (n / days)
    print(f"  {label:<38} {mde:+.3f}R   (~{est_days:.0f} trading days at this rate)")

print("\nTrades needed to detect a given true improvement:")
for eff in (0.05, 0.10, 0.15, 0.20, 0.30):
    need = (2.8 * sd / eff) ** 2
    print(f"  detect {eff:+.2f}R  ->  {need:>7.0f} trades  ~{need/(n/days):>6.0f} trading days"
          f"  ~{need/(n/days)/252:>4.1f} years")

print("\nFrequency reality against the 2-3 per session objective:")
SESS = [("Overnight 18:00-02:00",0,480),("London 02:00-07:00",480,780),
        ("NY premkt 07:00-09:30",780,930),("NY open 09:30-10:30",930,990),
        ("NY morning 10:30-12:00",990,1080),("Midday 12:00-14:00",1080,1200),
        ("NY pm 14:00-15:00",1200,1260),("Power hr 15:00-16:00",1260,1320)]
for name,a,z in SESS:
    c = sum(1 for t in log if a <= mspos[t["bar"]] < z)
    print(f"  {name:<26} {c:>4} trades over {days} days = {c/days:>5.2f} per session-day")
print(f"  {'ALL HOURS':<26} {n:>4} trades over {days} days = {n/days:>5.2f} per day")
