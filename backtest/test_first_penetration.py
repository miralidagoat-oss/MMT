#!/usr/bin/env python3
"""Tests A-G: the frozen first-qualifying-penetration state machine.

    AVAILABLE -> SWEPT -> CONSUMED_FOR_EVENT_GENERATION

Drives the REAL engine (v2_features.event_time_features) with synthetic bars,
so these prove the shipped emission path, not a restatement of it.

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
LEVEL = 15000.0


def synth(n=140, base=LEVEL + 20.0):
    """Flat bars well ABOVE the buy-side level, so nothing sweeps by accident.
    Starts at an 18:00 ET session open so trade dates are well defined."""
    op, _ = S.session_bounds(dt.date(2023, 3, 1))
    t0 = int(op.timestamp())
    b = {k: [] for k in ("t", "o", "h", "l", "c", "v")}
    for i in range(n):
        b["t"].append(t0 + i * BAR)
        b["o"].append(base); b["c"].append(base)
        b["h"].append(base + 2.0); b["l"].append(base - 2.0)
        b["v"].append(100.0)
    return b


def sweep_bar(b, i, level=LEVEL, extra=1.0):
    """Make bar i penetrate a BUY-SIDE (side=+1) level from above."""
    b["l"][i] = level - PEN - extra


def run(b, stream):
    st = FE.build_state(b)
    vwap, vsig, vnbar = FE.session_vwap(b, st)
    a15, n15, k15 = FE.htf_aggregates(b, st, 900)
    a1h, n1h, k1h = FE.htf_aggregates(b, st, 3600)
    return FE.event_time_features(b, st, stream, vwap, vsig, vnbar,
                                  a15, n15, k15, a1h, n1h, k1h)


def level(price=LEVEL, kind="pdl", side=1, avail_i=0, b=None):
    return dict(price=price, side=side, kind=kind,
                formation=b["t"][avail_i] - 60, avail=b["t"][avail_i])


def const_stream(b, view, lo=20):
    """The SAME dict objects on every bar - level identity is the object."""
    for i in range(len(b["t"])):
        yield i, (view if i >= lo else {})


print("A. A never-swept available level emits one event")
b = synth(); sweep_bar(b, 60)
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 1, f"exactly one event emitted ({len(rows)})")
ok(lv.get("has_emitted_sweep") is True, "level is CONSUMED_FOR_EVENT_GENERATION")

print("\nB. Emitted on the FIRST qualifying penetration")
b = synth(); sweep_bar(b, 60); sweep_bar(b, 80)
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 1, f"still one event with two qualifying bars ({len(rows)})")
ok(rows[0]["t0"] == b["t"][60] + BAR,
   "the event is stamped to the FIRST qualifying bar, not the later one")

print("\nC. A second qualifying bar immediately after adds nothing")
b = synth(); sweep_bar(b, 60); sweep_bar(b, 61)
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 1, f"consecutive qualifying bars -> one event ({len(rows)})")
ok(rows[0]["t0"] == b["t"][60] + BAR, "it is the first of the two")

print("\nD. Ten subsequent bars beyond the level add nothing")
b = synth()
for i in range(60, 71): sweep_bar(b, i)
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 1, f"11 consecutive qualifying bars -> one event ({len(rows)})")

print("\nE. Reclaim then penetrate again adds no new baseline event")
b = synth()
sweep_bar(b, 60)
for i in range(61, 70):                       # reclaimed: back above the level
    b["l"][i] = LEVEL + 5.0; b["c"][i] = LEVEL + 8.0; b["h"][i] = LEVEL + 10.0
sweep_bar(b, 75); sweep_bar(b, 90)            # penetrates again, twice
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 1, f"reclaim + re-penetration -> still one event ({len(rows)})")
ok(rows[0]["t0"] == b["t"][60] + BAR, "the original event stands")

print("\nF. A NEW level with a new identity emits its own event")
b = synth(); sweep_bar(b, 60); sweep_bar(b, 100)
old = level(b=b)
new = level(b=b, avail_i=70)                  # distinct object = new identity
def two(bars):
    for i in range(len(bars["t"])):
        v = {}
        if i >= 20: v["pdl"] = old
        if i >= 70: v["pdl2"] = new
        yield i, v
rows = run(b, two(b))
ok(len(rows) == 2, f"two distinct identities -> two events ({len(rows)})")
ok({r["t0"] for r in rows} == {b["t"][60] + BAR, b["t"][100] + BAR},
   "each identity emits at its own first qualifying penetration")
ok(old["has_emitted_sweep"] and new["has_emitted_sweep"], "both consumed")

print("\nG. Nested distinct levels swept on the SAME bar keep their identities")
b = synth()
b["l"][60] = LEVEL - 60.0                     # deep bar crossing all three
lv1 = level(price=LEVEL, kind="pdl", b=b)
lv2 = level(price=LEVEL - 20.0, kind="pwl", b=b)
lv3 = level(price=LEVEL - 40.0, kind="pivot", b=b)
rows = run(b, const_stream(b, {"a": lv1, "b": lv2, "c": lv3}))
ok(len(rows) == 3, f"three levels -> three events on one bar ({len(rows)})")
ok(sorted(r["liquidity_class"] for r in rows) == ["pdl", "pivot", "pwl"],
   "each event carries its OWN liquidity class, not one level repeated")
# rows carry no level_price field and adding one would move the frozen
# event-stream checksum, so identity is shown through penetration depth:
# three levels 20 points apart, swept by one bar, give three distinct depths
ok(len({round(r["penetration_pts"], 6) for r in rows}) == 3,
   f"three distinct penetration depths - not one level counted three times "
   f"{sorted(round(r['penetration_pts'],2) for r in rows)}")
ok(all(x["has_emitted_sweep"] for x in (lv1, lv2, lv3)), "all three consumed")
b2 = synth()
for i in range(61, 75): b2["l"][i] = LEVEL - 60.0
b2["l"][60] = LEVEL - 60.0
lv1 = level(price=LEVEL, kind="pdl", b=b2)
lv2 = level(price=LEVEL - 20.0, kind="pwl", b=b2)
lv3 = level(price=LEVEL - 40.0, kind="pivot", b=b2)
rows = run(b2, const_stream(b2, {"a": lv1, "b": lv2, "c": lv3}))
ok(len(rows) == 3, f"14 further bars beyond all three add nothing ({len(rows)})")

print("\nH. Equality without penetration is NOT a sweep (frozen rule)")
b = synth(); b["l"][60] = LEVEL                      # touches exactly
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 0, f"touching the level exactly emits nothing ({len(rows)})")
ok(not lv.get("has_emitted_sweep"), "the level stays AVAILABLE")
b = synth(); b["l"][60] = LEVEL - PEN                # exactly at the threshold
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 1, "penetration exactly equal to the threshold DOES qualify")
b = synth(); b["l"][60] = LEVEL - PEN + 0.01         # one cent short
lv = level(b=b); rows = run(b, const_stream(b, {"pdl": lv}))
ok(len(rows) == 0, "one cent short of the threshold does NOT qualify")

print("\nI. Sell-side (side=-1) obeys the mirror rule")
b = synth(base=LEVEL - 20.0); b["h"][60] = LEVEL + PEN + 1.0
lv = level(kind="pdh", side=-1, b=b)
rows = run(b, const_stream(b, {"pdh": lv}))
ok(len(rows) == 1, "a buy-side sweep of a sell-side level emits once")
b = synth(base=LEVEL - 20.0); b["h"][60] = LEVEL
lv = level(kind="pdh", side=-1, b=b)
ok(len(run(b, const_stream(b, {"pdh": lv}))) == 0,
   "equality on the sell side is not a sweep either")

print("\nJ. No re-arm mechanism exists in the engine")
src = open("backtest/v2_features.py").read()
import ast
names = {n.id for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Name)}
names |= {n.attr for n in ast.walk(ast.parse(src)) if isinstance(n, ast.Attribute)}
ok(not (names & {"rearm", "re_arm", "rearm_after", "rearm_atr", "rearm_minutes"}),
   f"no re-arm symbol {sorted(names & {'rearm','re_arm','rearm_after'})}")
ok(sum(1 for _ in [x for x in ast.walk(ast.parse(src))
                   if isinstance(x, ast.Subscript)
                   and isinstance(x.slice, ast.Constant)
                   and x.slice.value == "has_emitted_sweep"]) == 1,
   "has_emitted_sweep is assigned in exactly one place - never cleared")

print()
if FAILS:
    print(f"FIRST-PENETRATION TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("FIRST-PENETRATION TESTS PASSED (synthetic bars only, no outcome).")
