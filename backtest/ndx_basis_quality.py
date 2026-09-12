#!/usr/bin/env python3
"""Acceptance gate for the Dukascopy NDX basis (PROTOCOL v1.3 §12).

Runs BEFORE any hypothesis touches this data. Every check below can fail the
basis; a failure prints FAIL and the script exits non-zero, because a basis
accepted on trust is a result built on trust.

The checks exist because of specific ways this feed can be wrong:
  * truncated sessions - 2015-2017 returns ~14h/day, which would silently
    corrupt every Asia-session and overnight liquidity-pool feature while
    looking like ordinary data;
  * empty weekdays - a missing day is invisible once bars are concatenated;
  * broker volume - usable as a VWAP weight only if it carries real intraday
    structure rather than a constant or a counter;
  * intrabar sequencing - the 88% emulator accuracy in the research history was
    measured on NQ. It is not transferable. It is re-derived here.
"""
import collections
import csv
import datetime as dt
import os
import statistics
import sys
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
D = sys.argv[1] if len(sys.argv) > 1 else "data_ndx"
TAG = sys.argv[2] if len(sys.argv) > 2 else "NDX"
FAILS = []


def ok(cond, msg):
    print(("  PASS  " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


def load(name):
    with open(os.path.join(D, name)) as f:
        r = csv.reader(f)
        next(r)
        return [(int(x[0]), float(x[1]), float(x[2]), float(x[3]),
                 float(x[4]), float(x[5])) for x in r]


def trade_day(ts):
    """CME trade day: 18:00 ET rolls to the next day."""
    return (dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(ET)
            + dt.timedelta(hours=6)).date()


# ── 1. structural integrity ────────────────────────────────────────────────
print(f"1. Structural integrity - {D}/{TAG}_5m.csv")
rows = load(f"{TAG}_5m.csv")
ts = [r[0] for r in rows]
ok(len(ts) == len(set(ts)), f"no duplicate timestamps ({len(ts):,} bars)")
ok(all(ts[i] > ts[i - 1] for i in range(1, len(ts))), "strictly increasing")
bad = [r for r in rows if not (r[3] <= r[1] <= r[2] and r[3] <= r[4] <= r[2])]
ok(not bad, f"OHLC self-consistent ({len(bad)} violations)")
ok(all(r[5] >= 0 for r in rows), "no negative volume")

# ── 2. session coverage per year - the check that excludes 2015-2017 ───────
print("\n2. Session coverage by year (hours of the ET day seen)")
per_year = collections.defaultdict(set)
per_day = collections.Counter()
for r in rows:
    t = dt.datetime.fromtimestamp(r[0], dt.timezone.utc).astimezone(ET)
    per_year[t.year].add(t.hour)
    per_day[trade_day(r[0])] += 1
for y in sorted(per_year):
    h = len(per_year[y])
    flag = "" if h >= 22 else "   <-- TRUNCATED"
    print(f"   {y}  {h:2d}/23 ET hours present{flag}")
ok(all(len(v) >= 22 for v in per_year.values()),
   "every year carries a full ~23h session (truncated years excluded)")

# ── 3. per-trade-day bar counts ────────────────────────────────────────────
print("\n3. Bars per CME trade day")
counts = sorted(per_day.values())
full = 23 * 12                       # 23h of 5-minute bars
med = statistics.median(counts)
thin = [d for d, n in per_day.items() if n < 0.5 * med]
print(f"   trade days   {len(per_day):,}")
print(f"   median bars  {med:.0f} / {full} theoretical")
print(f"   thin days    {len(thin)} below half the median")
ok(med >= 0.8 * full, f"median day is near-complete ({med:.0f}/{full})")
ok(len(thin) / len(per_day) < 0.05,
   f"thin days are rare ({100*len(thin)/len(per_day):.1f}% < 5%)")

# ── 4. calendar gaps that are neither weekend nor maintenance halt ─────────
print("\n4. Unexplained gaps")
other = []
for i in range(1, len(ts)):
    d = ts[i] - ts[i - 1]
    if d <= 300:
        continue
    a = dt.datetime.fromtimestamp(ts[i - 1], dt.timezone.utc).astimezone(ET)
    b = dt.datetime.fromtimestamp(ts[i], dt.timezone.utc).astimezone(ET)
    if a.weekday() == 4 or b.weekday() == 0:        # weekend
        continue
    if a.hour == 16 or (a.hour == 17 or b.hour == 18):  # maintenance halt
        continue
    if d <= 86400 * 1.5 and (b.date() - a.date()).days <= 1 and d < 3600 * 4:
        continue                                     # short intraday hole
    other.append((a.isoformat(timespec="minutes"),
                  b.isoformat(timespec="minutes"), d / 3600))
print(f"   gaps not explained by weekend or the 17:00 ET halt: {len(other)}")
for g in other[:8]:
    print(f"     {g[0]} -> {g[1]}   {g[2]:.1f}h")
ok(len(other) < 60, f"unexplained gaps are few ({len(other)}; holidays expected)")

# ── 5. volume is a usable VWAP weight, not a constant ─────────────────────
print("\n5. Volume structure (broker volume - proxy, never exchange volume)")
by_h = collections.defaultdict(list)
for r in rows:
    t = dt.datetime.fromtimestamp(r[0], dt.timezone.utc).astimezone(ET)
    by_h[t.hour].append(r[5])
means = {h: statistics.mean(v) for h, v in by_h.items()}
allv = [r[5] for r in rows]
cv = statistics.stdev(allv) / statistics.mean(allv)
peak = max(means, key=means.get)
trough = min(means, key=means.get)
print(f"   CV {cv:.2f}   peak hour {peak:02d}:00 ET   trough hour {trough:02d}:00 ET")
ok(cv > 0.5, f"volume varies enough to weight a VWAP (CV {cv:.2f} > 0.5)")
ok(peak in (9, 10, 11), f"peak volume at the US cash open ({peak:02d}:00 ET)")
ok(means.get(3, 0) > means.get(1, 1e9),
   "London open (03:00 ET) carries more volume than the Asia lull (01:00 ET)")

# ── 6. price continuity ───────────────────────────────────────────────────
print("\n6. Price continuity")
jumps = 0
for i in range(1, len(rows)):
    prev, cur = rows[i - 1][4], rows[i][1]
    if prev > 0 and abs(cur - prev) / prev > 0.02 and ts[i] - ts[i - 1] <= 300:
        jumps += 1
ok(jumps < 10, f"no implausible intraday jumps (>2% across adjacent bars: {jumps})")

# ── 7. intrabar sequencing, re-derived on THIS basis ──────────────────────
print("\n7. Intrabar sequencing vs 1-minute ground truth (re-derived, not carried)")
try:
    m1 = load(f"{TAG}_1m.csv")
except FileNotFoundError:
    print("   SKIP - 1-minute file absent")
else:
    buck = collections.defaultdict(list)
    for r in m1:
        buck[r[0] - (r[0] % 300)].append(r)
    agree = dis = tie = 0
    up_n = up_lf = dn_n = dn_hf = 0
    for t, o, h, l, c, _ in rows:
        g = buck.get(t)
        if not g or len(g) < 2:
            continue
        hi, lo = max(x[2] for x in g), min(x[3] for x in g)
        t_hi = min(x[0] for x in g if x[2] == hi)
        t_lo = min(x[0] for x in g if x[3] == lo)
        if t_hi == t_lo:
            tie += 1
            continue
        truth = t_lo < t_hi             # did the low genuinely print first?
        assumed = c >= o                # emulator: up bar -> low first
        if truth == assumed:
            agree += 1
        else:
            dis += 1
        if c >= o:
            up_n += 1
            up_lf += truth
        else:
            dn_n += 1
            dn_hf += not truth
    tot = agree + dis
    if tot:
        acc = 100 * agree / tot
        print(f"   resolvable 5m buckets {tot:,}   unresolvable ties {tie:,}")
        print(f"   emulator correct      {acc:.1f}%")
        print(f"     up bars, low first  {100*up_lf/max(up_n,1):.1f}%")
        print(f"     down bars, high 1st {100*dn_hf/max(dn_n,1):.1f}%")
        ok(acc > 75, f"sequencing heuristic beats chance on this basis ({acc:.1f}%)")
        ok(abs(100*up_lf/max(up_n,1) - 100*dn_hf/max(dn_n,1)) < 10,
           "heuristic is symmetric across up and down bars (no directional bias)")

print()
if FAILS:
    print(f"BASIS REJECTED - {len(FAILS)} failed check(s):")
    for f in FAILS:
        print(f"  - {f}")
    sys.exit(1)
print("BASIS ACCEPTED for PROTOCOL v1.3 §12 use.")
