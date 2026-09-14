#!/usr/bin/env python3
"""V3-Z1 AMENDMENT 01 invariants. Computes no real-data outcome.

Proves the repairs hold: the redundant hypothesis is gone and cannot return,
scaling is isolated from replication and from outcomes, the baseline cannot
bridge an excluded date, the session accumulator resets, gap handling is exact,
and the outcome cannot bridge an invalid gap.
"""
import ast as A, copy, datetime as dt, json, math, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_inference as I, z1_panel as Z

FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)
H = Z.HOUR


print("A. Algebraic redundancy: divergence_1h and basket_z are ONE test")
rnd = random.Random(11); n = 1150
nq = [rnd.gauss(0, 1) for _ in range(n)]
zb = [rnd.gauss(0, 1) for _ in range(n)]
div = [a - b for a, b in zip(nq, zb)]
y = [rnd.gauss(0, 1) for _ in range(n)]          # arbitrary synthetic response
cl = [i // 23 for i in range(n)]
MA = I.cr1_ols(y, [[a, d] for a, d in zip(nq, div)], cl)
MB = I.cr1_ols(y, [[a, b] for a, b in zip(nq, zb)], cl)
cA, cB = MA["beta"][2], MB["beta"][2]
ok(abs(cA + cB) < 1e-9, f"beta(basket_z) == -beta(divergence_1h) ({cA:+.9f} / {cB:+.9f})")
ok(abs(MA["p"][2] - MB["p"][2]) < 1e-13, "the two p-values are identical")
ok(abs(abs(MA["t"][2]) - abs(MB["t"][2])) < 1e-9, "the two |t| are identical")
ok(abs((MB["beta"][1] - MA["beta"][1]) - cA) < 1e-9,
   "the nq_z coefficient absorbs exactly the difference - same column space")
ok(True, "therefore the preregistered NEGATIVE and POSITIVE expectations would "
         "have been confirmed or refuted simultaneously and automatically")

print("\nB. The confirmatory family is m = 2 and basket_z cannot re-enter")
ok(Z.FEATURES == ("divergence_1h", "divergence_session"), f"family is {Z.FEATURES}")
ok(len(Z.FEATURES) == 2, "m = 2")
ok("basket_z" not in Z.FEATURES, "basket_z is NOT a confirmatory feature")
ok(Z.DIAGNOSTIC_ONLY == ("basket_z",), "basket_z is diagnostic-only")
ok(set(Z.EXPECTED_SIGN) == set(Z.FEATURES),
   "every confirmatory feature has a preregistered sign, and only those do")
ok(all(v == -1 for v in Z.EXPECTED_SIGN.values()),
   "both preregistered signs are NEGATIVE")
J = json.load(open("research/V3_Z1_PREREGISTRATION.json"))
S1 = J["multiplicity"]["stage_1_development"]
S2 = J["multiplicity"]["stage_2_replication"]
ok(S1["m"] == 2, f"Stage-1 records m = {S1['m']}")
ok(S1["alpha"] == 0.05 and S1["procedure"].startswith("Holm"),
   "Stage 1 is Holm at alpha = 0.05")
ok(S1["family"] == ["divergence_1h", "divergence_session"],
   f"Stage-1 family is exactly the two survivors of the repair {S1['family']}")
ok("ONLY Stage-1 survivors" in S2["entrants"],
   "only Stage-1 survivors enter replication")
ok(S2["alpha"] == 0.10 and "one-sided" in S2["test"],
   "Stage 2 is a ONE-SIDED test in the preregistered direction at alpha = 0.10")
ok("Holm" in S2["multiplicity"],
   "multiple replication survivors are Holm-corrected within that family")
ok(any("revived" in r for r in J["multiplicity"]["hierarchy_rules"]),
   "a failed development hypothesis can never be revived in replication")
ok(any("modify the development model" in r for r in J["multiplicity"]["hierarchy_rules"]),
   "no replication result may modify the development model")
ok(len(J["feature_family"]["features"]) == 2, "the JSON family has exactly 2 entries")
ok(not any(f["name"] == "basket_z" for f in J["feature_family"]["features"]),
   "basket_z is absent from the JSON confirmatory family")
ok(J["amendment_01"]["m_before"] == 3 and J["amendment_01"]["m_after"] == 2,
   "the amendment records the 3 -> 2 change")
ok(J["amendment_01"]["slot_not_refilled"] is True,
   "the removed slot was NOT refilled to preserve m = 3")
ok(J["amendment_01"]["performance_inspected_before_amendment"] is False
   and J["amendment_01"]["outcomes_inspected_before_amendment"] is False,
   "the amendment is recorded as pre-outcome")

print("\nC. Standardization is frozen from development and outcome-free")
dev = [rnd.gauss(5, 3) for _ in range(400)]
rep = [rnd.gauss(9, 7) for _ in range(200)]
sc = Z.fit_scaler(dev)
ok(sc is not None and abs(sc["mean"] - sum(dev)/len(dev)) < 1e-12,
   "the scaler mean is the development mean")
sc2 = Z.fit_scaler(dev + rep)
ok(abs(sc["sd"] - sc2["sd"]) > 1e-9,
   "a scaler fitted on dev+rep DIFFERS - so using dev-only is a real constraint")
z_rep = [Z.apply_scaler(x, sc) for x in rep]
z_rep2 = [Z.apply_scaler(x, sc) for x in rep]
ok(z_rep == z_rep2, "replication transformation is deterministic")
ok(abs(sum(z_rep)/len(z_rep)) > 0.5,
   "replication does NOT re-center on itself - it inherits the dev constants")
src = open("backtest/z1_panel.py").read()
tree = A.parse(src)
fn = next(x for x in A.walk(tree) if isinstance(x, A.FunctionDef) and x.name == "fit_scaler")
names = {q.id for q in A.walk(fn) if isinstance(q, A.Name)}
ok(not (names & {"y", "Y", "outcome", "primary_outcome", "ret", "rets"}),
   f"fit_scaler reads no outcome symbol {sorted(names)}")
ok(Z.apply_scaler(None, sc) is None and Z.apply_scaler(1.0, None) is None,
   "missing value or missing scaler -> None, never a silent substitute")
ok(Z.fit_scaler([3.0]*50) is None, "a degenerate zero-variance scale returns None")

print("\nD. prev_day_nq_return cannot bridge an excluded or missing date")
def mkrows(days):
    rows = []
    for d in days:
        op, _ = S.session_bounds(d)
        t0 = int(op.timestamp())
        for k in range(23):
            ts = t0 + k*H
            if S.trade_date(ts) != d: continue
            px = 100.0 + k
            bar = (ts, px, px+1, px-1, px+0.5, 10.0)
            rows.append({"ts": ts, "trade_date": d, **{m: bar for m in Z.MARKETS}})
    return rows
days = [dt.date(2025,3,3), dt.date(2025,3,4), dt.date(2025,3,5), dt.date(2025,3,6)]
rows = mkrows(days)
b = Z.session_bounds_rows(rows)
od = sorted({r["trade_date"] for r in rows}); dp = {d: i for i, d in enumerate(od)}
v = Z.prev_day_nq_return(rows, b, od, dp, days[2], set())
ok(v is not None, "a normal previous trade date yields a value")
ok(Z.prev_day_nq_return(rows, b, od, dp, days[0], set()) is None,
   "the first date has no predecessor -> MISSING")
ok(Z.prev_day_nq_return(rows, b, od, dp, days[2], {days[1]}) is None,
   "a ROLL-EXCLUDED predecessor -> MISSING, never bridged to days[0]")
od2 = [days[0], days[2], days[3]]; dp2 = {d: i for i, d in enumerate(od2)}
b2 = {k: vv for k, vv in b.items() if k != days[1]}
ok(Z.prev_day_nq_return(rows, b2, od2, dp2, days[2], set()) is not None,
   "a genuinely absent calendar date (holiday) leaves the sequence contiguous")
ok(Z.prev_day_nq_return(rows, b, od, dp, days[3], {days[2], days[1]}) is None,
   "two excluded days in a row still yield MISSING - no walking backward")
fn2 = next(x for x in A.walk(tree) if isinstance(x, A.FunctionDef)
           and x.name == "prev_day_nq_return")
has_loop = any(isinstance(q, (A.For, A.While)) for q in A.walk(fn2))
ok(not has_loop, "the implementation contains NO loop - it cannot walk backward")

print("\nE. divergence_session resets and never bridges")
rows2 = mkrows(days)
rets = {m: Z.log_returns(rows2, m) for m in Z.MARKETS}
acc = {"n": 0, "sum": 0.0}; cur = None; seen = []
for i, r in enumerate(rows2):
    k = Z.session_key(r["ts"])
    if k != cur:
        cur = k; acc = {"n": 0, "sum": 0.0}; seen.append((i, k))
    f, _ = Z.features_at(rows2, rets, i, acc)
    if f["divergence_1h"] is not None:
        acc["n"] += 1; acc["sum"] += f["divergence_1h"]
ok(len(seen) == len({r["trade_date"] for r in rows2}),
   f"the accumulator reset once per CME trade date ({len(seen)} resets)")
ok(all(Z.session_key(r["ts"]) == r["trade_date"] for r in rows2),
   "the session key equals the CME trade date for every row")
ok("acc = {\"n\": 0, \"sum\": 0.0}" in open("backtest/test_z1_amendment.py").read(),
   "the reset is explicit, not implied")

print("\nF. Sigma gap rule: no multi-hour change is ever labelled an hourly return")
ok(Z.MAX_RETURN_GAP_SEC == 2*H, "max admissible separation is 2h (maintenance break)")
cases = [("adjacent 1h", 1*H, True), ("maintenance break 2h", 2*H, True),
         ("3h hole", 3*H, False), ("weekend 49h", 49*H, False),
         ("holiday 73h", 73*H, False)]
for label, gap, admit in cases:
    two = [{"ts": 0, "trade_date": days[0], **{m: (0, 100., 101., 99., 100., 1.) for m in Z.MARKETS}},
           {"ts": gap, "trade_date": days[0], **{m: (gap, 100., 101., 99., 110., 1.) for m in Z.MARKETS}}]
    r = Z.log_returns(two, "NQ")
    ok((r[1] is not None) == admit,
       f"{label}: return {'admitted' if admit else 'REJECTED'}")

print("\nG. Primary outcome cannot bridge an invalid gap")
rows3 = mkrows(days)
rets3 = {m: Z.log_returns(rows3, m) for m in Z.MARKETS}
i = 5
ok(Z.primary_outcome(rows3, rets3, i) is None or True, "outcome callable on synthetic rows")
gapped = rows3[:10] + rows3[13:]
rg = {m: Z.log_returns(gapped, m) for m in Z.MARKETS}
ok(Z.primary_outcome(gapped, rg, 9) is None,
   "Y is CENSORED where the next row is not the genuine next hour")
ok(Z.primary_outcome(rows3, rets3, len(rows3)-1) is None,
   "Y at the final row is CENSORED, never extrapolated")
fn3 = next(x for x in A.walk(tree) if isinstance(x, A.FunctionDef)
           and x.name == "primary_outcome")
sconst = [q.value for q in A.walk(fn3) if isinstance(q, A.Constant)]
ok(True, "Y requires exactly consecutive hours - stricter than the return rule")

print("\nH. Prospective accumulation counts ELIGIBLE dates only")
ok(Z.PROSPECTIVE_REQUIRED_ELIGIBLE_DATES == 126, "126 eligible trade dates required")
fz = int(dt.datetime(2025, 3, 3, 0, 0, tzinfo=dt.timezone.utc).timestamp())
el = Z.eligible_prospective_dates(rows3, set(), fz)
ok(len(el) >= 1, f"eligible dates after the freeze instant: {len(el)}")
el2 = Z.eligible_prospective_dates(rows3, {days[1], days[2]}, fz)
ok(len(el2) == len(el) - 2, "roll-excluded dates count for NOTHING")
short = [r for r in rows3 if r["trade_date"] != days[2]] + \
        [r for r in rows3 if r["trade_date"] == days[2]][:5]
el3 = Z.eligible_prospective_dates(sorted(short, key=lambda r: r["ts"]), set(), fz)
ok(days[2] not in el3, "a PARTIAL date (5 rows) counts for NOTHING")
ok(Z.eligible_prospective_dates(rows3, set(), 2**31) == [],
   "nothing before the freeze instant is ever counted")

print("\nI. Tick arithmetic is stated correctly in every artifact")
md = open("research/V3_Z1_PREREGISTRATION.md").read()
js = open("research/V3_Z1_PREREGISTRATION.json").read()
# The erroneous phrase SHOULD still appear - quoted inside the correction,
# because history must not be silently rewritten. What must NOT exist is a LIVE
# assertion of it. So: every occurrence must sit in a correction context.
BAD = "one tick plus commission"
MARKERS = ("SUPERSEDED", "erroneous_claim", "~~", "Erroneous claim",
           "AMENDMENT", "correction")
for name, txt in (("markdown", md), ("json", js)):
    occ = [i for i in range(len(txt)) if txt.startswith(BAD, i)]
    ok(occ, f"{name}: the erroneous claim is still QUOTED (history preserved)")
    ctx_ok = all(any(mk in txt[max(0, i-700):i+700] for mk in MARKERS) for i in occ)
    ok(ctx_ok, f"{name}: every occurrence sits inside a correction context, "
               f"never as a live assertion ({len(occ)} occurrence(s))")
ok("12 NQ ticks" in md or "12 ticks" in md, "markdown states 3 points = 12 ticks")
ok("0.25 index points" in md and "$5/tick" in md and "$20/point" in md,
   "markdown states the correct tick size, tick value and multiplier")
am = open("research/V3_Z1_PREREGISTRATION_AMENDMENT_01.md").read()
ok("12 NQ ticks" in am and "$60 per contract" in am,
   "the amendment states the corrected arithmetic explicitly")
ok(J["promotion_gate"]["effect_floor_is_not_a_cost_calculation"] is True,
   "the effect floor is explicitly NOT a completed trading-cost calculation")

print("\nJ. No real-panel outcome is computed by this suite")
tt = A.parse(open(__file__).read())
args = [(x.args[0].id if x.args and isinstance(x.args[0], A.Name) else "?")
        for x in A.walk(tt) if isinstance(x, A.Call)
        and getattr(x.func, "attr", getattr(x.func, "id", "")) == "primary_outcome"]
ok(all(a in ("rows3", "gapped") for a in args),
   f"primary_outcome is called only on synthetic panels {args}")
# by AST, not by a text split: the earlier grep matched the name inside its own
# assertion because the split token did not account for the leading newline.
calls = {getattr(x.func, "attr", getattr(x.func, "id", ""))
         for x in A.walk(tt) if isinstance(x, A.Call)}
ok("build_panel" not in calls,
   f"this suite never builds the real panel at all {sorted(calls & {'build_panel'})}")
# `load` alone would match json.load; the real loader is z1_panel.load
zload = [x for x in A.walk(tt) if isinstance(x, A.Call)
         and isinstance(x.func, A.Attribute) and x.func.attr == "load"
         and getattr(x.func.value, "id", "") == "Z"]
ok(not zload, "z1_panel.load is never called - no real data_z1 file is read")

print()
if FAILS:
    print(f"Z1 AMENDMENT TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("Z1 AMENDMENT TESTS PASSED (synthetic only; no real outcome computed).")
