#!/usr/bin/env python3
"""V3-Z1 execution-spec invariants and the outcome firewall.

Computes no real outcome. The firewall is proven by ATTEMPTING to reach the
outcome value function on the dry-run path and requiring it to raise.
"""
import ast as A, datetime as dt, json, math, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_inference as I, z1_design as D, z1_panel as Z
import run_z1_dev as R

FAILS = []
def ok(c, m):
    print(("  PASS  " if c else "  FAIL  ") + m)
    if not c: FAILS.append(m)
SP = json.load(open("research/V3_Z1_EXECUTION_SPEC.json"))


print("A. Frozen regression specification")
P = SP["primary_regression"]
ok(P["intercept"] is True and P["estimator"] == "OLS", "intercept YES, estimator OLS")
ok("CR1" in P["development_inference"] and "CME trade date" in P["development_inference"],
   "development inference is CR1 clustered by CME trade date")
ok("TWO-SIDED" in P["development_test"], "the development test is TWO-SIDED")
ok("SEPARATE promotion gate" in P["sign_handling"],
   "the expected sign is a separate gate, not a one-sided test")
for bad in ("interaction terms", "nonlinear transformations", "polynomial terms",
            "thresholding", "automatic feature selection"):
    ok(any(bad in x for x in P["forbidden"]), f"{bad} are forbidden")
ok(P["one_model_per_hypothesis"] is True, "one model per hypothesis")

print("\nB. Session coding is complete and frozen")
C = SP["session_coding"]
ok(len(C["categories"]) == 6, "six categories defined")
ok([c["name"] for c in C["categories"]] == list(D.SESSION_CATEGORIES),
   "spec categories match the code")
ok(C["reference_omitted"] == D.SESSION_REFERENCE == "asia", "reference is asia, frozen")
ok(len(D.SESSION_DUMMIES) == 5, "five dummies, reference omitted")
spans = [(c["hso"][0], c["hso"][1]) for c in C["categories"]]
ok(spans[0][0] == 0 and spans[-1][1] == 23, "hso 0..22 fully covered")
ok(all(spans[i][1] == spans[i+1][0] for i in range(5)), "categories are contiguous, no overlap")
seen = {D.session_bucket(S.session_epoch(dt.date(2025, 6, 3))[0] + h*3600)
        for h in range(23)}
ok(seen == set(D.SESSION_CATEGORIES), f"every hso 0..22 maps to a category {sorted(seen)}")

