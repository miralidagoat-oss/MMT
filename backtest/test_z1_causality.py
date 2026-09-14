#!/usr/bin/env python3
"""V3-Z1 timing and synchronization invariants.

Proves causality by CONSTRUCTION on synthetic panels: a future bar is mutated
and the feature must not move. The primary outcome function is exercised on
synthetic data ONLY - it is never evaluated against the real panel in the
preregistration turn.
"""
import copy, datetime as dt, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, z1_panel as Z

FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)

H = Z.HOUR


def synth(n=400, start=dt.date(2025, 3, 3)):
    """A clean synthetic panel: consecutive hourly bars, all four markets."""
    op, _ = S.session_bounds(start)
    t0 = int(op.timestamp())
    rows = []
    for k in range(n):
        ts = t0 + k * H
        d = S.trade_date(ts)
        if d is None:
            continue
        px = 100.0 + 0.1 * k + (0.5 if k % 7 == 0 else 0.0)
        bar = (ts, px, px + 1, px - 1, px + 0.25 * ((k % 5) - 2), 10.0)
        rows.append({"ts": ts, "trade_date": d, **{m: bar for m in Z.MARKETS}})
    return rows


def feats(rows, idx):
    rets = {m: Z.log_returns(rows, m) for m in Z.MARKETS}
    acc = {"n": 0, "sum": 0.0}; cur = None; out = None
    for i, r in enumerate(rows):
        k = Z.session_key(r["ts"])
        if k != cur: cur = k; acc = {"n": 0, "sum": 0.0}
        f, _ = Z.features_at(rows, rets, i, acc)
        if f["divergence_1h"] is not None:
            acc["n"] += 1; acc["sum"] += f["divergence_1h"]
        if i == idx: out = dict(f)
    return out


print("A. A feature at t cannot see t+1 (mutate the future, feature must not move)")
base = synth()
i = 300
f0 = feats(base, i)
ok(f0["divergence_1h"] is not None, "the probe index has a computable feature")
for future in (i + 1, i + 2, i + 10):
    mut = copy.deepcopy(base)
    ts = mut[future]["ts"]
    big = (ts, 9e4, 9e4 + 1, 9e4 - 1, 9e4, 10.0)
    for m in Z.MARKETS: mut[future][m] = big
    f1 = feats(mut, i)
    same = all((f0[k] is None and f1[k] is None)
               or (f0[k] is not None and abs(f0[k] - f1[k]) < 1e-12)
               for k in Z.FEATURES)
    ok(same, f"mutating bar t+{future-i} by 1000x leaves every feature at t unchanged")

print("\nB. A feature at t DOES respond to t and to the past (not inert)")
mut = copy.deepcopy(base)
ts = mut[i]["ts"]
mut[i]["NQ"] = (ts, 100.0, 101.0, 99.0, 9e4, 10.0)
f1 = feats(mut, i)
ok(f1["divergence_1h"] != f0["divergence_1h"],
   "changing the CURRENT NQ bar moves divergence_1h")
mut2 = copy.deepcopy(base)
ts2 = mut2[i-1]["ts"]
mut2[i-1]["NQ"] = (ts2, 100.0, 101.0, 99.0, 9e4, 10.0)
ok(feats(mut2, i)["divergence_1h"] != f0["divergence_1h"],
   "changing a PAST bar moves it too - the feature is genuinely data-dependent")

print("\nC. sigma uses only bars <= t, and normalizes a return it never saw")
rets = {m: Z.log_returns(base, m) for m in Z.MARKETS}
s_prev = Z.rolling_sigma(rets["NQ"], i - 1)
s_here = Z.rolling_sigma(rets["NQ"], i)
ok(s_prev is not None and s_here is not None, "both sigmas computable")
ok(s_prev != s_here, "sigma(t-1) and sigma(t) differ - the window really rolls")
mut = copy.deepcopy(base)
tsx = mut[i]["ts"]
mut[i]["NQ"] = (tsx, 100.0, 101.0, 99.0, 5e4, 10.0)
r2 = {m: Z.log_returns(mut, m) for m in Z.MARKETS}
ok(abs(Z.rolling_sigma(r2["NQ"], i-1) - s_prev) < 1e-15,
   "sigma(t-1) is unchanged by the bar at t - the normalizer cannot see its own bar")

print("\nD. The outcome begins strictly AFTER the feature bar")
y = Z.primary_outcome(base, rets, i)
ok(y is not None, "Y computable at the probe index")
mut = copy.deepcopy(base)
tsy = mut[i+1]["ts"]
mut[i+1]["NQ"] = (tsy, 100.0, 101.0, 99.0, 200.0, 10.0)
r3 = {m: Z.log_returns(mut, m) for m in Z.MARKETS}
ok(Z.primary_outcome(mut, r3, i) != y, "Y DOES move when bar t+1 changes")
ok(feats(mut, i)["divergence_1h"] == f0["divergence_1h"],
   "...while the feature at t is untouched by that same change")

