#!/usr/bin/env python3
"""Tests A-J: the frozen first-qualifying-penetration state machine.

    AVAILABLE -> SWEPT -> CONSUMED_FOR_EVENT_GENERATION

Drives the CANONICAL engine (v2_features.compute_events) with synthetic bars,
so these prove the shipped emission path rather than restating it.

Computes NO outcome: no return, no MFE, no MAE, no p-value.
"""
import datetime as dt, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_events as V, v2_features as FE

FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)

BAR = V.BAR_SECONDS
PEN = V.PROXY_SWEEP_PENETRATION_POINTS
LOW, HIGH, BASE = 14990.0, 15010.0, 15000.0
D0 = dt.date(2023, 3, 1)


def fixture(days=3, per=100):
    """Flat bars across whole trade days. Day 0 sets a known high and low, so
    day 1 carries a PDH at 15010 and a PDL at 14990 with known identities."""
    b = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
    d = D0
    for k in range(days):
        op, _ = S.session_bounds(d)
        ts = int(op.timestamp())
        for j in range(per):
            b["t"].append(ts + j*BAR)
            b["o"].append(BASE); b["c"].append(BASE)
            b["h"].append(HIGH if (k == 0 and j == 40) else BASE + 1.0)
            b["l"].append(LOW if (k == 0 and j == 60) else BASE - 1.0)
            b["v"].append(10.0)
        d += dt.timedelta(days=1)
        while d.weekday() >= 5:
            d += dt.timedelta(days=1)
    return b, [D0 + dt.timedelta(days=i) for i in range(days)]


def day_index(b, day_no, per=100):
    return day_no * per


def run(b):
    tr = {}
    return FE.compute_events(b, trace=tr), tr


def pdl_id(b, day_no, per=100):
    return f"PDL-{FE.S.trade_date(b['t'][day_index(b, day_no, per)])}"


print("A. A never-swept available level emits one event")
b, _ = fixture()
i = day_index(b, 1) + 20
b["l"][i] = LOW - PEN - 1.0
rows, tr = run(b)
pid = pdl_id(b, 1)
mine = [r for r in rows if r["level_id"] == pid]
ok(len(mine) == 1, f"exactly one event from {pid} ({len(mine)})")
lv = [x for x in tr["levels"] if x["level_id"] == pid][0]
ok(lv["has_emitted_sweep"] is True, "level is CONSUMED_FOR_EVENT_GENERATION")
ok(abs(lv["price"] - LOW) < 1e-9, f"it is the previous day's low ({lv['price']})")

print("\nB. Emitted on the FIRST qualifying penetration")
b, _ = fixture()
i0 = day_index(b, 1) + 20
for k in (i0, i0 + 30):
    b["l"][k] = LOW - PEN - 1.0
rows, _ = run(b)
mine = [r for r in rows if r["level_id"] == pdl_id(b, 1)]
ok(len(mine) == 1, f"two qualifying bars -> one event ({len(mine)})")
ok(mine[0]["t0"] == b["t"][i0] + BAR, "stamped to the FIRST qualifying bar")

print("\nC. A second qualifying bar immediately after adds nothing")
b, _ = fixture()
i0 = day_index(b, 1) + 20
b["l"][i0] = b["l"][i0+1] = LOW - PEN - 1.0
rows, _ = run(b)
mine = [r for r in rows if r["level_id"] == pdl_id(b, 1)]
ok(len(mine) == 1, f"consecutive qualifying bars -> one event ({len(mine)})")
ok(mine[0]["t0"] == b["t"][i0] + BAR, "it is the first of the two")

print("\nD. Ten subsequent bars beyond the level add nothing")
b, _ = fixture()
i0 = day_index(b, 1) + 20
for k in range(i0, i0 + 11):
    b["l"][k] = LOW - PEN - 1.0
rows, _ = run(b)
ok(len([r for r in rows if r["level_id"] == pdl_id(b, 1)]) == 1,
   "11 consecutive qualifying bars -> one event")

print("\nE. Reclaim then penetrate again adds no new baseline event")
b, _ = fixture()
i0 = day_index(b, 1) + 20
b["l"][i0] = LOW - PEN - 1.0
for k in range(i0+1, i0+10):                 # reclaimed: back above the level
    b["l"][k] = LOW + 5.0; b["c"][k] = LOW + 8.0; b["h"][k] = LOW + 10.0