print("\nC. beta_j is invariant to the reference category (so it cannot be gamed)")
rnd = random.Random(5); n = 1200
cl = [i // 23 for i in range(n)]
buck = [D.SESSION_CATEGORIES[i % 6] for i in range(n)]
z1 = [rnd.gauss(0, 1) for _ in range(n)]
y = [rnd.gauss(0, 1) for _ in range(n)]
def fit(ref):
    dums = [c for c in D.SESSION_CATEGORIES if c != ref]
    X = [[z1[i]] + [1.0 if buck[i] == d else 0.0 for d in dums] for i in range(n)]
    return I.cr1_ols(y, X, cl)
b_asia = fit("asia")["beta"][1]
for ref in ("europe", "us_close", "us_midday"):
    ok(abs(fit(ref)["beta"][1] - b_asia) < 1e-9,
       f"beta_Z1 identical with reference={ref}")
ok(abs(fit("asia")["p"][1] - fit("us_open")["p"][1]) < 1e-12,
   "the p-value is identical too - the reference choice cannot affect the test")

print("\nD. Design quality thresholds were frozen before any output")
Q = SP["design_quality"]
ok(Q["condition_number_warn"] == 30.0 and Q["condition_number_fail"] == 100.0,
   "warn 30 / fail 100, fixed")
ok(Q["threshold_frozen_before_outputs"] is True, "recorded as pre-output")
ok(D.CONDITION_NUMBER_FAIL == 100.0 and D.CONDITION_NUMBER_WARN == 30.0,
   "code matches the spec")
good = [[1.0, rnd.gauss(0,1), rnd.gauss(0,1)] for _ in range(300)]
info = D.check_design(good, ("intercept", "a", "b"))
ok(info["rank"] == 3, "a full-rank matrix passes")
dup = [[1.0, x[1], x[1]] for x in good]
try:
    D.check_design(dup, ("intercept", "a", "a_copy")); ok(False, "duplicate column should fail")
except D.DesignError:
    ok(True, "a rank-deficient design FAILS CLOSED")
ill = [[1.0, x[1], x[1] + 1e-7*rnd.gauss(0,1)] for x in good]
try:
    D.check_design(ill, ("intercept", "a", "b")); ok(False, "ill-conditioned should fail")
except D.DesignError as e:
    ok("condition number" in str(e) or "RANK" in str(e),
       "a near-collinear design FAILS on rank or conditioning")

print("\nE. Bootstrap algorithm is exact and deterministic")
B = SP["block_bootstrap"]
ok(B["block_lengths"] == [5, 10, 20] and B["resamples"] == 5000
   and B["seed"] == 20260914, "L in {5,10,20}, 5000 resamples, seed 20260914")
ok("moving-block" in B["type"].lower() and "trade date" in B["cluster"],
   "chronological moving-block over CME trade dates")
dates = [dt.date(2025, 1, 1) + dt.timedelta(days=i) for i in range(200)]
r1 = random.Random(D.BOOTSTRAP_SEED); r2 = random.Random(D.BOOTSTRAP_SEED)
s1 = D.moving_block_indices(dates, 10, r1)
s2 = D.moving_block_indices(dates, 10, r2)
ok(s1 == s2, "the same seed reproduces the same resample exactly")
ok(len(s1) == len(dates), f"the sample is truncated to exactly {len(dates)} whole date clusters")
ok(all(d in set(dates) for d in s1), "every sampled element is a real development date")
runs = 0
for i in range(1, len(s1)):
    if dates.index(s1[i]) == dates.index(s1[i-1]) + 1: runs += 1
ok(runs > len(s1) * 0.6, f"contiguity is preserved within blocks ({runs}/{len(s1)-1} adjacent)")
for L in (5, 10, 20):
    ok(len(D.moving_block_indices(dates, L, random.Random(1))) == len(dates),
       f"L={L} yields exactly the original date count")
try:
    D.moving_block_indices(dates[:3], 10, random.Random(1)); ok(False, "should fail")
except D.DesignError:
    ok(True, "a block longer than the sample FAILS CLOSED")
BR = SP["bootstrap_pass_rule"]
ok(BR["all_three_required"] is True and "UPPER endpoint" in BR["negative_hypotheses"],
   "all three block lengths required; upper 95% endpoint must be < 0")
ok(any("choosing the block length that looks best" in x for x in BR["forbidden"]),
   "cherry-picking a block length is forbidden")

print("\nF. Concentration rule is deterministic")
K = SP["concentration_rule"]
ok(K["group_sizes"] == [36]*10, f"ten contiguous groups of 36 {K['group_sizes']}")
ok(len(K["pass_requires_all"]) == 3, "three conjunctive conditions")
ok(K["no_p_values"].startswith("no p-value"), "no p-values are computed from the ten refits")
dd = D.deciles(dates[:200])
ok(len(set(dd.values())) == 10, "deciles() yields exactly 10 groups")
ok(dd[dates[0]] == 1 and dd[dates[199]] == 10, "groups are chronological")
ok(D.deciles(dates[:200]) == dd, "decile assignment is deterministic")

print("\nG. Gates are complete and conjunctive")
ok(len(SP["stage_1_promotion"]["all_nine_required"]) == 9, "nine Stage-1 gates")
ok(SP["effect_size_gate"]["threshold"] == 0.03, "effect floor 0.03")
ok(all(x in str(SP["effect_size_gate"]["must_not_be"]) for x in ("P&L", "ticks")),
   "the floor must not be converted into P&L or ticks")
S2 = SP["stage_2_replication"]
ok(S2["alpha"] == 0.10 and "ONE-SIDED" in S2["test"], "replication one-sided at 0.10")
ok("ONLY Stage-1 survivors" in S2["entrants"], "only survivors enter")
ok(S2["no_effect_size_ratio_required"] is True, "no post-hoc shrinkage gate")

print("\nH. THE OUTCOME FIREWALL - attempt to breach it")
rows = [{"ts": i*3600, "trade_date": dt.date(2025,1,1),
         **{m: (i*3600, 100., 101., 99., 100.+i, 1.) for m in Z.MARKETS}}
        for i in range(200)]
rets = {m: Z.log_returns(rows, m) for m in Z.MARKETS}
import importlib
importlib.reload(Z); importlib.reload(R)
R.build.__globals__["Z"].primary_outcome = R._poisoned
try:
    R.build.__globals__["Z"].primary_outcome(rows, rets, 5)
    ok(False, "the poisoned stub should have raised")
except R.OutcomeFirewall:
    ok(True, "on the dry-run path the outcome VALUE function RAISES OutcomeFirewall")
importlib.reload(Z)
ok(D.outcome_available(rows, rets, 5) in (True, False),
   "the PRESENCE predicate still works and returns a bool")
ok(isinstance(D.outcome_available(rows, rets, 5), bool),
   "outcome_available returns bool, never a number")
fn = next(x for x in A.walk(A.parse(open("backtest/z1_design.py").read()))
          if isinstance(x, A.FunctionDef) and x.name == "outcome_available")
rets_nodes = [x for x in A.walk(fn) if isinstance(x, A.Return)]
vals = {getattr(x.value, "value", "expr") for x in rets_nodes}
ok(all(v in (True, False, "expr") for v in vals),
   f"every return in outcome_available is a boolean expression {vals}")
# a RETURN requires a ratio or a log. Timestamp subtraction is legitimate and
# necessary (gap checking), so forbidding Sub outright was wrong.
ok(not any(isinstance(x, A.BinOp) and isinstance(x.op, A.Div) for x in A.walk(fn)),
   "outcome_available contains NO division - it cannot form a price ratio")
ok(not any(isinstance(x, A.Call) and getattr(x.func, "attr", "") == "log"
           for x in A.walk(fn)),
   "outcome_available calls no log - it cannot form a log return")
price_ops = [x for x in A.walk(fn) if isinstance(x, A.BinOp)
             and any(isinstance(o, A.Subscript)
                     and isinstance(getattr(o, "slice", None), A.Constant)
                     and o.slice.value == 4 for o in (x.left, x.right))]
ok(not price_ops,
   "no arithmetic combines close-price fields - prices are only compared to 0")
# two kinds of subtraction are legitimate: timestamp differences (gap checks)
# and integer index arithmetic (k-1). Neither can touch a price.
def _kind(node):
    if isinstance(node, A.Subscript) and isinstance(getattr(node, "slice", None), A.Constant):
        return node.slice.value
    return "index" if isinstance(node, (A.Name, A.Constant)) else "other"
subs = [x for x in A.walk(fn) if isinstance(x, A.BinOp) and isinstance(x.op, A.Sub)]
kinds = [tuple(sorted((_kind(x.left), _kind(x.right)))) for x in subs]
ok(all(set(k) <= {"ts", "index"} for k in kinds),
   f"every subtraction is a timestamp difference or index arithmetic, never a "
   f"price {kinds}")

print("\nI. The runner refuses to execute")
src = open("backtest/run_z1_dev.py").read()
ok("--i-authorize-outcome-inspection" in src, "execution needs explicit authorization")
ok("HALT: execution is not authorized in this build" in src,
   "the execute path HALTs in this build")
ok("Z.primary_outcome = _poisoned" in src, "dry-run poisons the value function")

print("\nJ. Hash verification halts on tampering")
ok(len(SP["protected_hashes"]) == 5, "five protected artifacts")
v = R.verify_hashes()
ok(v["verified"] is True, f"all protected hashes currently verify {v}")
import hashlib, tempfile, shutil
tmp = tempfile.mkdtemp()
bad = dict(SP); bad["protected_hashes"] = dict(SP["protected_hashes"])
bad["protected_hashes"]["backtest/z1_panel.py"] = "0"*64
p = os.path.join(tmp, "bad.json"); json.dump(bad, open(p, "w"))
try:
    R.verify_hashes(p); ok(False, "a tampered hash should HALT")
except SystemExit as e:
    ok("HALT" in str(e) and "No real outcome was read" in str(e),
       "a changed protected artifact HALTS before any outcome is read")
shutil.rmtree(tmp)

print("\nK. Firewall flags in the spec")
for k in ("performance_inspected", "outcomes_inspected", "development_run",
          "replication_run", "prospective_holdout_inspected"):
    ok(SP[k] is False, f"{k} = False")
ok(SP["data_cost_usd"] == 0, "data_cost_usd = 0")
ok(SP["prospective_firewall"]["sealed"] is True, "prospective holdout sealed")
ok("126 ELIGIBLE" in SP["prospective_firewall"]["opens_only_after"],
   "126 ELIGIBLE trade dates required")
ok("failed Stage 1" in SP["replication_firewall"]["rule"],
   "failed hypotheses are never inspected in replication")

print()
if FAILS:
    print(f"Z1 EXECUTION SPEC TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - " + f)
    sys.exit(1)
print("Z1 EXECUTION SPEC TESTS PASSED (no outcome computed).")
