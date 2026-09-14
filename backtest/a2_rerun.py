#!/usr/bin/env python3
"""A2 size diagnostic re-run with the Z1 RETURN outcome.

Separates the two candidate causes of the A2 failure:

  A2      HAR design + log(r^2) outcome      -> rejection rate 0.1710  FAIL
  A2-R1   HAR design + Z1 RETURN outcome     -> isolates the OUTCOME as the
                                                single changed variable
  A2-R2   ACTUAL Z1 design + Z1 return       -> directly tests the configuration
                                                that produced the V3-Z1 null

Only PERMUTED fits are computed for the new configurations. The unpermuted
HAR-design-with-return regression is NEVER fitted: that would be a new
undeclared test of a real relationship rather than a calibration exercise.
"""
import datetime as dt, json, math, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_inference as I, z1_panel as Z, z1_design as D
import z2_control as C

PERMS, SEED, ALPHA, BAND = 1000, 20260914, 0.05, (0.025, 0.080)
Z1SPEC = json.load(open("research/V3_Z1_EXECUTION_SPEC.json"))
SC1 = Z1SPEC["development_scaling_constants"]
P = json.load(open("research/V3_Z1_PREREGISTRATION.json"))["partitions"]
DEV0 = dt.date.fromisoformat(P["A_development"]["first"])
DEV1 = dt.date.fromisoformat(P["A_development"]["last"])
CUTOFF = int(dt.datetime.fromisoformat(
    P["C_true_prospective_holdout"]["starts_after_utc"]).timestamp())

rows, _ = Z.build_panel()
rets = {m: Z.log_returns(rows, m) for m in Z.MARKETS}
dates = sorted({r["trade_date"] for r in rows})
excl = Z.roll_excluded_dates(dates[0], dates[-1])
bounds = Z.session_bounds_rows(rows); ordered = sorted(bounds)
dpos = {d: i for i, d in enumerate(ordered)}


def collect():
    acc = {"n": 0, "sum": 0.0}; cur = None; out = []
    for i, r in enumerate(rows):
        k = Z.session_key(r["ts"])
        if k != cur:
            cur = k; acc = {"n": 0, "sum": 0.0}
        f, z = Z.features_at(rows, rets, i, acc)
        if f["divergence_1h"] is not None:
            acc["n"] += 1; acc["sum"] += f["divergence_1h"]
        d = r["trade_date"]
        if r["ts"] > CUTOFF or d in excl or not (DEV0 <= d <= DEV1):
            continue
        sig = Z.rolling_sigma(rets["NQ"], i)
        out.append({"i": i, "trade_date": d, "bucket": D.session_bucket(r["ts"]),
                    "har": C.har_features(rets["NQ"], i),
                    "div": f["divergence_1h"], "nq_z": z["NQ"],
                    "vol": (math.log(sig) if sig else None),
                    "prev": Z.prev_day_nq_return(rows, bounds, ordered, dpos, d, excl),
                    "y_ret": Z.primary_outcome(rows, rets, i)})
    return out


recs = collect()


def size_check(label, build_row, need, scal):
    cc = [r for r in recs if r["bucket"] and r["y_ret"] is not None
          and all(r[k] is not None for k in need)
          and not (isinstance(r.get("har"), dict) and "har" in need
                   and any(v is None for v in r["har"].values()))]
    if "har" in need:
        cc = [r for r in cc if all(v is not None for v in r["har"].values())]
    X = [build_row(r, scal) for r in cc]
    y = [r["y_ret"] for r in cc]
    bydate = {}
    for k, r in enumerate(cc):
        bydate.setdefault(r["trade_date"], []).append(k)
    dl = sorted(bydate)
    info = D.check_design([[1.0] + x for x in X],
                          ("intercept",) + tuple(f"c{j}" for j in range(len(X[0]))))
    rng = random.Random(SEED)
    rej = 0; done = 0; ts = []
    for _ in range(PERMS):
        perm = dl[:]; rng.shuffle(perm)
        Xp, yp, cp = [], [], []
        for d, src in zip(dl, perm):
            n = min(len(bydate[d]), len(bydate[src]))
            for a_, b_ in zip(bydate[src][:n], bydate[d][:n]):
                Xp.append(X[a_]); yp.append(y[b_]); cp.append(d)
        try:
            f2 = I.cr1_ols(yp, Xp, cp)
        except Exception:
            continue
        done += 1; ts.append(f2["t"][1])
        if f2["p"][1] <= ALPHA:
            rej += 1
    rate = rej / done if done else None
    return {"label": label, "rows": len(cc), "clusters": len(dl),
            "condition_number": info["condition_number"],
            "permutations": done, "rejections": rej, "rejection_rate": rate,
            "mean_abs_t": float(np.mean([abs(x) for x in ts])),
            "PASS": rate is not None and BAND[0] <= rate <= BAND[1]}


def row_har(r, sc):
    return [Z.apply_scaler(r["har"][k], sc[k]) for k in C.HAR_COMPONENTS] + \
        D.dummies(r["bucket"])


def row_z1(r, sc):
    return [Z.apply_scaler(r["div"], SC1["divergence_1h"]),
            Z.apply_scaler(r["nq_z"], SC1["nq_z"]),
            Z.apply_scaler(r["vol"], SC1["nq_vol_state"])] + \
        D.dummies(r["bucket"]) + \
        [Z.apply_scaler(r["prev"], SC1["prev_day_nq_return"])]


har_ok = [r for r in recs if all(v is not None for v in r["har"].values())]
sc_har = {k: Z.fit_scaler([r["har"][k] for r in har_ok]) for k in C.HAR_COMPONENTS}

print("=== OUTCOME DISTRIBUTION: the hypothesised cause ===")
import statistics
for nm, vals in (("log(r^2)  [A2 outcome]",
                  [C.forward_rv(rows, rets, r["i"]) for r in recs]),
                 ("normalized return [Z1 outcome]",
                  [r["y_ret"] for r in recs])):
    v = [x for x in vals if x is not None]
    m = statistics.mean(v); sd = statistics.pstdev(v)
    sk = sum(((x-m)/sd)**3 for x in v)/len(v)
    ku = sum(((x-m)/sd)**4 for x in v)/len(v)
    print(f"  {nm:<32} n {len(v):,}  skew {sk:+.3f}  kurtosis {ku:.2f}  "
          f"min {min(v):+.2f}  max {max(v):+.2f}")

out = {"A2_original": {"label": "HAR design + log(r^2)", "rejection_rate": 0.1710,
                       "PASS": False, "source": "research/V3_Z2_PC_RESULTS.json"}}
print("\n=== SIZE CHECKS (permuted nulls only) ===")
for res in (size_check("A2-R1  HAR design + Z1 RETURN outcome",
                       row_har, ["har"], sc_har),
            size_check("A2-R2  ACTUAL Z1 design + Z1 return outcome",
                       row_z1, ["div", "nq_z", "vol", "prev"], SC1)):
    out[res["label"].split()[0]] = res
    print(f"  {res['label']}")
    print(f"    rows {res['rows']:,}  clusters {res['clusters']}  "
          f"cond {res['condition_number']:.2f}")
    print(f"    rejections {res['rejections']}/{res['permutations']:,}  "
          f"rate {res['rejection_rate']:.4f}  mean|t| {res['mean_abs_t']:.3f}")
    print(f"    band [{BAND[0]}, {BAND[1]}] -> "
          f"{'PASS' if res['PASS'] else 'FAIL'}")
json.dump(out, open("research/V3_A2_RERUN_RESULTS.json", "w"), indent=2, default=str)
print("\n-> research/V3_A2_RERUN_RESULTS.json")
