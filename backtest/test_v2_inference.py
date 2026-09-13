#!/usr/bin/env python3
"""Audit item 11: CR1 inference on SYNTHETIC data only. No real outcome."""
import math, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2_inference as I

FAILS=[]
def ok(c,m):
    print(("  PASS  " if c else "  FAIL  ")+m)
    if not c: FAILS.append(m)

rng=random.Random(20260913)

# ── 1. OLS point estimates match a closed-form simple regression ───────────
print("1. Point estimates vs closed form")
x=[rng.gauss(0,1) for _ in range(600)]
y=[2.0+3.0*xi+rng.gauss(0,0.5) for xi in x]
g=[f"d{i//6}" for i in range(600)]
r=I.cr1_ols(y,[[v] for v in x],g)
mx=sum(x)/len(x); my=sum(y)/len(y)
b_cf=sum((a-mx)*(b-my) for a,b in zip(x,y))/sum((a-mx)**2 for a in x)
a_cf=my-b_cf*mx
ok(abs(r["beta"][1]-b_cf)<1e-9, f"slope matches closed form ({r['beta'][1]:.6f} vs {b_cf:.6f})")
ok(abs(r["beta"][0]-a_cf)<1e-9, "intercept matches closed form")
ok(r["G"]==100 and r["N"]==600 and r["K"]==2, f"G={r['G']} N={r['N']} K={r['K']}")
ok(r["df"]==r["G"]-1, "df = G-1")
ok(r["critical"].startswith("Student-t"), "critical distribution is Student-t")

# ── 2. CR1 covariance reproduces the frozen formula by hand ───────────────
print("\n2. CR1 covariance reproduces the frozen formula")
Xv=[[1.0,v] for v in x]
Xt=I._transpose(Xv); XtX=I._matmul(Xt,Xv); Xi=I._inv(XtX)
u=[y[i]-(r["beta"][0]+r["beta"][1]*x[i]) for i in range(600)]
by={}
for i,c in enumerate(g):
    s=by.setdefault(c,[0.0,0.0]); s[0]+=Xv[i][0]*u[i]; s[1]+=Xv[i][1]*u[i]
meat=[[0.0,0.0],[0.0,0.0]]
for s in by.values():
    for a in range(2):
        for b in range(2): meat[a][b]+=s[a]*s[b]
c=(100/99.0)*((600-1)/(600-2))
V=I._matmul(I._matmul(Xi,meat),Xi); V=[[c*V[a][b] for b in range(2)] for a in range(2)]
ok(abs(math.sqrt(V[1][1])-r["se"][1])<1e-12,
   f"hand-computed CR1 SE equals the implementation ({math.sqrt(V[1][1]):.8f})")

# ── 3. clustering matters: intra-cluster correlation widens the SE ────────
print("\n3. Clustering inflates the SE when the REGRESSOR is cluster-level")
# A day-shock alone does NOT inflate a slope SE when x varies independently
# within the day - the first version of this test asserted that and was wrong.
# Clustering bites when the regressor is itself constant within the cluster.
xs=[];ys=[];gs=[]
for d in range(120):
    shock=rng.gauss(0,2.0)                      # whole-day shock
    xd=rng.gauss(0,1)                           # CLUSTER-LEVEL regressor
    for _ in range(8):
        xs.append(xd); gs.append(f"d{d}")
        ys.append(1.0+0.0*xd+shock+rng.gauss(0,0.3))
rc=I.cr1_ols(ys,[[v] for v in xs],gs)
N=len(ys); res=[ys[i]-(rc["beta"][0]+rc["beta"][1]*xs[i]) for i in range(N)]
s2=sum(e*e for e in res)/(N-2); mxs=sum(xs)/N
se_naive=math.sqrt(s2/sum((v-mxs)**2 for v in xs))
ok(rc["se"][1] > 2.0*se_naive,
   f"CR1 SE {rc['se'][1]:.5f} is far larger than naive {se_naive:.5f} "
   f"(ratio {rc['se'][1]/se_naive:.1f}x) - naive inference would be badly "
   "overconfident here")

# ── 4. boolean mean-difference ────────────────────────────────────────────
print("\n4. Boolean test recovers a known mean difference")
b=[];yb=[];gb=[]
for d in range(200):
    for k in range(5):
        flag=(k%2==0); b.append(flag); gb.append(f"d{d}")
        yb.append((0.7 if flag else 0.2)+rng.gauss(0,0.4))
rb=I.boolean_test(b,yb,gb)
ok(abs(rb["beta_of_interest"]-0.5)<0.06,
   f"beta recovers the 0.5 mean difference ({rb['beta_of_interest']:.4f})")
ok(rb["p_of_interest"]<0.01, f"p is small as expected ({rb['p_of_interest']:.2e})")