b["l"][i0+20] = LOW - PEN - 1.0
b["l"][i0+40] = LOW - PEN - 1.0
rows, _ = run(b)
mine = [r for r in rows if r["level_id"] == pdl_id(b, 1)]
ok(len(mine) == 1, f"reclaim + two re-penetrations -> one event ({len(mine)})")
ok(mine[0]["t0"] == b["t"][i0] + BAR, "the original event stands")

print("\nF. A NEW level with a new identity emits its own event")
b, _ = fixture(days=3)
b["l"][day_index(b, 1) + 20] = LOW - PEN - 1.0     # sweeps day 1's PDL
b["l"][day_index(b, 2) + 20] = LOW - PEN - 6.0     # sweeps day 2's PDL
rows, _ = run(b)
ids = {r["level_id"] for r in rows}
ok(pdl_id(b, 1) in ids and pdl_id(b, 2) in ids,
   f"both trade days' PDLs emitted: {sorted(x for x in ids if 'PDL' in x)}")
ok(pdl_id(b, 1) != pdl_id(b, 2), "they are distinct immutable identities")
for n_ in (1, 2):
    ok(len([r for r in rows if r["level_id"] == pdl_id(b, n_)]) == 1,
       f"day {n_} PDL emitted exactly once")

print("\nG. Nested distinct levels swept on the SAME bar keep their identities")
b, _ = fixture(days=2, per=140)
i = day_index(b, 1, 140) + 60
b["l"][i] = LOW - 60.0                       # one deep bar through everything
rows, tr = run(b)
same = [r for r in rows if r["t0"] == b["t"][i] + BAR]
ok(len(same) >= 2, f"several levels swept on one bar ({len(same)})")
ok(len({r['level_id'] for r in same}) == len(same),
   "each event carries its OWN identity, not one level repeated")
# NOT penetration depth: distinct levels legitimately coincide in price (a
# PDL, a PWL and a fractal pivot can all sit at the same low), so equal depths
# prove nothing either way. Identity is what must be distinct.
ok(len({r["liquidity_class"] for r in same}) >= 2,
   f"they come from different generators "
   f"{sorted(r['liquidity_class'] for r in same)}")
ok(all(len([x for x in rows if x["level_id"] == r["level_id"]]) == 1
       for r in same),
   "each of those identities appears exactly once in the whole run")
for k in range(i+1, i+15):
    b["l"][k] = LOW - 60.0
rows2, _ = run(b)
ok(len([r for r in rows2 if r["t0"] == b["t"][i] + BAR]) == len(same)
   and len(rows2) == len(rows),
   f"14 further bars beyond them all add nothing ({len(rows2)} vs {len(rows)})")

print("\nH. Equality without penetration is NOT a sweep (frozen rule)")
for delta, expect, label in ((0.0, 0, "touching the level exactly"),
                             (PEN, 1, "penetration exactly at the threshold"),
                             (PEN - 0.01, 0, "one cent short of the threshold")):
    b, _ = fixture()
    i = day_index(b, 1) + 20
    b["l"][i] = LOW - delta
    rows, tr = run(b)
    n_ = len([r for r in rows if r["level_id"] == pdl_id(b, 1)])
    ok(n_ == expect, f"{label} -> {expect} event(s) (got {n_})")

print("\nI. Sell-side (side=-1) obeys the mirror rule")
b, _ = fixture()
i = day_index(b, 1) + 20
b["h"][i] = HIGH + PEN + 1.0
rows, _ = run(b)
hid = f"PDH-{FE.S.trade_date(b['t'][day_index(b, 1)])}"
ok(len([r for r in rows if r["level_id"] == hid]) == 1,
   "a buy-side sweep of a sell-side level emits once")
b, _ = fixture()
b["h"][day_index(b, 1) + 20] = HIGH
rows, _ = run(b)
ok(len([r for r in rows if r["level_id"] == hid]) == 0,
   "equality on the sell side is not a sweep either")

print("\nJ. No re-arm mechanism exists in the engine")
import ast
src = open("backtest/v2_features.py").read()
tree = ast.parse(src)
names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
names |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
bad = names & {"rearm", "re_arm", "rearm_after", "rearm_atr", "rearm_minutes"}
ok(not bad, f"no re-arm symbol {sorted(bad)}")
writes = [n for n in ast.walk(tree) if isinstance(n, ast.Subscript)
          and isinstance(n.slice, ast.Constant)
          and n.slice.value == "has_emitted_sweep"]
ok(len(writes) == 1, f"has_emitted_sweep assigned in exactly one place, never "
   f"cleared ({len(writes)})")

print()
if FAILS:
    print(f"FIRST-PENETRATION TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("FIRST-PENETRATION TESTS PASSED (synthetic bars only, no outcome).")
