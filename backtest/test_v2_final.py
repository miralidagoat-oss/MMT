#!/usr/bin/env python3
"""Final lock tests (item 17 A-R). Computes NO outcome of any kind."""
import ast, datetime as dt, glob, json, math, os, random, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2_inference as I, v2_population as POP, v2_events as V, v2_features as FE

FAILS=[]
def ok(c,m):
    print(("  PASS  " if c else "  FAIL  ")+m)
    if not c: FAILS.append(m)
FS=json.load(open("research/FEATURE_SPEC_V2.json"))

# --- semantic scanners (replace substring greps) -------------------------
# A raw substring scan over source text is unsound in BOTH directions: it
# flagged the docstring "NO forward return, NO MFE, NO MAE" - a file saying it
# computes no outcome - and in test R it flagged this file's own search
# pattern. These walk the AST instead, so comments and docstrings cannot
# trigger or suppress a finding.
_OUT = re.compile(r"^(y_\d+|mfe|mae|(mfe|mae)_\w+|forward_\w*|ret_\d+|"
                  r"signed_return|time_to_(mfe|mae)|remaining_return)$", re.I)

def outcome_symbols(path):
    """Identifiers through which an outcome could be computed or read:
    bound names, attributes, string subscripts, keyword arguments."""
    t = ast.parse(open(path).read()); hit = []
    for n in ast.walk(t):
        if isinstance(n, ast.Name) and _OUT.match(n.id): hit.append(n.id)
        elif isinstance(n, ast.Attribute) and _OUT.match(n.attr): hit.append(n.attr)
        elif isinstance(n, ast.keyword) and n.arg and _OUT.match(n.arg): hit.append(n.arg)
        elif isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant) \
                and isinstance(n.slice.value, str) and _OUT.match(n.slice.value):
            hit.append(n.slice.value)
    return sorted(set(hit))

def date_literals(path):
    """Every dt.date(y,m,d) the module can construct, as date objects."""
    t = ast.parse(open(path).read()); out = []
    for n in ast.walk(t):
        if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == "date" and len(n.args) == 3
                and all(isinstance(a, ast.Constant) for a in n.args)):
            out.append(dt.date(*[a.value for a in n.args]))
    return out



# A/B. exactly ONE Holm implementation, always m=22
print("A/B. One authoritative Holm")
defs=[]
for f in glob.glob("backtest/*.py"):
    for ln in open(f):
        if re.match(r"^def holm", ln.strip()) or re.match(r"^def holm", ln):
            defs.append((f, ln.strip()))
ok(len(defs)==1, f"exactly one 'def holm*' in the repo: {defs}")
ok(defs[0][0].endswith("v2_inference.py"), "it lives in the inference module")
ok("holm_fixed_family" in defs[0][1], "it is the fixed-family variant")
ok(not hasattr(I,"holm"), "the generic dynamic-family holm() is GONE")
ok(POP.holm_fixed_family is I.holm_fixed_family, "population re-exports, no second copy")
ok(I.HOLM_FAMILY_SIZE==22 and FS["holm"]["m"]==22, "m=22 in code and spec")

# C. multipliers with non-testable hypotheses + hand-computed values
print("\nC. Holm multipliers use the ORIGINAL family size")
r=I.holm_fixed_family({"a":0.001,"b":0.002}, not_testable=[f"n{i}" for i in range(20)])
mult=[x["multiplier"] for x in r["results"] if x["testable"]]
ok(mult==[22,21], f"2 testable -> multipliers {mult}, never [2,1]")
ok(abs(r["results"][0]["p_holm"]-0.022)<1e-12, "0.001*22 = 0.0220 exactly")
ok(abs(r["results"][1]["p_holm"]-0.042)<1e-12, "0.002*21 = 0.0420 exactly")
for T,expect in ((22,22),(21,22),(2,22),(1,22)):
    rr=I.holm_fixed_family({f"f{i}":0.0001*(i+1) for i in range(T)},
                           not_testable=[f"u{j}" for j in range(22-T)])
    ok(rr["results"][0]["multiplier"]==expect,
       f"T={T:>2} testable -> largest multiplier {rr['results'][0]['multiplier']}")
r0=I.holm_fixed_family({}, not_testable=[f"u{j}" for j in range(22)])
ok(r0["tested"]==0 and all(not x["reject"] for x in r0["results"]),
   "T=0 -> nothing tested, nothing rejected")
ok(all(x["status"].startswith("NOT TESTABLE") for x in r0["results"]),
   "all 22 reported NOT TESTABLE / NOT PROMOTABLE")
mono=I.holm_fixed_family({"a":0.01,"b":0.0001,"c":0.005})
ok(all(mono["results"][i]["p_holm"]<=mono["results"][i+1]["p_holm"]+1e-15
       for i in range(2)), "Holm monotonicity enforced")
