#!/usr/bin/env python3
"""Minimum detectable effect for the NQ 5m sample, under three dependence
assumptions. The earlier +0.380R figure assumed trade-level independence; this
script tests whether that assumption survives contact with the data."""
import datetime, math, os, random, statistics as st, sys
from dataclasses import replace
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import po3_engine as E
from evaluate import CANDIDATE

ET = ZoneInfo("America/New_York")
ALPHA, POWER = 0.05, 0.80
Z_A, Z_P = 1.959964, 0.841621      # two-sided alpha, one-sided power
K = Z_A + Z_P                       # 2.802

bars = E.load_csv("data_nq/NQ_5m.csv"); ctx = E.build_context(bars)
log = []
E.run(bars, ctx, replace(CANDIDATE, tick=0.25, cost_ticks=4.0), outcome_log=log)
t = bars["t"]

def trade_day(ts):
    """CME trade day: rolls at 18:00 ET, so shift back 6h and take the date."""
    return (datetime.datetime.fromtimestamp(ts, ET) - datetime.timedelta(hours=18)).date()

rows = [(trade_day(t[x["bar"]]), x["r"], x["dir"], x["bar"], x["exit_bar"]) for x in log]
rs = [r for _, r, _, _, _ in rows]
n = len(rs); mean = sum(rs)/n; sd = st.stdev(rs)

byday = {}
for d, r, *_ in rows: byday.setdefault(d, []).append(r)
G = len(byday); sizes = [len(v) for v in byday.values()]
mbar = n / G

print("="*74); print("NQ 5m MDE — inputs"); print("="*74)
print(f"  trades n                       {n}")
print(f"  independent trading days G     {G}")
print(f"  trades per day: mean {mbar:.2f}  median {st.median(sizes)}  max {max(sizes)}")
print(f"  mean R/trade                   {mean:+.4f}")
print(f"  sd  R/trade                    {sd:.4f}")
print(f"  alpha {ALPHA} two-sided, power {POWER} one-sided  ->  k = {K:.3f}")

# ---- serial / structural dependence diagnostics -------------------------
lag1 = (sum((rs[i]-mean)*(rs[i-1]-mean) for i in range(1, n)) /
        sum((x-mean)**2 for x in rs))
ov = 0
for i in range(n):
    a1, b1 = rows[i][3], rows[i][4]
    if any(not (b1 < rows[j][3] or rows[j][4] < a1) for j in range(n) if j != i):
        ov += 1
dl = {d: sum(r for r in v) for d, v in byday.items()}
longd, shortd = {}, {}
for d, r, dr, *_ in rows:
    (longd if dr == 1 else shortd).setdefault(d, []).append(r)
both = sorted(set(longd) & set(shortd))
if len(both) > 3:
    lv = [sum(longd[d]) for d in both]; sv = [sum(shortd[d]) for d in both]
    lm, sm = sum(lv)/len(lv), sum(sv)/len(sv)
    num = sum((a-lm)*(b-sm) for a, b in zip(lv, sv))
    den = math.sqrt(sum((a-lm)**2 for a in lv)*sum((b-sm)**2 for b in sv))
    ls_corr = num/den if den else 0.0
else:
    ls_corr = float("nan")
print(f"\n  lag-1 autocorrelation of R     {lag1:+.4f}")
print(f"  trades overlapping another     {ov}/{n} = {100*ov/n:.0f}%")
print(f"  corr(daily long R, daily short R) over {len(both)} days  {ls_corr:+.3f}")

# ---- ICC via one-way ANOVA ---------------------------------------------
msb = sum(len(v)*(sum(v)/len(v) - mean)**2 for v in byday.values())/(G-1)
msw = sum(sum((r - sum(v)/len(v))**2 for r in v) for v in byday.values())/(n-G)
m0 = (n - sum(s*s for s in sizes)/n)/(G-1)
icc = (msb-msw)/(msb+(m0-1)*msw) if (msb+(m0-1)*msw) else 0.0
deff = 1 + (mbar-1)*max(icc, 0.0)
print(f"\n  MSB {msb:.4f}   MSW {msw:.4f}   m0 {m0:.3f}")
print(f"  intracluster correlation ICC   {icc:+.4f}")
print(f"  design effect 1+(m-1)*ICC      {deff:.3f}")
print(f"  effective sample size n/deff   {n/deff:.0f}")

# ---- three SE estimates -------------------------------------------------
se_naive = sd/math.sqrt(n)
v_cr0 = sum((sum(r-mean for r in v))**2 for v in byday.values())/(n*n)
se_cr1 = math.sqrt(v_cr0*(G/(G-1)))
se_deff = se_naive*math.sqrt(deff)
# day-level: treat each day's total R as one observation, expressed per trade
dvals = [sum(v) for v in byday.values()]
se_day_total = st.stdev(dvals)/math.sqrt(G)
se_day_pertrade = se_day_total/mbar

random.seed(7)
boot = []
days = list(byday.values())
for _ in range(20000):
    s = [random.choice(days) for _ in range(G)]
    flat = [r for g in s for r in g]
    boot.append(sum(flat)/len(flat))
boot.sort()
b_lo, b_hi = boot[int(.025*len(boot))], boot[int(.975*len(boot))]
se_boot = st.stdev(boot)

print("\n" + "="*74); print("SE and MDE under each dependence assumption"); print("="*74)
print(f"  {'method':<42} {'SE':>8} {'95% half':>10} {'MDE':>8}")
for lbl, se in (("A. naive trade-level independence", se_naive),
                ("B. day-clustered robust (CR1)", se_cr1),
                ("B2. design-effect (ICC) correction", se_deff),
                ("B3. day-total, expressed per trade", se_day_pertrade),
                ("C. block bootstrap by trading day", se_boot)):
    print(f"  {lbl:<42} {se:>8.4f} {1.96*se:>10.4f} {K*se:>8.3f}")
print(f"\n  bootstrap 95% CI on mean R/trade: [{b_lo:+.3f}, {b_hi:+.3f}]  (point {mean:+.3f})")

# ---- what sample would be needed, in DAYS (the independent unit) --------
se_use = max(se_cr1, se_boot)
sd_eff = se_use*math.sqrt(n)          # per-trade sd inflated for clustering
print("\n" + "="*74)
print("Required sample, using the CONSERVATIVE clustered SE, in trading days")
print("(days are the independent unit; trades/day held at the observed rate)")
print("="*74)
for eff in (0.10, 0.15, 0.20, 0.30, 0.40):
    need_n = (K*sd_eff/eff)**2
    need_days = need_n/mbar
    print(f"  detect {eff:+.2f}R  ->  {need_n:>7.0f} trades   {need_days:>6.0f} trading days"
          f"   ~{need_days/252:>5.1f} years")
rel = 1/math.sqrt(2*(n-1))          # relative SE of a sd estimate
mde_pt = K*se_use
print("\n" + "="*74); print("Precision of the MDE estimate itself"); print("="*74)
print(f"  sd is estimated from n={n}, so it carries ~{100*rel:.1f}% relative error.")
print(f"  MDE = {mde_pt:.2f}R +/- {mde_pt*rel:.2f}R  ->  quote as {mde_pt:.2f}R, not 3 d.p.")
print(f"  Day counts likewise: 'detect +0.10R' needs {(K*sd_eff/0.10)**2/mbar:.0f} days")
print(f"  +/- ~{(K*sd_eff/0.10)**2/mbar*2*rel:.0f}, i.e. roughly 2 years, not '2.2 years'.")
