#!/usr/bin/env python3
"""V3-Z1 AUTHORIZED DEVELOPMENT EXECUTION. Inspects development outcomes.

Runs exactly the frozen specification. The prospective holdout is never touched.
"""
import datetime as dt, hashlib, json, math, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cme_session as S, v2_inference as I, z1_panel as Z, z1_design as D
import run_z1_dev as R

SPEC = json.load(open("research/V3_Z1_EXECUTION_SPEC.json"))
PRE = json.load(open("research/V3_Z1_PREREGISTRATION.json"))
SC = SPEC["development_scaling_constants"]
FREEZE_EPOCH = int(dt.datetime.fromisoformat(
    PRE["partitions"]["C_true_prospective_holdout"]["starts_after_utc"]).timestamp())

R.verify_hashes()
rows, _ = Z.build_panel()
rets = {m: Z.log_returns(rows, m) for m in Z.MARKETS}
dates = sorted({r["trade_date"] for r in rows})
excl = Z.roll_excluded_dates(dates[0], dates[-1])
bounds = Z.session_bounds_rows(rows); ordered = sorted(bounds)
dpos = {d: i for i, d in enumerate(ordered)}

P = PRE["partitions"]
DEV0, DEV1 = (dt.date.fromisoformat(P["A_development"]["first"]),
              dt.date.fromisoformat(P["A_development"]["last"]))
REP0, REP1 = (dt.date.fromisoformat(P["B_internal_chronological_replication"]["first"]),
              dt.date.fromisoformat(P["B_internal_chronological_replication"]["last"]))

# ── FIRST REAL OUTCOME INSPECTION ─────────────────────────────────────────
FIRST_OUTCOME_UTC = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
recs = []
acc = {"n": 0, "sum": 0.0}; cur = None
for i, r in enumerate(rows):
    k = Z.session_key(r["ts"])
    if k != cur:
        cur = k; acc = {"n": 0, "sum": 0.0}
    f, z = Z.features_at(rows, rets, i, acc)
    if f["divergence_1h"] is not None:
        acc["n"] += 1; acc["sum"] += f["divergence_1h"]
    d = r["trade_date"]
    # PROSPECTIVE FIREWALL: never compute an outcome past the frozen cutoff
    if r["ts"] > FREEZE_EPOCH:
        continue
    sig = Z.rolling_sigma(rets["NQ"], i)
    recs.append({"i": i, "ts": r["ts"], "trade_date": d,
        "roll_excluded": d in excl, "bucket": D.session_bucket(r["ts"]),
        "divergence_1h": f["divergence_1h"],
        "divergence_session": f["divergence_session"],
        "nq_z": z["NQ"], "nq_vol_state": (math.log(sig) if sig else None),
        "prev_day_nq_return": Z.prev_day_nq_return(rows, bounds, ordered, dpos, d, excl),
        "y": Z.primary_outcome(rows, rets, i)})


def sample(feature, d0, d1):
    out = []
    for r in recs:
        if r["roll_excluded"] or not (d0 <= r["trade_date"] <= d1): continue
        if r["y"] is None or r[feature] is None or r["bucket"] is None: continue
        if any(r[b] is None for b in ("nq_z", "nq_vol_state", "prev_day_nq_return")):
            continue
        out.append(r)
    return out


def design(cc, feature):
    X, y, cl = [], [], []
    for r in cc:
        X.append([1.0, Z.apply_scaler(r[feature], SC[feature]),
                  Z.apply_scaler(r["nq_z"], SC["nq_z"]),
                  Z.apply_scaler(r["nq_vol_state"], SC["nq_vol_state"])]
                 + D.dummies(r["bucket"])
                 + [Z.apply_scaler(r["prev_day_nq_return"], SC["prev_day_nq_return"])])
        y.append(r["y"]); cl.append(r["trade_date"])
    return X, y, cl