try:
    I.holm_fixed_family({f"f{i}":0.01 for i in range(23)}); ok(False,"should refuse")
except ValueError as e: ok("may not be enlarged" in str(e), "family cannot be enlarged past 22")

# D. outcome guard scans EVERY event
print("\nD. Outcome guard inspects every event, no sampling")
base=[{"event_id":f"e{i}","trade_date":None} for i in range(1000)]
for pos in (0,49,50,51,499,999):
    ev=[dict(x) for x in base]; ev[pos]["y_30"]=0.42
    try:
        POP.assert_no_outcome_fields(ev); ok(False,f"index {pos} should fail")
    except POP.OutcomeValueAccess as e:
        ok(f"index {pos}" in str(e), f"outcome at index {pos} caught")
for nm in ("Y_30","y_30","mfe_30","mae_30","forward_return","ret_30","mfe_atr","time_to_mae"):
    ev=[dict(x) for x in base[:5]]; ev[2][nm]=1.0
    try:
        POP.assert_no_outcome_fields(ev); ok(False,f"{nm} should fail")
    except POP.OutcomeValueAccess: ok(True,f"forbidden name {nm} caught")
ok(POP.assert_no_outcome_fields(base), "a clean event list passes")

# E. descriptor schema cannot carry an outcome
print("\nE. Censoring descriptor schema is outcome-free")
d=POP.descriptor({"event_id":"e1","trade_date":"d","session_location":"ny_open",
                  "hour_et":9,"direction":1,"liquidity_class":"pdh","y_30":9.9}, True)
ok("y_30" not in d, "an outcome present on the source event is NOT projected")
ok(set(d)==set(POP.CensorDescriptor.FIELDS), "descriptor has exactly the frozen fields")
ok(POP.assert_no_outcome_fields([d]), "descriptors pass the guard")

# F. excluded categories cannot influence included ranks
print("\nF. Filter-before-rank invariance")
rng=random.Random(3); cat=[];y=[]
for i in range(900):
    c="abc"[i%3]; cat.append(c); y.append({"a":0.,"b":1.,"c":2.}[c]+rng.gauss(0,.3))
vA=I.category_effect_vector(cat,y,{"a","b","c"})
cat2=list(cat)+["Z"]*300; y2=list(y)+[1e6]*150+[-1e6]*150
vB=I.category_effect_vector(cat2,y2,{"a","b","c"})
ok(all(abs(vA[k]-vB[k])<1e-12 for k in vA),
   "adding an EXCLUDED category with extreme values leaves A/B/C identical")
ok("Z" not in vB, "the excluded category contributes nothing")

# G. category admission is availability-only
print("\nG. Category admission ignores performance")
dim={"keep":{"eligible_clusters":40,"events":1,"eligible":1,"eligibility_rate":1,"clusters":1},
     "drop":{"eligible_clusters":29,"events":1,"eligible":1,"eligibility_rate":1,"clusters":1}}
k,dd=POP.admissible_categories(dim)
ok(k==["keep"] and dd=={"drop":29}, "only the cluster count decides admission")
import inspect
src=inspect.getsource(POP.admissible_categories)
ok(not any(w in src for w in ("mean","beta","p_value","effect","y_30")),
   "admission code references no performance quantity at all")

# H/I/J/K. winsorization freeze
print("\nH/I/J/K. Winsorization constants")
W=json.load(open("research/WINSORIZATION_FREEZE.json"))
feats=W["features"]
ok(len(feats)==19, f"19 winsorized features present ({len(feats)})")
nonnull=[k for k,v in feats.items() if v["frozen_lower"] is not None and v["frozen_upper"] is not None]
ok(len(nonnull)==19, f"all 19 have non-null bounds ({len(nonnull)})")
ok(all(v["valid_n"]>=100 for v in feats.values()), "every feature has >=100 valid burn-in obs")
ok(all(v["frozen_lower"]<=v["frozen_upper"] for v in feats.values()), "lower <= upper for all")
ok(W["source_period"]=="2022-09-09..2023-08-31", "source is the burn-in period only")
ok(W["basis"]==V.RAW_BASIS, "computed from the RAW basis")
for x,q,exp in (([1,2,3,4,5],0.005,1.02),([1,2,3,4,5],0.995,4.98),
                ([0,10],0.5,5.0),([7],0.5,7.0),([1,2,3,4],0.25,1.75)):
    ok(abs(FE.quantile(sorted(x),q)-exp)<1e-9, f"quantile({x},{q}) = {exp}")
FZ="backtest/freeze_winsorization.py"; fsrc=open(FZ).read()
# burn-in only, established from the dates the module can actually construct
# rather than from how a date happens to be spelled in the source text
dls=date_literals(FZ)
ok(dls and min(dls)==dt.date(2022,9,9) and max(dls)==dt.date(2023,8,31),
   f"freeze script reads burn-in only - no evaluable/validation/stress dates {dls}")
