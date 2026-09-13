#!/usr/bin/env python3
"""GATE 2: trade frequency must not move when warm-up length changes.

The evaluated interval is held fixed and only the warm-up is varied. Under the
V1 defect the denominator grew with warm-up, so frequency fell; under the fix it
must be identical to the last decimal.
"""
import copy, json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import partitions as P, report_result as R, po3_engine as E
from dataclasses import replace
from evaluate import CANDIDATE

BASIS = "data_ndx_q/NDX_5m.csv"
FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)

base = json.load(open("research/PARTITIONS.json"))
results = {}
for warm in ("2022-08-10", "2022-07-01", "2022-06-01"):
    m = copy.deepcopy(base)
    for pt in m["partitions"]:
        if pt["name"] == "development":
            pt["warmup_from"] = warm          # ONLY the warm-up changes
    fd, path = tempfile.mkstemp(suffix=".json"); os.close(fd)
    json.dump(m, open(path, "w"))
    bars, countable, eligible = P.load(BASIS, "development", manifest=path)
    ctx = E.build_context(bars)
    log = []
    E.run(bars, ctx, replace(CANDIDATE, friction_points=0.70, cost_ticks=0.0),
          outcome_log=log)
    log = P.countable(log, bars, countable)
    s = R.summarize(log, bars, eligible_days=eligible)
    results[warm] = (len(bars["t"]), s["n"], len(eligible),
                     s["freq_per_trade_day"])
    print(f"   warm-up from {warm}: bars={len(bars['t']):>7,}  "
          f"trades={s['n']:>5}  eligible_days={len(eligible):>4}  "
          f"freq={s['freq_per_trade_day']:.6f}")
    os.unlink(path)

vals = list(results.values())
ok(len({v[1] for v in vals}) == 1, "evaluated trade count is unchanged by warm-up length")
ok(len({v[2] for v in vals}) == 1, "eligible_days is unchanged by warm-up length")
ok(len({round(v[3], 9) for v in vals}) == 1,
   "trades/day is IDENTICAL across all warm-up lengths")
ok(len({v[0] for v in vals}) == len(vals),
   "bars loaded genuinely differed, so the test exercised the defect")

try:
    R.summarize([{"bar": 0, "r": 1.0, "dir": 1}], {"t": [0]})
    ok(False, "summarize() without eligible_days should refuse")
except ValueError as e:
    ok("GATE 2" in str(e), "summarize() refuses to guess a denominator")

print()
if FAILS:
    print(f"GATE 2 FAILED - {len(FAILS)}"); sys.exit(1)
print("GATE 2 PASSED - frequency depends only on the evaluated population.")