def ols_beta(X, y):
    A = np.asarray(X); b = np.asarray(y)
    return np.linalg.solve(A.T @ A, A.T @ b)


out = {"first_outcome_inspection_utc": FIRST_OUTCOME_UTC,
       "code_commit": os.popen("git rev-parse HEAD").read().strip(),
       "spec_hashes": SPEC["protected_hashes"],
       "performance_inspected": True, "outcomes_inspected": True,
       "development_run": True, "prospective_holdout_inspected": False,
       "data_cost_usd": 0, "development": {}, "holm": {}, "concentration": {},
       "bootstrap": {}, "gates": {}, "replication": {}}

# ── Stage 1: development ──────────────────────────────────────────────────
pvals = {}
for feat in Z.FEATURES:
    cc = sample(feat, DEV0, DEV1)
    X, y, cl = design(cc, feat)
    info = D.check_design(X)
    fit = I.cr1_ols(y, [row[1:] for row in X], cl)
    b = fit["beta"][1]; se = fit["se"][1]; p = fit["p"][1]
    out["development"][feat] = {
        "rows": len(cc), "trade_dates": len({r["trade_date"] for r in cc}),
        "beta": b, "cr1_se": se, "t": fit["t"][1], "df": fit["df"],
        "raw_p_two_sided": p, "ci95": fit["ci"][1],
        "expected_sign": Z.EXPECTED_SIGN[feat],
        "observed_sign": (1 if b > 0 else -1 if b < 0 else 0),
        "abs_standardized_beta": abs(b),
        "design_rank": info["rank"], "design_k": info["k"],
        "condition_number": info["condition_number"],
        "condition_warning": info["warn"], "G": fit["G"], "N": fit["N"]}
    pvals[feat] = p
    out["development"][feat]["_cc"] = None

holm = I.holm_fixed_family(pvals, family_size=2, alpha=0.05)
out["holm"] = {"m": 2, "alpha": 0.05,
    "results": [{"feature": e["feature"], "raw_p": e["p"], "rank": i+1,
                 "multiplier": e["multiplier"],
                 "holm_threshold": 0.05 / e["multiplier"],
                 "p_holm": e["p_holm"], "reject": e["reject"]}
                for i, e in enumerate(holm["results"])]}
json.dump(out, open("/tmp/claude-0/-home-user-MMT/7398f50c-a4ba-53ef-9346-ca0eb03feac2/scratchpad/z1_stage1.json", "w"), indent=2, default=str)
print(f"FIRST OUTCOME INSPECTION: {FIRST_OUTCOME_UTC}")
print(f"\n{'feature':<22} {'rows':>6} {'dates':>6} {'beta':>10} {'CR1 se':>9} "
      f"{'t':>7} {'df':>4} {'raw p':>9} {'|beta|':>7} sign")
for f in Z.FEATURES:
    d = out["development"][f]
    print(f"  {f:<20} {d['rows']:>6,} {d['trade_dates']:>6} {d['beta']:>+10.6f} "
          f"{d['cr1_se']:>9.6f} {d['t']:>+7.3f} {d['df']:>4} {d['raw_p_two_sided']:>9.5f} "
          f"{d['abs_standardized_beta']:>7.4f} {'NEG' if d['observed_sign']<0 else 'POS'}")
    print(f"      95% CR1 CI [{d['ci95'][0]:+.6f}, {d['ci95'][1]:+.6f}]   "
          f"rank {d['design_rank']}/{d['design_k']}  cond {d['condition_number']:.2f}  "
          f"warn {d['condition_warning']}")
print(f"\nHolm m=2 alpha=0.05:")
for e in out["holm"]["results"]:
    print(f"  rank {e['rank']}  {e['feature']:<22} raw p {e['raw_p']:.5f}  "
          f"mult {e['multiplier']}  threshold {e['holm_threshold']:.4f}  "
          f"adj p {e['p_holm']:.5f}  {'REJECT' if e['reject'] else 'FAIL'}")