# ── 5. categorical omnibus: null vs real effect ───────────────────────────
print("\n5. Categorical omnibus Wald")
cats=["a","b","c","d"]
cn=[];yn=[];gn=[]
for d in range(200):
    for k in range(6):
        cc=cats[k%4]; cn.append(cc); gn.append(f"d{d}"); yn.append(rng.gauss(0,1))
rn=I.categorical_test(cn,yn,gn)
ok(rn["q"]==3 and rn["reference"]=="a", f"K-1=3 dummies, reference '{rn['reference']}'")
# A single null draw landing at p=0.042 is not a defect - that happens 5% of the
# time by construction. The property worth testing is SIZE: the rejection rate
# under the null must sit near alpha across many replications.
rej=0; REPS=200
for rep in range(REPS):
    cc_=[];yy=[];gg=[]
    for d in range(120):
        for k in range(6):
            cc_.append(cats[k%4]); gg.append(f"d{d}"); yy.append(rng.gauss(0,1))
    if I.categorical_test(cc_,yy,gg)["p_of_interest"] <= 0.05: rej+=1
rate=rej/REPS
ok(0.01 <= rate <= 0.11,
   f"NULL rejection rate {rate:.3f} over {REPS} replications is near alpha=0.05 "
   f"(binomial SE ~{(0.05*0.95/REPS)**0.5:.3f}) - the omnibus test is correctly sized")
ce=[];ye=[];ge=[]
for d in range(200):
    for k in range(6):
        cc=cats[k%4]; ce.append(cc); ge.append(f"d{d}")
        ye.append({"a":0.0,"b":0.0,"c":0.0,"d":1.2}[cc]+rng.gauss(0,0.5))
re_=I.categorical_test(ce,ye,ge)
ok(re_["p_of_interest"]<0.01,
   f"a real category effect IS detected (p={re_['p_of_interest']:.2e})")
ok(re_["beta_of_interest"] is None,
   "categorical exposes no single 'sign' - beta_of_interest is None by design")

# ── 6. fail-closed behaviours ─────────────────────────────────────────────
print("\n6. Fail-closed behaviour")
try:
    # 200 clusters so the cluster-count guard does NOT mask the singularity,
    # which is what the first version of this test accidentally did
    I.cr1_ols([rng.gauss(0,1) for _ in range(600)], [[1.0]]*600,
              [f"d{i//3}" for i in range(600)])
    ok(False,"constant predictor should be singular")
except I.SingularDesign: ok(True,"perfectly collinear predictor -> SingularDesign")
try:
    I.cr1_ols([rng.gauss(0,1) for _ in range(100)],
              [[rng.gauss(0,1)] for _ in range(100)],[f"d{i//20}" for i in range(100)])
    ok(False,"5 clusters should be refused")
except I.TooFewClusters: ok(True,f"fewer than {I.MIN_CLUSTERS} clusters -> TooFewClusters")
yv=[rng.gauss(0,1) for _ in range(600)]; yv[3]=float("nan")
rd=I.cr1_ols(yv,[[v] for v in x],g)
ok(rd["dropped"]==1 and rd["N"]==599, f"NaN row dropped and COUNTED (dropped={rd['dropped']})")

# ── 7. ties use average ranks ─────────────────────────────────────────────
print("\n7. Rank/tie behaviour")
ok(I.average_ranks([10,20,20,30])==[1.0,2.5,2.5,4.0], "ties get average ranks")
ok(I.average_ranks([5,5,5])==[2.0,2.0,2.0], "all-tied -> all mid-rank")

# ── 8. Holm ───────────────────────────────────────────────────────────────
print("\n8. Holm step-down (fixed family of 22)")
# The generic dynamic-family holm() was DELETED: with m = len(items) it made the
# tested hypotheses easier to reject whenever fewer than 22 were testable.
ok(not hasattr(I,"holm"), "the generic dynamic-family holm() no longer exists")
h=I.holm_fixed_family({"a":0.001,"b":0.02,"c":0.04,"d":0.5},alpha=0.05)
adj={x["feature"]:x["p_holm"] for x in h["results"]}
ok(abs(adj["a"]-0.022)<1e-12, f"smallest p x 22 = {adj['a']:.4f} (family size, not 4)")
ok(all(h["results"][i]["p_holm"]<=h["results"][i+1]["p_holm"]+1e-12
       for i in range(len(h["results"])-1)), "adjusted p is monotone")
ok([x["feature"] for x in h["results"] if x["reject"]]==["a"],
   "only 'a' survives at alpha=0.05")
ok(h["family_size"]==22, "family size is 22 even with 4 p-values supplied")
full=I.holm_fixed_family({f"f{i}":0.03 for i in range(22)})
ok(full["tested"]==22 and full["family_size"]==22, "a full family of 22 is handled")

print()
if FAILS:
    print(f"V2 INFERENCE TESTS FAILED - {len(FAILS)}")
    for f in FAILS: print("  - "+f)
    sys.exit(1)
print("V2 INFERENCE TESTS PASSED (synthetic data only).")