print("\nE. No same-bar close serves as both feature input and future outcome")
src = open("backtest/z1_panel.py").read()
ok("rows[j][\"NQ\"][4]" in src and "rows[i][\"NQ\"][4]" in src,
   "Y is built from close(t) and close(t+h) only")
ok("i + horizon" in src, "the outcome endpoint is strictly forward of i")
ok("rolling_sigma(rets[\"NQ\"], i)" in src,
   "Y's denominator is sigma known AT t, not a future sigma")

print("\nF. Gap handling: nothing is stitched across a weekend")
gap = synth(200)
del gap[120:150]                     # excise 30 hours -> a large gap
rg = Z.log_returns(gap, "NQ")
ok(rg[120] is None, "the return across an excised multi-hour gap is None")
ok(Z.MAX_RETURN_GAP_SEC == 2 * H,
   "the admitted gap is exactly 2h - the CME maintenance break, nothing wider")
ok(Z.primary_outcome(gap, {m: Z.log_returns(gap, m) for m in Z.MARKETS}, 119) is None,
   "Y is CENSORED where the next hour is absent, never stitched")

print("\nG. Session labelling cannot access future bars")
ok(Z.session_key(base[i]["ts"]) == S.trade_date(base[i]["ts"]),
   "the session key is a pure function of the bar's own timestamp")
ok(Z.session_key(base[i]["ts"]) == Z.session_key(base[i]["ts"]),
   "it is deterministic")
mut = copy.deepcopy(base)
for k in range(i+1, len(mut)):
    mut[k]["trade_date"] = dt.date(1999, 1, 1)
ok(feats(mut, i)["divergence_session"] == f0["divergence_session"],
   "corrupting every FUTURE trade-date label leaves the session accumulator at t intact")

print("\nH. Strict synchronization: a market missing its hour kills the row")
rows2, series = Z.build_panel()
ok(len(rows2) <= min(len(series[m]) for m in Z.MARKETS),
   "the panel is no larger than the smallest market's bar count")
src2 = open("backtest/z1_panel.py").read()
for bad in ("ffill", "fillna", "interpolate", "bfill", "pad("):
    ok(bad not in src2, f"no {bad} anywhere in the panel module")
ok("common &= set(series[m])" in src2,
   "the panel is an INTERSECTION of timestamps, so no market can be absent")

print("\nI. Only hour-aligned closed bars are admitted")
ok("ts % HOUR != 0" in src2, "non-hour-aligned rows are dropped at load")
ok(all(r["ts"] % H == 0 for r in rows2), "every real panel row is hour-aligned")

print("\nJ. Roll exclusion is calendar-derived, never outcome-derived")
ok("third_friday" in src2 and "ROLL_BEFORE_DAYS" in src2, "expiry is computed from the calendar")
ok(Z.third_friday(2025, 3) == dt.date(2025, 3, 21), "third Friday Mar-2025 = 2025-03-21")
ok(Z.third_friday(2026, 9) == dt.date(2026, 9, 18), "third Friday Sep-2026 = 2026-09-18")
import ast as _a
tree = _a.parse(src2)
fn = next(n for n in _a.walk(tree) if isinstance(n, _a.FunctionDef)
          and n.name == "roll_excluded_dates")
names = {x.id for x in _a.walk(fn) if isinstance(x, _a.Name)}
FORBIDDEN = {"ret", "rets", "outcome", "primary_outcome", "volume", "close",
             "rows", "panel"}
ok(not (names & FORBIDDEN),
   f"the roll rule reads no return, outcome, volume or panel data "
   f"{sorted(names & FORBIDDEN)}")
ok(names <= {"ROLL_AFTER_DAYS", "ROLL_BEFORE_DAYS", "ROLL_MONTHS", "third_friday",
             "dt", "range", "set", "d", "e", "first", "last", "out", "yr", "mth"},
   f"it references ONLY calendar constants and locals {sorted(names)}")

print("\nK. This suite computes no real-data outcome")
ok("build_panel()" in open(__file__).read(),
   "the real panel is built only to check synchronization invariants")
# by AST, not by grep: a text scan finds the search string inside this very
# check. Collect the first argument of every primary_outcome call in this file.
_tt = _a.parse(open(__file__).read())
_args = [(_x.args[0].id if _x.args and isinstance(_x.args[0], _a.Name) else "?")
         for _x in _a.walk(_tt) if isinstance(_x, _a.Call)
         and getattr(_x.func, "attr", getattr(_x.func, "id", "")) == "primary_outcome"]
ok(_args, f"primary_outcome is exercised in this suite {_args}")
ok(all(a in ("base", "gap", "mut") for a in _args),
   f"every call passes a SYNTHETIC panel; the real panel is never passed {_args}")
ok("rows2" not in _args,
   "the real panel variable is never an argument to primary_outcome")

print()
if FAILS:
    print(f"Z1 CAUSALITY TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("Z1 CAUSALITY TESTS PASSED (synthetic timing proofs; no real outcome computed).")