ok(W["source_period"]=="2022-09-09..2023-08-31" and
   all(dt.date.fromisoformat(x)in dls for x in W["source_period"].split("..")),
   "the artifact's source period is the span the script actually read")
ok("data_ndx_q" not in re.sub(r"unquantized","",fsrc),
   "freeze script never names the quantized file")
osyms=outcome_symbols(FZ)
ok(not osyms, f"freeze script computes no outcome symbol {osyms}")

# L. VWAP slope missing, never 0
print("\nL. VWAP slope insufficient history -> MISSING")
ok("FEATURE MISSING" in FS["event_time_features"]["vwap_slope_sigma_per_bar"]["missing"],
   "spec says MISSING, not 0.0")
ok("0.0" not in FS["event_time_features"]["vwap_slope_sigma_per_bar"]["missing"],
   "no zero-imputation remains in the spec")
fsrc2=open("backtest/v2_features.py").read()
ok("if vnbar[i] >= 12 and i >= 12" in fsrc2 and "else None" in fsrc2,
   "implementation yields None, not 0.0, below 12 bars")

# M/N/O/P/Q. same-bucket comparators
print("\nM/N/O/P/Q. Same-bucket comparator causality")
for f in ("atr_percentile","realized_vol_state"):
    ok("SAME 5m bucket" in FS["event_time_features"][f]["formula"]
       or "SAME 5m bucket-of-trade-day" in FS["event_time_features"][f]["formula"],
       f"{f} uses the SAME 5m bucket on prior trade dates")
    ok("Not end-of-day" in FS["event_time_features"][f]["formula"],
       f"{f} explicitly forbids end-of-day substitution")
    ok(FS["event_time_features"][f]["comparator_identity"]==
       ["trade_date","bucket_id","timestamp","value"], f"{f} comparator identity frozen")
t0=1_700_000_000
hist=[(None,7,t0-86400*i,float(i)) for i in range(300,0,-1)]
ok(FE.same_bucket_percentile(150.0,hist,t0) is not None, "252 prior comparators -> computed")
ok(FE.same_bucket_percentile(150.0,hist[:251],t0) is None,
   "251 comparators -> MISSING, never partial history")
future=[(None,7,t0+i,float(i)) for i in range(300)]
ok(FE.same_bucket_percentile(1.0,future,t0) is None,
   "comparators at or after t0 are rejected -> insufficient prior history")
mixed=hist[:251]+[(None,7,t0+10,999.0)]
ok(FE.same_bucket_percentile(1.0,mixed,t0) is None,
   "a future comparator cannot top up an insufficient prior set")

# R. no outcome computed anywhere in these tests
print("\nR. This suite computes no outcome")
# An outcome symbol DOES appear here, deliberately: test D plants a fake y_30
# to prove the guard fires, which a guard test cannot do otherwise. So the
# property to establish is not absence of the token but that every such symbol
# is a hard-coded SENTINEL - bound to a literal, never to an expression that
# could read a price. That is the claim "this suite computes no outcome".
def sentinel_only(path):
    t=ast.parse(open(path).read()); bad=[]
    for n in ast.walk(t):
        tgts=[]
        if isinstance(n,ast.Assign): tgts=[(x,n.value) for x in n.targets]
        elif isinstance(n,(ast.AugAssign,ast.AnnAssign)) and n.value:
            tgts=[(n.target,n.value)]
        for tg,val in tgts:
            nm=(tg.id if isinstance(tg,ast.Name) else
                tg.attr if isinstance(tg,ast.Attribute) else
                tg.slice.value if (isinstance(tg,ast.Subscript)
                    and isinstance(tg.slice,ast.Constant)
                    and isinstance(tg.slice.value,str)) else None)
            if isinstance(nm,str) and _OUT.match(nm) and not isinstance(val,ast.Constant):
                bad.append(ast.unparse(n))
    return bad
nonlit=sentinel_only(__file__)
ok(not nonlit, f"every outcome symbol here is a hard-coded sentinel {nonlit}")
ok(outcome_symbols(__file__)==["y_30"],
   f"exactly one outcome symbol appears, the guard sentinel: {outcome_symbols(__file__)}")
# by AST, not by grep: a text scan matches the names inside this very check
_LOADERS={"load_raw","load_v2","iter_levels","build_state","event_time_features"}
_called={n.func.attr if isinstance(n.func,ast.Attribute) else
         getattr(n.func,"id",None)
         for n in ast.walk(ast.parse(open(__file__).read()))
         if isinstance(n,ast.Call)}
ok(not (_called & _LOADERS),
   f"this suite never loads bar data, so no outcome could be derived "
   f"{sorted(_called & _LOADERS)}")
ok(not os.path.exists("research/V2_RESULTS.json"), "no V2 results artifact exists")

print()
if FAILS:
    print(f"V2 FINAL TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - "+f)
    sys.exit(1)
print("V2 FINAL TESTS PASSED.")