# ── frozen robustness diagnostics ─────────────────────────────────────────
# Reported for a COMPLETE gate table. The Stage-1 gates are conjunctive, so
# these cannot rescue a hypothesis that has already failed gates 1-3.
dev_dates = sorted({r["trade_date"] for r in recs
                    if not r["roll_excluded"] and DEV0 <= r["trade_date"] <= DEV1
                    and r["y"] is not None})
for feat in Z.FEATURES:
    cc = sample(feat, DEV0, DEV1)
    dd = D.deciles(sorted({r["trade_date"] for r in cc}))
    X, y, cl = design(cc, feat)
    Xa = np.asarray(X); ya = np.asarray(y)
    full = ols_beta(Xa, ya)[1]
    per = []
    for g in range(1, D.N_DECILES + 1):
        keep = [k for k, r in enumerate(cc) if dd[r["trade_date"]] != g]
        per.append(float(ols_beta(Xa[keep], ya[keep])[1]))
    sgn = Z.EXPECTED_SIGN[feat]
    same = sum(1 for b in per if (b < 0) == (sgn < 0))
    opp = [abs(b) for b in per if (b < 0) != (sgn < 0)]
    med = float(np.median([abs(b) for b in per]))
    out["concentration"][feat] = {
        "full_beta": float(full), "full_abs_beta": abs(float(full)),
        "leave_one_decile_out_betas": per,
        "n_retaining_expected_sign": same,
        "largest_opposite_sign_abs": (max(opp) if opp else None),
        "median_loo_abs_beta": med,
        "median_over_full_ratio": (med / abs(full) if full else None),
        "cond_a_9of10_sign": same >= 9,
        "cond_b_no_reversal_exceeds_full": (not opp) or max(opp) <= abs(full),
        "cond_c_median_ge_50pct": (med >= 0.5 * abs(full)) if full else False}
    c = out["concentration"][feat]
    c["PASS"] = c["cond_a_9of10_sign"] and c["cond_b_no_reversal_exceeds_full"] \
        and c["cond_c_median_ge_50pct"]

    # moving-block bootstrap
    by_date = {}
    for k, r in enumerate(cc):
        by_date.setdefault(r["trade_date"], []).append(k)
    ddates = sorted(by_date)
    out["bootstrap"][feat] = {}
    for L in D.BOOTSTRAP_BLOCK_LENGTHS:
        rng = random.Random(D.BOOTSTRAP_SEED)
        betas = []
        for _ in range(D.BOOTSTRAP_RESAMPLES):
            sel = D.moving_block_indices(ddates, L, rng)
            idx = np.concatenate([by_date[d] for d in sel])
            try:
                betas.append(float(ols_beta(Xa[idx], ya[idx])[1]))
            except np.linalg.LinAlgError:
                continue
        a = np.asarray(betas)
        lo, hi = float(np.percentile(a, 2.5)), float(np.percentile(a, 97.5))
        frac = float((a < 0).mean()) if sgn < 0 else float((a > 0).mean())
        out["bootstrap"][feat][f"L{L}"] = {
            "block_length": L, "resamples": len(betas), "seed": D.BOOTSTRAP_SEED,
            "median_beta": float(np.median(a)), "pct_2_5": lo, "pct_97_5": hi,
            "fraction_in_expected_direction": frac,
            "PASS": hi < 0 if sgn < 0 else lo > 0}

