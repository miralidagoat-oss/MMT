#!/usr/bin/env python3
"""Final consistency pass tests (items 14 A-R). No outcome is computed."""
import datetime as dt, json, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2_events as V, v2_inference as I, v2_population as POP, partitions as P

FAILS=[]
def ok(c,m):
    print(("  PASS  " if c else "  FAIL  ")+m)
    if not c: FAILS.append(m)
FS=json.load(open("research/FEATURE_SPEC_V2.json"))

# A/B/C. raw basis only, no quantized, no rounding
print("A/B/C. Raw basis only")
ok(V.RAW_BASIS=="data_ndx/NDX_5m.csv", "V2 raw basis is data_ndx")
try:
    V.assert_v2_basis("data_ndx_q/NDX_5m.csv"); ok(False,"quantized should be refused")
except ValueError as e: ok("irreversibly rounded" in str(e), "quantized basis REFUSED")
ok(V.assert_v2_basis(V.RAW_BASIS), "raw basis accepted")
src=open("backtest/v2_events.py").read()+open("backtest/v2_population.py").read()
ok("round(" not in src, "no rounding call anywhere in the V2 event/population code")
pf=FS["global"]["price_fields"]
# "unquantized" contains the substring "quantized"; the first version of this
# test matched on that and failed for the wrong reason.
ok("quantized 5m bar" not in pf and "RAW unquantized" in pf,
   "price_fields says RAW unquantized, not 'quantized 5m bar'")
ok("data_ndx/NDX_5m.csv" in pf and "NEVER read by V2" in pf,
   "price_fields names the raw file and states the V1 file is never read")
ok("tick" not in FS, "no generic 'tick' field in the feature spec")

# D/R. four separate constants, genuinely uncoupled
print("\nD/R. Four separate research constants")
names=("PROXY_SWEEP_PENETRATION_POINTS","PROXY_TOUCH_TOLERANCE_POINTS",
       "PROXY_BODY_FLOOR_POINTS","PROXY_PIVOT_DUP_TOLERANCE_PTS")
ok(all(hasattr(V,n) for n in names), "all four constants exist separately")
ok(not hasattr(V,"TICK") and not hasattr(V,"PIVOT_DUP_TOLERANCE_POINTS"),
   "no shared TICK / aliased constant remains")
import importlib
V.PROXY_SWEEP_PENETRATION_POINTS = 99.0          # perturb ONE
ok(V.PROXY_TOUCH_TOLERANCE_POINTS==0.25 and V.PROXY_BODY_FLOOR_POINTS==0.25
   and V.PROXY_PIVOT_DUP_TOLERANCE_PTS==0.25,
   "changing sweep penetration does NOT alter touch/body/pivot-dup constants")
ok(V.touch(100.0, 100.2, 99.9), "touch() still uses its own tolerance after the perturbation")
importlib.reload(V)
ok(V.PROXY_SWEEP_PENETRATION_POINTS==0.25, "constant restored on reload")

# Q. sweep-bar OHLC features are stamped at t0
print("\nQ. Sweep-bar OHLC features stamped at EVENT_CONFIRMATION_TIME")
for f in ("close_vs_level_atr","wick_body_ratio","vwap_dist_sigma","penetration_atr",
          "level_age_min","minutes_since_session_open"):
    ok(FS["event_time_features"][f]["available"].startswith("EVENT_CONFIRMATION_TIME"),
       f"{f} available at t0")
ok("EVENT_CONFIRMATION_TIME" in FS["event_time_features"]["level_age_min"]["formula"],
   "level_age_min measured from t0, not the bar open")

# E/F/G. primary population before feature missingness
print("\nE/F/G. Primary-Y30 population")
t0=1_700_000_000; idx=set(range(t0-3000, t0+3000, 300))
e_ok={"t0":t0,"atr0":10.0,"event_id":"e1","trade_date":dt.date(2024,1,2)}
ok(POP.primary_eligible(e_ok, idx, t0-3000, t0+3000)[0], "complete path -> eligible")
# t0+1500 is BOTH the last path bar and the endpoint bar, so removing it fires
# missing_endpoint_bar first - correct precedence. Remove an INTERIOR bar.
gap=set(idx); gap.discard(t0+600)
ok(POP.primary_eligible(e_ok, gap, t0-3000, t0+3000)==(False,"path_gap"),
   "an interior hole -> path_gap, not a nearest-bar substitution")