print("\n=== CONCENTRATION (10 leave-one-decile-out refits) ===")
for feat in Z.FEATURES:
    c = out["concentration"][feat]
    print(f"  {feat}")
    print(f"    full beta {c['full_beta']:+.6f}   |full| {c['full_abs_beta']:.6f}")
    print(f"    LOO betas: {[f'{b:+.5f}' for b in c['leave_one_decile_out_betas']]}")
    print(f"    retaining expected sign {c['n_retaining_expected_sign']}/10  "
          f"(a) {c['cond_a_9of10_sign']}")
    print(f"    largest opposite-sign |beta| "
          f"{c['largest_opposite_sign_abs'] if c['largest_opposite_sign_abs'] is None else round(c['largest_opposite_sign_abs'],6)}"
          f"  (b) {c['cond_b_no_reversal_exceeds_full']}")
    print(f"    median LOO |beta| {c['median_loo_abs_beta']:.6f}  ratio "
          f"{c['median_over_full_ratio']:.3f}  (c) {c['cond_c_median_ge_50pct']}")
    print(f"    CONCENTRATION {'PASS' if c['PASS'] else 'FAIL'}")

print("\n=== MOVING-BLOCK BOOTSTRAP (seed 20260914, 5000 resamples) ===")
for feat in Z.FEATURES:
    print(f"  {feat}")
    for L in D.BOOTSTRAP_BLOCK_LENGTHS:
        b = out["bootstrap"][feat][f"L{L}"]
        print(f"    L={L:<3} median {b['median_beta']:+.6f}  "
              f"2.5% {b['pct_2_5']:+.6f}  97.5% {b['pct_97_5']:+.6f}  "
              f"frac NEG {b['fraction_in_expected_direction']:.3f}  "
              f"{'PASS' if b['PASS'] else 'FAIL'}")

# ── Stage-1 gate table ────────────────────────────────────────────────────
for feat in Z.FEATURES:
    d = out["development"][feat]
    h = next(e for e in out["holm"]["results"] if e["feature"] == feat)
    c = out["concentration"][feat]; bs = out["bootstrap"][feat]
    g = {"1_holm_p_le_alpha": bool(h["reject"]),
         "2_sign_matches": d["observed_sign"] == d["expected_sign"],
         "3_abs_beta_ge_0.03": d["abs_standardized_beta"] >= 0.03,
         "4_concentration": c["PASS"],
         "5_bootstrap_L5": bs["L5"]["PASS"],
         "6_bootstrap_L10": bs["L10"]["PASS"],
         "7_bootstrap_L20": bs["L20"]["PASS"],
         "8_full_baseline_model": d["design_k"] == 10,
         "9_rank_conditioning": d["design_rank"] == d["design_k"]
                                and d["condition_number"] <= D.CONDITION_NUMBER_FAIL}
    g["FINAL_DEVELOPMENT_PROMOTION"] = all(g.values())
    out["gates"][feat] = g

print("\n=== STAGE-1 GATE TABLE ===")
keys = list(out["gates"][Z.FEATURES[0]].keys())
print(f"  {'gate':<32} " + "  ".join(f"{f[:18]:>18}" for f in Z.FEATURES))
for k in keys:
    print(f"  {k:<32} " + "  ".join(
        f"{('PASS' if out['gates'][f][k] else 'FAIL'):>18}" for f in Z.FEATURES))

survivors = [f for f in Z.FEATURES if out["gates"][f]["FINAL_DEVELOPMENT_PROMOTION"]]
out["stage1_survivors"] = survivors
out["replication_run"] = bool(survivors)
if not survivors:
    out["classification"] = "V3-Z1 NEGATIVE - DEVELOPMENT"
    out["replication"] = {"run": False,
        "reason": "no hypothesis passed Stage 1; replication remains OUTCOME-UNINSPECTED"}
    print(f"\nSTAGE-1 SURVIVORS: NONE")
    print("REPLICATION NOT OPENED - remains outcome-uninspected.")
    print("CLASSIFICATION: V3-Z1 NEGATIVE - DEVELOPMENT")
for f in Z.FEATURES:
    out["development"][f].pop("_cc", None)
json.dump(out, open("research/V3_Z1_RESULTS.json", "w"), indent=2, default=str)
print("\n-> research/V3_Z1_RESULTS.json")