endgap=set(idx); endgap.discard(t0+1500)
ok(POP.primary_eligible(e_ok, endgap, t0-3000, t0+3000)==(False,"missing_endpoint_bar"),
   "removing the endpoint bar reports missing_endpoint_bar, not path_gap")
noend=set(idx); noend.discard(t0+30*60-300)
ok(POP.primary_eligible(e_ok, noend, t0-3000, t0+3000)==(False,"missing_endpoint_bar"),
   "no exact C30 endpoint bar -> primary-INELIGIBLE")
ok(POP.primary_eligible(dict(e_ok,atr0=0.0), idx, t0-3000, t0+3000)==(False,"invalid_atr0"),
   "invalid ATR0 -> ineligible")
ok(POP.primary_eligible(e_ok, idx, t0-3000, t0+600)==(False,"partition_boundary"),
   "horizon crossing the partition boundary -> censored, never borrowed")
ok(POP.primary_eligible(dict(e_ok,roll_crossed=True), idx, t0-3000, t0+3000)
   ==(False,"contract_roll"), "roll crossing -> censored")
evs=[e_ok, dict(e_ok,event_id="e2",t0=t0+600)]
el,cen,cnt=POP.build_population(evs, noend, t0-3000, t0+3000)
ok(len(el)+len(cen)==len(evs) and sum(cnt.values())==len(cen),
   "population partitions events exactly, with reason counts")

# H. censoring audit reads availability only
print("\nH. Censoring audit cannot read outcome values")
evs2=[dict(e_ok,event_id=f"e{i}",session_location="ny_open",direction=1,
           liquidity_class="pdh",year=2024,hour_et=9,
           trade_date=dt.date(2024,1,1)+dt.timedelta(days=i)) for i in range(40)]
aud=POP.censoring_audit(evs2, {e["event_id"] for e in evs2[:30]})
ok(abs(aud["session_location"]["ny_open"]["eligibility_rate"]-0.75)<1e-9,
   "eligibility RATE computed from availability alone")
try:
    POP.censoring_audit([dict(evs2[0], y_30=0.42)], set()); ok(False,"should refuse")
except POP.OutcomeValueAccess: ok(True,"an event carrying y_30 is REFUSED by the audit")

# I. late-session gaps are censoring
print("\nI. Late-session proxy gap is censoring, not silence")
ok("missing_endpoint_bar" in POP.CENSOR_REASONS and "path_gap" in POP.CENSOR_REASONS,
   "gap reasons are first-class censor categories")
ok("16:15" in FS["proxy_level_semantics"], "the proxy coverage gap is recorded in the spec")

# M. category admissibility is availability-only
print("\nM. Category inclusion is sample availability only")
dim={"a":{"eligible_clusters":50,"events":1,"eligible":1,"eligibility_rate":1,"clusters":1},
     "b":{"eligible_clusters":29,"events":1,"eligible":1,"eligibility_rate":1,"clusters":1}}
keep,drop=POP.admissible_categories(dim)
ok(keep==["a"] and drop=={"b":29}, "a category below 30 eligible clusters is excluded")
ok(POP.MIN_CLUSTERS_PER_CATEGORY==30, "threshold is the frozen 30")

# L. categorical stability is reference-invariant
print("\nL. Categorical stability is reference-invariant")
rng=random.Random(11); cat=[];y=[]
for i in range(1600):
    c="abcd"[i%4]; cat.append(c); y.append({"a":0.,"b":1.,"c":2.,"d":3.}[c]+rng.gauss(0,.4))
v_a=I.category_effect_vector(cat,y,["a","b","c","d"])
v_d=I.category_effect_vector(cat,y,["d","c","b","a"])
ok(all(abs(v_a[k]-v_d[k])<1e-12 for k in v_a), "centred vector independent of category ordering")
ok(abs(sum(v_a.values()))<1e-9, "centred vector sums to zero")
st=I.categorical_stability(v_a,v_a,v_a)
ok(st["stable"] and st["status"]=="EVALUATED", "identical vectors -> stable")
rev={k:-v for k,v in v_a.items()}
ok(not I.categorical_stability(v_a,rev,v_a)["stable"], "sign-flipped middle -> not stable")
two={"a":1.0,"b":-1.0}
ok(I.categorical_stability(two,two,two)["status"]=="INCONCLUSIVE",
   "fewer than 3 common categories -> INCONCLUSIVE, non-promotable")

# N. diagnostics cannot change promotion
print("\nN. Diagnostics cannot modify promoted=True/False")
gates={g:True for g in POP.HARD_GATES}
ok(POP.promote(gates) is True, "all hard gates true -> promoted")
ok(POP.promote(dict(gates, holm_adjusted_p_le_alpha=False)) is False, "one gate false -> not promoted")
try:
    POP.promote(dict(gates, day_concentration=False)); ok(False,"diagnostic should be refused")
except ValueError as e: ok("cannot participate" in str(e), "a diagnostic passed as a gate is REFUSED")
try:
    POP.promote({g:True for g in POP.HARD_GATES[:-1]}); ok(False,"missing gate should raise")
except ValueError as e: ok("missing hard gate" in str(e), "a missing hard gate raises")
for phrase in ("no domination by a handful of days","no single-year dependency",
               "no parameter needle","economically nontrivial"):
    ok(phrase in FS["promotion"]["removed_subjective_gates"], f"'{phrase}' removed as a gate")

# O/P. Holm family stays 22
print("\nO/P. Holm family size is invariant")
r=POP.holm_fixed_family({"f1":0.001,"f2":0.02}, not_testable=["f3","f4"])
ok(r["family_size"]==22, "m stays 22 with only 2 testable features")
ok(abs(r["results"][0]["p_holm"]-0.022)<1e-12, f"smallest p x 22 = {r['results'][0]['p_holm']:.4f}")
nt=[x for x in r["results"] if not x["testable"]]
ok(len(nt)==2 and all(x["status"].startswith("NOT TESTABLE") for x in nt),
   "non-testable features reported NOT TESTABLE / NOT PROMOTABLE")
ok(all(not x["reject"] for x in nt), "a non-testable feature is never promoted")
ok(POP.HOLM_FAMILY_SIZE==22 and FS["holm"]["m"]==22, "22 in both code and spec")
full=POP.holm_fixed_family({f"f{i}":0.001 for i in range(22)})
ok(abs(full["results"][0]["p_holm"]-0.022)<1e-12,
   "a full family of 22 gives the SAME adjustment - no power gained from dropouts")

# J/K. comparator causality
print("\nJ/K. 252-day comparators are causally prior and bucket-matched")
for f in ("atr_percentile","realized_vol_state","htf_1h_range_pctile","htf_1h_vol_state"):
    spec=FS["event_time_features"][f]
    ok("strictly earlier than t0" in spec["comparator_causality"], f"{f} comparator is prior to t0")
    ok("REFERENCE" in spec["formula"], f"{f} names its reference distribution explicitly")
ok("SAME bucket-of-trade-day" in FS["event_time_features"]["htf_1h_range_pctile"]["formula"],
   "1H range percentile compares the SAME bucket-of-day, not arbitrary end-of-day ranges")
ok("same bucket-of-trade-day comparator" in
   FS["event_time_features"]["htf_1h_vol_state"]["formula"].lower(),
   "1H vol state uses the same bucket comparator - choice made, not left open")
ok("FINAL observable" in FS["event_time_features"]["atr_percentile"]["formula"],
   "atr_percentile names which value represents a historical date")

print()
if FAILS:
    print(f"V2 LOCKED TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - "+f)
    sys.exit(1)
print("V2 LOCKED TESTS PASSED.")
